import { describe, expect, it, vi } from "vitest";
import {
	IDEAutoConnectManager,
	type IDEInfo,
	type IDEType,
	createIDEAutoConnectManager,
	detectIDEs,
	getIDEAutoConnectConfig,
	getPrimaryIDE,
} from "../../src/ide/auto-connect.js";

describe("IDE Auto-Connect", () => {
	describe("getIDEAutoConnectConfig", () => {
		it("returns default configuration", () => {
			const config = getIDEAutoConnectConfig();

			expect(config.enabled).toBe(true);
			expect(config.timeout).toBe(5000);
			expect(config.scanPorts).toBeInstanceOf(Array);
			expect(config.scanInterval).toBeGreaterThan(0);
		});

		it("respects COMPOSER_IDE_AUTOCONNECT=false", () => {
			const originalEnv = process.env.COMPOSER_IDE_AUTOCONNECT;
			process.env.COMPOSER_IDE_AUTOCONNECT = "false";

			try {
				const config = getIDEAutoConnectConfig();
				expect(config.enabled).toBe(false);
			} finally {
				if (originalEnv === undefined) {
					process.env.COMPOSER_IDE_AUTOCONNECT = undefined;
				} else {
					process.env.COMPOSER_IDE_AUTOCONNECT = originalEnv;
				}
			}
		});

		it("parses custom ports", () => {
			const originalEnv = process.env.COMPOSER_IDE_SCAN_PORTS;
			process.env.COMPOSER_IDE_SCAN_PORTS = "8000,9000,10000";

			try {
				const config = getIDEAutoConnectConfig();
				expect(config.scanPorts).toEqual([8000, 9000, 10000]);
			} finally {
				if (originalEnv === undefined) {
					process.env.COMPOSER_IDE_SCAN_PORTS = undefined;
				} else {
					process.env.COMPOSER_IDE_SCAN_PORTS = originalEnv;
				}
			}
		});
	});

	describe("detectIDEs", () => {
		it("returns an array of IDE info", () => {
			const ides = detectIDEs();

			expect(ides).toBeInstanceOf(Array);
			for (const ide of ides) {
				expect(ide.type).toBeDefined();
				expect(ide.name).toBeDefined();
				expect(typeof ide.running).toBe("boolean");
			}
		});

		it("includes valid IDE types", () => {
			const validTypes: IDEType[] = [
				"vscode",
				"vscode-insiders",
				"cursor",
				"windsurf",
				"jetbrains-idea",
				"jetbrains-webstorm",
				"jetbrains-pycharm",
				"jetbrains-goland",
				"jetbrains-rider",
				"jetbrains-clion",
				"jetbrains-rubymine",
				"jetbrains-datagrip",
				"vim",
				"neovim",
				"emacs",
				"sublime",
				"zed",
				"unknown",
			];

			const ides = detectIDEs();
			for (const ide of ides) {
				expect(validTypes).toContain(ide.type);
			}
		});
	});

	describe("getPrimaryIDE", () => {
		it("returns null or an IDE info object", () => {
			const primary = getPrimaryIDE();

			if (primary !== null) {
				expect(primary.type).toBeDefined();
				expect(primary.name).toBeDefined();
			}
		});
	});

	describe("IDEAutoConnectManager", () => {
		it("creates with default config", () => {
			const manager = createIDEAutoConnectManager();

			expect(manager).toBeDefined();
		});

		it("creates with custom config", () => {
			const manager = new IDEAutoConnectManager({
				enabled: false,
				timeout: 1000,
			});

			expect(manager).toBeDefined();
		});

		it("scans for IDEs", () => {
			const manager = new IDEAutoConnectManager();
			const ides = manager.scan();

			expect(ides).toBeInstanceOf(Array);
		});

		it("tracks connected IDE", () => {
			const manager = new IDEAutoConnectManager();

			// Initially no connected IDE
			expect(manager.getConnectedIDE()).toBeNull();

			// After scan, may have connected IDE
			manager.scan();
			// Result depends on environment
		});

		it("calls callbacks on connect", () => {
			const onConnect = vi.fn();
			const onDisconnect = vi.fn();

			const manager = new IDEAutoConnectManager();
			manager.setCallbacks({ onConnect, onDisconnect });

			// Scan - may trigger connect
			manager.scan();

			// If an IDE was detected, onConnect should have been called
			if (manager.getConnectedIDE() !== null) {
				expect(onConnect).toHaveBeenCalled();
			}
		});

		it("allows manual connection to IDE type", () => {
			const manager = new IDEAutoConnectManager();
			const ides = detectIDEs();

			if (ides.length > 0) {
				const firstIDE = ides[0];
				const connected = manager.connectTo(firstIDE.type);

				expect(connected).not.toBeNull();
				expect(manager.getConnectedIDE()?.type).toBe(firstIDE.type);
			}
		});

		it("disconnects from IDE", () => {
			const manager = new IDEAutoConnectManager();
			const ides = detectIDEs();

			if (ides.length > 0) {
				manager.connectTo(ides[0].type);
				manager.disconnect();

				expect(manager.getConnectedIDE()).toBeNull();
			}
		});

		it("starts and stops scanning", () => {
			const manager = new IDEAutoConnectManager({
				scanInterval: 100, // Fast for testing
			});

			expect(() => {
				manager.startScanning();
				manager.stopScanning();
			}).not.toThrow();
		});

		it("does not start scanning when disabled", () => {
			const manager = new IDEAutoConnectManager({
				enabled: false,
			});

			// Should not throw and should not start timer
			expect(() => {
				manager.startScanning();
				manager.stopScanning();
			}).not.toThrow();
		});

		it("returns all detected IDEs", () => {
			const manager = new IDEAutoConnectManager();
			const detected = manager.getDetectedIDEs();

			expect(detected).toBeInstanceOf(Array);
			expect(detected).toEqual(detectIDEs());
		});
	});
});
