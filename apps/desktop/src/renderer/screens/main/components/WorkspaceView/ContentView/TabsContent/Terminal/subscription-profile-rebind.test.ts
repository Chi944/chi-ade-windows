import { describe, expect, test } from "bun:test";
import {
	rebindPaneSubscriptionProfile,
	resolveSubscriptionProfileGate,
} from "shared/subscription-profile-rebind";
import type { Pane } from "shared/tabs-types";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

describe("resolveSubscriptionProfileGate", () => {
	test("allows a new pane with a transient explicit account selection", () => {
		expect(
			resolveSubscriptionProfileGate({
				agentRuntime: "codex",
				subscriptionProfileId: PROFILE_ID,
				subscriptionProfilePinned: true,
				binding: undefined,
				isBindingLoading: false,
			}),
		).toBe("ready");
		expect(
			resolveSubscriptionProfileGate({
				agentRuntime: "claude",
				subscriptionProfileId: null,
				subscriptionProfilePinned: true,
				binding: undefined,
				isBindingLoading: false,
			}),
		).toBe("ready");
	});

	test("waits for a device-local binding when restoring a pinned pane", () => {
		expect(
			resolveSubscriptionProfileGate({
				agentRuntime: "codex",
				subscriptionProfileId: undefined,
				subscriptionProfilePinned: true,
				binding: undefined,
				isBindingLoading: true,
			}),
		).toBe("loading");
	});

	test("mounts a restored pane when its local binding exists", () => {
		expect(
			resolveSubscriptionProfileGate({
				agentRuntime: "codex",
				subscriptionProfileId: undefined,
				subscriptionProfilePinned: true,
				binding: { provider: "codex", profileId: PROFILE_ID },
				isBindingLoading: false,
			}),
		).toBe("ready");
		expect(
			resolveSubscriptionProfileGate({
				agentRuntime: "claude",
				subscriptionProfileId: undefined,
				subscriptionProfilePinned: true,
				binding: { provider: "claude", profileId: null },
				isBindingLoading: false,
			}),
		).toBe("ready");
	});

	test("requires a choice when a restored pane has no binding on this device", () => {
		expect(
			resolveSubscriptionProfileGate({
				agentRuntime: "claude",
				subscriptionProfileId: undefined,
				subscriptionProfilePinned: true,
				binding: null,
				isBindingLoading: false,
			}),
		).toBe("rebind");
	});

	test("does not gate legacy panes without a portable marker", () => {
		expect(
			resolveSubscriptionProfileGate({
				agentRuntime: "claude",
				subscriptionProfileId: undefined,
				subscriptionProfilePinned: undefined,
				binding: undefined,
				isBindingLoading: false,
			}),
		).toBe("ready");
	});
});

describe("rebindPaneSubscriptionProfile", () => {
	test("keeps the explicit local choice transient and sets the portable marker", () => {
		const pane: Pane = {
			id: "pane",
			tabId: "tab",
			type: "terminal",
			name: "Claude",
			agentRuntime: "claude",
			subscriptionProfileNeedsRebind: true,
		};

		expect(rebindPaneSubscriptionProfile(pane, PROFILE_ID)).toEqual({
			...pane,
			subscriptionProfileId: PROFILE_ID,
			subscriptionProfilePinned: true,
			subscriptionProfileNeedsRebind: undefined,
		});
	});
});
