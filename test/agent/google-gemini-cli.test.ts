import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamGoogleGeminiCli } from "../../src/agent/providers/google-gemini-cli.js";
import type { Context, Model } from "../../src/agent/types.js";

const configLoaderMock = vi.hoisted(() => ({
	getMergedCustomModelUrlPolicyConfig: vi.fn(() => ({})),
}));

const urlPolicyMock = vi.hoisted(() => ({
	checkModelRequestUrlPolicy: vi.fn(),
	isInternalModelBaseUrl: vi.fn(() => false),
	recordCustomModelUrlPolicyBlock: vi.fn(),
}));

const networkConfigMock = vi.hoisted(() => ({
	fetchWithModelRequestPolicyRedirects: vi.fn(),
}));

vi.mock("../../src/models/config-loader.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/models/config-loader.js")
	>("../../src/models/config-loader.js");
	return {
		...actual,
		getMergedCustomModelUrlPolicyConfig:
			configLoaderMock.getMergedCustomModelUrlPolicyConfig,
	};
});

vi.mock("../../src/models/url-policy.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/models/url-policy.js")
	>("../../src/models/url-policy.js");
	return {
		...actual,
		checkModelRequestUrlPolicy: urlPolicyMock.checkModelRequestUrlPolicy,
		isInternalModelBaseUrl: urlPolicyMock.isInternalModelBaseUrl,
		recordCustomModelUrlPolicyBlock:
			urlPolicyMock.recordCustomModelUrlPolicyBlock,
	};
});

vi.mock("../../src/providers/network-config.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/providers/network-config.js")
	>("../../src/providers/network-config.js");
	return {
		...actual,
		fetchWithModelRequestPolicyRedirects:
			networkConfigMock.fetchWithModelRequestPolicyRedirects,
	};
});

const baseContext: Context = {
	systemPrompt: "",
	messages: [
		{
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		},
	],
	tools: [],
};

const geminiCliModel: Model<"google-gemini-cli"> = {
	id: "gemini-2.0-flash",
	name: "Gemini 2.0 Flash (Cloud Code Assist)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://cloudcode-pa.googleapis.com",
	reasoning: false,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 8192,
};

describe("Google Gemini CLI streaming", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		configLoaderMock.getMergedCustomModelUrlPolicyConfig.mockReset();
		configLoaderMock.getMergedCustomModelUrlPolicyConfig.mockReturnValue({});
		urlPolicyMock.checkModelRequestUrlPolicy.mockReset();
		urlPolicyMock.isInternalModelBaseUrl.mockReset();
		urlPolicyMock.isInternalModelBaseUrl.mockReturnValue(false);
		urlPolicyMock.recordCustomModelUrlPolicyBlock.mockReset();
		networkConfigMock.fetchWithModelRequestPolicyRedirects.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fails immediately when the request URL is blocked by policy", async () => {
		urlPolicyMock.checkModelRequestUrlPolicy.mockResolvedValue({
			allowed: false,
			reason: "not_in_allowed_base_urls",
			hostname: "blocked.example",
			resolvedAddresses: [],
		});

		const stream = streamGoogleGeminiCli(geminiCliModel, baseContext, {
			apiKey: JSON.stringify({ token: "token", projectId: "project" }),
		});

		await expect(stream.next()).resolves.toMatchObject({
			value: expect.objectContaining({ type: "start" }),
		});

		const nextResult = stream.next();
		await vi.runAllTimersAsync();
		await expect(nextResult).resolves.toMatchObject({
			done: false,
			value: {
				type: "error",
				reason: "error",
				error: expect.objectContaining({
					errorMessage:
						"Model request blocked by URL policy: not_in_allowed_base_urls",
				}),
			},
		});
		expect(urlPolicyMock.checkModelRequestUrlPolicy).toHaveBeenCalledTimes(1);
		expect(urlPolicyMock.recordCustomModelUrlPolicyBlock).toHaveBeenCalledTimes(
			1,
		);
		expect(
			networkConfigMock.fetchWithModelRequestPolicyRedirects,
		).not.toHaveBeenCalled();
	});
});
