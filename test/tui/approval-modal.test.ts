import { Text, visibleWidth } from "@evalops/tui";
import { describe, expect, it } from "vitest";

import { ApprovalModal } from "../../src/cli-tui/approval/approval-modal.js";
import { sanitizeAnsi } from "../../src/cli-tui/utils/text-formatting.js";

const noop = () => {};

describe("ApprovalModal", () => {
	it("wraps long reason text within the viewport width", () => {
		const modal = new ApprovalModal({
			request: {
				id: "req-1",
				toolName: "background_tasks",
				reason:
					"Background task shell mode requires manual approval because it enables pipes, redirects, and globbing across arbitrary commands.",
				args: {
					action: "start",
					command: "echo 'wrapped'",
				},
			},
			queueSize: 0,
			onApprove: noop,
			onDeny: noop,
			onCancel: noop,
		});
		const width = 40;
		const lines = modal.render(width);
		for (const line of lines) {
			const plain = sanitizeAnsi(line);
			expect(visibleWidth(plain)).toBeLessThanOrEqual(width);
		}
	});

	it("wraps long command lines with indentation", () => {
		const longCommand = [
			"echo 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'",
			"printf '\nINDENT_TEST:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
		].join(" && ");
		const modal = new ApprovalModal({
			request: {
				id: "req-2",
				toolName: "background_tasks",
				reason: "Testing",
				args: {
					action: "start",
					command: longCommand,
				},
			},
			queueSize: 1,
			onApprove: noop,
			onDeny: noop,
			onCancel: noop,
		});
		const width = 30;
		const lines = modal.render(width).map((line) => sanitizeAnsi(line));
		const commandIndex = lines.findIndex((line) =>
			line.toUpperCase().includes("COMMAND"),
		);
		expect(commandIndex).toBeGreaterThanOrEqual(0);
		const commandLines: string[] = [];
		const innerWidth = width - 4;
		for (let i = commandIndex + 1; i < lines.length; i++) {
			const line = lines[i];
			if (
				line.startsWith("╠") ||
				line.startsWith("╚") ||
				line.toUpperCase().includes("QUEUE STATUS")
			) {
				break;
			}
			// Double border uses ║ for vertical
			if (!line.includes("║")) {
				continue;
			}
			const inner = line.slice(2, Math.max(2, line.length - 2));
			if (inner.trim().length === 0) {
				continue;
			}
			commandLines.push(inner);
		}
		expect(commandLines.length).toBeGreaterThan(1);
		for (const line of commandLines) {
			expect(line.startsWith("  ")).toBe(true);
			expect(visibleWidth(line.trimEnd())).toBeLessThanOrEqual(innerWidth);
		}
	});

	it("renders fallback copy when reason or command are missing", () => {
		const modal = new ApprovalModal({
			request: {
				id: "req-3",
				toolName: "background_tasks",
				reason: " ",
				args: {},
			},
			queueSize: 0,
			onApprove: noop,
			onDeny: noop,
			onCancel: noop,
		});
		const width = 50;
		const lines = modal.render(width).map((line) => sanitizeAnsi(line));
		expect(lines.some((line) => line.includes("(no reason provided)"))).toBe(
			true,
		);
		expect(
			lines.some((line) => line.includes("(no literal command provided)")),
		).toBe(true);
	});

	it("handles very narrow widths without overflowing", () => {
		const modal = new ApprovalModal({
			request: {
				id: "req-4",
				toolName: "background_tasks",
				reason: "Narrow width stress test",
				args: {
					command: "printf 'abc'",
				},
			},
			queueSize: 2,
			onApprove: noop,
			onDeny: noop,
			onCancel: noop,
		});
		const width = 12;
		const lines = modal.render(width).map((line) => sanitizeAnsi(line));
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("handles tiny viewports even when indent equals the width", () => {
		const modal = new ApprovalModal({
			request: {
				id: "req-4b",
				toolName: "background_tasks",
				reason: "Tiny width stress test",
				args: {
					command: "echo longwordthatwillwrap",
				},
			},
			queueSize: 0,
			onApprove: noop,
			onDeny: noop,
			onCancel: noop,
		});
		const width = 6; // innerWidth becomes 2 and matches command indent width
		const lines = modal.render(width).map((line) => sanitizeAnsi(line));
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("respects exact inner-width boundaries for reason text", () => {
		const width = 34;
		const innerWidth = width - 4;
		const exactReason = "R".repeat(innerWidth);
		const modal = new ApprovalModal({
			request: {
				id: "req-5",
				toolName: "background_tasks",
				reason: exactReason,
				args: {
					command: "echo short",
				},
			},
			queueSize: 0,
			onApprove: noop,
			onDeny: noop,
			onCancel: noop,
		});
		const lines = modal.render(width).map((line) => sanitizeAnsi(line));
		const reasonHeaderIndex = lines.findIndex((line) =>
			line.toUpperCase().includes("REASON"),
		);
		expect(reasonHeaderIndex).toBeGreaterThanOrEqual(0);
		let captured = "";
		for (let i = reasonHeaderIndex + 1; i < lines.length; i++) {
			const line = lines[i];
			// Double border uses ║ for vertical
			if (!line.includes("║")) {
				continue;
			}
			const inner = line.slice(2, Math.max(2, line.length - 2));
			if (inner.trim().length === 0) {
				continue;
			}
			captured = inner.trimEnd();
			break;
		}
		expect(captured).toBe(exactReason);
		if (captured.length > 0) {
			expect(visibleWidth(captured)).toBe(innerWidth);
		}
	});
});

describe("Text component", () => {
	it("preserves multi-byte characters when slicing tokens", () => {
		const text = new Text("  😊", 0, 0);
		const lines = text.render(2);
		expect(lines.join(" ")).toContain("😊");
	});

	it("removes the full original indent even when truncating display indent", () => {
		const text = new Text("   abc", 0, 0);
		const lines = text.render(3);
		expect(lines[0]?.startsWith("  a")).toBe(true);
	});
});
