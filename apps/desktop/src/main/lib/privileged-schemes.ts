interface PrivilegedSchemeRegistrar {
	registerSchemesAsPrivileged: (
		schemes: Array<{
			scheme: string;
			privileges: {
				standard: boolean;
				secure: boolean;
				bypassCSP: boolean;
				supportFetchAPI: boolean;
			};
		}>,
	) => void;
}

/**
 * Electron requires custom schemes to be declared synchronously, before the
 * app emits `ready`. Keep this call in the bootstrap entrypoint, ahead of every
 * asynchronous startup operation.
 */
export function registerPrivilegedSchemes(
	protocol: PrivilegedSchemeRegistrar,
): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: "superset-icon",
			privileges: {
				standard: true,
				secure: true,
				bypassCSP: true,
				supportFetchAPI: true,
			},
		},
	]);
}
