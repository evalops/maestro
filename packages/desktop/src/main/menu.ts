/**
 * Application Menu
 *
 * Defines the native menu bar for the application.
 */

import { type BrowserWindow, Menu, app, shell } from "electron";

export function createMenu(mainWindow: BrowserWindow): void {
	const isMac = process.platform === "darwin";

	const template: Electron.MenuItemConstructorOptions[] = [
		// App menu (macOS only)
		...(isMac
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" as const },
							{ type: "separator" as const },
							{
								label: "Preferences...",
								accelerator: "Cmd+,",
								click: () => {
									mainWindow.webContents.send("menu:preferences");
								},
							},
							{ type: "separator" as const },
							{ role: "services" as const },
							{ type: "separator" as const },
							{ role: "hide" as const },
							{ role: "hideOthers" as const },
							{ role: "unhide" as const },
							{ type: "separator" as const },
							{ role: "quit" as const },
						],
					},
				]
			: []),

		// File menu
		{
			label: "File",
			submenu: [
				{
					label: "New Session",
					accelerator: isMac ? "Cmd+N" : "Ctrl+N",
					click: () => {
						mainWindow.webContents.send("menu:new-session");
					},
				},
				{ type: "separator" },
				{
					label: "Export Session...",
					accelerator: isMac ? "Cmd+Shift+E" : "Ctrl+Shift+E",
					click: () => {
						mainWindow.webContents.send("menu:export-session");
					},
				},
				{ type: "separator" },
				isMac ? { role: "close" } : { role: "quit" },
			],
		},

		// Edit menu
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
				{ type: "separator" },
				{
					label: "Find...",
					accelerator: isMac ? "Cmd+F" : "Ctrl+F",
					click: () => {
						mainWindow.webContents.send("menu:find");
					},
				},
			],
		},

		// View menu
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
				{ type: "separator" },
				{
					label: "Toggle Sidebar",
					accelerator: isMac ? "Cmd+\\" : "Ctrl+\\",
					click: () => {
						mainWindow.webContents.send("menu:toggle-sidebar");
					},
				},
			],
		},

		// Model menu
		{
			label: "Model",
			submenu: [
				{
					label: "Select Model...",
					accelerator: isMac ? "Cmd+M" : "Ctrl+M",
					click: () => {
						mainWindow.webContents.send("menu:select-model");
					},
				},
				{ type: "separator" },
				{
					label: "Claude Sonnet 4",
					click: () => {
						mainWindow.webContents.send(
							"menu:set-model",
							"claude-sonnet-4-5-20250929",
						);
					},
				},
				{
					label: "Claude Opus 4.6",
					click: () => {
						mainWindow.webContents.send("menu:set-model", "claude-opus-4-6");
					},
				},
				{
					label: "Claude Haiku",
					click: () => {
						mainWindow.webContents.send(
							"menu:set-model",
							"claude-haiku-4-5-20251001",
						);
					},
				},
			],
		},

		// Session menu
		{
			label: "Session",
			submenu: [
				{
					label: "Clear Context",
					accelerator: isMac ? "Cmd+K" : "Ctrl+K",
					click: () => {
						mainWindow.webContents.send("menu:clear-context");
					},
				},
				{
					label: "View Sessions...",
					accelerator: isMac ? "Cmd+Shift+S" : "Ctrl+Shift+S",
					click: () => {
						mainWindow.webContents.send("menu:view-sessions");
					},
				},
				{ type: "separator" },
				{
					label: "Share Session...",
					click: () => {
						mainWindow.webContents.send("menu:share-session");
					},
				},
			],
		},

		// Window menu
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				...(isMac
					? [
							{ type: "separator" as const },
							{ role: "front" as const },
							{ type: "separator" as const },
							{ role: "window" as const },
						]
					: [{ role: "close" as const }]),
			],
		},

		// Help menu
		{
			role: "help",
			submenu: [
				{
					label: "Documentation",
					click: () => {
						shell.openExternal("https://github.com/evalops/maestro#readme");
					},
				},
				{
					label: "Report Issue",
					click: () => {
						shell.openExternal("https://github.com/evalops/maestro/issues/new");
					},
				},
				{ type: "separator" },
				{
					label: "View Keyboard Shortcuts",
					accelerator: isMac ? "Cmd+/" : "Ctrl+/",
					click: () => {
						mainWindow.webContents.send("menu:show-shortcuts");
					},
				},
			],
		},
	];

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}
