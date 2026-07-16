import { describe, expect, test } from "bun:test";
import {
	isPersonalUpdateAvailable,
	parsePersonalUpdateManifest,
	selectPersonalUpdateAsset,
} from "./personal-update";

const VALID_MANIFEST = {
	schemaVersion: 1,
	version: "0.6.0",
	buildNumber: 123_456,
	commitSha: "0123456789abcdef0123456789abcdef01234567",
	publishedAt: "2026-07-16T01:02:03.000Z",
	releaseNotesUrl:
		"https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest",
	assets: {
		"win32-x64": {
			name: "ADE-Windows-x64.exe",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
			size: 101,
			sha256:
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		"darwin-arm64": {
			name: "ADE-macOS-Apple-Silicon.dmg",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Apple-Silicon.dmg",
			size: 202,
			sha256:
				"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		},
		"darwin-x64": {
			name: "ADE-macOS-Intel.dmg",
			url: "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Intel.dmg",
			size: 303,
			sha256:
				"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		},
	},
} as const;

type MutableManifest = {
	schemaVersion: unknown;
	version: unknown;
	buildNumber: unknown;
	commitSha: unknown;
	publishedAt: unknown;
	releaseNotesUrl: unknown;
	assets: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
};

function manifestWith(mutator: (manifest: MutableManifest) => void) {
	const manifest = structuredClone(
		VALID_MANIFEST,
	) as unknown as MutableManifest;
	mutator(manifest);
	return manifest;
}

describe("parsePersonalUpdateManifest", () => {
	test("accepts the exact v1 manifest and returns a deeply immutable value", () => {
		const parsed = parsePersonalUpdateManifest(VALID_MANIFEST);

		expect(parsed).toEqual(VALID_MANIFEST);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.assets)).toBe(true);
		expect(Object.isFrozen(parsed.assets["win32-x64"])).toBe(true);
	});

	test.each([
		["schema version", (value: MutableManifest) => (value.schemaVersion = 2)],
		["semantic version", (value: MutableManifest) => (value.version = "v0.6")],
		[
			"positive build number",
			(value: MutableManifest) => (value.buildNumber = 0),
		],
		[
			"integer build number",
			(value: MutableManifest) => (value.buildNumber = 1.5),
		],
		[
			"safe build number",
			(value: MutableManifest) =>
				(value.buildNumber = Number.MAX_SAFE_INTEGER + 1),
		],
		[
			"lowercase commit SHA",
			(value: MutableManifest) => (value.commitSha = "A".repeat(40)),
		],
		[
			"full commit SHA",
			(value: MutableManifest) => (value.commitSha = "a".repeat(39)),
		],
		[
			"ISO publication time",
			(value: MutableManifest) => (value.publishedAt = "yesterday"),
		],
		[
			"exact release notes URL",
			(value: MutableManifest) =>
				(value.releaseNotesUrl =
					"https://github.com/Chi944/chi-ade-windows/releases/latest"),
		],
		[
			"positive asset size",
			(value: MutableManifest) => (value.assets["win32-x64"].size = 0),
		],
		[
			"safe integer asset size",
			(value: MutableManifest) =>
				(value.assets["win32-x64"].size = Number.MAX_SAFE_INTEGER + 1),
		],
		[
			"lowercase SHA-256",
			(value: MutableManifest) =>
				(value.assets["win32-x64"].sha256 = "A".repeat(64)),
		],
		[
			"full SHA-256",
			(value: MutableManifest) =>
				(value.assets["win32-x64"].sha256 = "a".repeat(63)),
		],
	])("rejects an invalid %s", (_label, mutate) => {
		expect(() => parsePersonalUpdateManifest(manifestWith(mutate))).toThrow();
	});

	test.each([
		[
			"another repository",
			"https://github.com/example/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
		],
		[
			"HTTP",
			"http://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
		],
		[
			"a different tag",
			"https://github.com/Chi944/chi-ade-windows/releases/download/v0.6.0/ADE-Windows-x64.exe",
		],
		[
			"a query string",
			"https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe?download=1",
		],
		[
			"credentials",
			"https://token@github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
		],
	])("rejects an asset URL using %s", (_label, url) => {
		expect(() =>
			parsePersonalUpdateManifest(
				manifestWith((value) => {
					value.assets["win32-x64"].url = url;
				}),
			),
		).toThrow();
	});

	test.each([
		"../ADE-Windows-x64.exe",
		"folder/ADE-Windows-x64.exe",
		"ADE\\Windows.exe",
	])("rejects the path-like asset name %s", (name) => {
		expect(() =>
			parsePersonalUpdateManifest(
				manifestWith((value) => {
					value.assets["win32-x64"].name = name;
				}),
			),
		).toThrow();
	});

	test("requires exactly the three supported platform assets", () => {
		expect(() =>
			parsePersonalUpdateManifest(
				manifestWith((value) => {
					delete value.assets["darwin-x64"];
				}),
			),
		).toThrow();
		expect(() =>
			parsePersonalUpdateManifest(
				manifestWith((value) => {
					value.assets["linux-x64"] = value.assets["win32-x64"];
				}),
			),
		).toThrow();
	});

	test("rejects duplicate asset URLs", () => {
		expect(() =>
			parsePersonalUpdateManifest(
				manifestWith((value) => {
					value.assets["darwin-x64"].url = value.assets["win32-x64"].url;
				}),
			),
		).toThrow();
	});

	test("rejects excess fields at every payload level", () => {
		expect(() =>
			parsePersonalUpdateManifest(
				manifestWith((value) => {
					value.channel = "personal";
				}),
			),
		).toThrow();
		expect(() =>
			parsePersonalUpdateManifest(
				manifestWith((value) => {
					value.assets["win32-x64"].signature = "none";
				}),
			),
		).toThrow();
	});
});

describe("selectPersonalUpdateAsset", () => {
	const parsed = parsePersonalUpdateManifest(VALID_MANIFEST);

	test.each([
		["win32", "x64", "ADE-Windows-x64.exe"],
		["darwin", "arm64", "ADE-macOS-Apple-Silicon.dmg"],
		["darwin", "x64", "ADE-macOS-Intel.dmg"],
	])("selects %s-%s", (platform, arch, name) => {
		expect(String(selectPersonalUpdateAsset(parsed, platform, arch).name)).toBe(
			name,
		);
	});

	test.each([
		["win32", "arm64"],
		["darwin", "ia32"],
		["linux", "x64"],
	])("rejects unsupported %s-%s", (platform, arch) => {
		expect(() => selectPersonalUpdateAsset(parsed, platform, arch)).toThrow(
			"Unsupported update platform",
		);
	});
});

describe("isPersonalUpdateAvailable", () => {
	const parsed = parsePersonalUpdateManifest(VALID_MANIFEST);

	test("prefers a greater semantic version regardless of build number", () => {
		expect(isPersonalUpdateAvailable(parsed, "0.5.9", 999_999)).toBe(true);
		expect(isPersonalUpdateAvailable(parsed, "0.7.0", 1)).toBe(false);
	});

	test("uses the monotonic build number only when versions are equal", () => {
		expect(isPersonalUpdateAvailable(parsed, "0.6.0", 123_455)).toBe(true);
		expect(isPersonalUpdateAvailable(parsed, "0.6.0", 123_456)).toBe(false);
		expect(isPersonalUpdateAvailable(parsed, "0.6.0", 123_457)).toBe(false);
	});

	test("uses semantic prerelease ordering", () => {
		expect(isPersonalUpdateAvailable(parsed, "0.6.0-beta.2", 999_999)).toBe(
			true,
		);
	});

	test("rejects invalid installed build identity", () => {
		expect(() => isPersonalUpdateAvailable(parsed, "latest", 1)).toThrow();
		expect(() => isPersonalUpdateAvailable(parsed, "0.6.0", 0)).toThrow();
	});
});
