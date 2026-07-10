import { describe, expect, it } from "bun:test";
import { getCoordinationCliContent } from "./coordination-cli";

describe("coordination CLI", () => {
	it("uses the workspace capability without printing it", () => {
		const script = getCoordinationCliContent();
		expect(script).toContain('"x-ade-token": token');
		expect(script).toContain("/coordination/inbox");
		expect(script).toContain("/coordination/context");
		expect(script).not.toContain("console.log(token)");
	});
});
