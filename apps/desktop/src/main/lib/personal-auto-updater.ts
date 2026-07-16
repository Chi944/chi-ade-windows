import {
	AUTO_UPDATE_READY_ACTION,
	AUTO_UPDATE_STATUS,
	type AutoUpdateReadyAction,
	type AutoUpdateStatus,
} from "../../shared/auto-update";
import {
	isPersonalUpdateAvailable,
	PERSONAL_UPDATE_MANIFEST_URL,
	type PersonalUpdateManifest,
	parsePersonalUpdateManifest,
	selectPersonalUpdateAsset,
} from "../../shared/personal-update";
import {
	downloadPersonalUpdate,
	openVerifiedPersonalUpdate,
	type PersonalUpdateFetch,
	type VerifiedPersonalUpdate,
} from "./personal-update-downloader";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const NETWORK_ERROR_PATTERNS = [
	"net::ERR_INTERNET_DISCONNECTED",
	"net::ERR_NETWORK_CHANGED",
	"net::ERR_CONNECTION_REFUSED",
	"net::ERR_NAME_NOT_RESOLVED",
	"net::ERR_CONNECTION_TIMED_OUT",
	"net::ERR_CONNECTION_RESET",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNRESET",
] as const;

export interface PersonalBuildIdentity {
	commitSha: string;
	buildNumber: number;
}

export interface PersonalUpdateStatusEvent {
	status: AutoUpdateStatus;
	version?: string;
	error?: string;
	progress?: number;
	readyAction?: AutoUpdateReadyAction;
}

export interface PersonalUpdateControllerOptions {
	installedVersion: string;
	installedBuildNumber: number;
	platform: string;
	arch: string;
	updatesDirectory: string;
	fetch: PersonalUpdateFetch;
	download?: typeof downloadPersonalUpdate;
	open?: typeof openVerifiedPersonalUpdate;
	confirm: (details: {
		version: string;
		buildNumber: number;
		name: string;
	}) => Promise<boolean>;
	createSnapshot: () => Promise<void>;
	openPath: (path: string) => Promise<string>;
	showUpToDate?: () => Promise<void>;
	onStatus: (event: PersonalUpdateStatusEvent) => void;
}

export interface PersonalUpdateController {
	check(options?: { interactive?: boolean }): Promise<void>;
	download(): Promise<void>;
	install(): Promise<void>;
	dismiss(): void;
	getStatus(): PersonalUpdateStatusEvent;
}

export function parsePersonalBuildIdentity(
	commitSha: string | undefined,
	buildNumberValue: string | undefined,
): PersonalBuildIdentity | undefined {
	if (!commitSha && !buildNumberValue) return undefined;
	if (
		!commitSha ||
		!buildNumberValue ||
		!COMMIT_SHA_PATTERN.test(commitSha) ||
		!/^[0-9]+$/.test(buildNumberValue)
	) {
		throw new Error("Invalid embedded personal build identity");
	}
	const buildNumber = Number(buildNumberValue);
	if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) {
		throw new Error("Invalid embedded personal build identity");
	}
	return { commitSha, buildNumber };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isPersonalUpdateNetworkError(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		const record = current as {
			code?: unknown;
			cause?: unknown;
			message?: unknown;
		};
		const message =
			typeof record.message === "string" ? record.message : String(current);
		const code = typeof record.code === "string" ? record.code : "";
		if (
			NETWORK_ERROR_PATTERNS.some(
				(pattern) => message.includes(pattern) || code === pattern,
			)
		) {
			return true;
		}
		current = record.cause;
	}
	return false;
}

export function createPersonalUpdateController(
	options: PersonalUpdateControllerOptions,
): PersonalUpdateController {
	const download = options.download ?? downloadPersonalUpdate;
	const open = options.open ?? openVerifiedPersonalUpdate;
	let status: PersonalUpdateStatusEvent = {
		status: AUTO_UPDATE_STATUS.IDLE,
	};
	let currentManifest: PersonalUpdateManifest | undefined;
	let verified: VerifiedPersonalUpdate | undefined;
	let installInFlight: Promise<void> | undefined;

	const emit = (event: PersonalUpdateStatusEvent) => {
		status = { ...event };
		options.onStatus({ ...event });
	};

	return {
		async check(checkOptions = {}) {
			if (
				status.status === AUTO_UPDATE_STATUS.CHECKING ||
				status.status === AUTO_UPDATE_STATUS.DOWNLOADING
			) {
				return;
			}
			if (status.status === AUTO_UPDATE_STATUS.READY && verified) {
				emit({
					status: AUTO_UPDATE_STATUS.READY,
					version: verified.version,
					readyAction: AUTO_UPDATE_READY_ACTION.OPEN_INSTALLER,
				});
				return;
			}

			emit({ status: AUTO_UPDATE_STATUS.CHECKING });
			let response: Response;
			try {
				response = await options.fetch(PERSONAL_UPDATE_MANIFEST_URL, {
					cache: "no-store",
					headers: { accept: "application/json" },
				});
			} catch (error) {
				if (isPersonalUpdateNetworkError(error)) {
					emit({ status: AUTO_UPDATE_STATUS.IDLE });
					return;
				}
				emit({
					status: AUTO_UPDATE_STATUS.ERROR,
					error: `Personal update manifest check failed: ${errorMessage(error)}`,
				});
				return;
			}

			if (!response.ok) {
				emit({
					status: AUTO_UPDATE_STATUS.ERROR,
					error: `Personal update manifest check failed: Personal update manifest request failed with HTTP ${response.status}`,
				});
				return;
			}

			let responseText: string;
			try {
				responseText = await response.text();
			} catch (error) {
				if (isPersonalUpdateNetworkError(error)) {
					emit({ status: AUTO_UPDATE_STATUS.IDLE });
					return;
				}
				emit({
					status: AUTO_UPDATE_STATUS.ERROR,
					error: `Personal update manifest check failed: ${errorMessage(error)}`,
				});
				return;
			}

			let document: unknown;
			try {
				document = JSON.parse(responseText);
			} catch (error) {
				emit({
					status: AUTO_UPDATE_STATUS.ERROR,
					error: `Personal update manifest check failed: ${errorMessage(error)}`,
				});
				return;
			}

			try {
				const manifest = parsePersonalUpdateManifest(document);
				selectPersonalUpdateAsset(manifest, options.platform, options.arch);
				if (
					isPersonalUpdateAvailable(
						manifest,
						options.installedVersion,
						options.installedBuildNumber,
					)
				) {
					currentManifest = manifest;
					verified = undefined;
					emit({
						status: AUTO_UPDATE_STATUS.AVAILABLE,
						version: manifest.version,
					});
					return;
				}

				currentManifest = undefined;
				verified = undefined;
				emit({ status: AUTO_UPDATE_STATUS.IDLE });
				if (checkOptions.interactive) await options.showUpToDate?.();
			} catch (error) {
				emit({
					status: AUTO_UPDATE_STATUS.ERROR,
					error: `Personal update manifest check failed: ${errorMessage(error)}`,
				});
			}
		},

		async download() {
			if (status.status !== AUTO_UPDATE_STATUS.AVAILABLE || !currentManifest) {
				return;
			}
			const manifest = currentManifest;
			emit({
				status: AUTO_UPDATE_STATUS.DOWNLOADING,
				version: manifest.version,
				progress: 0,
			});
			try {
				verified = await download({
					manifest,
					platform: options.platform,
					arch: options.arch,
					updatesDirectory: options.updatesDirectory,
					fetch: options.fetch,
					getCurrentManifest: () => currentManifest,
					onProgress: (progress) => {
						emit({
							status: AUTO_UPDATE_STATUS.DOWNLOADING,
							version: manifest.version,
							progress,
						});
					},
				});
				emit({
					status: AUTO_UPDATE_STATUS.READY,
					version: verified.version,
					readyAction: AUTO_UPDATE_READY_ACTION.OPEN_INSTALLER,
				});
			} catch (error) {
				verified = undefined;
				emit({
					status: AUTO_UPDATE_STATUS.ERROR,
					version: manifest.version,
					error: errorMessage(error),
				});
			}
		},

		install() {
			if (installInFlight) return installInFlight;
			if (status.status !== AUTO_UPDATE_STATUS.READY || !verified) {
				return Promise.resolve();
			}

			const candidate = verified;
			const operation = (async () => {
				try {
					await open({
						verified: candidate,
						getCurrentManifest: () => currentManifest,
						confirm: options.confirm,
						createSnapshot: options.createSnapshot,
						openPath: options.openPath,
					});
					if (
						verified === candidate &&
						status.status === AUTO_UPDATE_STATUS.READY
					) {
						emit({
							status: AUTO_UPDATE_STATUS.READY,
							version: candidate.version,
							readyAction: AUTO_UPDATE_READY_ACTION.OPEN_INSTALLER,
						});
					}
				} catch (error) {
					emit({
						status: AUTO_UPDATE_STATUS.ERROR,
						version: candidate.version,
						error: errorMessage(error),
					});
				}
			})().finally(() => {
				if (installInFlight === operation) installInFlight = undefined;
			});
			installInFlight = operation;
			return operation;
		},

		dismiss() {
			emit({ status: AUTO_UPDATE_STATUS.IDLE });
		},

		getStatus() {
			return { ...status };
		},
	};
}
