export interface SqliteIntegrityDatabase {
	pragma(source: string, options: { simple: true }): unknown;
}

export type LocalDatabaseIntegrityResult =
	| { ok: true }
	| { ok: false; message: string };

export function checkSqliteDatabaseIntegrity(
	database: SqliteIntegrityDatabase,
): LocalDatabaseIntegrityResult {
	try {
		return database.pragma("quick_check", { simple: true }) === "ok"
			? { ok: true }
			: { ok: false, message: "SQLite integrity check failed" };
	} catch {
		return {
			ok: false,
			message: "SQLite integrity check could not run",
		};
	}
}
