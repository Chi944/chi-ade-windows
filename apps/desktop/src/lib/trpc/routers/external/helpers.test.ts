import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	getAppCommand,
	resolvePath,
	spawnAsync,
	stripPathWrappers,
} from "./helpers";

describe("getAppCommand", () => {
	const getMacAppCommand = (
		app: Parameters<typeof getAppCommand>[0],
		targetPath: string,
	) => getAppCommand(app, targetPath, "darwin");

	test("returns null for finder (handled specially)", () => {
		expect(getMacAppCommand("finder", "/path/to/file")).toBeNull();
	});

	test("returns single-element array for cursor", () => {
		const result = getMacAppCommand("cursor", "/path/to/file");
		expect(result).toEqual([
			{ command: "open", args: ["-a", "Cursor", "/path/to/file"] },
		]);
	});

	test("returns single-element array for vscode", () => {
		const result = getMacAppCommand("vscode", "/path/to/file");
		expect(result).toEqual([
			{
				command: "open",
				args: ["-a", "Visual Studio Code", "/path/to/file"],
			},
		]);
	});

	test("returns single-element array for sublime", () => {
		const result = getMacAppCommand("sublime", "/path/to/file");
		expect(result).toEqual([
			{ command: "open", args: ["-a", "Sublime Text", "/path/to/file"] },
		]);
	});

	test("returns single-element array for xcode", () => {
		const result = getMacAppCommand("xcode", "/path/to/file");
		expect(result).toEqual([
			{ command: "open", args: ["-a", "Xcode", "/path/to/file"] },
		]);
	});

	test("returns single-element array for iterm", () => {
		const result = getMacAppCommand("iterm", "/path/to/file");
		expect(result).toEqual([
			{ command: "open", args: ["-a", "iTerm", "/path/to/file"] },
		]);
	});

	test("returns single-element array for warp", () => {
		const result = getMacAppCommand("warp", "/path/to/file");
		expect(result).toEqual([
			{ command: "open", args: ["-a", "Warp", "/path/to/file"] },
		]);
	});

	test("returns single-element array for terminal", () => {
		const result = getMacAppCommand("terminal", "/path/to/file");
		expect(result).toEqual([
			{ command: "open", args: ["-a", "Terminal", "/path/to/file"] },
		]);
	});

	test("returns single-element array for ghostty", () => {
		const result = getMacAppCommand("ghostty", "/path/to/file");
		expect(result).toEqual([
			{ command: "open", args: ["-a", "Ghostty", "/path/to/file"] },
		]);
	});

	describe("JetBrains IDEs", () => {
		test("returns bundle ID candidates for intellij (multi-edition)", () => {
			const result = getMacAppCommand("intellij", "/path/to/file");
			expect(result).toEqual([
				{
					command: "open",
					args: ["-b", "com.jetbrains.intellij", "/path/to/file"],
				},
				{
					command: "open",
					args: ["-b", "com.jetbrains.intellij.ce", "/path/to/file"],
				},
			]);
		});

		test("returns bundle ID candidates for pycharm (multi-edition)", () => {
			const result = getMacAppCommand("pycharm", "/path/to/file");
			expect(result).toEqual([
				{
					command: "open",
					args: ["-b", "com.jetbrains.pycharm", "/path/to/file"],
				},
				{
					command: "open",
					args: ["-b", "com.jetbrains.pycharm.ce", "/path/to/file"],
				},
			]);
		});

		test("returns single-element array for webstorm (single-edition)", () => {
			const result = getMacAppCommand("webstorm", "/path/to/file");
			expect(result).toEqual([
				{ command: "open", args: ["-a", "WebStorm", "/path/to/file"] },
			]);
		});

		test("returns single-element array for goland (single-edition)", () => {
			const result = getMacAppCommand("goland", "/path/to/file");
			expect(result).toEqual([
				{ command: "open", args: ["-a", "GoLand", "/path/to/file"] },
			]);
		});

		test("returns single-element array for rustrover (single-edition)", () => {
			const result = getMacAppCommand("rustrover", "/path/to/file");
			expect(result).toEqual([
				{ command: "open", args: ["-a", "RustRover", "/path/to/file"] },
			]);
		});
	});

	test("preserves paths with spaces", () => {
		const result = getMacAppCommand("cursor", "/path/with spaces/file.ts");
		expect(result).toEqual([
			{
				command: "open",
				args: ["-a", "Cursor", "/path/with spaces/file.ts"],
			},
		]);
	});

	describe("Linux", () => {
		test("uses the VS Code CLI launcher", () => {
			expect(getAppCommand("vscode", "/project", "linux")).toEqual([
				{ command: "code", args: ["/project"] },
			]);
		});

		test("preserves JetBrains edition fallbacks", () => {
			expect(getAppCommand("intellij", "/project", "linux")).toEqual([
				{ command: "idea", args: ["/project"] },
				{ command: "intellij-idea-ultimate", args: ["/project"] },
				{ command: "intellij-idea-community", args: ["/project"] },
			]);
		});

		test("returns null for macOS-only applications", () => {
			expect(getAppCommand("xcode", "/project", "linux")).toBeNull();
		});
	});

	describe("Windows", () => {
		const targetPath = "C:\\Users\\Ada\\Project with spaces";

		test("uses CLI launchers for editors and Windows Terminal", () => {
			expect(getAppCommand("cursor", targetPath, "win32")).toEqual([
				{ command: "cursor", args: [targetPath] },
			]);
			expect(getAppCommand("vscode", targetPath, "win32")).toEqual([
				{ command: "code", args: [targetPath] },
			]);
			expect(getAppCommand("terminal", targetPath, "win32")).toEqual([
				{ command: "wt", args: ["-d", targetPath] },
			]);
		});

		test("uses JetBrains launcher fallbacks", () => {
			expect(getAppCommand("intellij", targetPath, "win32")).toEqual([
				{ command: "idea", args: [targetPath] },
				{ command: "idea64", args: [targetPath] },
			]);
		});

		test("returns null for unsupported macOS-only applications", () => {
			expect(getAppCommand("xcode", targetPath, "win32")).toBeNull();
			expect(getAppCommand("iterm", targetPath, "win32")).toBeNull();
		});
	});
});

if (process.platform === "win32") {
	describe("spawnAsync on Windows", () => {
		test("runs .cmd launchers through PowerShell", async () => {
			await expect(
				spawnAsync("npm.cmd", ["--version"]),
			).resolves.toBeUndefined();
		});

		test("rejects when the launcher does not exist", async () => {
			await expect(
				spawnAsync("definitely-not-an-ade-launcher", []),
			).rejects.toBeInstanceOf(Error);
		});
	});
}

describe("resolvePath", () => {
	const homedir = os.homedir();
	const originalHome = process.env.HOME;
	const absoluteFilePath = path.resolve("/absolute/path/file.ts");
	const projectPath = path.resolve("/project");

	beforeEach(() => {
		process.env.HOME = homedir;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
	});

	describe("home directory expansion", () => {
		test("expands ~ to home directory", () => {
			const result = resolvePath("~/Documents/file.ts");
			expect(result).toBe(path.join(homedir, "Documents/file.ts"));
		});

		test("expands ~ alone to home directory", () => {
			const result = resolvePath("~");
			expect(result).toBe(homedir);
		});

		test("does not expand ~ in middle of path", () => {
			const result = resolvePath("/path/~/file.ts");
			expect(result).toBe(path.resolve("/path/~/file.ts"));
		});
	});

	describe("absolute paths", () => {
		test("returns absolute path unchanged", () => {
			const result = resolvePath("/absolute/path/file.ts");
			expect(result).toBe(absoluteFilePath);
		});

		test("returns absolute path unchanged even with cwd", () => {
			const result = resolvePath("/absolute/path/file.ts", "/some/cwd");
			expect(result).toBe(absoluteFilePath);
		});
	});

	describe("relative paths", () => {
		test("resolves relative path against cwd", () => {
			const result = resolvePath("src/file.ts", "/project");
			expect(result).toBe(path.join(projectPath, "src/file.ts"));
		});

		test("resolves ./prefixed path against cwd", () => {
			const result = resolvePath("./src/file.ts", "/project");
			expect(result).toBe(path.join(projectPath, "src/file.ts"));
		});

		test("resolves ../prefixed path against cwd", () => {
			const result = resolvePath("../sibling/file.ts", "/project/subdir");
			expect(result).toBe(path.join(projectPath, "sibling/file.ts"));
		});

		test("resolves relative path against process.cwd() when no cwd provided", () => {
			const result = resolvePath("file.ts");
			expect(result).toBe(path.resolve("file.ts"));
		});
	});

	describe("combined expansion", () => {
		test("expands ~ then resolves (already absolute after expansion)", () => {
			const result = resolvePath("~/file.ts", "/ignored/cwd");
			expect(result).toBe(path.join(homedir, "file.ts"));
		});
	});

	describe("file:// URL handling", () => {
		test("converts file:// URL to regular path", () => {
			const filePath = path.resolve("/Users/test/Documents/file.ts");
			const result = resolvePath(pathToFileURL(filePath).href);
			expect(result).toBe(filePath);
		});

		test("decodes URL-encoded characters in file:// URL", () => {
			const filePath = path.resolve("/Users/test/My Documents/file.ts");
			const result = resolvePath(pathToFileURL(filePath).href);
			expect(result).toBe(filePath);
		});

		test("handles file:// URL with special characters", () => {
			const filePath = path.resolve("/Users/test/path with spaces/file+1.ts");
			const result = resolvePath(pathToFileURL(filePath).href);
			expect(result).toBe(filePath);
		});

		test("handles file:// URL unchanged when already absolute", () => {
			const result = resolvePath(
				pathToFileURL(absoluteFilePath).href,
				"/ignored/cwd",
			);
			expect(result).toBe(absoluteFilePath);
		});

		test("converts a Windows drive file URL", () => {
			const url = "file:///C:/Users/Ada/My%20Project/file.ts";
			expect(resolvePath(url)).toBe(path.resolve(fileURLToPath(url)));
		});
	});

	describe("wrapper character stripping", () => {
		test("strips double quotes from path", () => {
			const result = resolvePath('"/absolute/path/file.ts"');
			expect(result).toBe(absoluteFilePath);
		});

		test("strips single quotes from path", () => {
			const result = resolvePath("'/absolute/path/file.ts'");
			expect(result).toBe(absoluteFilePath);
		});

		test("strips backticks from path", () => {
			const result = resolvePath("`/absolute/path/file.ts`");
			expect(result).toBe(absoluteFilePath);
		});

		test("strips parentheses from path", () => {
			const result = resolvePath("(/absolute/path/file.ts)");
			expect(result).toBe(absoluteFilePath);
		});

		test("strips square brackets from path", () => {
			const result = resolvePath("[/absolute/path/file.ts]");
			expect(result).toBe(absoluteFilePath);
		});

		test("strips angle brackets from path", () => {
			const result = resolvePath("</absolute/path/file.ts>");
			expect(result).toBe(absoluteFilePath);
		});

		test("strips nested wrappers", () => {
			const result = resolvePath("\"'/absolute/path/file.ts'\"");
			expect(result).toBe(absoluteFilePath);
		});

		test("strips wrappers with leading/trailing whitespace", () => {
			const result = resolvePath('  "/absolute/path/file.ts"  ');
			expect(result).toBe(absoluteFilePath);
		});

		test("handles wrappers combined with ~ expansion", () => {
			const result = resolvePath('"~/Documents/file.ts"');
			expect(result).toBe(path.join(homedir, "Documents/file.ts"));
		});

		test("handles wrappers combined with relative paths", () => {
			const result = resolvePath("(src/file.ts)", "/project");
			expect(result).toBe(path.join(projectPath, "src/file.ts"));
		});
	});
});

describe("stripPathWrappers", () => {
	describe("single wrapper types", () => {
		test("strips double quotes", () => {
			expect(stripPathWrappers('"/path/to/file"')).toBe("/path/to/file");
		});

		test("strips single quotes", () => {
			expect(stripPathWrappers("'/path/to/file'")).toBe("/path/to/file");
		});

		test("strips backticks", () => {
			expect(stripPathWrappers("`/path/to/file`")).toBe("/path/to/file");
		});

		test("strips parentheses", () => {
			expect(stripPathWrappers("(/path/to/file)")).toBe("/path/to/file");
		});

		test("strips square brackets", () => {
			expect(stripPathWrappers("[/path/to/file]")).toBe("/path/to/file");
		});

		test("strips angle brackets", () => {
			expect(stripPathWrappers("</path/to/file>")).toBe("/path/to/file");
		});
	});

	describe("nested wrappers", () => {
		test("strips multiple layers of same wrapper", () => {
			expect(stripPathWrappers('"""/path/to/file"""')).toBe("/path/to/file");
		});

		test("strips mixed nested wrappers", () => {
			expect(stripPathWrappers("\"'/path/to/file'\"")).toBe("/path/to/file");
		});

		test("strips deeply nested mixed wrappers", () => {
			expect(stripPathWrappers("\"('[/path/to/file]')\"")).toBe(
				"/path/to/file",
			);
		});
	});

	describe("edge cases", () => {
		test("returns empty string for empty input", () => {
			expect(stripPathWrappers("")).toBe("");
		});

		test("returns trimmed string for whitespace only", () => {
			expect(stripPathWrappers("   ")).toBe("");
		});

		test("trims surrounding whitespace", () => {
			expect(stripPathWrappers('  "/path/to/file"  ')).toBe("/path/to/file");
		});

		test("does not strip mismatched wrappers", () => {
			expect(stripPathWrappers('"/path/to/file)')).toBe('"/path/to/file)');
		});

		test("does not strip opening wrapper only", () => {
			expect(stripPathWrappers('"/path/to/file')).toBe('"/path/to/file');
		});

		test("does not strip closing wrapper only", () => {
			expect(stripPathWrappers('/path/to/file"')).toBe('/path/to/file"');
		});

		test("preserves path with internal wrappers", () => {
			expect(stripPathWrappers("/path/to/(file)")).toBe("/path/to/(file)");
		});

		test("preserves path with no wrappers", () => {
			expect(stripPathWrappers("/path/to/file")).toBe("/path/to/file");
		});

		test("handles single character inside wrappers", () => {
			expect(stripPathWrappers('"a"')).toBe("a");
		});

		test("handles wrappers with only whitespace inside", () => {
			expect(stripPathWrappers('"  "')).toBe("  ");
		});
	});

	describe("trailing punctuation", () => {
		test("strips trailing period", () => {
			expect(stripPathWrappers("./path/file.ts.")).toBe("./path/file.ts");
		});

		test("strips trailing comma", () => {
			expect(stripPathWrappers("./path/file.ts,")).toBe("./path/file.ts");
		});

		test("strips trailing colon", () => {
			expect(stripPathWrappers("./path/file.ts:")).toBe("./path/file.ts");
		});

		test("strips trailing semicolon", () => {
			expect(stripPathWrappers("./path/file.ts;")).toBe("./path/file.ts");
		});

		test("strips trailing question mark", () => {
			expect(stripPathWrappers("./path/file.ts?")).toBe("./path/file.ts");
		});

		test("strips trailing exclamation", () => {
			expect(stripPathWrappers("./path/file.ts!")).toBe("./path/file.ts");
		});

		test("strips multiple trailing punctuation", () => {
			expect(stripPathWrappers("./path/file.ts..")).toBe("./path/file.ts");
		});

		test("strips mixed trailing punctuation", () => {
			expect(stripPathWrappers("./path/file.ts.,")).toBe("./path/file.ts");
		});

		test("preserves file extension", () => {
			expect(stripPathWrappers("./path/file.ts")).toBe("./path/file.ts");
		});

		test("preserves .json extension", () => {
			expect(stripPathWrappers("./path/file.json")).toBe("./path/file.json");
		});

		test("preserves multi-dot extensions like .test.ts", () => {
			expect(stripPathWrappers("./path/file.test.ts")).toBe(
				"./path/file.test.ts",
			);
		});

		test("preserves line number suffix :42", () => {
			expect(stripPathWrappers("./path/file.ts:42")).toBe("./path/file.ts:42");
		});

		test("preserves line:col suffix :42:10", () => {
			expect(stripPathWrappers("./path/file.ts:42:10")).toBe(
				"./path/file.ts:42:10",
			);
		});
	});

	describe("paths with adjacent tokens around parentheses", () => {
		test("extracts path from text(path)more pattern", () => {
			expect(stripPathWrappers("text(src/file.ts)more")).toBe("src/file.ts");
		});

		test("extracts path from text(./path)more pattern", () => {
			expect(stripPathWrappers("text(./src/file.ts)more")).toBe(
				"./src/file.ts",
			);
		});

		test("extracts path from prefix (path) suffix with spaces", () => {
			expect(stripPathWrappers("see (src/file.ts) for")).toBe("src/file.ts");
		});

		test("extracts path from 'applied to (path)' pattern", () => {
			expect(stripPathWrappers("applied to (src/file.ts)")).toBe("src/file.ts");
		});

		test("extracts path with line number from parentheses", () => {
			expect(stripPathWrappers("in (src/file.ts:42)")).toBe("src/file.ts:42");
		});

		test("extracts path with line:col from parentheses", () => {
			expect(stripPathWrappers("in (src/file.ts:42:10)")).toBe(
				"src/file.ts:42:10",
			);
		});

		test("handles absolute path inside parentheses with prefix", () => {
			expect(stripPathWrappers("see (/absolute/path/file.ts)")).toBe(
				"/absolute/path/file.ts",
			);
		});

		test("extracts a native Windows path from surrounding prose", () => {
			expect(stripPathWrappers(String.raw`see (C:\repo\file.ts) here`)).toBe(
				String.raw`C:\repo\file.ts`,
			);
		});

		test("handles ~ path inside parentheses with prefix", () => {
			expect(stripPathWrappers("in (~/Documents/file.ts)")).toBe(
				"~/Documents/file.ts",
			);
		});

		test("preserves valid paths with parentheses in directory names", () => {
			expect(stripPathWrappers("/path/dir (copy)/file.ts")).toBe(
				"/path/dir (copy)/file.ts",
			);
		});

		test("handles brackets similar to parentheses", () => {
			expect(stripPathWrappers("see [src/file.ts] here")).toBe("src/file.ts");
		});

		test("handles angle brackets similar to parentheses", () => {
			expect(stripPathWrappers("import <src/file.ts> done")).toBe(
				"src/file.ts",
			);
		});

		test("does not extract non-path content from parentheses", () => {
			expect(stripPathWrappers("text(not a path)more")).toBe(
				"text(not a path)more",
			);
		});

		test("handles nested brackets with path", () => {
			expect(stripPathWrappers("prefix((src/file.ts))suffix")).toBe(
				"src/file.ts",
			);
		});
	});

	describe("wrappers with trailing punctuation", () => {
		test("quoted path with trailing period", () => {
			expect(stripPathWrappers('"./path/file.ts".')).toBe("./path/file.ts");
		});

		test("quoted path with trailing comma", () => {
			expect(stripPathWrappers('"./path/file.ts",')).toBe("./path/file.ts");
		});

		test("parenthesized path with trailing period", () => {
			expect(stripPathWrappers("(./path/file.ts).")).toBe("./path/file.ts");
		});

		test("complex nested with trailing punctuation", () => {
			expect(stripPathWrappers('"(./path/file.ts)".')).toBe("./path/file.ts");
		});
	});

	describe("line numbers with trailing punctuation", () => {
		test("strips trailing period after line number", () => {
			expect(stripPathWrappers("./path/file.ts:42.")).toBe("./path/file.ts:42");
		});

		test("strips trailing comma after line number", () => {
			expect(stripPathWrappers("./path/file.ts:42,")).toBe("./path/file.ts:42");
		});

		test("strips trailing colon after line number", () => {
			expect(stripPathWrappers("./path/file.ts:42:")).toBe("./path/file.ts:42");
		});

		test("strips trailing period after line:col", () => {
			expect(stripPathWrappers("./path/file.ts:42:10.")).toBe(
				"./path/file.ts:42:10",
			);
		});

		test("strips trailing comma after line:col", () => {
			expect(stripPathWrappers("./path/file.ts:42:10,")).toBe(
				"./path/file.ts:42:10",
			);
		});
	});

	describe("various extension types", () => {
		test("preserves numeric extensions like .mp3", () => {
			expect(stripPathWrappers("./path/file.mp3")).toBe("./path/file.mp3");
		});

		test("preserves single character extensions like .c", () => {
			expect(stripPathWrappers("./path/file.c")).toBe("./path/file.c");
		});

		test("preserves uppercase extensions like .TSX", () => {
			expect(stripPathWrappers("./path/file.TSX")).toBe("./path/file.TSX");
		});

		test("preserves dotfiles", () => {
			expect(stripPathWrappers(".gitignore")).toBe(".gitignore");
		});

		test("preserves dotfiles with extension", () => {
			expect(stripPathWrappers(".eslintrc.json")).toBe(".eslintrc.json");
		});

		test("strips trailing period from dotfile with extension", () => {
			expect(stripPathWrappers(".eslintrc.json.")).toBe(".eslintrc.json");
		});
	});
});
