import { describe, expect, test } from "bun:test";
import {
	buildProductionDependencyInventory,
	evaluateProductionAudit,
	type ProductionDependencyInstance,
	renderAuditSummary,
	summarizeDependencyEvidence,
} from "./verify-production-audit";

const NOW = new Date("2026-07-16T12:00:00.000Z");

function finding(
	id: number,
	severity: "low" | "moderate" | "high" | "critical",
	title = `advisory ${id}`,
) {
	return {
		id,
		severity,
		title,
		url: `https://github.com/advisories/GHSA-test-${id}`,
		vulnerable_versions: "<99.0.0",
	};
}

function exception(
	overrides: Partial<{
		package: string;
		advisoryId: number;
		severity: "high" | "critical";
		owner: string;
		expiresOn: string;
		scope: string;
		rationale: string;
		upstream: string;
		evidenceSet: string;
	}> = {},
) {
	return {
		package: "minimatch",
		advisoryId: 1001,
		severity: "high" as const,
		owner: "Chi944",
		expiresOn: "2026-08-15",
		scope:
			"Build-only dependency excluded from every packaged desktop artifact.",
		rationale: "No untrusted patterns reach this build-time dependency.",
		upstream: "https://github.com/isaacs/minimatch/issues/1135",
		evidenceSet: "minimatch-1001",
		...overrides,
	};
}

function instance(
	overrides: Partial<ProductionDependencyInstance> = {},
): ProductionDependencyInstance {
	return {
		package: "minimatch",
		version: "1.0.0",
		dependencyPath: "tooling/minimatch",
		shippingTargets: ["apps/desktop"],
		...overrides,
	};
}

function evidence(instances: ProductionDependencyInstance[]) {
	return {
		package: instances[0]?.package ?? "minimatch",
		...summarizeDependencyEvidence(instances),
	};
}

function policy(
	exceptions: unknown[] = [],
	evidenceSets: Record<string, unknown> = {
		"minimatch-1001": evidence([instance()]),
	},
) {
	return { schemaVersion: 2, evidenceSets, exceptions };
}

function inventoryFor(audit: Record<string, ReturnType<typeof finding>[]>) {
	return Object.keys(audit).map((packageName) =>
		instance({
			package: packageName,
			dependencyPath: `${packageName}/instance`,
		}),
	);
}

describe("production dependency audit policy", () => {
	test("derives shipping targets from exact Bun lock dependency paths", () => {
		const inventory = buildProductionDependencyInventory({
			workspaces: {
				"apps/desktop": { name: "@ade/desktop", dependencies: {} },
				"apps/web": {
					name: "@superset/web",
					dependencies: { runtime: "1.0.0" },
				},
			},
			packages: {
				runtime: [
					"runtime@1.0.0",
					"",
					{ dependencies: { minimatch: "9.0.5" } },
				],
				"runtime/minimatch": ["minimatch@9.0.5", "", {}],
				tooling: [
					"tooling@1.0.0",
					"",
					{ dependencies: { minimatch: "9.0.5" } },
				],
				"tooling/minimatch": ["minimatch@9.0.5", "", {}],
			},
		});

		expect(inventory.filter((entry) => entry.package === "minimatch")).toEqual([
			instance({
				version: "9.0.5",
				dependencyPath: "runtime/minimatch",
				shippingTargets: ["apps/web"],
			}),
			instance({
				version: "9.0.5",
				dependencyPath: "tooling/minimatch",
				shippingTargets: [],
			}),
		]);
	});

	test("fails unexcepted high and critical findings but not lower severities", () => {
		const audit = {
			alpha: [finding(3, "moderate")],
			minimatch: [finding(1001, "high")],
			omega: [finding(9, "critical")],
		};
		const result = evaluateProductionAudit(
			audit,
			policy(),
			inventoryFor(audit),
			NOW,
		);

		expect(result.ok).toBe(false);
		expect(result.counts).toEqual({
			critical: 1,
			high: 1,
			moderate: 1,
			low: 0,
		});
		expect(result.unexcepted.map(({ key }) => key)).toEqual([
			"minimatch#1001 (high)",
			"omega#9 (critical)",
		]);
	});

	test("accepts only an exact, scoped, unexpired exception", () => {
		const result = evaluateProductionAudit(
			{ minimatch: [finding(1001, "high")] },
			policy([exception()], {
				"minimatch-1001": evidence([instance()]),
			}),
			[instance()],
			NOW,
		);

		expect(result.ok).toBe(true);
		expect(result.excepted.map(({ key }) => key)).toEqual([
			"minimatch#1001 (high)",
		]);
		expect(result.policyErrors).toEqual([]);
		expect(result.staleExceptions).toEqual([]);
	});

	test("does not allow one advisory exception to cover a new advisory", () => {
		const result = evaluateProductionAudit(
			{ minimatch: [finding(1002, "high")] },
			policy([exception()]),
			[instance()],
			NOW,
		);

		expect(result.ok).toBe(false);
		expect(result.unexcepted.map(({ key }) => key)).toEqual([
			"minimatch#1002 (high)",
		]);
		expect(result.staleExceptions).toEqual(["minimatch#1001 (high)"]);
	});

	test("an existing exception cannot cover a newly introduced runtime dependency path", () => {
		const approved = instance({
			version: "9.0.5",
			dependencyPath: "@sentry/node/minimatch",
			shippingTargets: ["apps/admin", "apps/web"],
		});
		const newlyIntroduced = instance({
			version: "9.0.5",
			dependencyPath: "runtime-plugin/minimatch",
			shippingTargets: ["apps/desktop"],
		});
		const scopedPolicy = policy([exception()], {
			"minimatch-1001": evidence([approved]),
		});

		const result = evaluateProductionAudit(
			{ minimatch: [finding(1001, "high")] },
			scopedPolicy,
			[approved, newlyIntroduced],
			NOW,
		);

		expect(result.ok).toBe(false);
		expect(result.unexcepted.map(({ key }) => key)).toEqual([
			"minimatch#1001 (high)",
		]);
		expect(result.policyErrors.join("\n")).toContain(
			"does not exactly match the vulnerable production dependency instances",
		);
	});

	test.each([
		["expired", { expiresOn: "2026-07-15" }, "is expired"],
		["longer than 30 days", { expiresOn: "2026-08-16" }, "within 30 days"],
		["blank owner", { owner: "  " }, "owner"],
		["different owner", { owner: "another-user" }, "Chi944"],
		["blank scope", { scope: "" }, "scope"],
		["blank rationale", { rationale: "" }, "rationale"],
		[
			"non-HTTPS upstream",
			{ upstream: "http://example.test/issue" },
			"upstream",
		],
	] as const)("rejects a malformed exception: %s", (_name, overrides, message) => {
		const result = evaluateProductionAudit(
			{ minimatch: [finding(1001, "high")] },
			policy([exception(overrides)]),
			[instance()],
			NOW,
		);

		expect(result.ok).toBe(false);
		expect(result.policyErrors.join("\n")).toContain(message);
		expect(result.unexcepted.map(({ key }) => key)).toEqual([
			"minimatch#1001 (high)",
		]);
	});

	test("a severity downgrade cannot broaden an existing exception", () => {
		const result = evaluateProductionAudit(
			{ minimatch: [finding(1001, "moderate")] },
			policy([exception()]),
			[instance()],
			NOW,
		);

		expect(result.ok).toBe(false);
		expect(result.unexcepted).toEqual([]);
		expect(result.staleExceptions).toEqual(["minimatch#1001 (high)"]);
	});

	test("fails stale exceptions after an advisory is fixed", () => {
		const result = evaluateProductionAudit(
			{},
			policy([exception()]),
			[instance()],
			NOW,
		);

		expect(result.ok).toBe(false);
		expect(result.staleExceptions).toEqual(["minimatch#1001 (high)"]);
	});

	test("renders a deterministic summary regardless of audit input order", () => {
		const firstAudit = {
			zeta: [finding(9, "critical", "last package")],
			alpha: [finding(7, "high", "first package")],
		};
		const first = evaluateProductionAudit(
			firstAudit,
			policy(),
			inventoryFor(firstAudit),
			NOW,
		);
		const secondAudit = {
			alpha: [finding(7, "high", "first package")],
			zeta: [finding(9, "critical", "last package")],
		};
		const second = evaluateProductionAudit(
			secondAudit,
			policy(),
			inventoryFor(secondAudit),
			NOW,
		);

		expect(renderAuditSummary(first)).toBe(renderAuditSummary(second));
		expect(renderAuditSummary(first)).toContain(
			"- alpha#7 (high): first package\n- zeta#9 (critical): last package",
		);
	});
});
