import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSharedCodexAuth } from "./codex-auth";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("syncSharedCodexAuth", () => {
	it("removes a Windows agent copy after global logout", () => {
		const root = mkdtempSync(join(tmpdir(), "ade-codex-auth-"));
		tempRoots.push(root);
		const sharedAuth = join(root, "global", "auth.json");
		const codexHome = join(root, "agent", ".codex");
		const agentAuth = join(codexHome, "auth.json");
		mkdirSync(join(root, "global"), { recursive: true });
		writeFileSync(sharedAuth, '{"token":"test-only"}');

		syncSharedCodexAuth(codexHome, {
			platform: "win32",
			sharedAuthPath: sharedAuth,
		});
		expect(readFileSync(agentAuth, "utf8")).toContain("test-only");

		rmSync(sharedAuth);
		syncSharedCodexAuth(codexHome, {
			platform: "win32",
			sharedAuthPath: sharedAuth,
		});
		expect(existsSync(agentAuth)).toBe(false);
	});
});
