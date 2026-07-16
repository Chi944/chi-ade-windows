import { describe, expect, test } from "bun:test";
import * as localDbTables from "@superset/local-db/schema/tables";
import * as localDbZod from "@superset/local-db/schema/zod";
import {
	createLocalDbSchemaMock,
	LOCAL_DB_TABLE_NAMES,
} from "./local-db-schema-mock";

describe("local database test schema contract", () => {
	test("mirrors every production table export", () => {
		expect([...LOCAL_DB_TABLE_NAMES].sort()).toEqual(
			Object.keys(localDbTables).sort(),
		);
	});

	test("uses every production runtime schema export", () => {
		const mockSchema = createLocalDbSchemaMock();

		for (const exportName of Object.keys(localDbZod)) {
			expect(mockSchema).toHaveProperty(exportName, localDbZod[exportName]);
		}
	});
});
