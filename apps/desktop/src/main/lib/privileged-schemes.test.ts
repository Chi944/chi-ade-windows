import { expect, test } from "bun:test";
import { registerPrivilegedSchemes } from "./privileged-schemes";

test("registers the icon scheme with the privileges required by packaged windows", () => {
	const calls: unknown[] = [];
	registerPrivilegedSchemes({
		registerSchemesAsPrivileged: (schemes) => calls.push(schemes),
	});

	expect(calls).toEqual([
		[
			{
				scheme: "superset-icon",
				privileges: {
					standard: true,
					secure: true,
					bypassCSP: true,
					supportFetchAPI: true,
				},
			},
		],
	]);
});
