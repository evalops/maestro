import { describe, expect, it } from "vitest";
import {
	ResourceMonitor,
	extractProcStatFields,
} from "../../src/tools/background/index.js";

describe("extractProcStatFields", () => {
	it("parses standard proc stat format", () => {
		const stat =
			"12345 (node) S 1234 12345 12345 0 -1 4194304 123 0 0 0 100 50 0 0 20 0 1 0 123456 123456789 1234 18446744073709551615";
		const fields = extractProcStatFields(stat);

		expect(fields).not.toBeNull();
		expect(fields?.[0]).toBe("S"); // state
		expect(fields?.[11]).toBe("100"); // utime (user ticks)
		expect(fields?.[12]).toBe("50"); // stime (system ticks)
	});

	it("handles command names with parentheses", () => {
		// Edge case: command name contains ")"
		const stat =
			"12345 (node (v18)) S 1234 12345 12345 0 -1 4194304 123 0 0 0 200 100 0 0 20 0 1 0 123456 123456789 1234 18446744073709551615";
		const fields = extractProcStatFields(stat);

		expect(fields).not.toBeNull();
		expect(fields?.[0]).toBe("S"); // state
		expect(fields?.[11]).toBe("200"); // utime
		expect(fields?.[12]).toBe("100"); // stime
	});

	it("handles command names with spaces", () => {
		const stat =
			"12345 (my process) R 1234 12345 12345 0 -1 4194304 123 0 0 0 50 25 0 0 20 0 1 0 123456 123456789 1234 18446744073709551615";
		const fields = extractProcStatFields(stat);

		expect(fields).not.toBeNull();
		expect(fields?.[0]).toBe("R"); // running state
	});

	it("returns null for invalid format - missing closing paren", () => {
		const stat = "12345 (node S 1234";
		const fields = extractProcStatFields(stat);
		expect(fields).toBeNull();
	});

	it("returns null for empty remainder after paren", () => {
		const stat = "12345 (node) ";
		const fields = extractProcStatFields(stat);
		expect(fields).toBeNull();
	});

	it("returns null for empty string", () => {
		const fields = extractProcStatFields("");
		expect(fields).toBeNull();
	});

	it("handles various process states", () => {
		const states = ["R", "S", "D", "Z", "T", "t", "X"];
		for (const state of states) {
			const stat = `12345 (proc) ${state} 1234 12345 12345 0 -1 4194304 123 0 0 0 100 50 0 0 20 0 1 0 123456 123456789 1234 18446744073709551615`;
			const fields = extractProcStatFields(stat);
			expect(fields).not.toBeNull();
			expect(fields?.[0]).toBe(state);
		}
	});
});

describe("ResourceMonitor", () => {
	it("creates instance without error", () => {
		const monitor = new ResourceMonitor();
		expect(monitor).toBeDefined();
	});

	it("returns correct mode based on platform", () => {
		const monitor = new ResourceMonitor();
		const mode = monitor.getMode();

		if (process.platform === "linux") {
			expect(mode).toBe("proc");
		} else if (process.platform === "darwin") {
			expect(mode).toBe("ps");
		} else {
			expect(mode).toBe("disabled");
		}
	});

	it("isAvailable returns true on supported platforms", () => {
		const monitor = new ResourceMonitor();
		const isAvailable = monitor.isAvailable();

		if (process.platform === "linux" || process.platform === "darwin") {
			expect(isAvailable).toBe(true);
		} else {
			expect(isAvailable).toBe(false);
		}
	});

	it("getUsage returns null for non-existent PID", () => {
		const monitor = new ResourceMonitor();
		// Use a very high PID that's unlikely to exist
		const usage = monitor.getUsage(999999999);
		expect(usage).toBeNull();
	});

	it("getUsage returns data for current process on supported platforms", () => {
		const monitor = new ResourceMonitor();

		if (!monitor.isAvailable()) {
			// Skip on unsupported platforms
			return;
		}

		const usage = monitor.getUsage(process.pid);

		// Should return some data for the current process
		expect(usage).not.toBeNull();

		// At least one metric should be present
		const hasMetric =
			usage?.maxRssKb !== undefined ||
			usage?.userMs !== undefined ||
			usage?.systemMs !== undefined;
		expect(hasMetric).toBe(true);
	});

	it("getUsage returns reasonable memory values", () => {
		const monitor = new ResourceMonitor();

		if (!monitor.isAvailable()) {
			return;
		}

		const usage = monitor.getUsage(process.pid);
		if (usage?.maxRssKb !== undefined) {
			// Memory should be positive and reasonable (< 10GB)
			expect(usage.maxRssKb).toBeGreaterThan(0);
			expect(usage.maxRssKb).toBeLessThan(10 * 1024 * 1024); // 10GB in KB
		}
	});

	it("getUsage returns non-negative CPU times", () => {
		const monitor = new ResourceMonitor();

		if (!monitor.isAvailable()) {
			return;
		}

		const usage = monitor.getUsage(process.pid);
		if (usage?.userMs !== undefined) {
			expect(usage.userMs).toBeGreaterThanOrEqual(0);
		}
		if (usage?.systemMs !== undefined) {
			expect(usage.systemMs).toBeGreaterThanOrEqual(0);
		}
	});
});
