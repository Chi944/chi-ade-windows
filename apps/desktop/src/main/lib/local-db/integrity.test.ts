import { describe, expect, test } from "bun:test";
import { checkSqliteDatabaseIntegrity } from "./integrity";

describe("checkSqliteDatabaseIntegrity", () => {
	test("reports a passing SQLite quick check", () => {
		expect(
			checkSqliteDatabaseIntegrity({
				pragma: (source, options) => {
					expect(source).toBe("quick_check");
					expect(options).toEqual({ simple: true });
					return "ok";
				},
			}),
		).toEqual({ ok: true });
	});

	test("returns only a generic failure message for damaged data", () => {
		expect(
			checkSqliteDatabaseIntegrity({
				pragma: () => "row 4 contains secret project content",
			}),
		).toEqual({ ok: false, message: "SQLite integrity check failed" });
	});

	test("converts checker errors into a non-sensitive result", () => {
		expect(
			checkSqliteDatabaseIntegrity({
				pragma: () => {
					throw new Error("C:\\Users\\chi\\private\\local.db");
				},
			}),
		).toEqual({
			ok: false,
			message: "SQLite integrity check could not run",
		});
	});
});
