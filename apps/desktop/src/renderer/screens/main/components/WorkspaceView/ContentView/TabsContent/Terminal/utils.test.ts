import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	MAX_DROPPED_FILES,
	shellEscapePaths,
	validateDroppedPaths,
} from "./utils";

describe("terminal file drops", () => {
	it("round-trips Explorer paths through PowerShell quoting", () => {
		const path = "C:\\Users\\O'Brien\\My Project\\spec.md";
		const escaped = shellEscapePaths([path], "powershell");
		expect(escaped).toBe("'C:\\Users\\O''Brien\\My Project\\spec.md'");
		if (process.platform === "win32") {
			const result = execFileSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-Command",
					`$value = ${escaped}; [Console]::Out.Write($value)`,
				],
				{ encoding: "utf8" },
			);
			expect(result).toBe(path);
		}
	});

	it("preserves legitimate spaces instead of changing a path", () => {
		const path = " /Users/me/My Project/mock.png ";
		expect(validateDroppedPaths([path])).toEqual([path]);
		expect(shellEscapePaths([path], "posix")).not.toContain("\n");
	});

	it("rejects an excessive number of dropped files", () => {
		expect(() =>
			validateDroppedPaths(
				Array.from(
					{ length: MAX_DROPPED_FILES + 1 },
					(_, index) => `/tmp/${index}`,
				),
			),
		).toThrow(`Drop up to ${MAX_DROPPED_FILES} files`);
	});

	it("rejects empty paths", () => {
		expect(() => validateDroppedPaths([" "])).toThrow(
			"Dropped file has no usable path",
		);
	});

	it("rejects control characters before writing to a terminal", () => {
		expect(() => validateDroppedPaths(["/tmp/file\nrm -rf"])).toThrow(
			"control characters",
		);
	});
});
