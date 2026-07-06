import { describe, expect, it } from "bun:test";
import { createAgentInput } from "./create-agent-input";

/**
 * Input validation for createAgent — focused on the optional `role` field
 * captured in the New Agent modal (trimmed, empty → undefined, capped length).
 */
describe("createAgentInput role", () => {
	const base = { projectId: "cat-1", name: "Scout" };

	it("defaults role to undefined when omitted", () => {
		const parsed = createAgentInput.parse(base);
		expect(parsed.role).toBeUndefined();
	});

	it("trims surrounding whitespace", () => {
		const parsed = createAgentInput.parse({ ...base, role: "  Researcher  " });
		expect(parsed.role).toBe("Researcher");
	});

	it("treats a whitespace-only role as unset (undefined)", () => {
		const parsed = createAgentInput.parse({ ...base, role: "   " });
		expect(parsed.role).toBeUndefined();
	});

	it("treats an empty string as unset (undefined)", () => {
		const parsed = createAgentInput.parse({ ...base, role: "" });
		expect(parsed.role).toBeUndefined();
	});

	it("keeps a role at the max length", () => {
		const role = "a".repeat(280);
		const parsed = createAgentInput.parse({ ...base, role });
		expect(parsed.role).toBe(role);
	});

	it("rejects a role over the max length", () => {
		expect(() =>
			createAgentInput.parse({ ...base, role: "a".repeat(281) }),
		).toThrow();
	});
});
