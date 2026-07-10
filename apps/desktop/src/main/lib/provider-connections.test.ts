import { describe, expect, it } from "bun:test";
import { probeSubscriptionConnections } from "./provider-connections";

describe("probeSubscriptionConnections", () => {
	it("returns sanitized installed/authenticated booleans", async () => {
		const calls: Array<{ binary: string; args: string[] }> = [];
		const result = await probeSubscriptionConnections({
			findBinaries: (name) => [`C:\\bin\\${name}.cmd`],
			runStatus: async (binary, args) => {
				calls.push({ binary, args });
				return args[0] === "--version" || binary.includes("claude");
			},
		});

		expect(result).toEqual({
			claude: { installed: true, authenticated: true },
			codex: { installed: true, authenticated: false },
		});
		expect(calls).toContainEqual({
			binary: "C:\\bin\\claude.cmd",
			args: ["auth", "status"],
		});
		expect(calls).toContainEqual({
			binary: "C:\\bin\\codex.cmd",
			args: ["login", "status"],
		});
	});

	it("skips an inaccessible alias and uses a later working binary", async () => {
		const result = await probeSubscriptionConnections({
			findBinaries: (name) =>
				name === "codex" ? ["windows-app-alias", "npm-codex.cmd"] : [],
			runStatus: async (binary, args) =>
				binary === "npm-codex.cmd" &&
				(args[0] === "--version" || args[0] === "login"),
		});

		expect(result.codex).toEqual({ installed: true, authenticated: true });
	});

	it("never authenticates a missing or non-runnable binary", async () => {
		let authRuns = 0;
		const result = await probeSubscriptionConnections({
			findBinaries: (name) => (name === "codex" ? ["broken-alias"] : []),
			runStatus: async (_binary, args) => {
				if (args[0] !== "--version") authRuns += 1;
				return false;
			},
		});

		expect(authRuns).toBe(0);
		expect(result.codex).toEqual({ installed: false, authenticated: false });
	});
});
