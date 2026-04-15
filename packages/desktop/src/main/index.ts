/**
 * Electron Main Process Entry Point
 *
 * This is the entry point for the Electron main process.
 * It handles app lifecycle, window creation, and native integrations.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app } from "electron";
import { setupIpc } from "./ipc";
import { createMenu } from "./menu";
import { startServer, stopServer } from "./server";
import { createMainWindow } from "./window";

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Disable hardware acceleration for better compatibility
app.disableHardwareAcceleration();

// Set app name
app.setName("Maestro");

// Keep a global reference of the window object
let mainWindow: BrowserWindow | null = null;

// Get the preload script path (vite-plugin-electron outputs as .mjs with CJS content)
const preloadPath = join(__dirname, "../preload/index.mjs");

// Create window when Electron is ready
app.whenReady().then(async () => {
	// Setup IPC handlers before creating window
	setupIpc();

	// Start the backend server
	console.log("Starting Composer backend server...");
	const serverStarted = await startServer();
	if (!serverStarted) {
		console.warn(
			"Backend server failed to start - app may have limited functionality",
		);
	}

	// Create the browser window
	mainWindow = createMainWindow(preloadPath);

	// Create the application menu
	createMenu(mainWindow);

	// On macOS, re-create a window when the dock icon is clicked
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			mainWindow = createMainWindow(preloadPath);
		}
	});
});

// Quit when all windows are closed, except on macOS
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// Stop server when app is about to quit
app.on("will-quit", () => {
	stopServer();
});

// Handle second instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		// If user tries to open a second instance, focus our window
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});
}

// Handle errors
process.on("uncaughtException", (error) => {
	console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason) => {
	console.error("Unhandled Rejection:", reason);
});
