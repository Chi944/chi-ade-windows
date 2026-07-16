export const AUTO_UPDATE_STATUS = {
	IDLE: "idle",
	CHECKING: "checking",
	AVAILABLE: "available",
	DOWNLOADING: "downloading",
	READY: "ready",
	ERROR: "error",
} as const;

export type AutoUpdateStatus =
	(typeof AUTO_UPDATE_STATUS)[keyof typeof AUTO_UPDATE_STATUS];

export const AUTO_UPDATE_READY_ACTION = {
	INSTALL_AND_RESTART: "install-and-restart",
	OPEN_INSTALLER: "open-installer",
} as const;

export type AutoUpdateReadyAction =
	(typeof AUTO_UPDATE_READY_ACTION)[keyof typeof AUTO_UPDATE_READY_ACTION];

export const RELEASES_URL =
	"https://github.com/Chi944/chi-ade-windows/releases";
