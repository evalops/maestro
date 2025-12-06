/**
 * Native TUI Launcher
 *
 * Spawns the Rust TUI binary and handles IPC communication.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Interface, createInterface } from "node:readline";
import type {
	CursorPosition,
	HistoryLine,
	InboundMessage,
	KeyModifiers,
	OutboundMessage,
	RenderNode,
} from "./protocol.js";

const DEBUG = process.env.COMPOSER_NATIVE_TUI_DEBUG === "1";

function debug(...args: unknown[]): void {
	if (DEBUG) {
		console.error("[native-tui]", ...args);
	}
}

export interface NativeTuiEvents {
	ready: (width: number, height: number, enhancedKeys: boolean) => void;
	key: (key: string, modifiers: KeyModifiers) => void;
	paste: (text: string) => void;
	resize: (width: number, height: number) => void;
	focus: (focused: boolean) => void;
	error: (message: string) => void;
	exit: (code: number) => void;
}

export class NativeTuiLauncher extends EventEmitter {
	private process: ChildProcess | null = null;
	private readline: Interface | null = null;
	private ipcWrite: NodeJS.WritableStream | null = null;
	private ready = false;
	private width = 80;
	private height = 24;
	private enhancedKeys = false;

	constructor(private binaryPath?: string) {
		super();
	}

	/**
	 * Find the native TUI binary path
	 */
	private findBinary(): string {
		// Check custom path first
		if (this.binaryPath && existsSync(this.binaryPath)) {
			return this.binaryPath;
		}

		// Check common locations
		const candidates = [
			// Development: built in packages/tui-rs
			join(process.cwd(), "packages/tui-rs/target/release/composer-tui"),
			join(process.cwd(), "packages/tui-rs/target/debug/composer-tui"),
			// Installed alongside composer
			join(__dirname, "../../../bin/composer-tui"),
			join(__dirname, "../../../../bin/composer-tui"),
			// System path
			"composer-tui",
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				debug("Found binary at:", candidate);
				return candidate;
			}
		}

		throw new Error(
			"Native TUI binary not found. Build it with: cd packages/tui-rs && cargo build --release",
		);
	}

	/**
	 * Start the native TUI process
	 *
	 * We use fd 3/4 for IPC instead of stdin/stdout so that the Rust process
	 * can access the terminal directly via /dev/tty.
	 * - fd 0 (stdin): inherited (terminal)
	 * - fd 1 (stdout): inherited (terminal)
	 * - fd 2 (stderr): inherited (terminal)
	 * - fd 3: pipe for TypeScript → Rust messages
	 * - fd 4: pipe for Rust → TypeScript messages
	 */
	async start(): Promise<void> {
		const binary = this.findBinary();
		debug("Starting native TUI:", binary);

		this.process = spawn(binary, [], {
			stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
			env: {
				...process.env,
				TERM: process.env.TERM || "xterm-256color",
			},
		});

		// Get the IPC pipes (fd 3 = index 3, fd 4 = index 4)
		const ipcWrite = this.process.stdio[3] as NodeJS.WritableStream;
		const ipcRead = this.process.stdio[4] as NodeJS.ReadableStream;

		if (!ipcWrite || !ipcRead) {
			throw new Error("Failed to create IPC pipes");
		}

		// Store the write pipe for sending messages
		this.ipcWrite = ipcWrite;

		// Set up readline for NDJSON parsing from fd 4
		this.readline = createInterface({
			input: ipcRead,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		this.readline.on("line", (line) => {
			this.handleMessage(line);
		});

		this.process.on("error", (err) => {
			debug("Process error:", err);
			this.emit("error", err.message);
		});

		this.process.on("exit", (code) => {
			debug("Process exited:", code);
			this.ready = false;
			this.emit("exit", code ?? 0);
		});

		// Wait for ready message
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("Native TUI failed to start within 5 seconds"));
			}, 5000);

			const onReady = () => {
				clearTimeout(timeout);
				resolve();
			};

			this.once("ready", onReady);
		});
	}

	/**
	 * Handle incoming message from Rust TUI
	 */
	private handleMessage(line: string): void {
		try {
			const msg = JSON.parse(line) as OutboundMessage;
			debug("Received:", msg.type);

			switch (msg.type) {
				case "ready":
					this.ready = true;
					this.width = msg.width;
					this.height = msg.height;
					this.enhancedKeys = msg.enhanced_keys;
					this.emit("ready", msg.width, msg.height, msg.enhanced_keys);
					break;

				case "key":
					this.emit("key", msg.key, msg.modifiers);
					break;

				case "paste":
					this.emit("paste", msg.text);
					break;

				case "resized":
					this.width = msg.width;
					this.height = msg.height;
					this.emit("resize", msg.width, msg.height);
					break;

				case "focus":
					this.emit("focus", msg.focused);
					break;

				case "error":
					this.emit("error", msg.message);
					break;

				case "exiting":
					this.emit("exit", msg.code);
					break;
			}
		} catch (err) {
			debug("Failed to parse message:", line, err);
		}
	}

	/**
	 * Send a message to the Rust TUI via fd 3
	 */
	private send(msg: InboundMessage): void {
		if (!this.ipcWrite || !this.ready) {
			debug("Cannot send - process not ready");
			return;
		}

		const json = JSON.stringify(msg);
		debug("Sending:", msg.type);
		this.ipcWrite.write(`${json}\n`);
	}

	/**
	 * Render a component tree
	 */
	render(root: RenderNode, cursor?: CursorPosition): void {
		this.send({
			type: "render",
			root,
			cursor: cursor ?? null,
		});
	}

	/**
	 * Push lines into terminal scrollback
	 */
	pushHistory(lines: HistoryLine[]): void {
		this.send({
			type: "push_history",
			lines,
		});
	}

	/**
	 * Notify terminal resize
	 */
	resize(width: number, height: number): void {
		this.send({
			type: "resize",
			width,
			height,
		});
	}

	/**
	 * Send desktop notification
	 */
	notify(message: string): void {
		this.send({
			type: "notify",
			message,
		});
	}

	/**
	 * Request exit
	 */
	exit(code = 0): void {
		this.send({
			type: "exit",
			code,
		});
	}

	/**
	 * Stop the native TUI process
	 */
	stop(): void {
		if (this.readline) {
			this.readline.close();
			this.readline = null;
		}

		if (this.process) {
			this.exit(0);
			// Give it a moment to clean up
			setTimeout(() => {
				if (this.process && !this.process.killed) {
					this.process.kill();
				}
			}, 100);
			this.process = null;
		}

		this.ready = false;
	}

	/**
	 * Check if native TUI is available
	 */
	static isAvailable(): boolean {
		try {
			// Check if binary exists
			const launcher = new NativeTuiLauncher();
			launcher.findBinary();

			// Check if /dev/tty is accessible (we have a controlling terminal)
			// This fails in background processes, CI, or when piped
			const fs = require("node:fs");
			fs.accessSync("/dev/tty", fs.constants.R_OK | fs.constants.W_OK);

			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get current terminal size
	 */
	getSize(): { width: number; height: number } {
		return { width: this.width, height: this.height };
	}

	/**
	 * Check if ready
	 */
	isReady(): boolean {
		return this.ready;
	}
}
