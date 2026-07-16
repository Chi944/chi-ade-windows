import { createHash } from "node:crypto";
import {
	PERSONAL_UPDATE_MANIFEST_URL,
	parsePersonalUpdateManifest,
	selectPersonalUpdateAsset,
} from "shared/personal-update";
import { MAX_CRASH_DUMP_BYTES, MAX_CRASH_DUMP_COUNT } from "./crash-storage";
import {
	MAX_COMPLETED_INSTALLER_BYTES,
	MAX_COMPLETED_INSTALLER_VERSIONS,
} from "./update-storage-health";

export type HealthNetworkFetch = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;

export async function fetchHealthUpdateManifest(options: {
	fetch: HealthNetworkFetch;
	timeoutMs?: number;
}): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("Health network timeout must be a positive safe integer");
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await options.fetch(PERSONAL_UPDATE_MANIFEST_URL, {
			cache: "no-store",
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return {};
		const text = await response.text();
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return {};
		}
	} finally {
		clearTimeout(timeout);
	}
}

export type HealthStatus = "pass" | "warning" | "fail";
export type HealthGroup =
	| "storage"
	| "state"
	| "tools"
	| "accounts"
	| "notifications"
	| "remote"
	| "updates"
	| "recovery";

export interface HealthCheckResult {
	id: string;
	group: HealthGroup;
	label: string;
	status: HealthStatus;
	message: string;
	remediation?: string;
}

export interface HealthReport {
	generatedAt: string;
	summary: Record<HealthStatus, number>;
	checks: HealthCheckResult[];
}

export interface StateShapeCounts {
	projectCount: number;
	workspaceCount: number;
	tabCount: number;
	paneCount: number;
	accountCount: number;
	remoteHostCount: number;
}

export interface StateShapeSummary extends StateShapeCounts {
	unavailableMetricCount: number;
}

const STATE_SHAPE_METRICS = [
	"projectCount",
	"workspaceCount",
	"tabCount",
	"paneCount",
	"accountCount",
	"remoteHostCount",
] as const satisfies ReadonlyArray<keyof StateShapeCounts>;

export function readStateShapeBestEffort(
	readers: Record<keyof StateShapeCounts, () => unknown>,
): StateShapeSummary {
	const counts = {} as StateShapeCounts;
	let unavailableMetricCount = 0;
	for (const metric of STATE_SHAPE_METRICS) {
		try {
			const value = readers[metric]();
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0
			) {
				unavailableMetricCount += 1;
				counts[metric] = 0;
				continue;
			}
			counts[metric] = value;
		} catch {
			unavailableMetricCount += 1;
			counts[metric] = 0;
		}
	}
	return { ...counts, unavailableMetricCount };
}

export interface HealthCheckDependencies {
	platform: string;
	arch: string;
	paths: {
		syncRoot: string;
		privateRoot: string;
	};
	now: () => Date;
	canWritePath: (path: string) => Promise<boolean>;
	readAppStateHealth: () => Promise<{
		valid: boolean;
		workspaceCount: number;
		paneCount: number;
		tabCount: number;
	}>;
	readDatabaseHealth: () => Promise<{
		integrity: "ok" | "corrupt" | "unavailable";
		projectCount: number;
		workspaceCount: number;
	}>;
	commandAvailable: (command: string) => Promise<boolean>;
	readProviderBindingHealth: () => Promise<{
		available: boolean;
		accountCount: number;
		bindingCount: number;
		unboundPaneCount: number;
		deferredCleanupCount: number;
	}>;
	readNotificationHealth: () => Promise<{
		supported: boolean;
		muted: boolean;
		selectedSoundReadable: boolean;
	}>;
	readRemoteHostHealth: () => Promise<{
		hostCount: number;
		bindingCount: number;
		inconsistentCount: number;
	}>;
	fetchUpdateManifest: () => Promise<unknown>;
	readStorageHealth: () => Promise<{
		diagnosticLogCount: number;
		diagnosticLogBytes: number;
		crashDumpCount: number;
		crashDumpBytes: number;
		invalidCrashDumpEntryCount: number;
		appStateSnapshotCount: number;
		databaseSnapshotCount: number;
		/** Final installer filenames with non-zero regular files; not historical hashes. */
		completedInstallerVersions: number;
		completedInstallerBytes: number;
		updateVersionOverageCount: number;
		invalidUpdateEntryCount: number;
	}>;
	readRecoveryHealth: () => Promise<{ pendingConflictCount: number }>;
}

type CheckFactory = (
	status: HealthStatus,
	message: string,
	remediation?: string,
) => HealthCheckResult;

function checkFactory(
	id: string,
	group: HealthGroup,
	label: string,
): CheckFactory {
	return (status, message, remediation) => ({
		id,
		group,
		label,
		status,
		message,
		...(remediation ? { remediation } : {}),
	});
}

async function writableRootCheck(
	deps: HealthCheckDependencies,
	kind: "sync" | "private",
): Promise<HealthCheckResult> {
	const sync = kind === "sync";
	const create = checkFactory(
		sync ? "sync-root" : "private-root",
		"storage",
		sync ? "ADE data folder" : "Private data folder",
	);
	try {
		const writable = await deps.canWritePath(
			sync ? deps.paths.syncRoot : deps.paths.privateRoot,
		);
		return writable
			? create("pass", "The folder is writable.")
			: create(
					"fail",
					"The folder is not writable.",
					"Check folder permissions and available disk space.",
				);
	} catch {
		return create(
			"fail",
			"The folder could not be checked.",
			"Check folder permissions and available disk space.",
		);
	}
}

async function appStateCheck(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult> {
	const create = checkFactory("app-state", "state", "Application state");
	try {
		const state = await deps.readAppStateHealth();
		return state.valid
			? create("pass", "Application state is valid.")
			: create(
					"fail",
					"Application state is invalid.",
					"Restore a recent state snapshot or reset state with a backup.",
				);
	} catch {
		return create(
			"fail",
			"Application state could not be checked.",
			"Open recovery controls and retry after creating a backup.",
		);
	}
}

async function databaseCheck(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult> {
	const create = checkFactory("local-database", "state", "Local database");
	const remediation =
		"Export diagnostics, then restart ADE. Do not use Reset app state or Restore app state; neither action can repair local.db.";
	try {
		const database = await deps.readDatabaseHealth();
		return database.integrity === "ok"
			? create("pass", "Database integrity is valid.")
			: create(
					"fail",
					database.integrity === "corrupt"
						? "Database integrity check failed."
						: "The database is unavailable.",
					remediation,
				);
	} catch {
		return create("fail", "The database could not be checked.", remediation);
	}
}

interface CommandDefinition {
	id: string;
	command: string;
	label: string;
	required: boolean;
}

function commandDefinitions(platform: string): CommandDefinition[] {
	const definitions: CommandDefinition[] = [
		{
			id: "command-claude",
			command: "claude",
			label: "Claude Code",
			required: false,
		},
		{ id: "command-codex", command: "codex", label: "Codex", required: false },
		{ id: "command-git", command: "git", label: "Git", required: true },
		{ id: "command-ssh", command: "ssh", label: "SSH", required: false },
		{ id: "command-sftp", command: "sftp", label: "SFTP", required: false },
	];
	if (platform === "win32") {
		definitions.push({
			id: "command-powershell",
			command: "powershell",
			label: "PowerShell",
			required: false,
		});
	}
	definitions.push({
		id: "command-shell",
		command:
			platform === "win32" ? "cmd" : platform === "darwin" ? "zsh" : "sh",
		label: "System shell",
		required: true,
	});
	return definitions;
}

async function commandChecks(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult[]> {
	const results: HealthCheckResult[] = [];
	for (const definition of commandDefinitions(deps.platform)) {
		const create = checkFactory(definition.id, "tools", definition.label);
		try {
			const available = await deps.commandAvailable(definition.command);
			results.push(
				available
					? create("pass", `${definition.label} is available.`)
					: create(
							definition.required ? "fail" : "warning",
							`${definition.label} is not available.`,
							definition.required
								? `Install ${definition.label} and restart ADE.`
								: `Install ${definition.label} to use its related features.`,
						),
			);
		} catch {
			results.push(
				create(
					definition.required ? "fail" : "warning",
					`${definition.label} availability could not be checked.`,
					"Verify the command is installed and available on PATH.",
				),
			);
		}
	}
	return results;
}

async function providerBindingsCheck(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult> {
	const create = checkFactory(
		"provider-bindings",
		"accounts",
		"Provider account bindings",
	);
	try {
		const health = await deps.readProviderBindingHealth();
		if (!health.available) {
			return create(
				"fail",
				"Provider account storage is unavailable.",
				"Restart ADE and retry private account storage initialization.",
			);
		}
		if (health.unboundPaneCount > 0 || health.deferredCleanupCount > 0) {
			return create(
				"warning",
				"Some provider account bindings need attention.",
				"Rebind waiting panes and rerun this check.",
			);
		}
		return create("pass", "Provider account bindings are consistent.");
	} catch {
		return create(
			"fail",
			"Provider account bindings could not be checked.",
			"Restart ADE and rerun this check.",
		);
	}
}

async function notificationChecks(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult[]> {
	const support = checkFactory(
		"notifications",
		"notifications",
		"Desktop notifications",
	);
	const sound = checkFactory(
		"selected-sound",
		"notifications",
		"Notification sound",
	);
	try {
		const health = await deps.readNotificationHealth();
		return [
			health.supported
				? support("pass", "Desktop notifications are supported.")
				: support(
						"warning",
						"Desktop notifications are not currently supported.",
						"Review operating-system notification permissions.",
					),
			health.selectedSoundReadable
				? sound(
						"pass",
						health.muted
							? "The selected sound is readable and muted."
							: "The selected sound is readable.",
					)
				: sound(
						"fail",
						"The selected notification sound is not readable.",
						"Choose another notification sound or re-import the custom sound.",
					),
		];
	} catch {
		return [
			support(
				"warning",
				"Notification support could not be checked.",
				"Review operating-system notification permissions.",
			),
			sound(
				"fail",
				"The selected notification sound could not be checked.",
				"Choose another notification sound and rerun this check.",
			),
		];
	}
}

async function remoteHostCheck(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult> {
	const create = checkFactory("remote-hosts", "remote", "Remote hosts");
	try {
		const health = await deps.readRemoteHostHealth();
		return health.inconsistentCount > 0
			? create(
					"fail",
					"Remote host configuration is inconsistent.",
					"Repair or remove incomplete remote workspace bindings.",
				)
			: create(
					"pass",
					health.hostCount === 0
						? "No remote hosts are configured."
						: "Remote host configuration is consistent.",
				);
	} catch {
		return create(
			"fail",
			"Remote host configuration could not be checked.",
			"Open Terminal settings and verify remote host bindings.",
		);
	}
}

async function updateManifestCheck(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult> {
	const create = checkFactory(
		"update-manifest",
		"updates",
		"Personal update channel",
	);
	let document: unknown;
	try {
		document = await deps.fetchUpdateManifest();
	} catch {
		return create(
			"warning",
			"The update manifest is not reachable right now.",
			"Check the network connection and run the health check again.",
		);
	}
	try {
		const manifest = parsePersonalUpdateManifest(document);
		selectPersonalUpdateAsset(manifest, deps.platform, deps.arch);
		return create("pass", "The update manifest and platform asset are valid.");
	} catch {
		return create(
			"fail",
			"The update manifest or platform asset is invalid.",
			"Use the current direct installer and rerun this check after the release is repaired.",
		);
	}
}

async function storageBudgetCheck(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult> {
	const create = checkFactory("storage-budget", "storage", "Recovery storage");
	try {
		const health = await deps.readStorageHealth();
		const overBudget =
			health.diagnosticLogCount > 3 ||
			health.diagnosticLogBytes > 3 * 1024 * 1024 ||
			health.crashDumpCount > MAX_CRASH_DUMP_COUNT ||
			health.crashDumpBytes > MAX_CRASH_DUMP_BYTES ||
			health.invalidCrashDumpEntryCount > 0 ||
			health.appStateSnapshotCount > 3 ||
			health.databaseSnapshotCount > 2 ||
			health.completedInstallerVersions > MAX_COMPLETED_INSTALLER_VERSIONS ||
			health.completedInstallerBytes > MAX_COMPLETED_INSTALLER_BYTES ||
			health.updateVersionOverageCount > 0 ||
			health.invalidUpdateEntryCount > 0;
		return overBudget
			? create(
					"warning",
					"Local diagnostics or recovery storage exceeds its budget.",
					"Review ADE's local diagnostics, recovery, and update storage; remove stale entries, then run this check again.",
				)
			: create("pass", "Local diagnostics and recovery storage is bounded.");
	} catch {
		return create(
			"warning",
			"Local diagnostics and recovery storage could not be measured.",
			"Check available disk space and rerun this check.",
		);
	}
}

async function recoveryConflictCheck(
	deps: HealthCheckDependencies,
): Promise<HealthCheckResult> {
	const create = checkFactory(
		"recovery-conflicts",
		"recovery",
		"Pending recovery conflicts",
	);
	try {
		const health = await deps.readRecoveryHealth();
		return health.pendingConflictCount > 0
			? create(
					"warning",
					"Recovery conflicts are waiting for review.",
					"Review preserved recovery copies before removing them.",
				)
			: create("pass", "No recovery conflicts are pending.");
	} catch {
		return create(
			"warning",
			"Recovery conflicts could not be checked.",
			"Restart ADE and run the health check again.",
		);
	}
}

export async function runHealthChecks(
	deps: HealthCheckDependencies,
): Promise<HealthReport> {
	const checks: HealthCheckResult[] = [
		await writableRootCheck(deps, "sync"),
		await writableRootCheck(deps, "private"),
		await appStateCheck(deps),
		await databaseCheck(deps),
		...(await commandChecks(deps)),
		await providerBindingsCheck(deps),
		...(await notificationChecks(deps)),
		await remoteHostCheck(deps),
		await updateManifestCheck(deps),
		await storageBudgetCheck(deps),
		await recoveryConflictCheck(deps),
	];
	const summary: Record<HealthStatus, number> = {
		pass: 0,
		warning: 0,
		fail: 0,
	};
	for (const check of checks) summary[check.status] += 1;
	return {
		generatedAt: deps.now().toISOString(),
		summary,
		checks,
	};
}

export interface DiagnosticsAppIdentity {
	version: string;
	buildNumber?: number;
	commitSha?: string;
	platform: string;
	arch: string;
}

interface RecentDiagnosticEvent {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	category: string;
}

export interface DiagnosticsExportBundle {
	schemaVersion: 1;
	generatedAt: string;
	app: Record<string, string | number>;
	health: {
		summary: Record<HealthStatus, number>;
		checks: Array<Pick<HealthCheckResult, "id" | "group" | "status">>;
	};
	stateShape: StateShapeSummary;
	storage: DiagnosticsStorageSummary;
	pathHashes: Record<string, string>;
	recentEvents: RecentDiagnosticEvent[];
}

export interface DiagnosticsStorageSummary {
	completedInstallerVersions: number;
	completedInstallerBytes: number;
	crashDumpCount: number;
	crashDumpBytes: number;
	unavailableMetricCount: number;
}

const STORAGE_METRICS = [
	"completedInstallerVersions",
	"completedInstallerBytes",
	"crashDumpCount",
	"crashDumpBytes",
] as const satisfies ReadonlyArray<
	keyof Omit<DiagnosticsStorageSummary, "unavailableMetricCount">
>;

const EVENT_CATEGORIES = new Set([
	"application",
	"database",
	"health",
	"recovery",
	"renderer",
	"security",
	"startup",
	"state",
	"update",
]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const EXPORTABLE_HEALTH_CHECK_GROUPS: Readonly<Record<string, HealthGroup>> = {
	"sync-root": "storage",
	"private-root": "storage",
	"app-state": "state",
	"local-database": "state",
	"command-claude": "tools",
	"command-codex": "tools",
	"command-git": "tools",
	"command-ssh": "tools",
	"command-sftp": "tools",
	"command-powershell": "tools",
	"command-shell": "tools",
	"provider-bindings": "accounts",
	notifications: "notifications",
	"selected-sound": "notifications",
	"remote-hosts": "remote",
	"update-manifest": "updates",
	"storage-budget": "storage",
	"recovery-conflicts": "recovery",
};

function eventCategory(event: unknown): string {
	if (typeof event !== "string") return "unknown";
	const candidate = event.split(/[.-]/, 1)[0]?.toLowerCase() ?? "";
	return EVENT_CATEGORIES.has(candidate) ? candidate : "unknown";
}

function safeCount(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: 0;
}

function safeTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const timestamp = new Date(value);
	return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function safeRecentEvents(entries: unknown[]): RecentDiagnosticEvent[] {
	return entries.slice(-100).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as Record<string, unknown>;
		const timestamp = safeTimestamp(record.timestamp ?? record.at);
		const level =
			typeof record.level === "string" && LOG_LEVELS.has(record.level)
				? (record.level as RecentDiagnosticEvent["level"])
				: null;
		if (!timestamp || !level) return [];
		return [
			{
				timestamp,
				level,
				category: eventCategory(record.event),
			},
		];
	});
}

function pathHash(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeAppIdentity(identity: DiagnosticsAppIdentity) {
	const app: Record<string, string | number> = {
		version: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(identity.version)
			? identity.version
			: "unknown",
		platform: ["win32", "darwin", "linux"].includes(identity.platform)
			? identity.platform
			: "unknown",
		arch: ["x64", "arm64"].includes(identity.arch) ? identity.arch : "unknown",
	};
	if (
		typeof identity.buildNumber === "number" &&
		Number.isSafeInteger(identity.buildNumber) &&
		identity.buildNumber > 0
	) {
		app.buildNumber = identity.buildNumber;
	}
	if (
		typeof identity.commitSha === "string" &&
		/^[a-f0-9]{40}$/.test(identity.commitSha)
	) {
		app.commitSha = identity.commitSha;
	}
	return app;
}

export function createDiagnosticsExport(options: {
	report: HealthReport;
	app: DiagnosticsAppIdentity;
	stateShape?: Partial<StateShapeSummary>;
	storage?: Partial<DiagnosticsStorageSummary>;
	paths: Partial<Record<"syncRoot" | "privateRoot", string>>;
	recentLogs: unknown[];
	now: () => Date;
}): DiagnosticsExportBundle {
	let unavailableMetricCount = Math.min(
		STATE_SHAPE_METRICS.length,
		safeCount(options.stateShape?.unavailableMetricCount),
	);
	const stateShape = {} as StateShapeCounts;
	for (const metric of STATE_SHAPE_METRICS) {
		const value = options.stateShape?.[metric];
		if (
			typeof value !== "number" ||
			!Number.isSafeInteger(value) ||
			value < 0
		) {
			unavailableMetricCount = Math.min(
				STATE_SHAPE_METRICS.length,
				unavailableMetricCount + 1,
			);
			stateShape[metric] = 0;
			continue;
		}
		stateShape[metric] = value;
	}
	let unavailableStorageMetricCount = Math.min(
		STORAGE_METRICS.length,
		safeCount(options.storage?.unavailableMetricCount),
	);
	const storage = {} as Omit<
		DiagnosticsStorageSummary,
		"unavailableMetricCount"
	>;
	for (const metric of STORAGE_METRICS) {
		const value = options.storage?.[metric];
		if (
			typeof value !== "number" ||
			!Number.isSafeInteger(value) ||
			value < 0
		) {
			unavailableStorageMetricCount = Math.min(
				STORAGE_METRICS.length,
				unavailableStorageMetricCount + 1,
			);
			storage[metric] = 0;
			continue;
		}
		storage[metric] = value;
	}
	const pathHashes: Record<string, string> = {};
	for (const key of ["syncRoot", "privateRoot"] as const) {
		const value = options.paths[key];
		if (typeof value === "string") pathHashes[key] = pathHash(value);
	}
	const checks = options.report.checks.flatMap(
		(check): Array<Pick<HealthCheckResult, "id" | "group" | "status">> => {
			const group = EXPORTABLE_HEALTH_CHECK_GROUPS[check.id];
			if (!group || !["pass", "warning", "fail"].includes(check.status)) {
				return [];
			}
			return [{ id: check.id, group, status: check.status }];
		},
	);
	return {
		schemaVersion: 1,
		generatedAt: options.now().toISOString(),
		app: safeAppIdentity(options.app),
		health: {
			summary: {
				pass: safeCount(options.report.summary.pass),
				warning: safeCount(options.report.summary.warning),
				fail: safeCount(options.report.summary.fail),
			},
			checks,
		},
		stateShape: { ...stateShape, unavailableMetricCount },
		storage: {
			...storage,
			unavailableMetricCount: unavailableStorageMetricCount,
		},
		pathHashes,
		recentEvents: safeRecentEvents(options.recentLogs),
	};
}

export async function exportDiagnostics(options: {
	chooseDestination: () => Promise<string | null>;
	createBundle: () => Promise<unknown>;
	writeFile: (path: string, contents: string) => Promise<void>;
}): Promise<{ canceled: boolean; path: string | null }> {
	const destination = await options.chooseDestination();
	if (!destination) return { canceled: true, path: null };
	const bundle = await options.createBundle();
	await options.writeFile(destination, `${JSON.stringify(bundle, null, 2)}\n`);
	return { canceled: false, path: destination };
}
