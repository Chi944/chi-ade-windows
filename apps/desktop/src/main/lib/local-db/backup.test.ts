import { describe, expect, mock, test } from "bun:test";
import { backupSqliteDatabase } from "./backup";

describe("backupSqliteDatabase", () => {
	test("uses SQLite's online backup API and then restricts the snapshot mode", async () => {
		const order: string[] = [];
		const database = {
			backup: mock(async (destination: string) => {
				expect(destination).toBe("C:\\recovery\\snapshot.db.part");
				order.push("backup");
			}),
		};
		const chmod = mock(async (path: string, mode: number) => {
			expect(path).toBe("C:\\recovery\\snapshot.db.part");
			expect(mode).toBe(0o600);
			order.push("chmod");
		});

		await backupSqliteDatabase(database, "C:\\recovery\\snapshot.db.part", {
			chmod,
		});

		expect(database.backup).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["backup", "chmod"]);
	});

	test("does not treat a failed online backup as a completed snapshot", async () => {
		const chmod = mock(async () => {});

		await expect(
			backupSqliteDatabase(
				{
					backup: async () => {
						throw new Error("SQLite backup failed");
					},
				},
				"C:\\recovery\\snapshot.db.part",
				{ chmod },
			),
		).rejects.toThrow("SQLite backup failed");
		expect(chmod).not.toHaveBeenCalled();
	});
});
