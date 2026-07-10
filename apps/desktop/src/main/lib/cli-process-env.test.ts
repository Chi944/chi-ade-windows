import { describe, expect, it } from "bun:test";
import { buildCliProcessEnvironment } from "./cli-process-env";

describe("CLI probe environment", () => {
	it("keeps runtime paths and selected homes but strips unrelated secrets", () => {
		const env = buildCliProcessEnvironment(
			{ CODEX_HOME: "C:\\ADE\\codex-profile" },
			{
				Path: "C:\\Windows\\System32",
				SystemRoot: "C:\\Windows",
				HOME: "/home/user",
				HTTPS_PROXY: "http://proxy.local",
				GH_TOKEN: "secret",
				OPENAI_API_KEY: "secret",
				DATABASE_URL: "secret",
				NODE_OPTIONS: "--require malicious.js",
			},
		);

		expect(env.Path).toBe("C:\\Windows\\System32");
		expect(env.SystemRoot).toBe("C:\\Windows");
		expect(env.CODEX_HOME).toBe("C:\\ADE\\codex-profile");
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.NODE_OPTIONS).toBeUndefined();
	});
});
