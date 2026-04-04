import { afterEach, describe, expect, it, vi } from "vitest";
import {
	exchangeOpenAIAuthorizationCode,
	generateOpenAILoginUrl,
} from "../../src/providers/openai-auth.js";

const CALLBACK_URL = "http://127.0.0.1:1455/auth/callback";

describe("OpenAI OAuth callback origin", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("generates a login URL with the explicit loopback callback host", async () => {
		const { url } = await generateOpenAILoginUrl();
		const parsed = new URL(url);

		expect(parsed.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
	});

	it("uses the explicit loopback callback host for token exchange", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				access_token: "access-token",
				refresh_token: "refresh-token",
				id_token: "id-token",
				expires_in: 3600,
			}),
		} as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			exchangeOpenAIAuthorizationCode("auth-code", "verifier"),
		).resolves.toMatchObject({
			accessToken: "access-token",
			refreshToken: "refresh-token",
			idToken: "id-token",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://auth.openai.com/oauth/token",
			expect.objectContaining({
				method: "POST",
				body: expect.any(String),
			}),
		);

		const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		const body = new URLSearchParams(String(requestInit?.body));
		expect(body.get("redirect_uri")).toBe(CALLBACK_URL);
	});
});
