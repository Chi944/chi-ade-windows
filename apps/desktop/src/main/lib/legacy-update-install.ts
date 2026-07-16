export interface LegacyUpdateInstallDependencies {
	createSnapshot: () => Promise<void>;
	setSkipQuitConfirmation: () => void;
	quitAndInstall: () => void;
}

export async function runLegacyUpdateInstall(
	dependencies: LegacyUpdateInstallDependencies,
): Promise<void> {
	await dependencies.createSnapshot();
	dependencies.setSkipQuitConfirmation();
	dependencies.quitAndInstall();
}
