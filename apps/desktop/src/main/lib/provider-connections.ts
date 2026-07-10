import { findRealBinaries } from "main/lib/agent-setup/utils";
import { probeBinaryCommand } from "main/lib/runtime-availability";

export const SUBSCRIPTION_PROVIDER_IDS = ["claude", "codex"] as const;
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];

export interface SubscriptionConnectionState {
	installed: boolean;
	authenticated: boolean;
}

export type SubscriptionConnectionStatus = Record<
	SubscriptionProviderId,
	SubscriptionConnectionState
>;

interface ProbeDependencies {
	findBinaries: (name: SubscriptionProviderId) => string[];
	runStatus: (binary: string, args: string[]) => Promise<boolean>;
}

const defaultDependencies: ProbeDependencies = {
	findBinaries: (name) => findRealBinaries(name),
	runStatus: probeBinaryCommand,
};

async function findRunnableBinary(
	provider: SubscriptionProviderId,
	dependencies: ProbeDependencies,
): Promise<string | null> {
	for (const binary of dependencies.findBinaries(provider)) {
		if (await dependencies.runStatus(binary, ["--version"])) return binary;
	}
	return null;
}

/**
 * Returns booleans only. Probes run asynchronously so a slow CLI cannot freeze
 * Electron's main process, and CLI output/account details never reach renderer.
 */
export async function probeSubscriptionConnections(
	dependencies: ProbeDependencies = defaultDependencies,
): Promise<SubscriptionConnectionStatus> {
	const [claudeBinary, codexBinary] = await Promise.all([
		findRunnableBinary("claude", dependencies),
		findRunnableBinary("codex", dependencies),
	]);

	const [claudeAuthenticated, codexAuthenticated] = await Promise.all([
		claudeBinary
			? dependencies.runStatus(claudeBinary, ["auth", "status"])
			: false,
		codexBinary
			? dependencies.runStatus(codexBinary, ["login", "status"])
			: false,
	]);

	return {
		claude: {
			installed: claudeBinary !== null,
			authenticated: claudeAuthenticated,
		},
		codex: {
			installed: codexBinary !== null,
			authenticated: codexAuthenticated,
		},
	};
}
