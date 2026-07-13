import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { findRealBinariesAsync } from "main/lib/agent-setup/utils";
import { probeBinaryCommand } from "main/lib/runtime-availability";
import desktopPackage from "../../../package.json";
import { buildCliProcessEnvironment } from "./cli-process-env";
import { getSubscriptionProfileEnvironment } from "./subscription-profiles";
import { treeKillWithEscalation } from "./tree-kill";

export interface CodexRateLimitWindow {
	id: string;
	label: string | null;
	usedPercent: number;
	windowDurationMins: number | null;
	resetsAt: number | null;
}

export interface CodexAccountUsage {
	available: boolean;
	authenticated: boolean;
	email: string | null;
	planType: string | null;
	windows: CodexRateLimitWindow[];
	summary: {
		lifetimeTokens: number | null;
		peakDailyTokens: number | null;
		longestRunningTurnSec: number | null;
		currentStreakDays: number | null;
		longestStreakDays: number | null;
	} | null;
	fetchedAt: number;
	error?: string;
}

interface JsonRpcResponse {
	id?: number;
	result?: unknown;
	error?: { message?: string };
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown, maxLength = 160): string | null {
	return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function emptyUsage(error?: string): CodexAccountUsage {
	return {
		available: false,
		authenticated: false,
		email: null,
		planType: null,
		windows: [],
		summary: null,
		fetchedAt: Date.now(),
		...(error ? { error } : {}),
	};
}

export function parseCodexRateLimitWindows(
	limitsResultValue: unknown,
): CodexRateLimitWindow[] {
	const limitsResult = recordOrNull(limitsResultValue);
	const limitsById = recordOrNull(limitsResult?.rateLimitsByLimitId);
	const fallbackLimit = recordOrNull(limitsResult?.rateLimits);
	const limitEntries = limitsById
		? Object.entries(limitsById)
		: fallbackLimit
			? [[String(fallbackLimit.limitId ?? "codex"), fallbackLimit] as const]
			: [];

	return limitEntries.flatMap(([rawId, raw]) => {
		const limit = recordOrNull(raw);
		if (!limit) return [];
		const windows = (["primary", "secondary"] as const).flatMap((kind) => {
			const window = recordOrNull(limit[kind]);
			const usedPercent = numberOrNull(window?.usedPercent);
			if (!window || usedPercent === null) return [];
			return [{ kind, window, usedPercent }];
		});
		const baseId = rawId.slice(0, 100);
		const baseLabel = stringOrNull(limit.limitName) ?? baseId;
		return windows.map(({ kind, window, usedPercent }) => ({
			id: windows.length > 1 ? `${baseId}:${kind}` : baseId,
			label: windows.length > 1 ? `${baseLabel} · ${kind}` : baseLabel,
			usedPercent: Math.min(100, Math.max(0, usedPercent)),
			windowDurationMins: numberOrNull(window.windowDurationMins),
			resetsAt: numberOrNull(window.resetsAt),
		}));
	});
}

export function getCodexUsageReadError(input: {
	account: boolean;
	rateLimits: boolean;
	usage: boolean;
}): string | null {
	if (input.account) return "Codex account status is unavailable";
	if (input.rateLimits && input.usage) {
		return "Codex usage and rate-limit status are unavailable";
	}
	if (input.rateLimits) return "Codex rate-limit status is unavailable";
	if (input.usage) return "Codex usage summary is unavailable";
	return null;
}

export function buildCodexAppServerLaunch(
	binary: string,
	platform: NodeJS.Platform = process.platform,
	comSpec = process.env.ComSpec,
): {
	executable: string;
	args: string[];
	windowsVerbatimArguments: boolean;
} {
	const isWindowsScript =
		platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);
	return {
		executable: isWindowsScript ? (comSpec ?? "cmd.exe") : binary,
		args: isWindowsScript
			? ["/d", "/s", "/c", `""${binary}" app-server"`]
			: ["app-server"],
		windowsVerbatimArguments: isWindowsScript,
	};
}

export async function readSelectedCodexAccountUsage(): Promise<CodexAccountUsage> {
	const profileEnvironment =
		getSubscriptionProfileEnvironment("codex").environment;
	const childEnvironment = buildCliProcessEnvironment(profileEnvironment);
	let binary: string | undefined;
	for (const candidate of await findRealBinariesAsync("codex", {
		env: childEnvironment,
	})) {
		if (
			await probeBinaryCommand(candidate, ["--version"], {
				env: childEnvironment,
			})
		) {
			binary = candidate;
			break;
		}
	}
	if (!binary) return emptyUsage("Codex CLI is not installed");

	const launch = buildCodexAppServerLaunch(binary);

	return new Promise((resolve) => {
		let settled = false;
		let initialized = false;
		let lines: ReturnType<typeof createInterface> | null = null;
		const responses = new Map<number, JsonRpcResponse>();
		const finish = (usage: CodexAccountUsage) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			lines?.close();
			try {
				child.stdin.end();
			} catch {
				// Process may already be gone.
			}
			if (child.pid) {
				void treeKillWithEscalation({
					pid: child.pid,
					escalationTimeoutMs: 750,
				});
			}
			resolve(usage);
		};

		const child = spawn(launch.executable, launch.args, {
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
			windowsVerbatimArguments: launch.windowsVerbatimArguments,
			shell: false,
			env: childEnvironment,
		});
		const send = (message: unknown) => {
			try {
				if (!child.stdin.destroyed) {
					child.stdin.write(`${JSON.stringify(message)}\n`);
				}
			} catch {
				finish(emptyUsage("Codex app-server input closed unexpectedly"));
			}
		};
		const timeout = setTimeout(
			() => finish(emptyUsage("Codex usage probe timed out")),
			6_000,
		);

		child.once("error", () => finish(emptyUsage("Could not start Codex CLI")));
		child.stdin.once("error", () =>
			finish(emptyUsage("Codex app-server input closed unexpectedly")),
		);
		child.once("exit", (_code) => {
			if (!settled) {
				finish(emptyUsage("Codex app-server exited before returning usage"));
			}
		});

		lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			let message: JsonRpcResponse;
			try {
				message = JSON.parse(line) as JsonRpcResponse;
			} catch {
				return;
			}
			if (typeof message.id !== "number") return;
			responses.set(message.id, message);

			if (message.id === 0 && !initialized) {
				initialized = true;
				send({ method: "initialized", params: {} });
				send({
					method: "account/read",
					id: 1,
					params: { refreshToken: false },
				});
				send({ method: "account/rateLimits/read", id: 2 });
				send({ method: "account/usage/read", id: 3 });
				return;
			}

			if (![1, 2, 3].every((id) => responses.has(id))) return;
			const accountResult = recordOrNull(responses.get(1)?.result);
			const account = recordOrNull(accountResult?.account);
			const windows = parseCodexRateLimitWindows(responses.get(2)?.result);
			const usageResult = recordOrNull(responses.get(3)?.result);
			const summaryRecord = recordOrNull(usageResult?.summary);
			const readError = getCodexUsageReadError({
				account: Boolean(responses.get(1)?.error?.message),
				rateLimits: Boolean(responses.get(2)?.error?.message),
				usage: Boolean(responses.get(3)?.error?.message),
			});
			finish({
				available: true,
				authenticated: account !== null,
				email: stringOrNull(account?.email, 254),
				planType: stringOrNull(account?.planType, 80),
				windows,
				summary: summaryRecord
					? {
							lifetimeTokens: numberOrNull(summaryRecord.lifetimeTokens),
							peakDailyTokens: numberOrNull(summaryRecord.peakDailyTokens),
							longestRunningTurnSec: numberOrNull(
								summaryRecord.longestRunningTurnSec,
							),
							currentStreakDays: numberOrNull(summaryRecord.currentStreakDays),
							longestStreakDays: numberOrNull(summaryRecord.longestStreakDays),
						}
					: null,
				fetchedAt: Date.now(),
				...(readError ? { error: readError } : {}),
			});
		});

		send({
			method: "initialize",
			id: 0,
			params: {
				clientInfo: {
					name: "chi_ade_windows",
					title: "Chi ADE",
					version: appVersion(),
				},
			},
		});
	});
}

function appVersion(): string {
	return process.env.npm_package_version || desktopPackage.version;
}
