import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type Severity = "low" | "moderate" | "high" | "critical";
type BlockingSeverity = Extract<Severity, "high" | "critical">;

export interface AuditFindingResult {
	key: string;
	package: string;
	advisoryId: number;
	severity: Severity;
	title: string;
	vulnerableVersions: string;
}

export interface ProductionDependencyInstance {
	package: string;
	version: string;
	dependencyPath: string;
	shippingTargets: string[];
}

export interface ProductionAuditResult {
	ok: boolean;
	counts: {
		critical: number;
		high: number;
		moderate: number;
		low: number;
	};
	excepted: AuditFindingResult[];
	unexcepted: AuditFindingResult[];
	policyErrors: string[];
	staleExceptions: string[];
}

interface ValidException {
	key: string;
	package: string;
	advisoryId: number;
	severity: BlockingSeverity;
	evidenceSet: string;
}

interface ValidEvidenceSet {
	key: string;
	package: string;
	instanceCount: number;
	runtimeInstanceCount: number;
	versions: string[];
	shippingTargets: string[];
	instancesSha256: string;
}

export type DependencyEvidence = Omit<ValidEvidenceSet, "key" | "package">;

const severityOrder: Record<Severity, number> = {
	critical: 0,
	high: 1,
	moderate: 2,
	low: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function findingKey(
	packageName: string,
	advisoryId: number,
	severity: Severity,
): string {
	return `${packageName}#${advisoryId} (${severity})`;
}

function parseAuditFindings(
	audit: unknown,
	errors: string[],
): AuditFindingResult[] {
	if (!isRecord(audit)) {
		errors.push("Audit output must be a JSON object keyed by package name.");
		return [];
	}

	const findings: AuditFindingResult[] = [];
	for (const packageName of Object.keys(audit).sort(compareText)) {
		const entries = audit[packageName];
		if (packageName.trim() === "" || !Array.isArray(entries)) {
			errors.push(
				`Audit package ${JSON.stringify(packageName)} must contain an array.`,
			);
			continue;
		}

		for (const [index, entry] of entries.entries()) {
			if (!isRecord(entry)) {
				errors.push(`${packageName}[${index}] must be an advisory object.`);
				continue;
			}
			const {
				id,
				severity,
				title,
				vulnerable_versions: vulnerableVersions,
			} = entry;
			if (!Number.isSafeInteger(id) || (id as number) <= 0) {
				errors.push(`${packageName}[${index}].id must be a positive integer.`);
				continue;
			}
			if (
				severity !== "low" &&
				severity !== "moderate" &&
				severity !== "high" &&
				severity !== "critical"
			) {
				errors.push(`${packageName}[${index}].severity is invalid.`);
				continue;
			}
			if (typeof title !== "string" || title.trim() === "") {
				errors.push(`${packageName}[${index}].title must be non-empty.`);
				continue;
			}
			if (
				typeof vulnerableVersions !== "string" ||
				vulnerableVersions.trim() === ""
			) {
				errors.push(
					`${packageName}[${index}].vulnerable_versions must be non-empty.`,
				);
				continue;
			}

			findings.push({
				key: findingKey(packageName, id as number, severity),
				package: packageName,
				advisoryId: id as number,
				severity,
				title: title.trim(),
				vulnerableVersions: vulnerableVersions.trim(),
			});
		}
	}

	return findings.sort((left, right) => {
		return (
			compareText(left.package, right.package) ||
			left.advisoryId - right.advisoryId ||
			severityOrder[left.severity] - severityOrder[right.severity]
		);
	});
}

function utcDay(date: Date): number {
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function parseDateOnly(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return undefined;
	}
	const [year, month, day] = value.split("-").map(Number);
	const timestamp = Date.UTC(year, month - 1, day);
	const parsed = new Date(timestamp);
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() !== month - 1 ||
		parsed.getUTCDate() !== day
	) {
		return undefined;
	}
	return timestamp;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isHttpsUrl(value: unknown): boolean {
	if (!isNonEmptyString(value)) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

function isExactSemver(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
	);
}

function compareInstances(
	left: ProductionDependencyInstance,
	right: ProductionDependencyInstance,
): number {
	return (
		compareText(left.package, right.package) ||
		compareText(left.version, right.version) ||
		compareText(left.dependencyPath, right.dependencyPath) ||
		compareText(
			left.shippingTargets.join("\0"),
			right.shippingTargets.join("\0"),
		)
	);
}

export function summarizeDependencyEvidence(
	instances: ProductionDependencyInstance[],
): DependencyEvidence {
	const canonical = instances
		.map((instance) => ({
			...instance,
			shippingTargets: [...instance.shippingTargets].sort(compareText),
		}))
		.sort(compareInstances);
	return {
		instanceCount: canonical.length,
		runtimeInstanceCount: canonical.filter(
			(instance) => instance.shippingTargets.length > 0,
		).length,
		versions: [...new Set(canonical.map((instance) => instance.version))].sort(
			compareText,
		),
		shippingTargets: [
			...new Set(canonical.flatMap((instance) => instance.shippingTargets)),
		].sort(compareText),
		instancesSha256: createHash("sha256")
			.update(JSON.stringify(canonical))
			.digest("hex"),
	};
}

function parseEvidenceSets(
	policy: Record<string, unknown>,
	errors: string[],
): Map<string, ValidEvidenceSet> {
	if (!isRecord(policy.evidenceSets)) {
		errors.push("Audit policy evidenceSets must be an object.");
		return new Map();
	}

	const evidenceSets = new Map<string, ValidEvidenceSet>();
	for (const key of Object.keys(policy.evidenceSets).sort(compareText)) {
		const label = `evidenceSets[${JSON.stringify(key)}]`;
		const entry = policy.evidenceSets[key];
		if (key.trim() === "" || !isRecord(entry)) {
			errors.push(`${label} must be a named object.`);
			continue;
		}
		if (!isNonEmptyString(entry.package)) {
			errors.push(`${label} must have a package.`);
			continue;
		}

		const packageName = entry.package.trim();
		const versions = entry.versions;
		const targets = entry.shippingTargets;
		const validVersions =
			Array.isArray(versions) && versions.every(isExactSemver);
		const validTargets =
			Array.isArray(targets) && targets.every(isNonEmptyString);
		const sortedVersions = validVersions
			? [...new Set(versions)].sort(compareText)
			: [];
		const sortedTargets = validTargets
			? [...new Set(targets.map((target) => target.trim()))].sort(compareText)
			: [];
		const valid =
			Number.isSafeInteger(entry.instanceCount) &&
			(entry.instanceCount as number) > 0 &&
			Number.isSafeInteger(entry.runtimeInstanceCount) &&
			(entry.runtimeInstanceCount as number) >= 0 &&
			(entry.runtimeInstanceCount as number) <=
				(entry.instanceCount as number) &&
			validVersions &&
			sortedVersions.length > 0 &&
			JSON.stringify(versions) === JSON.stringify(sortedVersions) &&
			validTargets &&
			JSON.stringify(targets) === JSON.stringify(sortedTargets) &&
			typeof entry.instancesSha256 === "string" &&
			/^[0-9a-f]{64}$/.test(entry.instancesSha256);
		if (!valid) {
			errors.push(
				`${label} must contain deterministic instanceCount, runtimeInstanceCount, versions, shippingTargets, and instancesSha256 evidence.`,
			);
		} else {
			evidenceSets.set(key, {
				key,
				package: packageName,
				instanceCount: entry.instanceCount as number,
				runtimeInstanceCount: entry.runtimeInstanceCount as number,
				versions: sortedVersions,
				shippingTargets: sortedTargets,
				instancesSha256: entry.instancesSha256 as string,
			});
		}
	}

	return evidenceSets;
}

function parsePolicyExceptions(
	policy: unknown,
	now: Date,
	errors: string[],
): {
	exceptions: ValidException[];
	evidenceSets: Map<string, ValidEvidenceSet>;
} {
	if (!isRecord(policy)) {
		errors.push("Audit policy must be a JSON object.");
		return { exceptions: [], evidenceSets: new Map() };
	}
	if (policy.schemaVersion !== 2) {
		errors.push("Audit policy schemaVersion must be 2.");
	}
	const evidenceSets = parseEvidenceSets(policy, errors);
	if (!Array.isArray(policy.exceptions)) {
		errors.push("Audit policy exceptions must be an array.");
		return { exceptions: [], evidenceSets };
	}

	const valid: ValidException[] = [];
	const seen = new Set<string>();
	const today = utcDay(now);
	const maxExpiry = today + 30 * 24 * 60 * 60 * 1000;

	for (const [index, entry] of policy.exceptions.entries()) {
		const label = `exceptions[${index}]`;
		if (!isRecord(entry)) {
			errors.push(`${label} must be an object.`);
			continue;
		}

		const entryErrors: string[] = [];
		if (!isNonEmptyString(entry.package)) entryErrors.push("package");
		if (
			!Number.isSafeInteger(entry.advisoryId) ||
			(entry.advisoryId as number) <= 0
		) {
			entryErrors.push("advisoryId");
		}
		if (entry.severity !== "high" && entry.severity !== "critical") {
			entryErrors.push("severity");
		}
		if (entry.owner !== "Chi944") {
			entryErrors.push('owner (must be "Chi944")');
		}
		if (!isNonEmptyString(entry.scope)) entryErrors.push("scope");
		if (!isNonEmptyString(entry.rationale)) entryErrors.push("rationale");
		if (!isHttpsUrl(entry.upstream)) entryErrors.push("upstream (HTTPS URL)");
		if (!isNonEmptyString(entry.evidenceSet)) entryErrors.push("evidenceSet");

		const expiresOn = parseDateOnly(entry.expiresOn);
		if (expiresOn === undefined) {
			entryErrors.push("expiresOn (YYYY-MM-DD)");
		} else if (expiresOn < today) {
			entryErrors.push("expiresOn is expired");
		} else if (expiresOn > maxExpiry) {
			entryErrors.push("expiresOn must be within 30 days");
		}

		if (entryErrors.length > 0) {
			errors.push(`${label} has invalid ${entryErrors.join(", ")}.`);
			continue;
		}

		const packageName = (entry.package as string).trim();
		const advisoryId = entry.advisoryId as number;
		const severity = entry.severity as BlockingSeverity;
		const key = findingKey(packageName, advisoryId, severity);
		const evidenceSet = (entry.evidenceSet as string).trim();
		const evidence = evidenceSets.get(evidenceSet);
		if (!evidence) {
			errors.push(`${label} references unknown or invalid ${evidenceSet}.`);
			continue;
		}
		if (evidence.package !== packageName) {
			errors.push(
				`${label} package ${packageName} does not match evidence set ${evidenceSet}.`,
			);
			continue;
		}
		if (seen.has(key)) {
			errors.push(`${label} duplicates ${key}.`);
			continue;
		}
		seen.add(key);
		valid.push({
			key,
			package: packageName,
			advisoryId,
			severity,
			evidenceSet,
		});
	}

	return {
		exceptions: valid.sort((left, right) => compareText(left.key, right.key)),
		evidenceSets,
	};
}

interface LockPackageNode {
	package: string;
	version: string;
	dependencies: string[];
	optionalDependencies: string[];
}

function dependencyNames(value: unknown): string[] {
	if (!isRecord(value)) return [];
	return Object.keys(value).sort(compareText);
}

function parseResolvedPackage(value: unknown): {
	package: string;
	version: string;
} {
	if (typeof value !== "string") {
		throw new Error("A bun.lock package resolution is not a string.");
	}
	const separator = value.lastIndexOf("@");
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error(`Cannot parse bun.lock package resolution ${value}.`);
	}
	return {
		package: value.slice(0, separator),
		version: value.slice(separator + 1),
	};
}

/**
 * Builds a package inventory from Bun's lockfile. Every physical lock path is
 * annotated with each apps/* production workspace that can reach it; an empty
 * target list means the installed copy is build/test-only in this repository.
 * This makes exception scope independent from human-written policy prose.
 */
export function buildProductionDependencyInventory(
	lockfile: unknown,
): ProductionDependencyInstance[] {
	if (!isRecord(lockfile) || !isRecord(lockfile.workspaces)) {
		throw new Error("bun.lock must contain a workspaces object.");
	}
	if (!isRecord(lockfile.packages)) {
		throw new Error("bun.lock must contain a packages object.");
	}

	const workspaces = lockfile.workspaces;
	const packages = new Map<string, LockPackageNode>();
	for (const dependencyPath of Object.keys(lockfile.packages)) {
		const entry = lockfile.packages[dependencyPath];
		if (
			Array.isArray(entry) &&
			entry.length === 1 &&
			typeof entry[0] === "string" &&
			entry[0].includes("@workspace:")
		) {
			continue;
		}
		const metadata = Array.isArray(entry)
			? isRecord(entry[2])
				? entry[2]
				: isRecord(entry[1])
					? entry[1]
					: undefined
			: undefined;
		if (!Array.isArray(entry) || !metadata) {
			throw new Error(`bun.lock package ${dependencyPath} is malformed.`);
		}
		const resolved = parseResolvedPackage(entry[0]);
		packages.set(dependencyPath, {
			...resolved,
			dependencies: dependencyNames(metadata.dependencies),
			optionalDependencies: dependencyNames(metadata.optionalDependencies),
		});
	}

	const workspaceByPackage = new Map<string, string>();
	for (const workspacePath of Object.keys(workspaces)) {
		const workspace = workspaces[workspacePath];
		if (isRecord(workspace) && isNonEmptyString(workspace.name)) {
			workspaceByPackage.set(workspace.name.trim(), workspacePath);
		}
	}

	const shippingTargets = Object.keys(workspaces)
		.filter((workspacePath) => /^apps\/[A-Za-z0-9._-]+$/.test(workspacePath))
		.sort(compareText);
	if (shippingTargets.length === 0) {
		throw new Error("bun.lock does not define any apps/* shipping targets.");
	}

	const parentCache = new Map<string, string | undefined>();
	function parentPackagePath(dependencyPath: string): string | undefined {
		if (parentCache.has(dependencyPath)) return parentCache.get(dependencyPath);
		let slash = dependencyPath.lastIndexOf("/");
		while (slash > 0) {
			const candidate = dependencyPath.slice(0, slash);
			if (packages.has(candidate)) {
				parentCache.set(dependencyPath, candidate);
				return candidate;
			}
			slash = dependencyPath.lastIndexOf("/", slash - 1);
		}
		parentCache.set(dependencyPath, undefined);
		return undefined;
	}

	function resolvePackagePath(
		fromPath: string | undefined,
		dependencyName: string,
	): string | undefined {
		let scope = fromPath;
		while (scope) {
			const nested = `${scope}/${dependencyName}`;
			if (packages.has(nested)) return nested;
			scope = parentPackagePath(scope);
		}
		return packages.has(dependencyName) ? dependencyName : undefined;
	}

	const targetsByPath = new Map<string, Set<string>>();
	for (const shippingTarget of shippingTargets) {
		const visitedPackages = new Set<string>();
		const visitedWorkspaces = new Set<string>();

		function visitDependencies(
			dependencyList: string[],
			fromPath: string | undefined,
		): void {
			for (const dependencyName of dependencyList) {
				const workspacePath = workspaceByPackage.get(dependencyName);
				if (workspacePath) {
					visitWorkspace(workspacePath);
					continue;
				}
				const dependencyPath = resolvePackagePath(fromPath, dependencyName);
				if (dependencyPath) visitPackage(dependencyPath);
			}
		}

		function visitWorkspace(workspacePath: string): void {
			if (visitedWorkspaces.has(workspacePath)) return;
			visitedWorkspaces.add(workspacePath);
			const workspace = workspaces[workspacePath];
			if (!isRecord(workspace)) {
				throw new Error(`bun.lock workspace ${workspacePath} is malformed.`);
			}
			visitDependencies(dependencyNames(workspace.dependencies), undefined);
			visitDependencies(
				dependencyNames(workspace.optionalDependencies),
				undefined,
			);
		}

		function visitPackage(dependencyPath: string): void {
			if (visitedPackages.has(dependencyPath)) return;
			visitedPackages.add(dependencyPath);
			const node = packages.get(dependencyPath);
			if (!node) return;
			const targets = targetsByPath.get(dependencyPath) ?? new Set<string>();
			targets.add(shippingTarget);
			targetsByPath.set(dependencyPath, targets);
			visitDependencies(node.dependencies, dependencyPath);
			visitDependencies(node.optionalDependencies, dependencyPath);
		}

		visitWorkspace(shippingTarget);
	}

	const inventory: ProductionDependencyInstance[] = [];
	for (const [dependencyPath, node] of packages) {
		if (!isExactSemver(node.version)) continue;
		inventory.push({
			package: node.package,
			version: node.version,
			dependencyPath,
			shippingTargets: [...(targetsByPath.get(dependencyPath) ?? [])].sort(
				compareText,
			),
		});
	}
	return inventory.sort(compareInstances);
}

export function evaluateProductionAudit(
	audit: unknown,
	policy: unknown,
	inventory: ProductionDependencyInstance[],
	now = new Date(),
): ProductionAuditResult {
	const policyErrors: string[] = [];
	const findings = parseAuditFindings(audit, policyErrors);
	const { exceptions, evidenceSets } = parsePolicyExceptions(
		policy,
		now,
		policyErrors,
	);
	const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
	for (const finding of findings) counts[finding.severity] += 1;

	const blocking = findings.filter(
		(finding) => finding.severity === "high" || finding.severity === "critical",
	);
	const exceptionByKey = new Map(
		exceptions.map((exception) => [exception.key, exception]),
	);
	const matchedExceptionKeys = new Set<string>();
	for (const finding of blocking) {
		const exception = exceptionByKey.get(finding.key);
		if (!exception) continue;
		const evidence = evidenceSets.get(exception.evidenceSet);
		if (!evidence) continue;

		let matchingInstances: ProductionDependencyInstance[];
		try {
			matchingInstances = inventory
				.filter(
					(instance) =>
						instance.package === finding.package &&
						Bun.semver.satisfies(instance.version, finding.vulnerableVersions),
				)
				.sort(compareInstances);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			policyErrors.push(
				`${finding.key} has an invalid vulnerable version range: ${detail}`,
			);
			continue;
		}

		const actualEvidence = summarizeDependencyEvidence(matchingInstances);
		const policyEvidence: DependencyEvidence = {
			instanceCount: evidence.instanceCount,
			runtimeInstanceCount: evidence.runtimeInstanceCount,
			versions: evidence.versions,
			shippingTargets: evidence.shippingTargets,
			instancesSha256: evidence.instancesSha256,
		};
		if (JSON.stringify(actualEvidence) !== JSON.stringify(policyEvidence)) {
			policyErrors.push(
				`${finding.key} evidence set ${exception.evidenceSet} does not exactly match the vulnerable production dependency instances (policy=${evidence.instanceCount}, lockfile=${matchingInstances.length}).`,
			);
			continue;
		}
		matchedExceptionKeys.add(finding.key);
	}

	const blockingKeys = new Set(blocking.map(({ key }) => key));
	const excepted = blocking.filter(({ key }) => matchedExceptionKeys.has(key));
	const unexcepted = blocking.filter(
		({ key }) => !matchedExceptionKeys.has(key),
	);
	const staleExceptions = exceptions
		.filter(({ key }) => !blockingKeys.has(key))
		.map(({ key }) => key);

	return {
		ok:
			unexcepted.length === 0 &&
			policyErrors.length === 0 &&
			staleExceptions.length === 0,
		counts,
		excepted,
		unexcepted,
		policyErrors: policyErrors.sort(compareText),
		staleExceptions,
	};
}

export function renderAuditSummary(result: ProductionAuditResult): string {
	const lines = [
		`Production dependency audit: ${result.ok ? "PASS" : "FAIL"}`,
		`Findings: critical=${result.counts.critical}, high=${result.counts.high}, moderate=${result.counts.moderate}, low=${result.counts.low}`,
		`Excepted high/critical: ${result.excepted.length}`,
	];

	if (result.unexcepted.length > 0) {
		lines.push(
			"Unexcepted high/critical:",
			...result.unexcepted.map(({ key, title }) => `- ${key}: ${title}`),
		);
	}
	if (result.staleExceptions.length > 0) {
		lines.push(
			"Stale exceptions:",
			...result.staleExceptions.map((key) => `- ${key}`),
		);
	}
	if (result.policyErrors.length > 0) {
		lines.push(
			"Policy/input errors:",
			...result.policyErrors.map((error) => `- ${error}`),
		);
	}

	return lines.join("\n");
}

function parseJson(source: string, label: string): unknown {
	try {
		return JSON.parse(source);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${label} is not valid JSON: ${detail}`);
	}
}

function run(): number {
	const audit = spawnSync(
		process.execPath,
		["audit", "--production", "--json"],
		{
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
		},
	);
	if (audit.error) throw audit.error;
	if (audit.status !== 0 && audit.status !== 1) {
		throw new Error(
			`bun audit failed with exit code ${audit.status ?? "unknown"}: ${audit.stderr.trim()}`,
		);
	}

	const auditOutput = parseJson(audit.stdout.trim(), "bun audit output");
	const policyPath = new URL(
		"../.github/dependency-audit-policy.json",
		import.meta.url,
	);
	const policy = parseJson(
		readFileSync(policyPath, "utf8"),
		"dependency audit policy",
	);
	const lockfilePath = new URL("../bun.lock", import.meta.url);
	const lockfile = Bun.JSONC.parse(readFileSync(lockfilePath, "utf8"));
	const inventory = buildProductionDependencyInventory(lockfile);
	const result = evaluateProductionAudit(auditOutput, policy, inventory);
	console.log(renderAuditSummary(result));
	return result.ok ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exitCode = run();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
