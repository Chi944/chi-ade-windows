import { describe, expect, it } from "bun:test";
import {
	chooseAutoSplitOrientation,
	MIN_AUTO_SPLIT_PANE_WIDTH,
} from "./split-orientation";

describe("chooseAutoSplitOrientation", () => {
	it("uses side-by-side panes when both children retain the minimum width", () => {
		expect(
			chooseAutoSplitOrientation({
				width: MIN_AUTO_SPLIT_PANE_WIDTH * 2,
				height: 800,
			}),
		).toBe("vertical");
	});

	it("stacks panes when a landscape window would create cramped children", () => {
		expect(
			chooseAutoSplitOrientation({
				width: MIN_AUTO_SPLIT_PANE_WIDTH * 2 - 1,
				height: 800,
			}),
		).toBe("horizontal");
	});

	it("stacks panes in portrait containers", () => {
		expect(chooseAutoSplitOrientation({ width: 1600, height: 1800 })).toBe(
			"horizontal",
		);
	});
});
