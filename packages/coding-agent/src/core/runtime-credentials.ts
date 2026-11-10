import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string | ((signal?: AbortSignal) => Promise<string | undefined>)>();
	private readonly fallbackToStore = new Set<string>();
	/** Modifications not yet written or failed, for example an OAuth refresh. */
	private readonly pendingModifications = new Set<Promise<void>>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	getPersistentStore(): CredentialStore {
		return this.store;
	}

	/** With `fallbackToStore`, a function override that resolves no key defers to the stored credential. */
	setRuntimeApiKey(
		providerId: string,
		apiKey: string | ((signal?: AbortSignal) => Promise<string | undefined>),
		options: { fallbackToStore?: boolean } = {},
	): void {
		this.overrides.set(providerId, apiKey);
		if (options.fallbackToStore) this.fallbackToStore.add(providerId);
		else this.fallbackToStore.delete(providerId);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
		this.fallbackToStore.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		if (typeof override === "function") {
			// A runtime-owned session remains authoritative when absent or when
			// refresh fails, unless the override opted into the saved credential.
			const key = await override(options?.signal);
			options?.signal?.throwIfAborted();
			if (key === undefined && this.fallbackToStore.has(providerId)) return this.store.read(providerId, options);
			return { type: "api_key", key };
		}
		return override ? { type: "api_key", key: override } : this.store.read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const modification = this.store.modify(providerId, fn, options);
		const pending = modification.then(
			() => undefined,
			() => undefined,
		);
		this.pendingModifications.add(pending);
		void pending.finally(() => this.pendingModifications.delete(pending));
		return modification;
	}

	/**
	 * Resolves when every modification started so far is written or failed. An OAuth refresh may
	 * already have spent the single-use refresh token, so exiting before its result is written would
	 * leave only the spent token in auth.json.
	 */
	async settled(): Promise<void> {
		await Promise.all(this.pendingModifications);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.store.delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
