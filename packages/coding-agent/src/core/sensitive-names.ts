/** Names of fields and variables that conventionally hold credentials. */

const SENSITIVE_KEY = /(?:^|[-_])(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie)(?:$|[-_])/i;
/** Environment names that also count as credentials: `*_KEY`, `*_PASS`, `*_PASSPHRASE`, `*_PRIVATE_*`. */
const SENSITIVE_ENV_NAME = /(?:^|[-_])(key|pass|passphrase|private)(?:$|[-_])/i;

function splitCamelCase(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

/** Whether a field name conventionally holds a credential. */
export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(splitCamelCase(key));
}

/** Whether an environment variable name conventionally holds a credential. Broader than field names. */
export function isSensitiveEnvName(name: string): boolean {
	const normalized = splitCamelCase(name);
	return SENSITIVE_KEY.test(normalized) || SENSITIVE_ENV_NAME.test(normalized);
}
