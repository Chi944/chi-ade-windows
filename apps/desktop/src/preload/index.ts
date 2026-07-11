import { contextBridge, ipcRenderer, webUtils } from "electron";
import { exposeElectronTRPC } from "trpc-electron/main";
import {
	assertRendererIpcEventChannel,
	isValidDeepLinkPath,
	type RendererIpcEventChannel,
} from "./ipc-policy";

declare const __APP_VERSION__: string;

declare global {
	interface Window {
		App: typeof API;
		ipcRenderer: typeof ipcRendererAPI;
		webUtils: {
			getPathForFile: (file: File) => string;
		};
	}
}

const API = {
	sayHelloFromBridge: () => console.log("\nHello from bridgeAPI! 👋\n\n"),
	username: process.env.USER,
	appVersion: __APP_VERSION__,
};

type DeepLinkListener = (path: string) => void;
type WrappedIpcListener = Parameters<typeof ipcRenderer.on>[1];

// Store mapping of user listeners to wrapped listeners for proper cleanup.
const listenerMap = new WeakMap<DeepLinkListener, WrappedIpcListener>();

/**
 * IPC renderer API
 * Note: Primary IPC communication uses tRPC. This API is for low-level IPC needs.
 */
const ipcRendererAPI = {
	on: (channel: RendererIpcEventChannel, listener: DeepLinkListener) => {
		assertRendererIpcEventChannel(channel);
		if (typeof listener !== "function") {
			throw new TypeError("IPC listener must be a function");
		}

		const wrappedListener: WrappedIpcListener = (_event, ...args) => {
			if (args.length !== 1 || !isValidDeepLinkPath(args[0])) return;
			listener(args[0]);
		};
		listenerMap.set(listener, wrappedListener);
		ipcRenderer.on(channel, wrappedListener);
	},

	off: (channel: RendererIpcEventChannel, listener: DeepLinkListener) => {
		assertRendererIpcEventChannel(channel);
		if (typeof listener !== "function") {
			throw new TypeError("IPC listener must be a function");
		}

		const wrappedListener = listenerMap.get(listener);
		if (wrappedListener) {
			ipcRenderer.removeListener(channel, wrappedListener);
			listenerMap.delete(listener);
		}
	},
};

// Expose electron-trpc IPC channel FIRST (must be before contextBridge calls)
exposeElectronTRPC();

contextBridge.exposeInMainWorld("App", API);
contextBridge.exposeInMainWorld("ipcRenderer", ipcRendererAPI);
contextBridge.exposeInMainWorld("webUtils", {
	getPathForFile: (file: File) => webUtils.getPathForFile(file),
});
