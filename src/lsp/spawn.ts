import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	StreamMessageReader,
	StreamMessageWriter,
	createMessageConnection,
} from "vscode-jsonrpc/node.js";
import { LspClient } from "./client.js";
import type { LspServerConfig } from "./types.js";
import { sleep } from "./utils.js";

/**
 * Wait for process to spawn successfully or fail
 */
async function waitForSpawn(
	proc: ChildProcessWithoutNullStreams,
): Promise<boolean> {
	return Promise.race([
		// If error event fires, spawn failed
		once(proc, "error").then(() => false),
		// If stdout becomes readable, spawn succeeded
		once(proc.stdout, "readable").then(() => true),
		// If process exits immediately, spawn failed
		once(proc, "exit").then(([code]) => code === null || code === 0),
		// Timeout fallback - assume success if no error within 100ms
		sleep(100).then(() => true),
	]);
}

/**
 * Spawn and initialize an LSP client
 */
export async function spawnLspClient(
	server: LspServerConfig,
	root: string,
): Promise<LspClient | undefined> {
	try {
		const proc = spawn(server.command, server.args ?? [], {
			cwd: root,
			env: { ...process.env, ...server.env },
		});

		// Setup error handler
		proc.on("error", (err) => {
			console.error(`[lsp] Failed to spawn ${server.id}:`, err);
		});

		// Prevent unhandled pipe errors
		proc.stdin.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code !== "EPIPE") {
				console.error(`[lsp] stdin error for ${server.id}:`, err);
			}
		});

		// Wait for spawn to complete or fail
		const spawnSuccess = await waitForSpawn(proc);
		if (!spawnSuccess) {
			return undefined;
		}

		// Create connection (inputStream=stdout, outputStream=stdin)
		const connection = createMessageConnection(
			new StreamMessageReader(proc.stdout),
			new StreamMessageWriter(proc.stdin),
		);

		// Create client instance
		const client = new LspClient(server, root, proc, connection);

		// Start listening
		connection.listen();

		// Initialize
		await client.initialize(server.initializationOptions);

		return client;
	} catch (error) {
		console.error(`[lsp] Failed to start ${server.id}:`, error);
		return undefined;
	}
}
