export interface ProjectOrderFields {
	id: string;
	tabOrder: number | null;
	isPinned: boolean;
}

/**
 * Canonical project order used by the sidebar and keyboard navigation.
 * Pinned projects stay together at the top; tabOrder remains the persisted
 * order within each group.
 */
export function compareProjectOrder(
	a: ProjectOrderFields,
	b: ProjectOrderFields,
): number {
	if (a.isPinned !== b.isPinned) {
		return a.isPinned ? -1 : 1;
	}

	const tabOrderDifference =
		(a.tabOrder ?? Number.MAX_SAFE_INTEGER) -
		(b.tabOrder ?? Number.MAX_SAFE_INTEGER);
	if (tabOrderDifference !== 0) return tabOrderDifference;

	return a.id.localeCompare(b.id);
}
