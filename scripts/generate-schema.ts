#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

// Import the schemas from registry (we'll recreate them here to avoid import issues)
const headersSchema = z.record(z.string()).optional();

const baseUrlSchema = z
	.string()
	.url("Base URL must be a valid URL")
	.describe("The base URL for the provider API. Can be auto-normalized for common providers.");

const modelSchema = z.object({
	id: z.string().min(1).describe("Unique identifier for the model"),
	name: z.string().min(1).describe("Display name for the model"),
	api: z
		.enum([
			"openai-completions",
			"openai-responses",
			"anthropic-messages",
			"google-generative-ai",
		])
		.optional()
		.describe("API type for this model"),
	baseUrl: baseUrlSchema.optional(),
	reasoning: z.boolean().optional().describe("Whether this model supports extended thinking/reasoning"),
	input: z.array(z.enum(["text", "image"])).optional().describe("Supported input modalities"),
	cost: z
		.object({
			input: z.number().nonnegative().describe("Cost per input token (in dollars)"),
			output: z.number().nonnegative().describe("Cost per output token (in dollars)"),
			cacheRead: z.number().nonnegative().describe("Cost per cached read token (in dollars)"),
			cacheWrite: z.number().nonnegative().describe("Cost per cached write token (in dollars)"),
		})
		.optional()
		.describe("Token costs for this model"),
	contextWindow: z.number().positive().describe("Maximum context window size in tokens"),
	maxTokens: z.number().positive().describe("Maximum output tokens"),
	headers: headersSchema.describe("Custom HTTP headers to send with requests"),
}).describe("Model configuration");

const providerSchema = z.object({
	id: z.string().min(1).describe("Unique identifier for the provider"),
	name: z.string().min(1).describe("Display name for the provider"),
	api: modelSchema.shape.api.optional().describe("Default API type for all models in this provider"),
	baseUrl: baseUrlSchema.optional().describe("Base URL for the provider. Auto-generated for some providers like AWS Bedrock."),
	apiKeyEnv: z.string().min(1).optional().describe("Environment variable name containing the API key"),
	apiKey: z.string().min(1).optional().describe("API key (not recommended - use apiKeyEnv or {env:VAR} instead)"),
	models: z.array(modelSchema).min(1).describe("List of models provided by this provider"),
}).describe("Provider configuration");

const configSchema = z.object({
	$schema: z.string().optional().describe("JSON Schema reference for IDE support"),
	providers: z.array(providerSchema).default([]).describe("List of model providers"),
}).describe("Composer CLI configuration");

// Generate the JSON Schema
const jsonSchema = zodToJsonSchema(configSchema, {
	name: "ComposerConfig",
	$refStrategy: "none",
});

// Add some metadata
const schema = {
	...jsonSchema,
	$id: "https://composer-cli.dev/config.schema.json",
	title: "Composer CLI Configuration",
	description: "Configuration schema for Composer CLI model providers and models",
};

// Write to dist/config.schema.json
const outputPath = join(process.cwd(), "dist", "config.schema.json");
writeFileSync(outputPath, JSON.stringify(schema, null, 2));

console.log("✓ Generated JSON Schema:", outputPath);
console.log(`\nAdd this to your config file for IDE autocomplete:`);
console.log(`  "$schema": "https://composer-cli.dev/config.schema.json"\n`);
