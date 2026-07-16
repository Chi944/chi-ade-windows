import { getInitialSafeRecoveryRoute } from "renderer/lib/startup-recovery";

export type AuthenticatedLayoutMode = "normal" | "safe";

export function getAuthenticatedLayoutMode(
	search: string,
): AuthenticatedLayoutMode {
	return getInitialSafeRecoveryRoute(search) ? "safe" : "normal";
}
