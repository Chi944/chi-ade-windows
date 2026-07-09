import { beforeEach, describe, expect, mock, test } from "bun:test";

const showItemInFolder = mock(() => {});
const openPath = mock(async () => "");

mock.module("electron", () => ({
	clipboard: { writeText: mock(() => {}) },
	shell: {
		openExternal: mock(async () => {}),
		openPath,
		showItemInFolder,
	},
}));

mock.module("main/lib/local-db", () => ({ localDb: {} }));

const { openPathInApp } = await import("./index");

describe("openPathInApp", () => {
	beforeEach(() => {
		showItemInFolder.mockClear();
		openPath.mockClear();
	});

	test("keeps the system file-manager behavior", async () => {
		await openPathInApp("C:\\repo\\file.ts", "finder");

		expect(showItemInFolder).toHaveBeenCalledWith("C:\\repo\\file.ts");
		expect(openPath).not.toHaveBeenCalled();
	});

	if (process.platform !== "darwin") {
		test("rejects an unsupported app instead of opening the path itself", async () => {
			await expect(
				openPathInApp("C:\\repo\\file.ts", "appcode"),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: `'appcode' is not supported on ${process.platform}.`,
			});
			expect(openPath).not.toHaveBeenCalled();
		});
	}
});
