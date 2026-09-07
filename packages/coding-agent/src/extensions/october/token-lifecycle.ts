import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthOperationOptions, Credential } from "@earendil-works/pi-ai";
import type { AuthStorage } from "../../core/auth-storage.ts";
import { revokeOctoberInferenceToken } from "./device-code.ts";

const PROVIDER = "october";
const memoryJournals = new WeakMap<AuthStorage, string[]>();

/** Only literal inference credentials are owned here, never Desktop JWTs or env references. */
function inferenceToken(credential: Credential | undefined): string | undefined {
	const token =
		credential?.type === "api_key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined;
	return typeof token === "string" && token.startsWith("oct_inf_") ? token : undefined;
}

function journalPath(store: AuthStorage): string | undefined {
	const path = store.getPath();
	return path ? `${path}.october-pending.json` : undefined;
}

function readJournalFile(path: string, purpose: "pending" | "uncommitted" = "pending"): string[] {
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			(process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
		) {
			throw new Error("Unsafe recovery file");
		}
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			typeof data !== "object" ||
			data === null ||
			!("version" in data) ||
			data.version !== 1 ||
			!("purpose" in data) ||
			data.purpose !== purpose ||
			!("tokens" in data) ||
			!Array.isArray(data.tokens) ||
			!data.tokens.every((token: unknown) => typeof token === "string" && token.startsWith("oct_inf_"))
		) {
			throw new Error("Invalid recovery file");
		}
		return [...new Set(data.tokens as string[])];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		// JSON parse errors can contain the secret input. Never propagate them.
		throw new OctoberTokenCleanupError(
			`Cannot safely read October token recovery file: ${path}. Leave it intact for recovery.`,
		);
	}
}

function writeJournalFile(path: string, tokens: string[], purpose: "pending" | "uncommitted" = "pending"): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, JSON.stringify({ version: 1, purpose, tokens: [...new Set(tokens)] }));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temporary);
		} catch {
			/* Already renamed, or never created. */
		}
	}
}

function readJournal(store: AuthStorage): string[] {
	const path = journalPath(store);
	return path ? readJournalFile(path) : [...(memoryJournals.get(store) ?? [])];
}

function writeJournal(store: AuthStorage, tokens: string[]): void {
	const path = journalPath(store);
	if (path) writeJournalFile(path, tokens);
	else memoryJournals.set(store, [...new Set(tokens)]);
}

function recoveryHint(store: AuthStorage): string {
	const path = journalPath(store);
	return path
		? `Pending tokens remain in ${path}. Retry october logout.`
		: "Pending tokens remain in this in-memory store. Retry logout before disposing it.";
}

export class OctoberTokenCleanupError extends Error {
	readonly credentialSaved: boolean;
	constructor(message: string, credentialSaved = false) {
		super(message);
		this.name = "OctoberTokenCleanupError";
		this.credentialSaved = credentialSaved;
	}
}

/** Called only while holding the credential-store lock. Self-revocation is idempotent. */
async function cleanLocked(store: AuthStorage, active: string | undefined): Promise<void> {
	const pending = readJournal(store);
	if (!pending.length) return;
	const signal = AbortSignal.timeout(15000);
	for (const token of pending) {
		if (token !== active && !(await revokeOctoberInferenceToken(token, signal))) {
			throw new OctoberTokenCleanupError(
				`October token revocation failed; local credentials were retained. ${recoveryHint(store)}`,
			);
		}
	}
	// Drop the active token from the journal only after its credential is committed.
	writeJournal(store, []);
}

export async function retryOctoberTokenCleanup(store: AuthStorage): Promise<void> {
	try {
		await store.transactCredential(PROVIDER, async (current) => {
			await cleanLocked(store, inferenceToken(current));
			return { result: undefined };
		});
	} catch (error) {
		if (error instanceof OctoberTokenCleanupError) throw error;
		throw new OctoberTokenCleanupError(`October token cleanup could not complete. ${recoveryHint(store)}`);
	}
}

/** A journal-write/lock failure must not discard an issued token either. */
async function recoverUntrackedToken(token: string): Promise<string> {
	if (await revokeOctoberInferenceToken(token)) return "The uncommitted token was revoked.";
	try {
		const directory = mkdtempSync(join(tmpdir(), "october-token-recovery-"));
		const path = join(directory, "pending.json");
		writeJournalFile(path, [token], "uncommitted");
		return `Remote revocation also failed. Token saved privately; retry: october logout --recovery-file ${path}`;
	} catch {
		return "Remote revocation and recovery-file creation both failed. The newly issued token could not be retained; account-side token cleanup is required before retrying.";
	}
}

export async function saveOctoberCredential(
	store: AuthStorage,
	credential: Credential,
	options: AuthOperationOptions & { newlyIssued?: boolean } = {},
): Promise<void> {
	// Pasted credentials already belong to the caller: a failed save must not revoke them.
	const issued = options.newlyIssued === false ? undefined : inferenceToken(credential);
	let journaled = false;
	let alreadyActive = false;
	try {
		// No caller cancellation on the lock: an already-issued token must first be
		// recorded or revoked. The user can still cancel before the commit below.
		await store.transactCredential(PROVIDER, async (current) => {
			const previous = inferenceToken(current);
			alreadyActive = issued !== undefined && previous === issued;
			const pending = readJournal(store);
			writeJournal(store, [...pending, ...(previous ? [previous] : []), ...(issued ? [issued] : [])]);
			journaled = true;
			options.signal?.throwIfAborted();
			return { result: undefined, credential };
		});
	} catch {
		if (!journaled) {
			const recovery =
				issued && !alreadyActive ? await recoverUntrackedToken(issued) : "The supplied credential was not revoked.";
			throw new Error(`October login was not saved. ${recovery}`);
		}
		// Re-read under the lock. A write may have committed before reporting an
		// error, or another login may have won. Never revoke the actual active token.
		try {
			await retryOctoberTokenCleanup(store);
		} catch {
			throw new OctoberTokenCleanupError(
				`October credential persistence failed or was cancelled; commit status may be uncertain. ${recoveryHint(store)}`,
			);
		}
		throw new Error(
			`October login persistence failed or was cancelled. ${issued ? "Uncommitted tokens were revoked" : "The supplied credential was not revoked"}; the current stored credential was preserved.`,
		);
	}
	try {
		await retryOctoberTokenCleanup(store);
	} catch {
		throw new OctoberTokenCleanupError(
			`October login was saved, but previous token cleanup is incomplete. ${recoveryHint(store)}`,
			true,
		);
	}
}

export async function loginOctoberWithStore(
	store: AuthStorage,
	acquire: () => Promise<Credential>,
	options: AuthOperationOptions & { newlyIssued?: boolean } = {},
): Promise<Credential> {
	options.signal?.throwIfAborted();
	await retryOctoberTokenCleanup(store);
	options.signal?.throwIfAborted();
	const credential = await acquire();
	await saveOctoberCredential(store, credential, options);
	return credential;
}

export async function logoutOctoberWithStore(store: AuthStorage, signal?: AbortSignal): Promise<boolean> {
	// Read -> journal -> revoke -> delete is one transaction. A later login must
	// wait for removal before committing, so logout cannot erase that new login.
	try {
		return await store.transactCredential(
			PROVIDER,
			async (current) => {
				const pending = readJournal(store);
				const active = inferenceToken(current);
				if (!current && !pending.length) return { result: false };
				writeJournal(store, [...pending, ...(active ? [active] : [])]);
				await cleanLocked(store, undefined);
				return { result: true, credential: null };
			},
			{ signal },
		);
	} catch (error) {
		if (error instanceof OctoberTokenCleanupError) throw error;
		throw new OctoberTokenCleanupError(
			`October logout did not complete; local credential removal was not confirmed. ${recoveryHint(store)}`,
		);
	}
}

/** Recovery files contain only uncommitted tokens, never the active credential. */
export async function recoverOctoberTokenFile(path: string): Promise<void> {
	const tokens = readJournalFile(path, "uncommitted");
	if (!tokens.length) throw new Error("No pending tokens in this recovery file.");
	const signal = AbortSignal.timeout(15000);
	for (const token of tokens) {
		if (!(await revokeOctoberInferenceToken(token, signal))) {
			throw new Error(`October token revocation failed. Recovery file retained: ${path}`);
		}
	}
	writeJournalFile(path, [], "uncommitted");
}
