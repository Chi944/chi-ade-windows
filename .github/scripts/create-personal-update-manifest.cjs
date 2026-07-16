#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { createReadStream, statSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { basename, join, resolve } = require("node:path");

const MANIFEST_NAME = "ade-personal-update-v1.json";
const RELEASE_NOTES_URL =
	"https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest";
const DOWNLOAD_BASE_URL =
	"https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/";
const ASSET_DEFINITIONS = [
	["win32-x64", "ADE-Windows-x64.exe"],
	["darwin-arm64", "ADE-macOS-Apple-Silicon.dmg"],
	["darwin-x64", "ADE-macOS-Intel.dmg"],
];
const SEMVER_PATTERN =
	/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function assertExactKeys(value, expected, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (
		actual.length !== sortedExpected.length ||
		actual.some((key, index) => key !== sortedExpected[index])
	) {
		throw new Error(`${label} has an unexpected or missing field`);
	}
}

function assertPositiveSafeInteger(value, label) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive safe integer`);
	}
}

function assertPersonalUpdateManifest(manifest) {
	assertExactKeys(
		manifest,
		[
			"schemaVersion",
			"version",
			"buildNumber",
			"commitSha",
			"publishedAt",
			"releaseNotesUrl",
			"assets",
		],
		"personal update manifest",
	);
	if (manifest.schemaVersion !== 1) {
		throw new Error("personal update manifest schemaVersion must be 1");
	}
	if (
		typeof manifest.version !== "string" ||
		!SEMVER_PATTERN.test(manifest.version)
	) {
		throw new Error("version must be a canonical semantic version");
	}
	assertPositiveSafeInteger(manifest.buildNumber, "build number");
	if (
		typeof manifest.commitSha !== "string" ||
		!/^[0-9a-f]{40}$/.test(manifest.commitSha)
	) {
		throw new Error("commit SHA must be 40 lowercase hexadecimal characters");
	}
	if (
		typeof manifest.publishedAt !== "string" ||
		Number.isNaN(Date.parse(manifest.publishedAt)) ||
		new Date(manifest.publishedAt).toISOString() !== manifest.publishedAt
	) {
		throw new Error("publishedAt must be a canonical ISO-8601 timestamp");
	}
	if (manifest.releaseNotesUrl !== RELEASE_NOTES_URL) {
		throw new Error("release notes URL does not match personal-latest");
	}

	assertExactKeys(
		manifest.assets,
		ASSET_DEFINITIONS.map(([key]) => key),
		"personal update assets",
	);
	const urls = new Set();
	for (const [key, name] of ASSET_DEFINITIONS) {
		const asset = manifest.assets[key];
		assertExactKeys(asset, ["name", "url", "size", "sha256"], `${key} asset`);
		if (asset.name !== name) throw new Error(`${key} asset name is unexpected`);
		const expectedUrl = `${DOWNLOAD_BASE_URL}${name}`;
		if (asset.url !== expectedUrl)
			throw new Error(`${key} asset URL is unexpected`);
		if (urls.has(asset.url))
			throw new Error("asset URLs must not be duplicate");
		urls.add(asset.url);
		assertPositiveSafeInteger(asset.size, `${key} asset size`);
		if (
			typeof asset.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(asset.sha256)
		) {
			throw new Error(`${key} asset SHA-256 is invalid`);
		}
	}
	return manifest;
}

function sha256(path) {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("error", reject)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolveHash(hash.digest("hex")));
	});
}

async function createPersonalUpdateManifest(options) {
	if (!Array.isArray(options.assetPaths) || options.assetPaths.length !== 3) {
		throw new Error("Personal update manifest requires exactly three assets");
	}
	const resolvedPaths = options.assetPaths.map((path) => resolve(path));
	const uniquePaths = new Set(
		resolvedPaths.map((path) =>
			process.platform === "win32" ? path.toLowerCase() : path,
		),
	);
	if (uniquePaths.size !== resolvedPaths.length) {
		throw new Error("Personal update asset paths contain a duplicate");
	}
	const byName = new Map();
	for (const path of resolvedPaths) {
		const name = basename(path);
		if (!ASSET_DEFINITIONS.some(([, expected]) => expected === name)) {
			throw new Error(`Unexpected personal update asset: ${name}`);
		}
		if (byName.has(name))
			throw new Error(`Duplicate personal update asset: ${name}`);
		const metadata = statSync(path);
		if (!metadata.isFile())
			throw new Error(`Personal update asset is not a file: ${name}`);
		byName.set(name, {
			path,
			size: metadata.size,
			sha256: await sha256(path),
		});
	}

	const assets = {};
	for (const [key, name] of ASSET_DEFINITIONS) {
		const file = byName.get(name);
		if (!file) throw new Error(`Missing personal update asset: ${name}`);
		assets[key] = {
			name,
			url: `${DOWNLOAD_BASE_URL}${name}`,
			size: file.size,
			sha256: file.sha256,
		};
	}

	return assertPersonalUpdateManifest({
		schemaVersion: 1,
		version: options.version,
		buildNumber: options.buildNumber,
		commitSha: options.commitSha,
		publishedAt: options.publishedAt,
		releaseNotesUrl: RELEASE_NOTES_URL,
		assets,
	});
}

async function writePersonalUpdateManifest(manifest, outputPath) {
	assertPersonalUpdateManifest(manifest);
	await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

async function main() {
	const directory = resolve(process.argv[2] || "release-assets");
	const version = process.env.ADE_VERSION;
	const buildNumberRaw = process.env.ADE_BUILD_NUMBER;
	const commitSha = process.env.ADE_BUILD_SHA;
	const publishedAt = process.env.ADE_PUBLISHED_AT;
	if (!version || !buildNumberRaw || !commitSha || !publishedAt) {
		throw new Error(
			"ADE_VERSION, ADE_BUILD_NUMBER, ADE_BUILD_SHA, and ADE_PUBLISHED_AT are required",
		);
	}
	if (!/^[0-9]+$/.test(buildNumberRaw)) {
		throw new Error("ADE_BUILD_NUMBER must contain decimal digits only");
	}
	const manifest = await createPersonalUpdateManifest({
		assetPaths: ASSET_DEFINITIONS.map(([, name]) => join(directory, name)),
		version,
		buildNumber: Number(buildNumberRaw),
		commitSha,
		publishedAt,
	});
	const outputPath = join(directory, MANIFEST_NAME);
	await writePersonalUpdateManifest(manifest, outputPath);
	console.log(`created personal update manifest: ${outputPath}`);
}

module.exports = {
	ASSET_DEFINITIONS,
	MANIFEST_NAME,
	assertPersonalUpdateManifest,
	createPersonalUpdateManifest,
	writePersonalUpdateManifest,
};

if (require.main === module) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
