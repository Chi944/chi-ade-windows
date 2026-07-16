import { describe, expect, mock, test } from "bun:test";
import {
	AUTO_UPDATE_READY_ACTION,
	AUTO_UPDATE_STATUS,
} from "../../shared/auto-update";
import {
	parsePersonalUpdateManifest,
	selectPersonalUpdateAsset,
} from "../../shared/personal-update";
import {
	createPersonalUpdateController,
	type PersonalUpdateStatusEvent,
	parsePersonalBuildIdentity,
} from "./personal-auto-updater";
import type { DownloadPersonalUpdateOptions } from "./personal-update-downloader";

const MANIFEST = {
	schemaVersion: 1,
	version: "0.6.0",
	buildNumber: 20,
	commitSha: "0123456789abcdef0123456789abcdef01234567",
	publishedAt: "2026-07-16T01:02:03.000Z",
	releaseNotesUrl:
		"https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest",
	assets: {
		"win32-x64": {
			name: "ADE-Windows-x64.exe",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
			size: 9,
			sha256: "a".repeat(64),
		},
		"darwin-arm64": {
			name: "ADE-macOS-Apple-Silicon.dmg",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Apple-Silicon.dmg",
			size: 10,
			sha256: "b".repeat(64),
		},
		"darwin-x64": {
			name: "ADE-macOS-Intel.dmg",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Intel.dmg",
			size: 11,
			sha256: "c".repeat(64),
		},
	},
};

function manifestResponse(value: unknown = MANIFEST): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function setup(
	overrides: Partial<Parameters<typeof createPersonalUpdateController>[0]> = {},
) {
	const events: PersonalUpdateStatusEvent[] = [];
	const download = mock(async (options: DownloadPersonalUpdateOptions) => {
		options.onProgress?.(25);
		return Object.freeze({
			path: "C:\\updates\\0.6.0\\ADE-Windows-x64.exe",
			version: "0.6.0",
			buildNumber: 20,
			commitSha: MANIFEST.commitSha,
			manifestFingerprint: "fingerprint",
			asset: selectPersonalUpdateAsset(
				parsePersonalUpdateManifest(MANIFEST),
				"win32",
				"x64",
			),
			reused: false,
		});
	});
	const open = mock(async () => "opened" as const);
	const showUpToDate = mock(async () => {});
	const controller = createPersonalUpdateController({
		installedVersion: "0.5.0",
		installedBuildNumber: 10,
		platform: "win32",
		arch: "x64",
		updatesDirectory: "C:\\updates",
		fetch: mock(async () => manifestResponse()),
		download,
		open,
		confirm: mock(async () => true),
		createSnapshot: mock(async () => {}),
		openPath: mock(async () => ""),
		showUpToDate,
		onStatus: (event) => events.push(event),
		...overrides,
	});
	return { controller, download, events, open, showUpToDate };
}

describe("parsePersonalBuildIdentity", () => {
	test("selects legacy mode only when both embedded values are absent", () => {
		expect(parsePersonalBuildIdentity(undefined, undefined)).toBeUndefined();
		expect(parsePersonalBuildIdentity("", "")).toBeUndefined();
	});

	test("accepts an exact lowercase full SHA and positive safe build number", () => {
		expect(
			parsePersonalBuildIdentity(
				"0123456789abcdef0123456789abcdef01234567",
				"123456",
			),
		).toEqual({
			commitSha: "0123456789abcdef0123456789abcdef01234567",
			buildNumber: 123_456,
		});
	});

	test.each([
		["partial SHA", "0123456789abcdef0123456789abcdef01234567", ""],
		["partial number", "", "123"],
		["uppercase SHA", "A".repeat(40), "123"],
		["short SHA", "a".repeat(39), "123"],
		["zero number", "a".repeat(40), "0"],
		["fractional number", "a".repeat(40), "1.5"],
		["unsafe number", "a".repeat(40), String(Number.MAX_SAFE_INTEGER + 1)],
	])("fails closed for %s", (_label, sha, buildNumber) => {
		expect(() => parsePersonalBuildIdentity(sha, buildNumber)).toThrow(
			"personal build identity",
		);
	});
});

describe("personal update controller", () => {
	test("a background check only announces an available update", async () => {
		const { controller, download, events } = setup();

		await controller.check();

		expect(events.map(({ status }) => status)).toEqual([
			AUTO_UPDATE_STATUS.CHECKING,
			AUTO_UPDATE_STATUS.AVAILABLE,
		]);
		expect(controller.getStatus()).toEqual({
			status: AUTO_UPDATE_STATUS.AVAILABLE,
			version: "0.6.0",
		});
		expect(download).not.toHaveBeenCalled();
	});

	test("an interactive check reports when the installed build is current", async () => {
		const showUpToDate = mock(async () => {});
		const { controller, events } = setup({
			installedVersion: "0.6.0",
			installedBuildNumber: 20,
			showUpToDate,
		});

		await controller.check({ interactive: true });

		expect(events.at(-1)).toEqual({ status: AUTO_UPDATE_STATUS.IDLE });
		expect(showUpToDate).toHaveBeenCalledTimes(1);
	});

	test("nested network-loss errors return quietly to Idle", async () => {
		const networkCause = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
			code: "ENOTFOUND",
		});
		const { controller, events } = setup({
			fetch: mock(async () => {
				throw new Error("fetch failed", { cause: networkCause });
			}),
		});

		await controller.check();

		expect(events.at(-1)).toEqual({ status: AUTO_UPDATE_STATUS.IDLE });
		expect(controller.getStatus()).toEqual({
			status: AUTO_UPDATE_STATUS.IDLE,
		});
	});

	test("network loss while reading a successful response returns quietly to Idle", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.error(
					Object.assign(new Error("response body reset"), {
						code: "ECONNRESET",
					}),
				);
			},
		});
		const { controller, events } = setup({
			fetch: mock(async () => new Response(stream, { status: 200 })),
		});

		await controller.check();

		expect(events.at(-1)).toEqual({ status: AUTO_UPDATE_STATUS.IDLE });
		expect(controller.getStatus()).toEqual({
			status: AUTO_UPDATE_STATUS.IDLE,
		});
	});

	test("schema and origin failures remain visible to late subscribers", async () => {
		const invalid = structuredClone(MANIFEST);
		invalid.assets["win32-x64"].url = "https://example.com/ADE-Windows-x64.exe";
		const { controller, events } = setup({
			fetch: mock(async () => manifestResponse(invalid)),
		});

		await controller.check();

		expect(events.at(-1)?.status).toBe(AUTO_UPDATE_STATUS.ERROR);
		expect(controller.getStatus().status).toBe(AUTO_UPDATE_STATUS.ERROR);
		expect(controller.getStatus().error).toContain("manifest");
	});

	test("does not silence schema errors containing a network-error token", async () => {
		const invalid = { ...structuredClone(MANIFEST), ENOTFOUND: true };
		const { controller, events } = setup({
			fetch: mock(async () => manifestResponse(invalid)),
		});

		await controller.check();

		expect(events.at(-1)?.status).toBe(AUTO_UPDATE_STATUS.ERROR);
		expect(controller.getStatus().error).toContain("manifest");
	});

	test("dismiss transitions the durable state to Idle", async () => {
		const { controller, events } = setup();
		await controller.check();

		controller.dismiss();

		expect(controller.getStatus()).toEqual({
			status: AUTO_UPDATE_STATUS.IDLE,
		});
		expect(events.at(-1)).toEqual({ status: AUTO_UPDATE_STATUS.IDLE });
	});

	test("download begins only after the explicit action and reaches Ready", async () => {
		const { controller, download, events } = setup();
		await controller.check();

		await controller.download();

		expect(download).toHaveBeenCalledTimes(1);
		expect(events.slice(-3)).toEqual([
			{
				status: AUTO_UPDATE_STATUS.DOWNLOADING,
				version: "0.6.0",
				progress: 0,
			},
			{
				status: AUTO_UPDATE_STATUS.DOWNLOADING,
				version: "0.6.0",
				progress: 25,
			},
			{
				status: AUTO_UPDATE_STATUS.READY,
				version: "0.6.0",
				readyAction: AUTO_UPDATE_READY_ACTION.OPEN_INSTALLER,
			},
		]);
	});

	test("install delegates the second confirmation and verified open only from Ready", async () => {
		const { controller, open } = setup();
		await controller.install();
		expect(open).not.toHaveBeenCalled();
		await controller.check();
		await controller.download();

		await controller.install();

		expect(open).toHaveBeenCalledTimes(1);
		expect(controller.getStatus()).toEqual({
			status: AUTO_UPDATE_STATUS.READY,
			version: "0.6.0",
			readyAction: AUTO_UPDATE_READY_ACTION.OPEN_INSTALLER,
		});
	});

	test("serializes concurrent installer-open requests", async () => {
		let releaseOpen: (() => void) | undefined;
		const open = mock(
			() =>
				new Promise<"opened">((resolve) => {
					releaseOpen = () => resolve("opened");
				}),
		);
		const { controller } = setup({ open });
		await controller.check();
		await controller.download();

		const first = controller.install();
		await Promise.resolve();
		const second = controller.install();

		expect(open).toHaveBeenCalledTimes(1);
		releaseOpen?.();
		await Promise.all([first, second]);
		expect(open).toHaveBeenCalledTimes(1);
	});

	test("a verified-open failure becomes a visible error", async () => {
		const { controller } = setup({
			open: mock(async () => {
				throw new Error("Snapshot failed");
			}),
		});
		await controller.check();
		await controller.download();

		await controller.install();

		expect(controller.getStatus()).toEqual({
			status: AUTO_UPDATE_STATUS.ERROR,
			version: "0.6.0",
			error: "Snapshot failed",
		});
	});
});
