let acquired: boolean | null = null;

/**
 * Acquire Electron's process-wide lock once, before any boot attempt is
 * recorded. Keeping the result in this dependency-free module lets the main
 * entry consume the bootstrap decision without requesting a second lock.
 */
export function acquireSingleInstanceLock(requestLock: () => boolean): boolean {
	if (acquired === null) acquired = requestLock();
	return acquired;
}

export function hasSingleInstanceLock(): boolean {
	if (acquired === null) {
		throw new Error("The single-instance lock has not been acquired");
	}
	return acquired;
}

/** @internal */
export function resetSingleInstanceLockForTests(): void {
	acquired = null;
}
