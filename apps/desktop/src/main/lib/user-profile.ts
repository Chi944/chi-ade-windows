import { userInfo } from "node:os";

/**
 * The human's name, used to seed an agent's memory/USER.md (docs/ade
 * memory-spec §8, E4). Single-user app. For v1 this derives from the OS
 * account; a settings-backed, user-editable name captured at first run is a
 * fast-follow (add a `userName` column to the settings table and prefer it
 * here when set).
 */
export function getUserName(): string {
	try {
		const info = userInfo();
		// macOS/Linux fullname when available, else the login name.
		const full = (info as { fullname?: string }).fullname?.trim();
		return full || info.username || "the user";
	} catch {
		return "the user";
	}
}
