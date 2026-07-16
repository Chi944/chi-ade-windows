import { chmod as chmodFile } from "node:fs/promises";
import { SUPERSET_SENSITIVE_FILE_MODE } from "../app-environment";

export interface SqliteOnlineBackupDatabase {
	backup(destination: string): Promise<unknown>;
}

export interface SqliteBackupDependencies {
	chmod: (path: string, mode: number) => Promise<void>;
}

export async function backupSqliteDatabase(
	database: SqliteOnlineBackupDatabase,
	destination: string,
	dependencies: SqliteBackupDependencies = { chmod: chmodFile },
): Promise<void> {
	await database.backup(destination);
	await dependencies.chmod(destination, SUPERSET_SENSITIVE_FILE_MODE);
}
