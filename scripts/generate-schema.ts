#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";

const ApiTypeSchema = Type.Optional(
	Type.Union(
		[
			Type.Literal("openai-completions"),
			Type.Literal("openai-responses"),
			Type.Literal("anthropic-messages"),
			Type.Literal("google-generative-ai"),
		],
		{ description: "API type for this model" },
	),
);

const BaseUrlSchema = Type.Optional(
	Type.String({
		description:
			"The base URL for the provider API. Can be auto-normalized for common providers.",
		format: "uri",
	}),
);

const HeadersSchema = Type.Optional(
	Type.Record(Type.String(), Type.String(), {
		description: "Custom HTTP headers to send with requests",
	}),
);

const CostSchema = Type.Optional(
	Type.Object(
		{
			input: Type.Number({
				description: "Cost per input token (in dollars)",
				minimum: 0,
			}),
			output: Type.Number({
				description: "Cost per output token (in dollars)",
				minimum: 0,
			}),
			cacheRead: Type.Number({
				description: "Cost per cached read token (in dollars)",
				minimum: 0,
			}),
			cacheWrite: Type.Number({
				description: "Cost per cached write token (in dollars)",
				minimum: 0,
			}),
		},
		{ description: "Token costs for this model" },
	),
);

const InputSchema = Type.Optional(
	Type.Array(
		Type.Union(
			[
				Type.Literal("text"),
				Type.Literal("image"),
			],
			{ description: "Supported input modalities" },
		),
	),
);

const ModelSchema = Type.Strict(
	Type.Object(
		{
			id: Type.String({
				description: "Unique identifier for the model",
				minLength: 1,
			}),
			name: Type.String({
				description: "Display name for the model",
				minLength: 1,
			}),
			api: ApiTypeSchema,
			baseUrl: BaseUrlSchema,
			reasoning: Type.Optional(
				Type.Boolean({
					description: "Whether this model supports extended thinking/reasoning",
				}),
			),
			input: InputSchema,
			cost: CostSchema,
			contextWindow: Type.Number({
				description: "Maximum context window size in tokens",
				minimum: 1,
			}),
			maxTokens: Type.Number({
				description: "Maximum output tokens",
				minimum: 1,
			}),
			headers: HeadersSchema,
		},
		{ description: "Model configuration" },
	),
);

const ProviderSchema = Type.Strict(
	Type.Object(
		{
			id: Type.String({
				description: "Unique identifier for the provider",
				minLength: 1,
			}),
			name: Type.String({
				description: "Display name for the provider",
				minLength: 1,
			}),
			api: ApiTypeSchema,
			baseUrl: BaseUrlSchema,
			apiKeyEnv: Type.Optional(
				Type.String({
					description: "Environment variable name containing the API key",
					minLength: 1,
				}),
			),
			apiKey: Type.Optional(
				Type.String({
					description:
						"API key (not recommended - use apiKeyEnv or {env:VAR} instead)",
					minLength: 1,
				}),
			),
			models: Type.Array(ModelSchema, {
				description: "List of models provided by this provider",
				minItems: 1,
			}),
		},
		{ description: "Provider configuration" },
	),
);

const ConfigSchema = Type.Strict(
	Type.Object(
		{
			$schema: Type.Optional(
				Type.String({ description: "JSON Schema reference for IDE support" }),
			),
			providers: Type.Array(ProviderSchema, {
				description: "List of model providers",
				default: [],
			}),
		},
		{ description: "Composer CLI configuration" },
	),
);

const schema = {
	...ConfigSchema,
	$id: "https://composer-cli.dev/config.schema.json",
	title: "Composer CLI Configuration",
	description: "Configuration schema for Composer CLI model providers and models",
};

const outputPath = join(process.cwd(), "dist", "config.schema.json");
writeFileSync(outputPath, JSON.stringify(schema, null, 2));

console.log("✓ Generated JSON Schema:", outputPath);
console.log("\nAdd this to your config file for IDE autocomplete:");
console.log('  "$schema": "https://composer-cli.dev/config.schema.json"\n');