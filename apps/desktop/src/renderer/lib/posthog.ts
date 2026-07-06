// Telemetry removed for ADE (local-first, single-user). This is a no-op stub so
// existing capture/identify call sites compile without sending any analytics.
// A Proxy returns a no-op function for any accessed property (capture, identify,
// reset, register, opt_in_capturing, …).
const noop = () => {};

export const posthog = new Proxy(
	{},
	{
		get: () => noop,
	},
) as Record<string, (...args: unknown[]) => void>;
