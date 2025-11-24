import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent/agent.js";
import * as exporter from "../src/export-html.js";
import type { SessionManager } from "../src/session/manager.js";
import { ImportExportView } from "../src/tui/import-view.js";

const buildAgent = (): Agent =>
	({
		state: {
			systemPrompt: "",
			model: {
				id: "test",
				name: "Test",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://example.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 4096,
			},
			thinkingLevel: "off",
			tools: [],
			messages: [],
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Map(),
		},
	}) as unknown as Agent;

const buildView = (overrides: Partial<SessionManager> = {}) => {
	const agent = buildAgent();
	const sessionManager = {
		flush: vi.fn().mockResolvedValue(undefined),
		getSessionFile: vi.fn().mockReturnValue("/tmp/session.jsonl"),
		...overrides,
	} as SessionManager;
	const chatEntries: unknown[] = [];
	const chatContainer = {
		addChild: (child: unknown) => {
			chatEntries.push(child);
		},
		clear: vi.fn(),
	} as any;
	const ui = { requestRender: vi.fn() } as any;
	const view = new ImportExportView({
		agent,
		sessionManager,
		chatContainer,
		ui,
		showInfoMessage: vi.fn(),
		applyLoadedSessionContext: vi.fn(),
		recordShareArtifact: vi.fn(),
	});
	return { view, sessionManager, chatEntries };
};

describe("ImportExportView.handleExportCommand", () => {
	const spies: Array<any> = [];

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		for (const spy of spies) {
			spy.mockRestore();
		}
		spies.length = 0;
	});

	it("passes text mode regardless of argument order", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "export-test-"));
		const targetPath = join(tmp, "nested", "session.txt");
		const textSpy = vi
			.spyOn(exporter, "exportSessionToText")
			.mockResolvedValue(targetPath);
		spies.push(textSpy);
		const { view, sessionManager } = buildView();
		await view.handleExportCommand(`/export ${targetPath} text`);
		expect(textSpy).toHaveBeenCalledTimes(1);
		expect(textSpy.mock.calls[0][0]).toBe(sessionManager);
		expect(textSpy.mock.calls[0][2]).toBe(targetPath);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("creates parent directories before exporting", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "export-test-"));
		const nestedDir = join(tmp, "deep", "path");
		const targetPath = join(nestedDir, "session.html");
		const htmlSpy = vi
			.spyOn(exporter, "exportSessionToHtml")
			.mockResolvedValue(targetPath);
		spies.push(htmlSpy);
		const { view } = buildView();
		await view.handleExportCommand(`/export html ${targetPath}`);
		expect(htmlSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			targetPath,
		);
		expect(existsSync(nestedDir)).toBe(true);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("expands tilde paths and defaults to html", async () => {
		const homeRelative = "~/composer-export/view.html";
		const expanded = join(homedir(), "composer-export", "view.html");
		const htmlSpy = vi
			.spyOn(exporter, "exportSessionToHtml")
			.mockResolvedValue(expanded);
		spies.push(htmlSpy);
		const { view } = buildView();
		await view.handleExportCommand(`/export ${homeRelative}`);
		expect(htmlSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expanded,
		);
	});

	it("expands bare tilde to home directory", () => {
		const { view } = buildView();
		const expanded = (view as any).expandPath("~") as string;
		expect(expanded).toBe(homedir());
	});

	it("rejects export paths outside allowed directories", () => {
		const { view } = buildView();
		expect(() =>
			(view as any).resolveExportPath("/etc/composer-export.html"),
		).toThrow(/Export path must be inside/);
	});
});
