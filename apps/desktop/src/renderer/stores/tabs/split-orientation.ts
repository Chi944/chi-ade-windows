export type AutoSplitOrientation = "vertical" | "horizontal";

/** Minimum usable width for each side-by-side terminal pane. */
export const MIN_AUTO_SPLIT_PANE_WIDTH = 720;

/**
 * Chooses the automatic split direction without creating cramped CLI panes.
 * Explicit Split Right / Split Down actions are unaffected.
 */
export function chooseAutoSplitOrientation(dimensions: {
	width: number;
	height: number;
}): AutoSplitOrientation {
	const hasTwoUsableColumns = dimensions.width / 2 >= MIN_AUTO_SPLIT_PANE_WIDTH;
	return dimensions.width >= dimensions.height && hasTwoUsableColumns
		? "vertical"
		: "horizontal";
}
