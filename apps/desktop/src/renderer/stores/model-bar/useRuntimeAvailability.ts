import type {
	CheckedBinary,
	RuntimeAvailability,
} from "@superset/shared/agent-binaries";
import { toast } from "@superset/ui/sonner";
import { useCallback, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

export interface RuntimeAvailabilityHandle {
	/** Availability map, or `undefined` until the first probe resolves. */
	availability: RuntimeAvailability | undefined;
	isLoading: boolean;
	/**
	 * Whether a specific binary is installed. Returns `true` while unknown so the
	 * UI stays optimistic (no false "not detected" flash before the probe lands).
	 */
	isAvailable: (binary: CheckedBinary) => boolean;
	/** Re-probe, bypassing the main-process cache (call after an install). */
	recheck: () => Promise<void>;
	isFetching: boolean;
}

/**
 * Reads config.runtimeAvailability — which agent CLIs (claude / codex / opencode)
 * and git are installed. Backs the ModelBar "not detected" state, the NewAgentModal
 * runtime picker, and the create-agent git preflight.
 */
export function useRuntimeAvailability(): RuntimeAvailabilityHandle {
	const [isRechecking, setIsRechecking] = useState(false);
	const query = electronTrpc.config.runtimeAvailability.useQuery(undefined, {
		staleTime: 5_000,
	});
	const utils = electronTrpc.useUtils();
	const recheck = useCallback(async () => {
		setIsRechecking(true);
		try {
			const value = await utils.config.runtimeAvailability.fetch({
				force: true,
			});
			utils.config.runtimeAvailability.setData(undefined, value);
		} catch (error) {
			toast.error(
				error instanceof Error
					? `Could not re-check installed CLIs: ${error.message}`
					: "Could not re-check installed CLIs",
			);
		} finally {
			setIsRechecking(false);
		}
	}, [utils]);

	return {
		availability: query.data,
		isLoading: query.isLoading,
		isAvailable: (binary) => query.data?.[binary] ?? true,
		recheck,
		isFetching: query.isFetching || isRechecking,
	};
}
