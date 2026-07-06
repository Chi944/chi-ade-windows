import { getDeviceName, getHashedDeviceId } from "main/lib/device-info";
import { publicProcedure, router } from "../..";

/**
 * ADE is local-first with no cloud account. The previous OAuth flow to
 * the cloud backend (sign-in, token persistence, deep-link callback) has been
 * removed. What remains is local device identity plus a no-op sign-out, kept so
 * the account menu and device-presence hooks keep working.
 */
export const createAuthRouter = () => {
	return router({
		getDeviceInfo: publicProcedure.query(() => ({
			deviceId: getHashedDeviceId(),
			deviceName: getDeviceName(),
		})),

		signOut: publicProcedure.mutation(() => ({ success: true })),
	});
};

export type AuthRouter = ReturnType<typeof createAuthRouter>;
