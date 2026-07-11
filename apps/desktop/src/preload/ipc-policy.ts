export const RENDERER_IPC_EVENT_CHANNEL = "deep-link-navigate" as const;

export type RendererIpcEventChannel = typeof RENDERER_IPC_EVENT_CHANNEL;

export function assertRendererIpcEventChannel(
	channel: string,
): asserts channel is RendererIpcEventChannel {
	if (channel !== RENDERER_IPC_EVENT_CHANNEL) {
		throw new Error(`Blocked renderer IPC channel: ${channel}`);
	}
}

export function isValidDeepLinkPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!value.includes("\0")
	);
}
