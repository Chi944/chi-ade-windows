import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

interface SyncSharedCodexAuthOptions {
	platform?: NodeJS.Platform;
	sharedAuthPath?: string;
}

/**
 * Share the global Codex login with an isolated agent CODEX_HOME.
 * Windows uses a refreshed private copy because file symlinks commonly require
 * Developer Mode. Removing that copy when the global file is absent makes a
 * global `codex logout` effective for every agent on its next terminal launch.
 */
export function syncSharedCodexAuth(
	codexHome: string,
	options: SyncSharedCodexAuthOptions = {},
): void {
	const platform = options.platform ?? os.platform();
	const sharedAuth =
		options.sharedAuthPath ?? join(os.homedir(), ".codex", "auth.json");
	const agentAuth = join(codexHome, "auth.json");

	try {
		if (!fs.existsSync(sharedAuth)) {
			if (platform === "win32") fs.rmSync(agentAuth, { force: true });
			return;
		}

		fs.mkdirSync(codexHome, { recursive: true });
		if (platform === "win32") {
			fs.copyFileSync(sharedAuth, agentAuth);
			fs.chmodSync(agentAuth, 0o600);
			return;
		}

		// existsSync follows symlinks, so an existing valid link is left alone.
		if (fs.existsSync(agentAuth)) return;
		fs.symlinkSync(sharedAuth, agentAuth);
	} catch {
		// Auth sharing is a convenience; a failure here must not break the terminal.
	}
}
