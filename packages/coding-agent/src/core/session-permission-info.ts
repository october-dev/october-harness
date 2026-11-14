import type { OctoberPermissionExplanation } from "../extensions/october/permissions.ts";

export type SessionPermissionInfoProvider = (hasUI: boolean) => OctoberPermissionExplanation | undefined;

const providers = new WeakMap<object, SessionPermissionInfoProvider>();

export function registerSessionPermissionInfoProvider(
	session: object,
	provider: SessionPermissionInfoProvider,
): () => void {
	providers.set(session, provider);
	return () => {
		if (providers.get(session) === provider) providers.delete(session);
	};
}

export function getSessionPermissionInfo(session: object, hasUI: boolean): OctoberPermissionExplanation | undefined {
	return providers.get(session)?.(hasUI);
}
