import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SSH_RENDER_INTERVAL_MS,
	getLowBandwidthConfig,
	getRenderInterval,
	getTerminalCapabilities,
	isMinimalMode,
} from "../../src/cli-tui/terminal/terminal-utils.js";

// Helper to clear env var (lint rule forbids direct delete)
function clearEnv(key: string): void {
	Reflect.deleteProperty(process.env, key);
}

describe("terminal-utils", () => {
	describe("SSH_RENDER_INTERVAL_MS", () => {
		it("is 50ms", () => {
			expect(SSH_RENDER_INTERVAL_MS).toBe(50);
		});
	});

	describe("getTerminalCapabilities", () => {
		it("returns capabilities object with expected properties", () => {
			const caps = getTerminalCapabilities();
			expect(caps).toHaveProperty("isTTY");
			expect(caps).toHaveProperty("columns");
			expect(caps).toHaveProperty("rows");
			expect(caps).toHaveProperty("colorLevel");
			expect(typeof caps.isTTY).toBe("boolean");
			expect(typeof caps.columns).toBe("number");
			expect(typeof caps.rows).toBe("number");
			expect(typeof caps.colorLevel).toBe("number");
		});

		it("has reasonable default values", () => {
			const caps = getTerminalCapabilities();
			expect(caps.columns).toBeGreaterThanOrEqual(80);
			expect(caps.rows).toBeGreaterThanOrEqual(24);
			expect(caps.colorLevel).toBeGreaterThanOrEqual(0);
		});
	});

	describe("getLowBandwidthConfig", () => {
		const envBackup: Record<string, string | undefined> = {};

		beforeEach(() => {
			envBackup.MAESTRO_TUI_LOW_BW = process.env.MAESTRO_TUI_LOW_BW;
			envBackup.MAESTRO_TUI_LOW_BW_BATCH_MS =
				process.env.MAESTRO_TUI_LOW_BW_BATCH_MS;
			envBackup.MAESTRO_TUI_SCROLLBACK = process.env.MAESTRO_TUI_SCROLLBACK;
			envBackup.SSH_CONNECTION = process.env.SSH_CONNECTION;
			envBackup.SSH_TTY = process.env.SSH_TTY;
		});

		afterEach(() => {
			for (const key of Object.keys(envBackup)) {
				if (envBackup[key] === undefined) {
					clearEnv(key);
				} else {
					process.env[key] = envBackup[key];
				}
			}
		});

		it("returns default values when no env vars set", () => {
			clearEnv("MAESTRO_TUI_LOW_BW");
			clearEnv("MAESTRO_TUI_LOW_BW_BATCH_MS");
			clearEnv("MAESTRO_TUI_SCROLLBACK");
			clearEnv("SSH_CONNECTION");
			clearEnv("SSH_TTY");

			const config = getLowBandwidthConfig();
			expect(config.enabled).toBe(false);
			expect(config.batchIntervalMs).toBe(120);
			expect(config.scrollbackLimit).toBe(600);
		});

		it("enables low bandwidth mode with MAESTRO_TUI_LOW_BW=1", () => {
			clearEnv("SSH_CONNECTION");
			clearEnv("SSH_TTY");
			process.env.MAESTRO_TUI_LOW_BW = "1";
			const config = getLowBandwidthConfig();
			expect(config.enabled).toBe(true);
		});

		it("enables low bandwidth mode with MAESTRO_TUI_LOW_BW=true", () => {
			clearEnv("SSH_CONNECTION");
			clearEnv("SSH_TTY");
			process.env.MAESTRO_TUI_LOW_BW = "true";
			const config = getLowBandwidthConfig();
			expect(config.enabled).toBe(true);
		});

		it("enables low bandwidth mode when SSH_CONNECTION is set", () => {
			clearEnv("MAESTRO_TUI_LOW_BW");
			process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 54321";
			const config = getLowBandwidthConfig();
			expect(config.enabled).toBe(true);
		});

		it("enables low bandwidth mode when SSH_TTY is set", () => {
			clearEnv("MAESTRO_TUI_LOW_BW");
			clearEnv("SSH_CONNECTION");
			process.env.SSH_TTY = "/dev/pts/0";
			const config = getLowBandwidthConfig();
			expect(config.enabled).toBe(true);
		});

		it("uses custom batch interval when specified", () => {
			process.env.MAESTRO_TUI_LOW_BW_BATCH_MS = "200";
			const config = getLowBandwidthConfig();
			expect(config.batchIntervalMs).toBe(200);
		});

		it("uses custom scrollback limit when specified", () => {
			process.env.MAESTRO_TUI_SCROLLBACK = "1000";
			const config = getLowBandwidthConfig();
			expect(config.scrollbackLimit).toBe(1000);
		});
	});

	describe("isMinimalMode", () => {
		const envBackup: Record<string, string | undefined> = {};

		beforeEach(() => {
			envBackup.MAESTRO_TUI_MINIMAL = process.env.MAESTRO_TUI_MINIMAL;
			envBackup.SSH_CONNECTION = process.env.SSH_CONNECTION;
			envBackup.SSH_TTY = process.env.SSH_TTY;
		});

		afterEach(() => {
			for (const key of Object.keys(envBackup)) {
				if (envBackup[key] === undefined) {
					clearEnv(key);
				} else {
					process.env[key] = envBackup[key];
				}
			}
		});

		it("returns false when no minimal indicators", () => {
			clearEnv("MAESTRO_TUI_MINIMAL");
			clearEnv("SSH_CONNECTION");
			clearEnv("SSH_TTY");
			expect(isMinimalMode()).toBe(false);
		});

		it("returns true with MAESTRO_TUI_MINIMAL=1", () => {
			clearEnv("SSH_CONNECTION");
			clearEnv("SSH_TTY");
			process.env.MAESTRO_TUI_MINIMAL = "1";
			expect(isMinimalMode()).toBe(true);
		});

		it("returns true with MAESTRO_TUI_MINIMAL=true", () => {
			clearEnv("SSH_CONNECTION");
			clearEnv("SSH_TTY");
			process.env.MAESTRO_TUI_MINIMAL = "true";
			expect(isMinimalMode()).toBe(true);
		});

		it("returns true when SSH_TTY is set", () => {
			clearEnv("MAESTRO_TUI_MINIMAL");
			clearEnv("SSH_CONNECTION");
			process.env.SSH_TTY = "/dev/pts/0";
			expect(isMinimalMode()).toBe(true);
		});

		it("returns true when SSH_CONNECTION is set", () => {
			clearEnv("MAESTRO_TUI_MINIMAL");
			clearEnv("SSH_TTY");
			process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 54321";
			expect(isMinimalMode()).toBe(true);
		});
	});

	describe("getRenderInterval", () => {
		const envBackup: Record<string, string | undefined> = {};

		beforeEach(() => {
			envBackup.MAESTRO_TUI_RENDER_INTERVAL_MS =
				process.env.MAESTRO_TUI_RENDER_INTERVAL_MS;
			envBackup.SSH_CONNECTION = process.env.SSH_CONNECTION;
			envBackup.SSH_TTY = process.env.SSH_TTY;
		});

		afterEach(() => {
			for (const key of Object.keys(envBackup)) {
				if (envBackup[key] === undefined) {
					clearEnv(key);
				} else {
					process.env[key] = envBackup[key];
				}
			}
		});

		it("returns 0 when no env vars set and not SSH", () => {
			clearEnv("MAESTRO_TUI_RENDER_INTERVAL_MS");
			clearEnv("SSH_CONNECTION");
			clearEnv("SSH_TTY");
			expect(getRenderInterval()).toBe(0);
		});

		it("returns SSH_RENDER_INTERVAL_MS when SSH_CONNECTION is set", () => {
			clearEnv("MAESTRO_TUI_RENDER_INTERVAL_MS");
			process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 54321";
			expect(getRenderInterval()).toBe(SSH_RENDER_INTERVAL_MS);
		});

		it("returns SSH_RENDER_INTERVAL_MS when SSH_TTY is set", () => {
			clearEnv("MAESTRO_TUI_RENDER_INTERVAL_MS");
			clearEnv("SSH_CONNECTION");
			process.env.SSH_TTY = "/dev/pts/0";
			expect(getRenderInterval()).toBe(SSH_RENDER_INTERVAL_MS);
		});

		it("returns custom interval when MAESTRO_TUI_RENDER_INTERVAL_MS is set", () => {
			process.env.MAESTRO_TUI_RENDER_INTERVAL_MS = "100";
			expect(getRenderInterval()).toBe(100);
		});

		it("returns 0 for negative values", () => {
			process.env.MAESTRO_TUI_RENDER_INTERVAL_MS = "-10";
			expect(getRenderInterval()).toBe(0);
		});
	});
});
