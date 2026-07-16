import { describe, expect, it } from "bun:test";
import {
	createDiagnosticsExport,
	exportDiagnostics,
	fetchHealthUpdateManifest,
	type HealthCheckDependencies,
	readStateShapeBestEffort,
	runHealthChecks,
} from "./health";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function validManifest() {
	return {
		schemaVersion: 1,
		version: "0.6.0",
		buildNumber: 42,
		commitSha: SHA,
		publishedAt: "2026-07-16T00:00:00.000Z",
		releaseNotesUrl:
			"https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest",
		assets: {
			"win32-x64": {
				name: "ADE-Windows-x64.exe",
				url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
				size: 100,
				sha256: DIGEST,
			},
			"darwin-arm64": {
				name: "ADE-macOS-Apple-Silicon.dmg",
				url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Apple-Silicon.dmg",
				size: 100,
				sha256: DIGEST,
			},
			"darwin-x64": {
				name: "ADE-macOS-Intel.dmg",
				url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Intel.dmg",
				size: 100,
				sha256: DIGEST,
			},
		},
	};
}

function healthyDependencies(
	overrides: Partial<HealthCheckDependencies> = {},
): HealthCheckDependencies {
	return {
		platform: "win32",
		arch: "x64",
		paths: {
			syncRoot: "C:\\Users\\person\\.ade",
			privateRoot: "C:\\Users\\person\\AppData\\Local\\ADE\\private",
		},
		now: () => new Date("2026-07-16T00:00:00.000Z"),
		canWritePath: async () => true,
		readAppStateHealth: async () => ({
			valid: true,
			workspaceCount: 2,
			paneCount: 3,
			tabCount: 2,
		}),
		readDatabaseHealth: async () => ({
			integrity: "ok",
			projectCount: 2,
			workspaceCount: 2,
		}),
		commandAvailable: async () => true,
		readProviderBindingHealth: async () => ({
			available: true,
			accountCount: 2,
			bindingCount: 3,
			unboundPaneCount: 0,
			deferredCleanupCount: 0,
		}),
		readNotificationHealth: async () => ({
			supported: true,
			muted: false,
			selectedSoundReadable: true,
		}),
		readRemoteHostHealth: async () => ({
			hostCount: 1,
			bindingCount: 1,
			inconsistentCount: 0,
		}),
		fetchUpdateManifest: async () => validManifest(),
		readStorageHealth: async () => ({
			diagnosticLogCount: 3,
			diagnosticLogBytes: 3 * 1024 * 1024,
			crashDumpCount: 0,
			crashDumpBytes: 0,
			invalidCrashDumpEntryCount: 0,
			appStateSnapshotCount: 3,
			databaseSnapshotCount: 2,
			completedInstallerVersions: 1,
			completedInstallerBytes: 100,
			updateVersionOverageCount: 0,
			invalidUpdateEntryCount: 0,
		}),
		readRecoveryHealth: async () => ({ pendingConflictCount: 0 }),
		...overrides,
	};
}

function resultById(
	report: Awaited<ReturnType<typeof runHealthChecks>>,
	id: string,
) {
	const result = report.checks.find((check) => check.id === id);
	if (!result) throw new Error(`Missing health result: ${id}`);
	return result;
}

describe("health checks", () => {
	it("bounds a stalled update-manifest request with an abort signal", async () => {
		let observedSignal: AbortSignal | undefined;
		const request = fetchHealthUpdateManifest({
			timeoutMs: 5,
			fetch: async (_url, init) => {
				observedSignal = init?.signal as AbortSignal;
				return await new Promise<Response>((_resolve, reject) => {
					observedSignal?.addEventListener(
						"abort",
						() =>
							reject(
								Object.assign(new Error("request aborted"), {
									name: "AbortError",
								}),
							),
						{ once: true },
					);
				});
			},
		});

		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(observedSignal?.aborted).toBe(true);
	});

	it("returns a complete passing report without exposing paths or command output", async () => {
		const report = await runHealthChecks(healthyDependencies());

		expect(report.summary).toEqual({ pass: 18, warning: 0, fail: 0 });
		expect(report.checks.map((check) => check.id)).toEqual([
			"sync-root",
			"private-root",
			"app-state",
			"local-database",
			"command-claude",
			"command-codex",
			"command-git",
			"command-ssh",
			"command-sftp",
			"command-powershell",
			"command-shell",
			"provider-bindings",
			"notifications",
			"selected-sound",
			"remote-hosts",
			"update-manifest",
			"storage-budget",
			"recovery-conflicts",
		]);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("C:\\\\Users");
		expect(serialized).not.toContain("AppData");
	});

	it("classifies unwritable roots, invalid state, and database corruption as failures", async () => {
		const report = await runHealthChecks(
			healthyDependencies({
				canWritePath: async (path) => !path.includes(".ade"),
				readAppStateHealth: async () => ({
					valid: false,
					workspaceCount: 0,
					paneCount: 0,
					tabCount: 0,
				}),
				readDatabaseHealth: async () => ({
					integrity: "corrupt",
					projectCount: 0,
					workspaceCount: 0,
				}),
			}),
		);

		expect(resultById(report, "sync-root").status).toBe("fail");
		expect(resultById(report, "private-root").status).toBe("pass");
		expect(resultById(report, "app-state").status).toBe("fail");
		expect(resultById(report, "local-database").status).toBe("fail");
		expect(resultById(report, "local-database").remediation).toBe(
			"Export diagnostics, then restart ADE. Do not use Reset app state or Restore app state; neither action can repair local.db.",
		);
		expect(resultById(report, "local-database").remediation).not.toContain(
			"recovery procedure",
		);
	});

	it("distinguishes required commands from optional agent and remote tooling", async () => {
		const attempted: string[] = [];
		const report = await runHealthChecks(
			healthyDependencies({
				commandAvailable: async (command) => {
					attempted.push(command);
					return false;
				},
			}),
		);

		expect(attempted).toEqual([
			"claude",
			"codex",
			"git",
			"ssh",
			"sftp",
			"powershell",
			"cmd",
		]);
		expect(resultById(report, "command-claude").status).toBe("warning");
		expect(resultById(report, "command-codex").status).toBe("warning");
		expect(resultById(report, "command-ssh").status).toBe("warning");
		expect(resultById(report, "command-sftp").status).toBe("warning");
		expect(resultById(report, "command-powershell").status).toBe("warning");
		expect(resultById(report, "command-git").status).toBe("fail");
		expect(resultById(report, "command-shell").status).toBe("fail");
	});

	it("uses the native shell and omits PowerShell on macOS", async () => {
		const attempted: string[] = [];
		const report = await runHealthChecks(
			healthyDependencies({
				platform: "darwin",
				arch: "arm64",
				commandAvailable: async (command) => {
					attempted.push(command);
					return true;
				},
			}),
		);

		expect(attempted).toContain("zsh");
		expect(attempted).not.toContain("powershell");
		expect(
			report.checks.some((check) => check.id === "command-powershell"),
		).toBe(false);
		expect(report.summary.pass).toBe(17);
	});

	it("reports provider binding, notification, sound, and remote configuration problems", async () => {
		const report = await runHealthChecks(
			healthyDependencies({
				readProviderBindingHealth: async () => ({
					available: true,
					accountCount: 1,
					bindingCount: 1,
					unboundPaneCount: 2,
					deferredCleanupCount: 1,
				}),
				readNotificationHealth: async () => ({
					supported: false,
					muted: false,
					selectedSoundReadable: false,
				}),
				readRemoteHostHealth: async () => ({
					hostCount: 2,
					bindingCount: 3,
					inconsistentCount: 1,
				}),
			}),
		);

		expect(resultById(report, "provider-bindings").status).toBe("warning");
		expect(resultById(report, "notifications").status).toBe("warning");
		expect(resultById(report, "selected-sound").status).toBe("fail");
		expect(resultById(report, "remote-hosts").status).toBe("fail");
		for (const check of report.checks) {
			expect(check).not.toHaveProperty("accountId");
			expect(check).not.toHaveProperty("hostName");
		}
	});

	it("treats update network loss as a warning and invalid or incomplete manifests as failures", async () => {
		const offline = await runHealthChecks(
			healthyDependencies({
				fetchUpdateManifest: async () => {
					throw Object.assign(new Error("offline secret"), {
						code: "ENOTFOUND",
					});
				},
			}),
		);
		expect(resultById(offline, "update-manifest").status).toBe("warning");
		expect(JSON.stringify(offline)).not.toContain("offline secret");

		const invalid = await runHealthChecks(
			healthyDependencies({
				fetchUpdateManifest: async () => ({ nope: true }),
			}),
		);
		expect(resultById(invalid, "update-manifest").status).toBe("fail");

		const missingAssetManifest = validManifest();
		delete (missingAssetManifest.assets as Record<string, unknown>)[
			"darwin-arm64"
		];
		const missingAsset = await runHealthChecks(
			healthyDependencies({
				platform: "darwin",
				arch: "arm64",
				fetchUpdateManifest: async () => missingAssetManifest,
			}),
		);
		expect(resultById(missingAsset, "update-manifest").status).toBe("fail");
	});

	it("warns when bounded storage or recovery conflict limits are exceeded", async () => {
		const report = await runHealthChecks(
			healthyDependencies({
				readStorageHealth: async () => ({
					diagnosticLogCount: 4,
					diagnosticLogBytes: 4 * 1024 * 1024,
					crashDumpCount: 4,
					crashDumpBytes: 20 * 1024 * 1024,
					invalidCrashDumpEntryCount: 2,
					appStateSnapshotCount: 4,
					databaseSnapshotCount: 3,
					completedInstallerVersions: 4,
					completedInstallerBytes: 2 * 1024 * 1024 * 1024,
					updateVersionOverageCount: 1,
					invalidUpdateEntryCount: 2,
				}),
				readRecoveryHealth: async () => ({ pendingConflictCount: 2 }),
			}),
		);

		const storage = resultById(report, "storage-budget");
		expect(storage.status).toBe("warning");
		expect(storage.remediation).toBe(
			"Review ADE's local diagnostics, recovery, and update storage; remove stale entries, then run this check again.",
		);
		expect(storage.remediation).not.toContain("Restart");
		expect(resultById(report, "recovery-conflicts").status).toBe("warning");
	});

	it("warns when completed installers exceed the global retention budget", async () => {
		const report = await runHealthChecks(
			healthyDependencies({
				readStorageHealth: async () => ({
					diagnosticLogCount: 3,
					diagnosticLogBytes: 3 * 1024 * 1024,
					crashDumpCount: 0,
					crashDumpBytes: 0,
					invalidCrashDumpEntryCount: 0,
					appStateSnapshotCount: 3,
					databaseSnapshotCount: 2,
					completedInstallerVersions: 4,
					completedInstallerBytes: 400,
					updateVersionOverageCount: 0,
					invalidUpdateEntryCount: 0,
				}),
			}),
		);

		expect(resultById(report, "storage-budget").status).toBe("warning");
	});

	it("warns when crash dumps exceed their local count or byte budget", async () => {
		const report = await runHealthChecks(
			healthyDependencies({
				readStorageHealth: async () => ({
					diagnosticLogCount: 3,
					diagnosticLogBytes: 3 * 1024 * 1024,
					crashDumpCount: 4,
					crashDumpBytes: 20 * 1024 * 1024,
					invalidCrashDumpEntryCount: 0,
					appStateSnapshotCount: 3,
					databaseSnapshotCount: 2,
					completedInstallerVersions: 1,
					completedInstallerBytes: 100,
					updateVersionOverageCount: 0,
					invalidUpdateEntryCount: 0,
				}),
			}),
		);

		expect(resultById(report, "storage-budget").status).toBe("warning");
	});

	it("warns when one retained installer exceeds the global byte budget", async () => {
		const report = await runHealthChecks(
			healthyDependencies({
				readStorageHealth: async () => ({
					diagnosticLogCount: 3,
					diagnosticLogBytes: 3 * 1024 * 1024,
					crashDumpCount: 0,
					crashDumpBytes: 0,
					invalidCrashDumpEntryCount: 0,
					appStateSnapshotCount: 3,
					databaseSnapshotCount: 2,
					completedInstallerVersions: 1,
					completedInstallerBytes: 1024 * 1024 * 1024 + 1,
					updateVersionOverageCount: 0,
					invalidUpdateEntryCount: 0,
				}),
			}),
		);

		expect(resultById(report, "storage-budget").status).toBe("warning");
	});

	it("contains probe failures and returns actionable fail results without leaking errors", async () => {
		const report = await runHealthChecks(
			healthyDependencies({
				readDatabaseHealth: async () => {
					throw new Error("C:\\private\\local.db password=hunter2");
				},
				readProviderBindingHealth: async () => {
					throw new Error("account UUID 123 secret");
				},
			}),
		);

		expect(resultById(report, "local-database").status).toBe("fail");
		expect(resultById(report, "local-database").remediation).toBe(
			"Export diagnostics, then restart ADE. Do not use Reset app state or Restore app state; neither action can repair local.db.",
		);
		expect(resultById(report, "provider-bindings").status).toBe("fail");
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("hunter2");
		expect(serialized).not.toContain("account UUID");
	});
});

describe("diagnostics export", () => {
	it("contains each state-shape reader failure without exporting its error", () => {
		const summary = readStateShapeBestEffort({
			projectCount: () => 2,
			workspaceCount: () => {
				throw new Error("C:\\Users\\secret\\local.db token=hunter2");
			},
			tabCount: () => 3,
			paneCount: () => 4,
			accountCount: () => {
				throw new Error("account 550e8400-e29b-41d4-a716-446655440000");
			},
			remoteHostCount: () => 1,
		});

		expect(summary).toEqual({
			projectCount: 2,
			workspaceCount: 0,
			tabCount: 3,
			paneCount: 4,
			accountCount: 0,
			remoteHostCount: 1,
			unavailableMetricCount: 2,
		});
		expect(JSON.stringify(summary)).not.toContain("hunter2");
		expect(JSON.stringify(summary)).not.toContain("550e8400");
	});

	it("uses a truthful bounded placeholder when state-shape reads are unavailable", async () => {
		const report = await runHealthChecks(healthyDependencies());
		const bundle = createDiagnosticsExport({
			report,
			app: { version: "0.6.0", platform: "win32", arch: "x64" },
			stateShape: undefined as never,
			paths: {},
			recentLogs: [],
			now: () => new Date(0),
		});

		expect(bundle.stateShape).toEqual({
			projectCount: 0,
			workspaceCount: 0,
			tabCount: 0,
			paneCount: 0,
			accountCount: 0,
			remoteHostCount: 0,
			unavailableMetricCount: 6,
		});
	});

	it("emits a strict allowlist with counts, hashes, and categorized log metadata only", async () => {
		const report = await runHealthChecks(healthyDependencies());
		const exportedChecks = report.checks.map(({ id, group, status }) => ({
			id,
			group,
			status,
		}));
		const bundle = createDiagnosticsExport({
			report,
			app: {
				version: "0.6.0",
				buildNumber: 42,
				commitSha: SHA,
				platform: "win32",
				arch: "x64",
			},
			stateShape: {
				projectCount: 2,
				workspaceCount: 3,
				tabCount: 4,
				paneCount: 5,
				accountCount: 2,
				remoteHostCount: 1,
				unavailableMetricCount: 0,
			},
			storage: {
				completedInstallerVersions: 2,
				completedInstallerBytes: 1_234,
				crashDumpCount: 1,
				crashDumpBytes: 456,
				unavailableMetricCount: 0,
			},
			paths: {
				syncRoot: "C:\\Users\\secret-user\\.ade",
				privateRoot: "C:\\Users\\secret-user\\AppData\\Local\\ADE\\private",
			},
			recentLogs: [
				{
					timestamp: "2026-07-16T00:00:00.000Z",
					level: "error",
					event: "update.download.failed",
					message: "terminal transcript password=hunter2",
					details: {
						chat: "raw chat text",
						accountId: "550e8400-e29b-41d4-a716-446655440000",
						env: process.env,
					},
				},
				{
					timestamp: "2026-07-16T00:00:01.000Z",
					level: "info",
					event: "arbitrary user-provided project text",
					path: "/Users/private/project",
				},
			],
			now: () => new Date("2026-07-16T01:00:00.000Z"),
		});

		expect(bundle).toEqual({
			schemaVersion: 1,
			generatedAt: "2026-07-16T01:00:00.000Z",
			app: {
				version: "0.6.0",
				buildNumber: 42,
				commitSha: SHA,
				platform: "win32",
				arch: "x64",
			},
			health: {
				summary: { pass: 18, warning: 0, fail: 0 },
				checks: exportedChecks,
			},
			stateShape: {
				projectCount: 2,
				workspaceCount: 3,
				tabCount: 4,
				paneCount: 5,
				accountCount: 2,
				remoteHostCount: 1,
				unavailableMetricCount: 0,
			},
			storage: {
				completedInstallerVersions: 2,
				completedInstallerBytes: 1_234,
				crashDumpCount: 1,
				crashDumpBytes: 456,
				unavailableMetricCount: 0,
			},
			pathHashes: {
				syncRoot: expect.stringMatching(/^[a-f0-9]{64}$/),
				privateRoot: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			recentEvents: [
				{
					timestamp: "2026-07-16T00:00:00.000Z",
					level: "error",
					category: "update",
				},
				{
					timestamp: "2026-07-16T00:00:01.000Z",
					level: "info",
					category: "unknown",
				},
			],
		});
		const serialized = JSON.stringify(bundle);
		for (const forbidden of [
			"secret-user",
			"AppData",
			"hunter2",
			"terminal transcript",
			"raw chat text",
			"550e8400",
			"arbitrary user-provided",
			"/Users/private/project",
			"PATH",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it("does not trust caller-provided health text or unknown path keys", async () => {
		const base = await runHealthChecks(healthyDependencies());
		const bundle = createDiagnosticsExport({
			report: {
				...base,
				checks: [
					{
						id: "sync-root",
						group: "storage",
						label: "C:\\Users\\secret-user\\.ade",
						status: "fail",
						message: "token=private raw terminal text",
						remediation: "account 550e8400-e29b-41d4-a716-446655440000",
					},
					{
						id: "user-provided secret",
						group: "state",
						label: "secret",
						status: "warning",
						message: "secret",
					},
				],
			},
			app: {
				version: "0.6.0",
				platform: "win32",
				arch: "x64",
			},
			stateShape: {
				projectCount: 0,
				workspaceCount: 0,
				tabCount: 0,
				paneCount: 0,
				accountCount: 0,
				remoteHostCount: 0,
			},
			paths: {
				syncRoot: "C:\\Users\\secret-user\\.ade",
				...({ "secret-key-name": "secret-value" } as Record<string, string>),
			},
			recentLogs: [],
			now: () => new Date(0),
		});

		expect(bundle.health.checks).toEqual([
			{ id: "sync-root", group: "storage", status: "fail" },
		]);
		expect(Object.keys(bundle.pathHashes)).toEqual(["syncRoot"]);
		const serialized = JSON.stringify(bundle);
		for (const forbidden of [
			"secret-user",
			"token=private",
			"raw terminal text",
			"550e8400",
			"user-provided secret",
			"secret-key-name",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it("bounds logs and sanitizes invalid counts and build identity", async () => {
		const report = await runHealthChecks(healthyDependencies());
		const bundle = createDiagnosticsExport({
			report,
			app: {
				version: "0.6.0",
				buildNumber: Number.NaN,
				commitSha: "secret-sha",
				platform: "win32",
				arch: "x64",
			},
			stateShape: {
				projectCount: -1,
				workspaceCount: Number.POSITIVE_INFINITY,
				tabCount: 2.5,
				paneCount: 1,
				accountCount: 1,
				remoteHostCount: 1,
			},
			paths: {},
			recentLogs: Array.from({ length: 250 }, (_, index) => ({
				timestamp: new Date(index * 1000).toISOString(),
				level: "debug",
				event: "health.run",
			})),
			now: () => new Date(0),
		});

		expect(bundle.app).toEqual({
			version: "0.6.0",
			platform: "win32",
			arch: "x64",
		});
		expect(bundle.stateShape).toEqual({
			projectCount: 0,
			workspaceCount: 0,
			tabCount: 0,
			paneCount: 1,
			accountCount: 1,
			remoteHostCount: 1,
			unavailableMetricCount: 3,
		});
		expect(bundle.recentEvents).toHaveLength(100);
		expect(bundle.recentEvents[0]?.timestamp).toBe(
			new Date(150 * 1000).toISOString(),
		);
	});

	it("returns cancellation without writing and propagates write failures", async () => {
		let writes = 0;
		const canceled = await exportDiagnostics({
			chooseDestination: async () => null,
			createBundle: async () => ({ schemaVersion: 1 }),
			writeFile: async () => {
				writes += 1;
			},
		});
		expect(canceled).toEqual({ canceled: true, path: null });
		expect(writes).toBe(0);

		expect(
			exportDiagnostics({
				chooseDestination: async () => "C:\\safe\\diagnostics.json",
				createBundle: async () => ({ schemaVersion: 1 }),
				writeFile: async () => {
					throw new Error("disk full");
				},
			}),
		).rejects.toThrow("disk full");
	});
});
