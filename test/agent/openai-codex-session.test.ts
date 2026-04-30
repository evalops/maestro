import { describe, expect, it } from "vitest";
import {
	resolveOpenAICodexSession,
	resolveOpenAICodexUrl,
} from "../../src/agent/providers/openai-codex-session.js";

function encodeBase64Url(value: unknown): string {
	return Buffer.from(JSON.stringify(value))
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function fakeCodexToken(accountId = "acct_chatgpt"): string {
	return [
		encodeBase64Url({ alg: "none" }),
		encodeBase64Url({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
		"sig",
	].join(".");
}

describe("OpenAI Codex session helpers", () => {
	it("normalizes ChatGPT Codex URLs without leaking transport details into providers", () => {
		expect(resolveOpenAICodexUrl()).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
		expect(resolveOpenAICodexUrl("https://chatgpt.com/backend-api/")).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
		expect(resolveOpenAICodexUrl("https://example.test/codex")).toBe(
			"https://example.test/codex/responses",
		);
	});

	it("builds the first-party account session headers in one boundary", () => {
		const session = resolveOpenAICodexSession({
			token: fakeCodexToken("acct_from_token"),
			sessionId: "session_123",
			optionHeaders: { "x-extra": "1" },
		});

		expect(session.accountId).toBe("acct_from_token");
		expect(session.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(session.headers.get("authorization")).toMatch(/^Bearer /);
		expect(session.headers.get("chatgpt-account-id")).toBe("acct_from_token");
		expect(session.headers.get("originator")).toBe("codex_cli_rs");
		expect(session.headers.get("openai-beta")).toBe("responses=experimental");
		expect(session.headers.get("session_id")).toBe("session_123");
		expect(session.headers.get("x-client-request-id")).toBe("session_123");
		expect(session.headers.get("x-extra")).toBe("1");
	});

	it("lets explicit account headers override token-derived account ids", () => {
		const session = resolveOpenAICodexSession({
			token: fakeCodexToken("acct_from_token"),
			optionHeaders: { "chatgpt-account-id": "acct_from_header" },
		});

		expect(session.accountId).toBe("acct_from_header");
		expect(session.headers.get("chatgpt-account-id")).toBe("acct_from_header");
	});
});
