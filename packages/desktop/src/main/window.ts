/**
 * Window Management
 *
 * Handles creation and configuration of the main application window.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, shell } from "electron";
import Store from "electron-store";

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Store for window state persistence
const store = new Store<{
	windowBounds?: { x: number; y: number; width: number; height: number };
	isMaximized?: boolean;
}>();

// Default window dimensions
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const OPEN_DEVTOOLS =
	process.env.MAESTRO_DESKTOP_OPEN_DEVTOOLS === "1" ||
	process.env.VITE_DESKTOP_OPEN_DEVTOOLS === "1";
const LOG_RENDERER_CONSOLE =
	process.env.MAESTRO_DESKTOP_LOG_RENDERER === "1" ||
	process.env.VITE_DESKTOP_LOG_RENDERER === "1";

export function createMainWindow(preloadPath: string): BrowserWindow {
	// Restore previous window bounds if available
	const previousBounds = store.get("windowBounds");
	const wasMaximized = store.get("isMaximized", false);

	const mainWindow = new BrowserWindow({
		width: previousBounds?.width ?? DEFAULT_WIDTH,
		height: previousBounds?.height ?? DEFAULT_HEIGHT,
		x: previousBounds?.x,
		y: previousBounds?.y,
		minWidth: MIN_WIDTH,
		minHeight: MIN_HEIGHT,
		show: false, // Don't show until ready
		frame: process.platform !== "darwin", // Frameless on macOS
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
		trafficLightPosition: { x: 16, y: 16 },
		backgroundColor: "#0a0a0b", // Dark background to prevent flash
		webPreferences: {
			preload: preloadPath,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});

	// Restore maximized state
	if (wasMaximized) {
		mainWindow.maximize();
	}

	// Show window when ready to prevent visual flash
	mainWindow.once("ready-to-show", () => {
		mainWindow.show();
	});

	// Save window state on close
	mainWindow.on("close", () => {
		const bounds = mainWindow.getBounds();
		const isMaximized = mainWindow.isMaximized();

		store.set("windowBounds", bounds);
		store.set("isMaximized", isMaximized);
	});

	// Open external links in browser
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});

	if (LOG_RENDERER_CONSOLE) {
		mainWindow.webContents.on(
			"console-message",
			(_event, level, message, line, sourceId) => {
				console.log(`[Renderer:${level}] ${message} (${sourceId}:${line})`);
			},
		);
	}

	// Load the app
	if (process.env.VITE_DEV_SERVER_URL) {
		// Development: load from Vite dev server
		mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
		if (OPEN_DEVTOOLS) {
			mainWindow.webContents.openDevTools();
		}
	} else {
		// Production: load from bundled files
		mainWindow.loadFile(join(__dirname, "../../dist/index.html"));
	}

	return mainWindow;
}
