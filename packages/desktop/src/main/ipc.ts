/**
 * IPC Handlers
 *
 * Handles Inter-Process Communication between main and renderer processes.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	BrowserWindow,
	type IpcMainInvokeEvent,
	app,
	clipboard,
	dialog,
	ipcMain,
	nativeTheme,
	shell,
} from "electron";

export function setupIpc(): void {
	// App info
	ipcMain.handle("app:getVersion", () => {
		return app.getVersion();
	});

	ipcMain.handle("app:getName", () => {
		return app.getName();
	});

	// Theme
	ipcMain.handle("theme:get", () => {
		return nativeTheme.shouldUseDarkColors ? "dark" : "light";
	});

	ipcMain.handle("theme:set", (_event, theme: "dark" | "light" | "system") => {
		nativeTheme.themeSource = theme;
	});

	// Window controls
	ipcMain.handle("window:minimize", (event: IpcMainInvokeEvent) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		win?.minimize();
	});

	ipcMain.handle("window:maximize", (event: IpcMainInvokeEvent) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (win?.isMaximized()) {
			win.unmaximize();
		} else {
			win?.maximize();
		}
	});

	ipcMain.handle("window:close", (event: IpcMainInvokeEvent) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		win?.close();
	});

	ipcMain.handle("window:isMaximized", (event: IpcMainInvokeEvent) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		return win?.isMaximized() ?? false;
	});

	// File dialogs
	ipcMain.handle(
		"dialog:openFile",
		async (
			_event,
			options: {
				title?: string;
				filters?: { name: string; extensions: string[] }[];
			},
		) => {
			const result = await dialog.showOpenDialog({
				title: options.title ?? "Open File",
				filters: options.filters,
				properties: ["openFile"],
			});
			return result.canceled ? null : result.filePaths[0];
		},
	);

	ipcMain.handle(
		"dialog:saveFile",
		async (
			_event,
			options: {
				title?: string;
				defaultPath?: string;
				filters?: { name: string; extensions: string[] }[];
			},
		) => {
			const result = await dialog.showSaveDialog({
				title: options.title ?? "Save File",
				defaultPath: options.defaultPath,
				filters: options.filters,
			});
			return result.canceled ? null : result.filePath;
		},
	);

	// File operations
	ipcMain.handle("file:read", async (_event, filePath: string) => {
		try {
			const content = await readFile(filePath, "utf-8");
			return { success: true, content };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	ipcMain.handle(
		"file:write",
		async (_event, filePath: string, content: string) => {
			try {
				await writeFile(filePath, content, "utf-8");
				return { success: true };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Clipboard
	ipcMain.handle("clipboard:write", (_event, text: string) => {
		clipboard.writeText(text);
	});

	ipcMain.handle("clipboard:read", () => {
		return clipboard.readText();
	});

	// Shell
	ipcMain.handle("shell:openExternal", (_event, url: string) => {
		shell.openExternal(url);
	});

	ipcMain.handle("shell:showItemInFolder", (_event, filePath: string) => {
		shell.showItemInFolder(filePath);
	});

	// Notifications
	ipcMain.handle(
		"notification:show",
		(_event, title: string, body: string, options?: { silent?: boolean }) => {
			const { Notification } = require("electron");
			const notification = new Notification({
				title,
				body,
				silent: options?.silent ?? false,
			});
			notification.show();
		},
	);

	// Get paths
	ipcMain.handle("path:userData", () => {
		return app.getPath("userData");
	});

	ipcMain.handle("path:documents", () => {
		return app.getPath("documents");
	});

	ipcMain.handle("path:downloads", () => {
		return app.getPath("downloads");
	});

	ipcMain.handle("path:home", () => {
		return app.getPath("home");
	});
}
