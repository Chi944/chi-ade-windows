import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep, win32 } from "node:path";

const PRIVATE_NAMESPACE_LENGTH = 16;
const PRIVATE_DIRECTORY_MODE = 0o700;
let storageRootOverride: string | null = null;

export interface ResolveSubscriptionProfileStorageRootOptions {
	adeHomeDir: string;
	platform?: NodeJS.Platform;
	env?: Readonly<Record<string, string | undefined>>;
	homeDir?: string;
}

/** @internal Test seam; never exposed through renderer RPC. */
export function setSubscriptionProfileStorageRootForTests(
	root: string | null,
): void {
	storageRootOverride = root;
}

export function resolveSubscriptionProfileStorageRoot({
	adeHomeDir,
	platform = process.platform,
	env = process.env,
	homeDir = homedir(),
}: ResolveSubscriptionProfileStorageRootOptions): string {
	if (!adeHomeDir) throw new Error("ADE home directory is required");

	const pathApi = platform === "win32" ? win32 : posix;
	const resolvedAdeHome = pathApi.resolve(adeHomeDir);
	const namespace = createHash("sha256")
		.update(resolvedAdeHome)
		.digest("hex")
		.slice(0, PRIVATE_NAMESPACE_LENGTH);

	const localDataRoot = resolveSubscriptionProfileLocalDataRoot({
		platform,
		env,
		homeDir,
	});

	return pathApi.join(
		localDataRoot,
		"ADE",
		"private",
		namespace,
		"provider-accounts",
	);
}

function resolveSubscriptionProfileLocalDataRoot({
	platform = process.platform,
	env = process.env,
	homeDir = homedir(),
}: Pick<
	ResolveSubscriptionProfileStorageRootOptions,
	"platform" | "env" | "homeDir"
>): string {
	if (platform === "win32") {
		if (!env.LOCALAPPDATA) {
			throw new Error(
				"Windows local application data directory is unavailable",
			);
		}
		return env.LOCALAPPDATA;
	}
	if (platform === "darwin") {
		return posix.join(homeDir, "Library", "Application Support");
	}
	return env.XDG_DATA_HOME || posix.join(homeDir, ".local", "share");
}

export function initializeSubscriptionProfileStorageRoot(
	options: ResolveSubscriptionProfileStorageRootOptions,
): string {
	const usesTestOverride = storageRootOverride !== null;
	const requestedRoot = getSubscriptionProfileStorageRoot(options);
	const pathApi =
		(options.platform ?? process.platform) === "win32" ? win32 : posix;
	const root = pathApi.resolve(requestedRoot);

	if (!existsSync(root)) {
		mkdirSync(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	}
	if (lstatSync(root).isSymbolicLink()) {
		throw new Error("Refusing to use a linked private provider storage root");
	}
	if (!lstatSync(root).isDirectory()) {
		throw new Error("Private provider storage root is not a directory");
	}

	try {
		chmodSync(root, PRIVATE_DIRECTORY_MODE);
	} catch {
		console.warn(
			"[subscription-profile-storage] Could not repair private directory permissions",
		);
	}

	const realRoot = realpathSync(root);
	const realAdeHome = existsSync(options.adeHomeDir)
		? realpathSync(options.adeHomeDir)
		: pathApi.resolve(options.adeHomeDir);
	assertOutsideAdeHome(realRoot, realAdeHome, pathApi);
	if (!usesTestOverride) {
		assertAnchoredInCanonicalLocalDataBase(realRoot, options, pathApi);
	}
	return realRoot;
}

/** Resolve the configured root without creating it, so migration can run first. */
export function getSubscriptionProfileStorageRoot(
	options: ResolveSubscriptionProfileStorageRootOptions,
): string {
	const usesTestOverride = storageRootOverride !== null;
	const requestedRoot = usesTestOverride
		? (storageRootOverride as string)
		: resolveSubscriptionProfileStorageRoot(options);
	const pathApi =
		(options.platform ?? process.platform) === "win32" ? win32 : posix;
	const root = pathApi.resolve(requestedRoot);
	assertOutsideAdeHome(root, pathApi.resolve(options.adeHomeDir), pathApi);
	const prospectiveRealRoot = resolveProspectiveRealPath(root, pathApi);
	const realAdeHome = existsSync(options.adeHomeDir)
		? realpathSync(options.adeHomeDir)
		: pathApi.resolve(options.adeHomeDir);
	assertOutsideAdeHome(prospectiveRealRoot, realAdeHome, pathApi);
	if (!usesTestOverride) {
		assertAnchoredInCanonicalLocalDataBase(
			prospectiveRealRoot,
			options,
			pathApi,
		);
	}
	return root;
}

function assertAnchoredInCanonicalLocalDataBase(
	realRoot: string,
	options: ResolveSubscriptionProfileStorageRootOptions,
	pathApi: typeof posix | typeof win32,
): void {
	const configuredBase = pathApi.resolve(
		resolveSubscriptionProfileLocalDataRoot(options),
	);
	const canonicalBase = resolveProspectiveRealPath(configuredBase, pathApi);
	const configuredRoot = pathApi.resolve(
		resolveSubscriptionProfileStorageRoot(options),
	);
	const suffix = pathApi.relative(configuredBase, configuredRoot);
	const expectedCanonicalRoot = pathApi.join(canonicalBase, suffix);
	if (pathApi.relative(expectedCanonicalRoot, realRoot) !== "") {
		throw new Error(
			"Private provider storage escaped the canonical OS-local data base",
		);
	}
}

function resolveProspectiveRealPath(
	target: string,
	pathApi: typeof posix | typeof win32,
): string {
	let existingAncestor = target;
	const missingSegments: string[] = [];
	while (!existsSync(existingAncestor)) {
		const parent = pathApi.dirname(existingAncestor);
		if (parent === existingAncestor) return target;
		missingSegments.unshift(pathApi.basename(existingAncestor));
		existingAncestor = parent;
	}
	return pathApi.join(realpathSync(existingAncestor), ...missingSegments);
}

function assertOutsideAdeHome(
	root: string,
	adeHome: string,
	pathApi: typeof posix | typeof win32,
): void {
	const relativeToAdeHome = pathApi.relative(adeHome, root);
	if (
		relativeToAdeHome === "" ||
		(!relativeToAdeHome.startsWith("..") &&
			!pathApi.isAbsolute(relativeToAdeHome))
	) {
		throw new Error("Private provider storage must be outside ADE home");
	}
}

interface StorageInventoryEntry {
	path: string;
	size: number;
	sha256: string;
}

type StorageInventory = StorageInventoryEntry[];

export interface MigrateSubscriptionProfileStorageOptions {
	legacyRoot: string;
	privateRoot: string;
	stopTerminalSessions: () => Promise<void>;
	resetTerminalService: () => void;
	/** @internal Test seam for promotion failures. */
	renameForMigration?: (source: string, destination: string) => void;
	/** @internal Test seam for verification failures. */
	copyFileForMigration?: (source: string, destination: string) => void;
	/** @internal Test seam for legacy cleanup failures. */
	removeTreeForMigration?: (root: string) => void;
}

export type SubscriptionProfileStorageMigrationResult =
	| { status: "not-needed" }
	| { status: "migrated" }
	| { status: "duplicate-removed" }
	| { status: "conflict-recovered"; recoveryRoot: string }
	| { status: "cleanup-deferred"; recoveryRoot?: string }
	| { status: "legacy-deferred" }
	| { status: "private-deferred" };

export async function migrateSubscriptionProfileStorage({
	legacyRoot,
	privateRoot,
	stopTerminalSessions,
	resetTerminalService,
	renameForMigration = renameSync,
	copyFileForMigration = copyFileSync,
	removeTreeForMigration = removeStorageTree,
}: MigrateSubscriptionProfileStorageOptions): Promise<SubscriptionProfileStorageMigrationResult> {
	const resolvedLegacyRoot = resolve(legacyRoot);
	const resolvedPrivateRoot = resolve(privateRoot);
	if (!existsSync(resolvedLegacyRoot)) return { status: "not-needed" };

	await stopTerminalSessions();
	const legacyInventory = inventoryStorageTree(resolvedLegacyRoot);
	if (!existsSync(resolvedPrivateRoot)) {
		copyVerifyAndPromote({
			source: resolvedLegacyRoot,
			destination: resolvedPrivateRoot,
			expectedInventory: legacyInventory,
			renameForMigration,
			copyFileForMigration,
		});
		try {
			resetTerminalService();
			if (
				removeStorageTreeAfterVerification(
					resolvedLegacyRoot,
					legacyInventory,
					removeTreeForMigration,
				) === "partial"
			) {
				return { status: "cleanup-deferred" };
			}
			return { status: "migrated" };
		} catch {
			// The verified private copy is retained, but intact legacy remains
			// authoritative for this launch because cutover did not complete.
			return { status: "legacy-deferred" };
		}
	}

	const privateInventory = inventoryStorageTree(resolvedPrivateRoot);
	if (inventoriesEqual(legacyInventory, privateInventory)) {
		try {
			resetTerminalService();
			assertStorageTreeMatches(resolvedPrivateRoot, legacyInventory);
			if (
				removeStorageTreeAfterVerification(
					resolvedLegacyRoot,
					legacyInventory,
					removeTreeForMigration,
				) === "partial"
			) {
				return { status: "cleanup-deferred" };
			}
			return { status: "duplicate-removed" };
		} catch {
			return { status: "private-deferred" };
		}
	}

	const recoveryRoot = join(
		dirname(resolvedPrivateRoot),
		"provider-accounts-legacy-recovery",
	);
	let createdRecovery = false;
	try {
		if (existsSync(recoveryRoot)) {
			const recoveryInventory = inventoryStorageTree(recoveryRoot);
			if (!inventoriesEqual(legacyInventory, recoveryInventory)) {
				resetTerminalService();
				return { status: "cleanup-deferred", recoveryRoot };
			}
		} else {
			copyVerifyAndPromote({
				source: resolvedLegacyRoot,
				destination: recoveryRoot,
				expectedInventory: legacyInventory,
				renameForMigration,
				copyFileForMigration,
			});
			createdRecovery = true;
		}
		resetTerminalService();
		assertStorageTreeMatches(recoveryRoot, legacyInventory);
		if (
			removeStorageTreeAfterVerification(
				resolvedLegacyRoot,
				legacyInventory,
				removeTreeForMigration,
			) === "partial"
		) {
			return { status: "cleanup-deferred", recoveryRoot };
		}
		return { status: "conflict-recovered", recoveryRoot };
	} catch {
		if (createdRecovery) {
			try {
				rmSync(recoveryRoot, {
					recursive: true,
					force: true,
					maxRetries: 3,
					retryDelay: 100,
				});
			} catch {
				// A failed recovery cleanup must not switch away from private storage.
			}
		}
		return { status: "private-deferred" };
	}
}

function inventoryStorageTree(root: string): StorageInventory {
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink()) {
		throw new Error("Refusing to migrate linked provider storage");
	}
	if (!rootStat.isDirectory()) {
		throw new Error("Provider storage root is not a directory");
	}

	const inventory: StorageInventory = [];
	const visit = (directory: string, relativeDirectory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(left, right) => left.name.localeCompare(right.name),
		)) {
			const absolutePath = join(directory, entry.name);
			const relativePath = relativeDirectory
				? join(relativeDirectory, entry.name)
				: entry.name;
			const stat = lstatSync(absolutePath);
			if (stat.isSymbolicLink()) {
				throw new Error("Refusing to migrate linked provider storage content");
			}
			if (stat.isDirectory()) {
				visit(absolutePath, relativePath);
				continue;
			}
			if (!stat.isFile()) {
				throw new Error(
					"Refusing to migrate non-regular provider storage content",
				);
			}
			inventory.push({
				path: relativePath.split(sep).join("/"),
				size: stat.size,
				sha256: createHash("sha256")
					.update(readFileSync(absolutePath))
					.digest("hex"),
			});
		}
	};
	visit(root, "");
	return inventory;
}

function inventoriesEqual(
	left: StorageInventory,
	right: StorageInventory,
): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => {
			const other = right[index];
			return (
				entry.path === other?.path &&
				entry.size === other.size &&
				entry.sha256 === other.sha256
			);
		})
	);
}

function assertStorageTreeMatches(
	root: string,
	expectedInventory: StorageInventory,
): void {
	if (!inventoriesEqual(expectedInventory, inventoryStorageTree(root))) {
		throw new Error("Provider storage verification failed");
	}
}

function copyStorageTree(
	source: string,
	destination: string,
	copyFile: (source: string, destination: string) => void,
): void {
	if (existsSync(destination)) {
		throw new Error("Provider storage destination already exists");
	}
	mkdirSync(destination, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

	const visit = (
		sourceDirectory: string,
		destinationDirectory: string,
	): void => {
		for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
			const sourcePath = join(sourceDirectory, entry.name);
			const destinationPath = join(destinationDirectory, entry.name);
			const stat = lstatSync(sourcePath);
			if (stat.isSymbolicLink()) {
				throw new Error("Refusing to copy linked provider storage content");
			}
			if (stat.isDirectory()) {
				mkdirSync(destinationPath, { mode: PRIVATE_DIRECTORY_MODE });
				visit(sourcePath, destinationPath);
				continue;
			}
			if (!stat.isFile()) {
				throw new Error(
					"Refusing to copy non-regular provider storage content",
				);
			}
			copyFile(sourcePath, destinationPath);
			try {
				chmodSync(destinationPath, 0o600);
			} catch {
				// Windows does not provide POSIX modes; content verification is authoritative.
			}
		}
	};

	try {
		visit(source, destination);
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

function copyVerifyAndPromote({
	source,
	destination,
	expectedInventory,
	renameForMigration,
	copyFileForMigration,
}: {
	source: string;
	destination: string;
	expectedInventory: StorageInventory;
	renameForMigration: (source: string, destination: string) => void;
	copyFileForMigration: (source: string, destination: string) => void;
}): void {
	mkdirSync(dirname(destination), {
		recursive: true,
		mode: PRIVATE_DIRECTORY_MODE,
	});
	const temporaryRoot = join(
		dirname(destination),
		`.provider-accounts-migration-${process.pid}-${randomUUID()}`,
	);
	let fallbackTemporaryRoot: string | null = null;
	copyStorageTree(source, temporaryRoot, copyFileForMigration);
	try {
		assertStorageTreeMatches(temporaryRoot, expectedInventory);
		try {
			renameForMigration(temporaryRoot, destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			fallbackTemporaryRoot = join(
				dirname(destination),
				`.provider-accounts-cross-device-${process.pid}-${randomUUID()}`,
			);
			copyStorageTree(
				temporaryRoot,
				fallbackTemporaryRoot,
				copyFileForMigration,
			);
			assertStorageTreeMatches(fallbackTemporaryRoot, expectedInventory);
			renameForMigration(fallbackTemporaryRoot, destination);
			fallbackTemporaryRoot = null;
			rmSync(temporaryRoot, { recursive: true, force: true });
		}
		assertStorageTreeMatches(destination, expectedInventory);
	} catch (error) {
		rmSync(temporaryRoot, { recursive: true, force: true });
		if (fallbackTemporaryRoot) {
			rmSync(fallbackTemporaryRoot, { recursive: true, force: true });
		}
		if (existsSync(destination)) {
			rmSync(destination, { recursive: true, force: true });
		}
		throw error;
	}
}

function removeStorageTreeAfterVerification(
	root: string,
	expectedInventory: StorageInventory,
	removeTree: (root: string) => void,
): "removed" | "partial" {
	assertStorageTreeMatches(root, expectedInventory);
	try {
		removeTree(root);
	} catch (error) {
		if (storageTreeMatches(root, expectedInventory)) throw error;
		return "partial";
	}
	if (!existsSync(root)) return "removed";
	if (storageTreeMatches(root, expectedInventory)) {
		throw new Error("Verified legacy provider storage was not removed");
	}
	return "partial";
}

function storageTreeMatches(
	root: string,
	expectedInventory: StorageInventory,
): boolean {
	try {
		return inventoriesEqual(expectedInventory, inventoryStorageTree(root));
	} catch {
		return false;
	}
}

function removeStorageTree(root: string): void {
	rmSync(root, {
		recursive: true,
		force: true,
		maxRetries: 3,
		retryDelay: 100,
	});
}
