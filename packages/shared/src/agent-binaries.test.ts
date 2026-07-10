import { describe, expect, it } from "bun:test";
import {
	BINARY_INSTALL,
	CHECKED_BINARIES,
	getBinaryInstallInfo,
	RUNTIME_BINARY,
} from "./agent-binaries";
import { AGENT_TYPES } from "./agent-command";

describe("agent-binaries", () => {
	it("maps every agent runtime to a binary that has install info", () => {
		for (const type of AGENT_TYPES) {
			const binary = RUNTIME_BINARY[type];
			expect(binary).toBeDefined();
			expect(BINARY_INSTALL[binary]).toBeDefined();
		}
	});

	it("routes the OpenRouter-proxied runtimes through the claude CLI", () => {
		expect(RUNTIME_BINARY.kimi).toBe("claude");
		expect(RUNTIME_BINARY.minimax).toBe("claude");
		expect(RUNTIME_BINARY.glm).toBe("claude");
	});

	it("uses the minimal Codex runner by default for custom model providers", () => {
		expect(RUNTIME_BINARY.huggingface).toBe("codex");
		expect(RUNTIME_BINARY.ollama).toBe("codex");
	});

	it("gives every checked binary a copy-pasteable command and URL", () => {
		for (const binary of CHECKED_BINARIES) {
			const info = BINARY_INSTALL[binary];
			expect(info.command.length).toBeGreaterThan(0);
			expect(info.url.startsWith("https://")).toBe(true);
		}
	});

	it("uses platform-correct Git installation commands", () => {
		expect(getBinaryInstallInfo("git", "win32").command).toContain("winget");
		expect(getBinaryInstallInfo("git", "darwin").command).toBe(
			"xcode-select --install",
		);
	});

	it("does not offer the Unix Cursor installer in a Windows shell", () => {
		const info = getBinaryInstallInfo("cursor-agent", "win32");
		expect(info.command).toStartWith("Start-Process");
		expect(info.command).not.toContain("| bash");
		expect(info.note).toContain("cursor-agent.cmd");
	});
});
