import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { convertMessagesForGoogle } from "../../src/agent/providers/google.js";
import type { Context, Model } from "../../src/agent/types.js";

describe("google provider: thought signature preservation", () => {
	it("preserves thinkingSignature on thinking blocks", () => {
		const model: Model<"google-generative-ai"> = {
			id: "gemini-test",
			name: "Gemini Test",
			api: "google-generative-ai",
			provider: "google",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 1000,
		};

		const context: Context = {
			systemPrompt: "test",
			tools: [],
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "reasoning",
							thinkingSignature: "sig-123",
						},
						{ type: "text", text: "ok" },
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			],
		};

		const contents = convertMessagesForGoogle(model, context);
		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn).toBeTruthy();
		const partsUnknown = (modelTurn as { parts?: unknown }).parts;
		expect(Array.isArray(partsUnknown)).toBe(true);
		const parts = (partsUnknown as unknown[]).filter(
			(p): p is Record<string, unknown> => Boolean(p) && typeof p === "object",
		);
		const thoughtPart = parts.find((p) => p.thought === true);
		expect(thoughtPart).toBeTruthy();
		expect(thoughtPart?.thoughtSignature).toBe("sig-123");
	});

	it("preserves thoughtSignature on tool calls", () => {
		const model: Model<"google-generative-ai"> = {
			id: "gemini-test",
			name: "Gemini Test",
			api: "google-generative-ai",
			provider: "google",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 1000,
		};

		const context: Context = {
			systemPrompt: "test",
			tools: [
				{ name: "noop", description: "noop", parameters: Type.Object({}) },
			],
			messages: [
				{ role: "user", content: "run tool", timestamp: Date.now() },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "noop",
							arguments: {},
							thoughtSignature: "tsig-999",
						},
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
			],
		};

		const contents = convertMessagesForGoogle(model, context);
		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn).toBeTruthy();
		const partsUnknown = (modelTurn as { parts?: unknown }).parts;
		expect(Array.isArray(partsUnknown)).toBe(true);
		const parts = (partsUnknown as unknown[]).filter(
			(p): p is Record<string, unknown> => Boolean(p) && typeof p === "object",
		);
		const functionCallPart = parts.find((p) => {
			const functionCall = p.functionCall;
			return (
				Boolean(functionCall) &&
				typeof functionCall === "object" &&
				(functionCall as { name?: unknown }).name === "noop"
			);
		});
		expect(functionCallPart).toBeTruthy();
		expect(functionCallPart?.thoughtSignature).toBe("tsig-999");
	});
});
