import { compare, valid } from "semver";
import { z } from "zod/v4";

export const PERSONAL_UPDATE_MANIFEST_NAME =
	"ade-personal-update-v1.json" as const;
export const PERSONAL_UPDATE_MANIFEST_URL =
	"https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ade-personal-update-v1.json" as const;
export const PERSONAL_UPDATE_RELEASE_NOTES_URL =
	"https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest" as const;

const ASSET_NAMES = {
	"win32-x64": "ADE-Windows-x64.exe",
	"darwin-arm64": "ADE-macOS-Apple-Silicon.dmg",
	"darwin-x64": "ADE-macOS-Intel.dmg",
} as const;

export type PersonalUpdateAssetKey = keyof typeof ASSET_NAMES;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DOWNLOAD_BASE_URL =
	"https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/";

function semanticVersionSchema() {
	return z.string().refine((value) => valid(value) === value, {
		message: "Expected a canonical semantic version",
	});
}

function positiveSafeIntegerSchema() {
	return z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
}

function assetSchema<Key extends PersonalUpdateAssetKey>(key: Key) {
	const name = ASSET_NAMES[key];
	return z
		.object({
			name: z.literal(name),
			url: z.literal(`${DOWNLOAD_BASE_URL}${name}`),
			size: positiveSafeIntegerSchema(),
			sha256: z.string().regex(SHA256_PATTERN),
		})
		.strict();
}

const personalUpdateManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		version: semanticVersionSchema(),
		buildNumber: positiveSafeIntegerSchema(),
		commitSha: z.string().regex(COMMIT_SHA_PATTERN),
		publishedAt: z.iso.datetime({ offset: true }),
		releaseNotesUrl: z.literal(PERSONAL_UPDATE_RELEASE_NOTES_URL),
		assets: z
			.object({
				"win32-x64": assetSchema("win32-x64"),
				"darwin-arm64": assetSchema("darwin-arm64"),
				"darwin-x64": assetSchema("darwin-x64"),
			})
			.strict(),
	})
	.strict()
	.superRefine((manifest, context) => {
		const urls = Object.values(manifest.assets).map((asset) => asset.url);
		if (new Set(urls).size !== urls.length) {
			context.addIssue({
				code: "custom",
				path: ["assets"],
				message: "Update asset URLs must be unique",
			});
		}
	});

export type PersonalUpdateManifest = z.infer<
	typeof personalUpdateManifestSchema
>;
export type PersonalUpdateAsset =
	PersonalUpdateManifest["assets"][PersonalUpdateAssetKey];

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

export function parsePersonalUpdateManifest(
	value: unknown,
): PersonalUpdateManifest {
	return deepFreeze(personalUpdateManifestSchema.parse(value));
}

export function selectPersonalUpdateAsset(
	manifest: PersonalUpdateManifest,
	platform: string = process.platform,
	arch: string = process.arch,
): PersonalUpdateAsset {
	const key = `${platform}-${arch}`;
	if (!(key in manifest.assets)) {
		throw new Error(`Unsupported update platform: ${key}`);
	}
	return manifest.assets[key as PersonalUpdateAssetKey];
}

function assertInstalledBuildIdentity(
	version: string,
	buildNumber: number,
): void {
	if (valid(version) !== version) {
		throw new Error("Installed version is not canonical semantic versioning");
	}
	if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) {
		throw new Error("Installed build number must be a positive safe integer");
	}
}

export function isPersonalUpdateAvailable(
	manifest: PersonalUpdateManifest,
	installedVersion: string,
	installedBuildNumber: number,
): boolean {
	assertInstalledBuildIdentity(installedVersion, installedBuildNumber);
	const versionOrder = compare(manifest.version, installedVersion);
	if (versionOrder !== 0) return versionOrder > 0;
	return manifest.buildNumber > installedBuildNumber;
}
