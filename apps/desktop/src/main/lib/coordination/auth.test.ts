import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getCoordinationTokenPath,
	getInternalCoordinationToken,
	getWorkspaceCoordinationToken,
	isValidInternalCoordinationToken,
	isValidWorkspaceCoordinationToken,
	resetCoordinationAuthForTests,
} from "./auth";

const originalHome = process.env.ADE_HOME_DIR;
const testHome = join(tmpdir(), `ade-coordination-auth-${process.pid}`);

afterEach(() => {
	resetCoordinationAuthForTests();
	if (originalHome === undefined) delete process.env.ADE_HOME_DIR;
	else process.env.ADE_HOME_DIR = originalHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("coordination auth", () => {
	it("persists one private internal token and derives scoped capabilities", () => {
		process.env.ADE_HOME_DIR = testHome;
		mkdirSync(testHome, { recursive: true });

		const internal = getInternalCoordinationToken();
		const workspaceA = getWorkspaceCoordinationToken("workspace-a");
		const workspaceB = getWorkspaceCoordinationToken("workspace-b");

		expect(internal).toMatch(/^[a-f0-9]{64}$/);
		expect(readFileSync(getCoordinationTokenPath(), "utf8").trim()).toBe(
			internal,
		);
		expect(workspaceA).not.toBe(workspaceB);
		expect(workspaceA).not.toBe(internal);
		expect(isValidInternalCoordinationToken(internal)).toBe(true);
		expect(isValidWorkspaceCoordinationToken("workspace-a", workspaceA)).toBe(
			true,
		);
		expect(isValidWorkspaceCoordinationToken("workspace-b", workspaceA)).toBe(
			false,
		);

		if (process.platform !== "win32") {
			expect(statSync(getCoordinationTokenPath()).mode & 0o777).toBe(0o600);
		}
	});
});
