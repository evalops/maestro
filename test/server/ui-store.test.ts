import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalWebUiState = process.env.MAESTRO_WEB_UI_STATE;

afterEach(() => {
	if (originalWebUiState === undefined) {
		delete process.env.MAESTRO_WEB_UI_STATE;
	} else {
		process.env.MAESTRO_WEB_UI_STATE = originalWebUiState;
	}
	vi.resetModules();
});

describe("web UI state store", () => {
	it("normalizes retired ensemble footer state to rich", async () => {
		const path = join(
			mkdtempSync(join(tmpdir(), "maestro-web-ui-")),
			"state.json",
		);
		process.env.MAESTRO_WEB_UI_STATE = path;
		writeFileSync(
			path,
			JSON.stringify({
				sessions: {
					"session-1": {
						footerMode: "ensemble",
						cleanMode: "soft",
					},
				},
			}),
			"utf-8",
		);
		vi.resetModules();

		const { loadWebUiState, getSessionUiState } = await import(
			"../../src/server/stores/ui-store.js"
		);
		const state = loadWebUiState();

		expect(getSessionUiState(state, "session-1").footerMode).toBe("rich");
	});
});
