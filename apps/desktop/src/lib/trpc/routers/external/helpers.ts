import { spawn } from "node:child_process";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalApp } from "@superset/local-db";

/** Map of app IDs to their macOS application names */
const MACOS_APP_NAMES: Record<ExternalApp, string | null> = {
	finder: null, // Handled specially with shell.showItemInFolder
	vscode: "Visual Studio Code",
	"vscode-insiders": "Visual Studio Code - Insiders",
	cursor: "Cursor",
	antigravity: "Antigravity",
	zed: "Zed",
	xcode: "Xcode",
	iterm: "iTerm",
	warp: "Warp",
	terminal: "Terminal",
	ghostty: "Ghostty",
	sublime: "Sublime Text",
	intellij: null, // Multi-edition, uses bundle IDs
	webstorm: "WebStorm",
	pycharm: null, // Multi-edition, uses bundle IDs
	phpstorm: "PhpStorm",
	rubymine: "RubyMine",
	goland: "GoLand",
	clion: "CLion",
	rider: "Rider",
	datagrip: "DataGrip",
	appcode: "AppCode",
	fleet: "Fleet",
	rustrover: "RustRover",
};

/**
 * Bundle ID candidates for JetBrains IDEs with multiple editions.
 * `open -b <bundleId>` works regardless of the .app display name,
 * so "IntelliJ IDEA Ultimate.app" and "IntelliJ IDEA CE.app" both resolve correctly.
 */
const BUNDLE_ID_CANDIDATES: Partial<Record<ExternalApp, string[]>> = {
	intellij: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
	pycharm: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
};

/** Map of app IDs to their Linux CLI commands. */
const LINUX_CLI_COMMANDS: Record<ExternalApp, string | null> = {
	finder: null,
	vscode: "code",
	"vscode-insiders": "code-insiders",
	cursor: "cursor",
	antigravity: "antigravity",
	zed: "zed",
	xcode: null,
	iterm: null,
	warp: "warp-terminal",
	terminal: null,
	ghostty: "ghostty",
	sublime: "subl",
	intellij: null,
	webstorm: "webstorm",
	pycharm: null,
	phpstorm: "phpstorm",
	rubymine: "rubymine",
	goland: "goland",
	clion: "clion",
	rider: "rider",
	datagrip: "datagrip",
	appcode: null,
	fleet: "fleet",
	rustrover: "rustrover",
};

const LINUX_CLI_CANDIDATES: Partial<Record<ExternalApp, string[]>> = {
	intellij: ["idea", "intellij-idea-ultimate", "intellij-idea-community"],
	pycharm: ["pycharm", "pycharm-professional", "pycharm-community"],
};

/** Map of app IDs to their Windows CLI commands. */
const WINDOWS_CLI_COMMANDS: Record<ExternalApp, string | null> = {
	finder: null,
	vscode: "code",
	"vscode-insiders": "code-insiders",
	cursor: "cursor",
	antigravity: "antigravity",
	zed: "zed",
	xcode: null,
	iterm: null,
	warp: "warp",
	terminal: "wt",
	ghostty: null,
	sublime: "subl",
	intellij: null,
	webstorm: null,
	pycharm: null,
	phpstorm: null,
	rubymine: null,
	goland: null,
	clion: null,
	rider: null,
	datagrip: null,
	appcode: null,
	fleet: "fleet",
	rustrover: null,
};

/**
 * JetBrains Toolbox can expose short launchers while standalone installs commonly
 * expose the 64-bit executable name, so try both on Windows.
 */
const WINDOWS_CLI_CANDIDATES: Partial<Record<ExternalApp, string[]>> = {
	intellij: ["idea", "idea64"],
	webstorm: ["webstorm", "webstorm64"],
	pycharm: ["pycharm", "pycharm64"],
	phpstorm: ["phpstorm", "phpstorm64"],
	rubymine: ["rubymine", "rubymine64"],
	goland: ["goland", "goland64"],
	clion: ["clion", "clion64"],
	rider: ["rider", "rider64"],
	datagrip: ["datagrip", "datagrip64"],
	rustrover: ["rustrover", "rustrover64"],
};

/**
 * Get candidate commands to open a path in the specified app.
 * Returns an array of commands to try in order. macOS uses `open`, while Linux
 * and Windows use each application's CLI launcher.
 */
export function getAppCommand(
	app: ExternalApp,
	targetPath: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] }[] | null {
	if (platform === "darwin") {
		const bundleIds = BUNDLE_ID_CANDIDATES[app];
		if (bundleIds) {
			return bundleIds.map((id) => ({
				command: "open",
				args: ["-b", id, targetPath],
			}));
		}

		const appName = MACOS_APP_NAMES[app];
		if (!appName) return null;
		return [{ command: "open", args: ["-a", appName, targetPath] }];
	}

	if (platform === "win32" && app === "terminal") {
		return [{ command: "wt", args: ["-d", targetPath] }];
	}

	const candidates =
		platform === "win32"
			? WINDOWS_CLI_CANDIDATES[app]
			: LINUX_CLI_CANDIDATES[app];
	if (candidates) {
		return candidates.map((command) => ({ command, args: [targetPath] }));
	}

	const command =
		platform === "win32" ? WINDOWS_CLI_COMMANDS[app] : LINUX_CLI_COMMANDS[app];
	if (!command) return null;
	return [{ command, args: [targetPath] }];
}

/**
 * Wrapper characters that can surround paths.
 * These are pairs of [open, close] characters.
 */
const PATH_WRAPPERS: [string, string][] = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["(", ")"],
	["[", "]"],
	["<", ">"],
];

/**
 * Trailing punctuation that can appear after paths in sentences.
 * These are stripped unless they're part of a valid suffix (extension, line:col).
 */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Check if a string looks like a file path.
 * A path typically contains forward slashes, or starts with ., ~, or /
 */
function looksLikePath(str: string): boolean {
	return (
		str.includes("/") ||
		str.includes("\\") ||
		str.startsWith(".") ||
		str.startsWith("~") ||
		str.startsWith("/")
	);
}

/**
 * Extract a path from within brackets/parentheses when there's adjacent text.
 * Handles patterns like:
 *   "text(src/file.ts)more" -> "src/file.ts"
 *   "see (path/to/file) here" -> "path/to/file"
 *   "in [src/file.ts:42]" -> "src/file.ts:42"
 *
 * Returns the original string if no embedded path is found.
 */
function extractEmbeddedPath(input: string): string {
	const bracketPairs: [string, string][] = [
		["(", ")"],
		["[", "]"],
		["<", ">"],
	];

	for (const [open, close] of bracketPairs) {
		const openIdx = input.indexOf(open);
		const closeIdx = input.lastIndexOf(close);

		if (openIdx !== -1 && closeIdx > openIdx) {
			const hasTextBefore = openIdx > 0;
			const hasTextAfter = closeIdx < input.length - 1;

			if (hasTextBefore || hasTextAfter) {
				const content = input.slice(openIdx + 1, closeIdx);
				if (looksLikePath(content)) {
					return content;
				}
			}
		}
	}

	return input;
}

/**
 * Strip trailing punctuation from a path, but preserve valid suffixes.
 * - Preserves file extensions like .ts, .json
 * - Preserves line:col suffixes like :42 or :42:10
 * - Strips sentence punctuation like trailing period, comma, etc.
 */
function stripTrailingPunctuation(path: string): string {
	const match = path.match(TRAILING_PUNCTUATION);
	if (!match) return path;

	const punct = match[0];
	const beforePunct = path.slice(0, -punct.length);

	// Don't strip if it looks like a file extension (e.g., "file.ts")
	if (punct === "." || punct.startsWith(".")) {
		const extMatch = beforePunct.match(/\.[a-zA-Z0-9]{1,10}$/);
		if (extMatch) {
			return beforePunct;
		}
		// e.g., path ends with ".ts." - strip just the final "."
		if (/^\.[a-zA-Z0-9]{1,10}\.$/.test(punct)) {
			return path.slice(0, -1);
		}
	}

	// Don't strip colons followed by digits (line numbers like :42)
	if (punct === ":") {
		return beforePunct;
	}
	if (punct.startsWith(":") && /^:\d/.test(punct)) {
		return path;
	}

	return beforePunct;
}

/**
 * Strip matching wrapper characters and trailing punctuation from a path.
 * Handles nested wrappers and multiple layers of wrapping.
 * Examples:
 *   "(path/to/file)" -> "path/to/file"
 *   '"path/to/file"' -> "path/to/file"
 *   "'(path/to/file)'" -> "path/to/file"
 *   "./path/file.ts." -> "./path/file.ts"
 *   '"./path/file.ts",' -> "./path/file.ts"
 *   "path/to/file" -> "path/to/file" (unchanged)
 */
export function stripPathWrappers(filePath: string): string {
	let result = filePath.trim();

	// First, try to extract embedded paths from patterns like "text(path)more"
	result = extractEmbeddedPath(result);

	let changed = true;
	while (changed && result.length > 0) {
		changed = false;

		const withoutPunct = stripTrailingPunctuation(result);
		if (withoutPunct !== result) {
			result = withoutPunct;
			changed = true;
			continue;
		}

		for (const [open, close] of PATH_WRAPPERS) {
			if (result.startsWith(open) && result.endsWith(close)) {
				result = result.slice(1, -1);
				changed = true;
				break;
			}
		}
	}

	return result;
}

/**
 * Resolve a path by expanding ~ and converting relative paths to absolute.
 * Also handles file:// URLs by converting them to regular file paths.
 * Strips wrapping characters like quotes, parentheses, brackets, etc.
 */
export function resolvePath(filePath: string, cwd?: string): string {
	let resolved = stripPathWrappers(filePath);

	if (resolved.startsWith("file://")) {
		try {
			resolved = fileURLToPath(resolved);
		} catch {
			// If URL parsing fails, try simple prefix removal
			resolved = decodeURIComponent(resolved.replace(/^file:\/\//, ""));
		}
	}

	if (
		resolved === "~" ||
		resolved.startsWith("~/") ||
		resolved.startsWith("~\\")
	) {
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home) {
			resolved = nodePath.resolve(home, resolved.slice(2));
		}
	}

	if (!nodePath.isAbsolute(resolved)) {
		resolved = cwd
			? nodePath.resolve(cwd, resolved)
			: nodePath.resolve(resolved);
	}

	return nodePath.resolve(resolved);
}

/**
 * Spawns a process and waits for it to complete.
 * @throws Error if the process exits with non-zero code or fails to spawn
 */
export function spawnAsync(command: string, args: string[]): Promise<void> {
	let spawnCommand = command;
	let spawnArgs = args;

	// Windows editor launchers such as code.cmd and cursor.cmd cannot be spawned
	// directly by Node. Invoke them through PowerShell without enabling a shell
	// for untrusted path input.
	if (process.platform === "win32") {
		const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
		const invocation = [command, ...args].map(quote).join(" ");
		const script = [
			"$ErrorActionPreference = 'Stop'",
			`& ${invocation}`,
			"if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
		].join("; ");

		spawnCommand = "powershell.exe";
		spawnArgs = [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		];
	}

	return new Promise((resolve, reject) => {
		const child = spawn(spawnCommand, spawnArgs, {
			stdio: ["ignore", "ignore", "pipe"],
			detached: false,
		});

		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			reject(
				new Error(
					`Failed to spawn '${command}': ${error.message}. Ensure the application is installed.`,
				),
			);
		});

		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				const stderrMessage = stderr.trim();
				reject(
					new Error(stderrMessage || `'${command}' exited with code ${code}`),
				);
			}
		});
	});
}

export type { ExternalApp };
