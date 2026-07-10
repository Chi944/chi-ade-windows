import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database(":memory:");
sqlite.exec(`
	PRAGMA foreign_keys = OFF;
	CREATE TABLE projects (id TEXT PRIMARY KEY);
	CREATE TABLE workspaces (id TEXT PRIMARY KEY);
	CREATE TABLE agent_messages (
		id TEXT PRIMARY KEY,
		project_id TEXT,
		recipient_workspace_id TEXT
	);
	CREATE TABLE agent_message_receipts (
		id TEXT PRIMARY KEY,
		message_id TEXT NOT NULL,
		workspace_id TEXT NOT NULL
	);
	CREATE TABLE shared_memories (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		workspace_id TEXT NOT NULL
	);
`);

const testDb = drizzle(sqlite);
mock.module("main/lib/local-db", () => ({ localDb: testDb }));

const { deleteProjectRecord, deleteWorkspace } = await import("./db-helpers");

function ids(table: string): string[] {
	return (
		sqlite.query(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{
			id: string;
		}>
	).map(({ id }) => id);
}

beforeEach(() => {
	for (const table of [
		"agent_message_receipts",
		"agent_messages",
		"shared_memories",
		"workspaces",
		"projects",
	]) {
		sqlite.exec(`DELETE FROM ${table}`);
	}
});

afterAll(() => {
	sqlite.close();
});

describe("coordination cleanup", () => {
	test("workspace deletion removes only private coordination rows", () => {
		sqlite.exec(`
			INSERT INTO projects VALUES ('project-1');
			INSERT INTO workspaces VALUES ('workspace-1'), ('workspace-2');
			INSERT INTO agent_messages VALUES
				('broadcast', 'project-1', NULL),
				('target-1', 'project-1', 'workspace-1'),
				('target-2', 'project-1', 'workspace-2');
			INSERT INTO agent_message_receipts VALUES
				('receipt-for-target-1', 'target-1', 'workspace-2'),
				('receipt-workspace-1', 'broadcast', 'workspace-1'),
				('receipt-workspace-2', 'broadcast', 'workspace-2');
			INSERT INTO shared_memories VALUES
				('memory-project', 'project-1', 'project', ''),
				('memory-workspace-1', 'project-1', 'workspace', 'workspace-1'),
				('memory-workspace-2', 'project-1', 'workspace', 'workspace-2');
		`);

		deleteWorkspace("workspace-1");

		expect(ids("workspaces")).toEqual(["workspace-2"]);
		expect(ids("agent_messages")).toEqual(["broadcast", "target-2"]);
		expect(ids("agent_message_receipts")).toEqual(["receipt-workspace-2"]);
		expect(ids("shared_memories")).toEqual([
			"memory-project",
			"memory-workspace-2",
		]);
	});

	test("project deletion removes project coordination rows and receipts", () => {
		sqlite.exec(`
			INSERT INTO projects VALUES ('project-1'), ('project-2');
			INSERT INTO agent_messages VALUES
				('message-1', 'project-1', NULL),
				('message-2', 'project-2', NULL);
			INSERT INTO agent_message_receipts VALUES
				('receipt-1', 'message-1', 'workspace-1'),
				('receipt-2', 'message-2', 'workspace-2');
			INSERT INTO shared_memories VALUES
				('memory-1', 'project-1', 'project', ''),
				('memory-2', 'project-2', 'project', '');
		`);

		deleteProjectRecord("project-1");

		expect(ids("projects")).toEqual(["project-2"]);
		expect(ids("agent_messages")).toEqual(["message-2"]);
		expect(ids("agent_message_receipts")).toEqual(["receipt-2"]);
		expect(ids("shared_memories")).toEqual(["memory-2"]);
	});
});
