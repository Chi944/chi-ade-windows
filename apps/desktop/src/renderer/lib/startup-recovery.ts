const SAFE_RECOVERY_QUERY_KEY = "adeSafeRecovery";
const HEALTH_RECOVERY_ROUTE = "/settings/health" as const;

export function getInitialSafeRecoveryRoute(
	search: string,
): typeof HEALTH_RECOVERY_ROUTE | null {
	return new URLSearchParams(search).get(SAFE_RECOVERY_QUERY_KEY) === "1"
		? HEALTH_RECOVERY_ROUTE
		: null;
}

export function buildSafeRecoveryLocation(
	pathname: string,
	search: string,
): string | null {
	const route = getInitialSafeRecoveryRoute(search);
	return route ? `${pathname}${search}#${route}` : null;
}
