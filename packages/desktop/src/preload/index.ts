/**
 * Preload Script
 *
 * This script runs in the renderer process before the web page loads.
 * It exposes selected Electron APIs to the renderer process via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
const electronAPI = {
	// App
	getVersion: () => ipcRenderer.invoke("app:getVersion"),
	getName: () => ipcRenderer.invoke("app:getName"),

	// Theme
	getTheme: () => ipcRenderer.invoke("theme:get"),
	setTheme: (theme: "dark" | "light" | "system") =>
		ipcRenderer.invoke("theme:set", theme),

	// Window controls
	minimize: () => ipcRenderer.invoke("window:minimize"),
	maximize: () => ipcRenderer.invoke("window:maximize"),
	close: () => ipcRenderer.invoke("window:close"),
	isMaximized: () => ipcRenderer.invoke("window:isMaximized"),

	// File dialogs
	openFile: (options?: {
		title?: string;
		filters?: { name: string; extensions: string[] }[];
	}) => ipcRenderer.invoke("dialog:openFile", options),

	saveFile: (options?: {
		title?: string;
		defaultPath?: string;
		filters?: { name: string; extensions: string[] }[];
	}) => ipcRenderer.invoke("dialog:saveFile", options),

	// File operations
	readFile: (filePath: string) => ipcRenderer.invoke("file:read", filePath),
	writeFile: (filePath: string, content: string) =>
		ipcRenderer.invoke("file:write", filePath, content),

	// Clipboard
	writeClipboard: (text: string) => ipcRenderer.invoke("clipboard:write", text),
	readClipboard: () => ipcRenderer.invoke("clipboard:read"),

	// Shell
	openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
	showItemInFolder: (filePath: string) =>
		ipcRenderer.invoke("shell:showItemInFolder", filePath),

	// Notifications
	showNotification: (
		title: string,
		body: string,
		options?: { silent?: boolean },
	) => ipcRenderer.invoke("notification:show", title, body, options),

	// Paths
	getUserDataPath: () => ipcRenderer.invoke("path:userData"),
	getDocumentsPath: () => ipcRenderer.invoke("path:documents"),
	getDownloadsPath: () => ipcRenderer.invoke("path:downloads"),
	getHomePath: () => ipcRenderer.invoke("path:home"),

	// Menu events listener
	onMenuEvent: (
		callback: (event: string, ...args: unknown[]) => void,
	): (() => void) => {
		const channels = [
			"menu:preferences",
			"menu:new-session",
			"menu:export-session",
			"menu:find",
			"menu:toggle-sidebar",
			"menu:select-model",
			"menu:set-model",
			"menu:clear-context",
			"menu:view-sessions",
			"menu:share-session",
			"menu:show-shortcuts",
		];

		const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
			callback((_event as unknown as { type: string }).type, ...args);
		};

		// Register listeners for all channels
		const handlers = channels.map((channel) => {
			const channelHandler = (
				_event: Electron.IpcRendererEvent,
				...args: unknown[]
			) => {
				callback(channel.replace("menu:", ""), ...args);
			};
			ipcRenderer.on(channel, channelHandler);
			return { channel, handler: channelHandler };
		});

		// Return cleanup function
		return () => {
			for (const { channel, handler } of handlers) {
				ipcRenderer.removeListener(channel, handler);
			}
		};
	},

	// Platform info
	platform: process.platform,
	isMac: process.platform === "darwin",
	isWindows: process.platform === "win32",
	isLinux: process.platform === "linux",
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld("electron", electronAPI);

// Type definition for the exposed API
export type ElectronAPI = typeof electronAPI;

// Declare the global type
declare global {
	interface Window {
		electron: ElectronAPI;
	}
}
