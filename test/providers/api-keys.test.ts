import { afterEach, describe, expect, it } from "vitest";
import {
	getEnvVarsForProvider,
	lookupApiKey,
} from "../../src/providers/api-keys.js";

describe("api key provider families", () => {
	const originalEvalOpsAccessToken = process.env.MAESTRO_EVALOPS_ACCESS_TOKEN;

	afterEach(() => {
		if (originalEvalOpsAccessToken === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_ACCESS_TOKEN");
		} else {
			process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = originalEvalOpsAccessToken;
		}
	});

	it("maps managed evalops provider aliases to evalops env vars", () => {
		expect(getEnvVarsForProvider("evalops-openrouter")).toEqual([
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]);
		expect(getEnvVarsForProvider("evalops-azure-openai")).toEqual([
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]);
		expect(getEnvVarsForProvider("evalops-cohere")).toEqual([
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]);
		expect(getEnvVarsForProvider("evalops-google")).toEqual([
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]);
		expect(getEnvVarsForProvider("evalops-groq")).toEqual([
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]);
		expect(getEnvVarsForProvider("evalops-databricks")).toEqual([
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]);
		expect(getEnvVarsForProvider("evalops-mistral")).toEqual([
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]);
		expect(getEnvVarsForProvider("evalops-xai")).toEqual([
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]);
	});

	it("resolves evalops alias credentials from MAESTRO_EVALOPS_ACCESS_TOKEN", () => {
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
		const credential = lookupApiKey("evalops-openrouter");
		expect(credential.key).toBe("managed-token");
		expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
		expect(credential.source).toBe("env");
	});

	it("resolves Azure managed alias credentials from MAESTRO_EVALOPS_ACCESS_TOKEN", () => {
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
		const credential = lookupApiKey("evalops-azure-openai");
		expect(credential.key).toBe("managed-token");
		expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
		expect(credential.source).toBe("env");
	});

	it("resolves Cohere managed alias credentials from MAESTRO_EVALOPS_ACCESS_TOKEN", () => {
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
		const credential = lookupApiKey("evalops-cohere");
		expect(credential.key).toBe("managed-token");
		expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
		expect(credential.source).toBe("env");
	});

	it("resolves Google managed alias credentials from MAESTRO_EVALOPS_ACCESS_TOKEN", () => {
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
		const credential = lookupApiKey("evalops-google");
		expect(credential.key).toBe("managed-token");
		expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
		expect(credential.source).toBe("env");
	});

	it("resolves Groq managed alias credentials from MAESTRO_EVALOPS_ACCESS_TOKEN", () => {
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
		const credential = lookupApiKey("evalops-groq");
		expect(credential.key).toBe("managed-token");
		expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
		expect(credential.source).toBe("env");
	});

	it("resolves Databricks managed alias credentials from MAESTRO_EVALOPS_ACCESS_TOKEN", () => {
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
		const credential = lookupApiKey("evalops-databricks");
		expect(credential.key).toBe("managed-token");
		expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
		expect(credential.source).toBe("env");
	});

	it("resolves Mistral managed alias credentials from MAESTRO_EVALOPS_ACCESS_TOKEN", () => {
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
		const credential = lookupApiKey("evalops-mistral");
		expect(credential.key).toBe("managed-token");
		expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
		expect(credential.source).toBe("env");
	});

	it("resolves xAI managed alias credentials from MAESTRO_EVALOPS_ACCESS_TOKEN", () => {
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
		const credential = lookupApiKey("evalops-xai");
		expect(credential.key).toBe("managed-token");
		expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
		expect(credential.source).toBe("env");
	});
});
