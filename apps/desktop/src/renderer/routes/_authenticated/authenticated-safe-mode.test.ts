import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getAuthenticatedLayoutMode } from "./safe-recovery-mode";

describe("authenticated safe recovery subtree", () => {
	test("selects the minimal layout only for the exact main-process flag", () => {
		expect(getAuthenticatedLayoutMode("?adeSafeRecovery=1")).toBe("safe");
		expect(getAuthenticatedLayoutMode("")).toBe("normal");
		expect(getAuthenticatedLayoutMode("?adeSafeRecovery=true")).toBe("normal");
	});

	test("safe layout source cannot mount updater, agent, sync, or workspace terminal effects", () => {
		const source = readFileSync(
			new URL("./layout.tsx", import.meta.url),
			"utf8",
		);
		const safeStart = source.indexOf("function SafeRecoveryLayout");
		const normalStart = source.indexOf("function NormalAuthenticatedLayout");
		expect(safeStart).toBeGreaterThan(-1);
		expect(normalStart).toBeGreaterThan(safeStart);
		const safeSource = source.slice(safeStart, normalStart);
		for (const forbidden of [
			"useAgentHookListener",
			"useUpdateListener",
			"useTabsSyncSubscription",
			"WorkspaceInitEffects",
			"AgentHooks",
			"NewAgentModal",
			"NewCategoryModal",
			"InitGitDialog",
			"CollectionsProvider",
			"DndProvider",
		]) {
			expect(safeSource).not.toContain(forbidden);
		}
		expect(safeSource).toContain('to="/settings/health"');
		expect(safeSource).toContain("<Outlet />");
	});
});
