import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { getMatchingItemsForSection } from "../utils/settings-search";
import { HealthSettings } from "./components/HealthSettings";

export const Route = createFileRoute("/_authenticated/settings/health/")({
	component: HealthSettingsPage,
});

function HealthSettingsPage() {
	const searchQuery = useSettingsSearchQuery();
	const visibleItems = useMemo(() => {
		if (!searchQuery) return null;
		return getMatchingItemsForSection(searchQuery, "health").map(
			(item) => item.id,
		);
	}, [searchQuery]);

	return <HealthSettings visibleItems={visibleItems} />;
}
