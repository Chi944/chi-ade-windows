const DEFAULT_RENDERER_READY_TIMEOUT_MS = 20_000;

let committed = false;
let resolveCommit!: () => void;
const commitPromise = new Promise<void>((resolve) => {
	resolveCommit = resolve;
});

/** Mark readiness only after React commits and the main process accepts it. */
export function signalRendererCommit(): void {
	if (committed) return;
	committed = true;
	resolveCommit();
}

/** Await the one-shot post-commit signal without letting smoke hang forever. */
export async function waitForRendererCommit(
	timeoutMs: number = DEFAULT_RENDERER_READY_TIMEOUT_MS,
): Promise<void> {
	if (committed) return;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("renderer commit signal timed out"));
		}, timeoutMs);
		void commitPromise.then(() => {
			clearTimeout(timeout);
			resolve();
		});
	});
}
