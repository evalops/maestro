/**
 * Backend Server Management
 *
 * Spawns and manages the Maestro backend server process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import {
	DESKTOP_DEFAULT_API_PORT,
	DESKTOP_DEFAULT_CSRF_TOKEN,
	DESKTOP_DEV_API_KEY,
} from "../shared/runtime-defaults.js";
import { getDeviceIdentityHelperPath } from "./device-identity-helper-path.js";

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let serverProcess: ChildProcess | null = null;
let serverReady = false;

const SERVER_PORT = Number(
	process.env.MAESTRO_DESKTOP_PORT ?? DESKTOP_DEFAULT_API_PORT,
);
const SERVER_HOST = "127.0.0.1";
const RENDERER_SERVER_HOST = "localhost";
const IS_DEV_SERVER = Boolean(process.env.VITE_DEV_SERVER_URL);
const DEV_UI_PORT =
	process.env.MAESTRO_DESKTOP_UI_PORT ?? process.env.VITE_PORT;
const DEV_UI_ORIGIN = process.env.VITE_DEV_SERVER_URL
	? process.env.VITE_DEV_SERVER_URL.replace(/\/$/, "")
	: `http://localhost:${DEV_UI_PORT ?? "5173"}`;
const CSRF_TOKEN =
	process.env.MAESTRO_DESKTOP_CSRF_TOKEN ?? DESKTOP_DEFAULT_CSRF_TOKEN;
const API_KEY =
	process.env.MAESTRO_DESKTOP_API_KEY ??
	(IS_DEV_SERVER ? DESKTOP_DEV_API_KEY : randomUUID());
const JWT_SECRET =
	process.env.MAESTRO_DESKTOP_JWT_SECRET ?? randomBytes(32).toString("hex");

export interface DesktopApiConfig {
	baseUrl: string;
	apiKey: string;
	csrfToken: string;
}

/**
 * Get the path to the web server module
 */
function getWebServerPath(): string {
	// In development, use the local web-server from the monorepo dist
	if (
		process.env.NODE_ENV === "development" ||
		process.env.VITE_DEV_SERVER_URL
	) {
		// Go up from packages/desktop/dist-electron/main to the root
		return join(__dirname, "../../../../dist/web-server.js");
	}

	// In production, use bundled web-server or system-installed
	const resourcesPath = process.resourcesPath || app.getAppPath();
	return join(resourcesPath, "web-server.js");
}

/**
 * Check if the server is ready by polling the health endpoint
 */
async function waitForServer(
	maxAttempts = 30,
	delayMs = 500,
): Promise<boolean> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const response = await fetch(
				`http://${SERVER_HOST}:${SERVER_PORT}/healthz`,
			);
			if (response.ok) {
				return true;
			}
		} catch {
			// Server not ready yet
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	return false;
}

/**
 * Start the Maestro backend server
 */
export async function startServer(): Promise<boolean> {
	if (serverProcess && serverReady) {
		console.log("Server already running");
		return true;
	}

	const webServerPath = getWebServerPath();
	console.log("Starting Maestro server from:", webServerPath);

	return new Promise((resolve) => {
		try {
			// Spawn the web server directly
			serverProcess = spawn("node", [webServerPath], {
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PORT: String(SERVER_PORT),
					NODE_ENV: "production",
					// Disable API key requirement for local desktop use
					MAESTRO_WEB_REQUIRE_KEY: "0",
					MAESTRO_WEB_API_KEY: API_KEY,
					MAESTRO_WEB_REQUIRE_REDIS: "0",
					MAESTRO_WEB_CSRF_TOKEN: CSRF_TOKEN,
					MAESTRO_JWT_SECRET: JWT_SECRET,
					// Allow CORS from Vite dev server and Electron
					MAESTRO_WEB_ORIGIN: DEV_UI_ORIGIN,
				},
				detached: false,
			});

			serverProcess.stdout?.on("data", (data: Buffer) => {
				const output = data.toString();
				console.log("[Server]", output);

				// Check if server is ready
				if (
					output.includes("listening") ||
					output.includes("ready") ||
					output.includes(`:${SERVER_PORT}`)
				) {
					serverReady = true;
				}
			});

			serverProcess.stderr?.on("data", (data: Buffer) => {
				console.error("[Server Error]", data.toString());
			});

			serverProcess.on("error", (error) => {
				console.error("Failed to start server:", error);
				serverProcess = null;
				serverReady = false;
				resolve(false);
			});

			serverProcess.on("exit", (code) => {
				console.log("Server process exited with code:", code);
				serverProcess = null;
				serverReady = false;
			});

			// Wait for server to be ready
			waitForServer().then((ready) => {
				serverReady = ready;
				if (ready) {
					console.log("Server is ready!");
				} else {
					console.error("Server failed to start within timeout");
				}
				resolve(ready);
			});
		} catch (error) {
			console.error("Error starting server:", error);
			resolve(false);
		}
	});
}

/**
 * Stop the Maestro backend server
 */
export function stopServer(): void {
	if (serverProcess) {
		console.log("Stopping server...");
		serverProcess.kill("SIGTERM");
		serverProcess = null;
		serverReady = false;
	}
}

/**
 * Check if the server is currently running and ready
 */
export function isServerReady(): boolean {
	return serverReady && serverProcess !== null;
}

/**
 * Get the server URL
 */
export function getServerUrl(): string {
	return `http://${RENDERER_SERVER_HOST}:${SERVER_PORT}`;
}

export function getServerApiConfig(): DesktopApiConfig {
	return {
		baseUrl: getServerUrl(),
		apiKey: API_KEY,
		csrfToken: CSRF_TOKEN,
	};
}
