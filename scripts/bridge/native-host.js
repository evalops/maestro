#!/usr/bin/env node
// Native messaging host for the Conductor <-> Composer bridge.
// Implements Chrome's length-prefixed JSON protocol and launches/monitors
// the local Composer web server as needed.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE_URL =
	process.env.COMPOSER_BRIDGE_BASE_URL?.trim() || "http://localhost:8080";
const HOST_NAME =
	process.env.COMPOSER_BRIDGE_HOST?.trim() || "com.evalops.composer_bridge";
const COMMAND =
	process.env.COMPOSER_BRIDGE_COMMAND?.trim() || "composer";
const RAW_ARGS = process.env.COMPOSER_BRIDGE_ARGS?.trim() || "";
const STATUS_POLL_INTERVAL_MS = Number.parseInt(
	process.env.COMPOSER_BRIDGE_POLL_MS || "2000",
	10,
);
const LAUNCH_TIMEOUT_MS = Number.parseInt(
	process.env.COMPOSER_BRIDGE_LAUNCH_TIMEOUT_MS || "15000",
	10,
);

let webProcess = null;
let statusTimer = null;
let lastStatusSignature = "";
let currentBaseUrl = DEFAULT_BASE_URL;
let polling = false;

function parseArgs(raw) {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.map((value) => String(value));
		}
	} catch {
		// fall back to whitespace split
	}
	return raw.split(/\s+/).filter(Boolean);
}

const EXTRA_ARGS = parseArgs(RAW_ARGS);

function resolveBaseUrls(baseUrl) {
	const urls = [];
	if (!baseUrl) return urls;
	urls.push(baseUrl);
	try {
		const parsed = new URL(baseUrl);
		if (parsed.hostname === "localhost") {
			urls.push(baseUrl.replace("localhost", "127.0.0.1"));
		} else if (parsed.hostname === "127.0.0.1") {
			urls.push(baseUrl.replace("127.0.0.1", "localhost"));
		}
	} catch {
		// ignore invalid base url
	}
	return Array.from(new Set(urls));
}

async function fetchWithTimeout(url, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		return response;
	} finally {
		clearTimeout(timer);
	}
}

async function probeBridgeStatus(baseUrl) {
	const candidates = resolveBaseUrls(baseUrl);
	let lastError = null;

	for (const candidate of candidates) {
		try {
			const response = await fetchWithTimeout(
				new URL("/api/bridge/status", candidate).toString(),
				4000,
			);
			if (!response.ok) {
				throw new Error(`status ${response.status}`);
			}
			const data = await response.json();
			return {
				reachable: true,
				baseUrl: candidate,
				bridgeStatus: data,
				error: null,
			};
		} catch (error) {
			lastError = error;
		}
	}

	return {
		reachable: false,
		baseUrl: candidates[0] || baseUrl || null,
		bridgeStatus: null,
		error: lastError ? String(lastError) : "Bridge status unavailable",
	};
}

function isProcessRunning(proc) {
	return Boolean(proc && proc.exitCode === null && !proc.killed);
}

function getPortFromBaseUrl(baseUrl) {
	try {
		const parsed = new URL(baseUrl);
		return parsed.port ? Number.parseInt(parsed.port, 10) : null;
	} catch {
		return null;
	}
}

function buildLaunchEnv() {
	const env = { ...process.env };
	if (!env.COMPOSER_WEB_REQUIRE_KEY) env.COMPOSER_WEB_REQUIRE_KEY = "0";
	if (!env.COMPOSER_WEB_REQUIRE_REDIS) env.COMPOSER_WEB_REQUIRE_REDIS = "0";
	if (!env.COMPOSER_WEB_ORIGIN) env.COMPOSER_WEB_ORIGIN = "*";
	return env;
}

async function ensureComposerWeb(baseUrl) {
	currentBaseUrl = baseUrl || currentBaseUrl;
	const status = await probeBridgeStatus(currentBaseUrl);
	if (status.reachable) {
		return { ...status, launched: false };
	}

	if (!isProcessRunning(webProcess)) {
		const port = getPortFromBaseUrl(currentBaseUrl);
		const args = ["web", ...(port ? ["--port", String(port)] : []), ...EXTRA_ARGS];
		try {
			webProcess = spawn(COMMAND, args, {
				stdio: "ignore",
				env: buildLaunchEnv(),
			});
			webProcess.on("exit", () => {
				webProcess = null;
			});
			webProcess.on("error", (_err) => {
				// Handle spawn errors (e.g., ENOENT when command not found)
				// The error is logged but not thrown to avoid crashing the host
				webProcess = null;
			});
		} catch (error) {
			return {
				reachable: false,
				baseUrl: currentBaseUrl,
				bridgeStatus: null,
				error: `Failed to launch Composer: ${error instanceof Error ? error.message : String(error)}`,
				launched: false,
			};
		}
	}

	const startedAt = Date.now();
	while (Date.now() - startedAt < LAUNCH_TIMEOUT_MS) {
		const refreshed = await probeBridgeStatus(currentBaseUrl);
		if (refreshed.reachable) {
			return { ...refreshed, launched: true };
		}
		await delay(500);
	}

	return {
		reachable: false,
		baseUrl: currentBaseUrl,
		bridgeStatus: null,
		error: "Composer did not become reachable in time",
		launched: false,
	};
}

function makeStatusPayload(status, extras = {}) {
	return {
		host: {
			name: HOST_NAME,
			command: COMMAND,
			pid: webProcess?.pid ?? null,
		},
		baseUrl: status.baseUrl ?? currentBaseUrl,
		reachable: Boolean(status.reachable),
		error: status.error ?? null,
		bridgeStatus: status.bridgeStatus ?? null,
		...extras,
	};
}

function statusSignature(payload) {
	return JSON.stringify({
		reachable: payload.reachable,
		baseUrl: payload.baseUrl,
		version: payload.bridgeStatus?.version ?? null,
	});
}

function startStatusPolling() {
	if (statusTimer) return;
  statusTimer = setInterval(async () => {
    if (polling) return;
		polling = true;
		try {
			const status = await probeBridgeStatus(currentBaseUrl);
			const payload = makeStatusPayload(status, { event: "poll" });
			const signature = statusSignature(payload);
			if (signature !== lastStatusSignature) {
				lastStatusSignature = signature;
				sendNotification("bridge/status", payload);
			}
		} catch (error) {
			sendNotification("bridge/status", {
				host: { name: HOST_NAME },
				reachable: false,
				error: String(error),
				baseUrl: currentBaseUrl,
			});
		} finally {
			polling = false;
		}
  }, STATUS_POLL_INTERVAL_MS);
  statusTimer.unref?.();
}

function stopStatusPolling() {
	if (!statusTimer) return;
	clearInterval(statusTimer);
	statusTimer = null;
}

function sendNativeMessage(message) {
	const json = JSON.stringify(message);
	const buffer = Buffer.from(json, "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(buffer.length, 0);
	process.stdout.write(Buffer.concat([header, buffer]));
}

function sendResponse(id, type, payload) {
	sendNativeMessage({
		id,
		type,
		ok: !payload?.error,
		...payload,
	});
}

function sendNotification(method, params) {
	sendNativeMessage({
		jsonrpc: "2.0",
		method,
		params,
	});
}

function handleMessage(message) {
	if (!message || typeof message !== "object") {
		return;
	}
	const { id, type } = message;
	if (id == null || typeof type !== "string") {
		sendNativeMessage({
			type: "error",
			ok: false,
			error: "Invalid bridge message",
		});
		return;
	}

	const baseUrl =
		typeof message.baseUrl === "string" && message.baseUrl.trim()
			? message.baseUrl.trim()
			: currentBaseUrl;

	switch (type) {
		case "ping": {
			sendResponse(id, "pong", { data: { host: HOST_NAME } });
			break;
		}
		case "status": {
			currentBaseUrl = baseUrl;
			startStatusPolling();
			probeBridgeStatus(baseUrl)
				.then((status) => {
					const payload = makeStatusPayload(status);
					sendResponse(id, "status_response", { data: payload });
				})
				.catch((error) => {
					sendResponse(id, "status_response", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			break;
		}
		case "launch": {
			currentBaseUrl = baseUrl;
			startStatusPolling();
			ensureComposerWeb(baseUrl)
				.then((status) => {
					const payload = makeStatusPayload(status, {
						launched: status.launched ?? false,
					});
					sendResponse(id, "launch_response", { data: payload });
				})
				.catch((error) => {
					sendResponse(id, "launch_response", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			break;
		}
		case "shutdown": {
			if (isProcessRunning(webProcess)) {
				try {
					webProcess.kill();
				} catch {
					// ignore errors
				}
			}
			stopStatusPolling();
			sendResponse(id, "shutdown_response", { data: { stopped: true } });
			break;
		}
		default: {
			sendResponse(id, "error", { error: `Unknown request type: ${type}` });
		}
	}
}

// Native messaging framing
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (buffer.length >= 4) {
		const messageLength = buffer.readUInt32LE(0);
		if (buffer.length < 4 + messageLength) return;
		const messageBuffer = buffer.slice(4, 4 + messageLength);
		buffer = buffer.slice(4 + messageLength);
		try {
			const message = JSON.parse(messageBuffer.toString("utf8"));
			handleMessage(message);
		} catch (error) {
			sendNativeMessage({
				type: "error",
				ok: false,
				error: `Failed to parse message: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
});

process.stdin.on("end", () => {
	stopStatusPolling();
	if (isProcessRunning(webProcess)) {
		try {
			webProcess.kill();
		} catch {
			// ignore errors
		}
	}
});

process.stdin.resume();
