"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { drizzle } = require("drizzle-orm/better-sqlite3");
const { migrate } = require("drizzle-orm/better-sqlite3/migrator");

const nativeRoot = process.env.ADE_ELECTRON_NATIVE_ROOT;
const Database = nativeRoot
	? require(path.resolve(nativeRoot, "better-sqlite3"))
	: require("better-sqlite3");
const sqlite = new Database(":memory:");

try {
	sqlite.function("uuid_v4", () => randomUUID());
	sqlite.function("uuid_is_valid_v4", (_value) => 1);
	migrate(drizzle(sqlite), {
		migrationsFolder: path.resolve(
			__dirname,
			"../../../packages/local-db/drizzle",
		),
	});

	const requiredTables = [
		"agent_message_receipts",
		"agent_messages",
		"remote_hosts",
		"shared_memories",
	];
	const placeholders = requiredTables.map(() => "?").join(", ");
	const rows = sqlite
		.prepare(
			`SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name IN (${placeholders})`,
		)
		.all(...requiredTables);
	const found = new Set(rows.map((row) => row.name));
	const missing = requiredTables.filter((table) => !found.has(table));
	if (missing.length > 0) {
		throw new Error(
			`Migration smoke test is missing tables: ${missing.join(", ")}`,
		);
	}
	console.log(`Migration smoke passed (${requiredTables.join(", ")})`);
} finally {
	sqlite.close();
}
