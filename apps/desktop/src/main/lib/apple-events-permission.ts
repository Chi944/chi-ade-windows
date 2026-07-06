import { execFile } from "node:child_process";

/**
 * Triggers the macOS Apple Events / Automation permission prompt by
 * sending a minimal AppleScript command to System Events.
 * This is a no-op on non-macOS platforms.
 *
 * On macOS, this will cause the system to show the "would like to
 * access data from other apps" dialog if it hasn't been granted yet.
 * Once granted, the permission is remembered and the dialog won't reappear.
 */
let appleEventsRequested = false;

/**
 * Fires {@link requestAppleEventsAccess} at most once per app run. Called lazily
 * from the first terminal spawn so the macOS "control other apps" prompt appears
 * in context (the user just started an agent) rather than at cold boot.
 */
export function requestAppleEventsAccessOnce(): void {
	if (appleEventsRequested) return;
	appleEventsRequested = true;
	requestAppleEventsAccess();
}

export function requestAppleEventsAccess(): void {
	if (process.platform !== "darwin") {
		return;
	}

	execFile(
		"osascript",
		["-e", 'tell application "System Events" to return 1'],
		(err) => {
			if (err) {
				console.log(
					"[apple-events] Permission request error (expected if denied):",
					err.message,
				);
			} else {
				console.log("[apple-events] Apple Events access granted");
			}
		},
	);
}
