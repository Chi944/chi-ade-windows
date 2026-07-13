import { describe, expect, it } from "bun:test";
import { compareProjectOrder, type ProjectOrderFields } from "./project-order";

function order(projects: ProjectOrderFields[]): string[] {
	return [...projects].sort(compareProjectOrder).map((project) => project.id);
}

describe("compareProjectOrder", () => {
	it("places pinned projects before unpinned projects", () => {
		expect(
			order([
				{ id: "normal", tabOrder: 0, isPinned: false },
				{ id: "pinned", tabOrder: 10, isPinned: true },
			]),
		).toEqual(["pinned", "normal"]);
	});

	it("preserves tab order within each pin group", () => {
		expect(
			order([
				{ id: "normal-2", tabOrder: 3, isPinned: false },
				{ id: "pinned-2", tabOrder: 2, isPinned: true },
				{ id: "normal-1", tabOrder: 1, isPinned: false },
				{ id: "pinned-1", tabOrder: 0, isPinned: true },
			]),
		).toEqual(["pinned-1", "pinned-2", "normal-1", "normal-2"]);
	});

	it("orders missing and tied tab positions deterministically", () => {
		expect(
			order([
				{ id: "z", tabOrder: null, isPinned: false },
				{ id: "b", tabOrder: 1, isPinned: false },
				{ id: "a", tabOrder: 1, isPinned: false },
			]),
		).toEqual(["a", "b", "z"]);
	});
});
