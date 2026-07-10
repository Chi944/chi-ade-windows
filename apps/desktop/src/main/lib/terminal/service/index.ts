export { ServiceTerminalManager } from "./service-manager";
export type { ColdRestoreInfo, SessionInfo } from "./types";

import { ServiceTerminalManager } from "./service-manager";

let serviceManager: ServiceTerminalManager | null = null;

export function getServiceTerminalManager(): ServiceTerminalManager {
	if (!serviceManager) {
		serviceManager = new ServiceTerminalManager();
	}
	return serviceManager;
}
