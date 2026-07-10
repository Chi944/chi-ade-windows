import { electronTrpcClient } from "../../../lib/trpc-client";

interface KillRequest {
	promise: Promise<void>;
	deleteHistory: boolean;
}

const killRequests = new Map<string, KillRequest>();

function runKill(
	paneId: string,
	options: { deleteHistory?: boolean; workspaceId?: string },
): Promise<void> {
	return electronTrpcClient.terminal.kill
		.mutate({ paneId, ...options })
		.catch((error) => {
			console.warn(`Failed to kill terminal for pane ${paneId}:`, error);
		});
}

function trackKill(
	paneId: string,
	promise: Promise<void>,
	deleteHistory: boolean,
): Promise<void> {
	const request = { promise, deleteHistory };
	killRequests.set(paneId, request);
	void promise.finally(() => {
		if (killRequests.get(paneId) === request) killRequests.delete(paneId);
	});
	return promise;
}

/**
 * Uses standalone tRPC client to avoid React hook dependencies
 */
export const killTerminalForPane = (
	paneId: string,
	options: { deleteHistory?: boolean; workspaceId?: string } = {},
): Promise<void> => {
	const existing = killRequests.get(paneId);
	if (!existing) {
		return trackKill(
			paneId,
			runKill(paneId, options),
			Boolean(options.deleteHistory),
		);
	}

	if (options.deleteHistory && !existing.deleteHistory) {
		const upgraded = existing.promise.then(() => runKill(paneId, options));
		return trackKill(paneId, upgraded, true);
	}

	return existing.promise;
};
