const SAFE_CLI_ENV_KEYS = new Set([
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"TEMP",
	"TMP",
	"TMPDIR",
	"SHELL",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
]);

const PROFILE_HOME_KEYS = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR"]);

/**
 * Minimal environment for discovering and probing user-installed provider CLIs.
 * Unknown launch-time variables are excluded so a PATH executable cannot inherit
 * unrelated API tokens, database URLs, or CI credentials from ADE.
 */
export function buildCliProcessEnvironment(
	overrides: Record<string, string> = {},
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const normalized = key.toUpperCase();
		if (SAFE_CLI_ENV_KEYS.has(normalized) || normalized.startsWith("LC_")) {
			result[key] = value;
		}
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (PROFILE_HOME_KEYS.has(key.toUpperCase()) && value) result[key] = value;
	}
	return result;
}
