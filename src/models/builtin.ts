import type { Api, Model } from "../agent/types.js";
import { MODELS as GENERATED_MODELS } from "./models.generated.js";
import { normalizeModelBaseUrl } from "./url-normalize.js";

// Manual overlay for Claude Opus 4.5 (not yet in models.dev registry)
const ANTHROPIC_OPUS_45_OVERLAY = {
	anthropic: {
		"claude-opus-4-5-20251101": {
			id: "claude-opus-4-5-20251101",
			name: "Claude Opus 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"anthropic-messages">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for OpenRouter Responses models (currently not emitted by generator)
const OPENROUTER_RESPONSES_OVERLAY = {
	openrouter: {
		"openai/o4-mini": {
			id: "openai/o4-mini",
			name: "OpenAI O4 Mini (Responses)",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
		"openai/o4": {
			id: "openai/o4",
			name: "OpenAI O4 (Responses)",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
		"openai/o4-mini:online": {
			id: "openai/o4-mini:online",
			name: "OpenAI O4 Mini Online (Responses)",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
		"openai/o4:online": {
			id: "openai/o4:online",
			name: "OpenAI O4 Online (Responses)",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for Groq Responses models
const GROQ_RESPONSES_OVERLAY = {
	groq: {
		"openai/gpt-oss-20b": {
			id: "openai/gpt-oss-20b",
			name: "GPT-OSS 20B (Groq Responses)",
			api: "openai-responses",
			provider: "groq",
			baseUrl: "https://api.groq.com/openai/v1",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
		"openai/gpt-oss-120b": {
			id: "openai/gpt-oss-120b",
			name: "GPT-OSS 120B (Groq Responses)",
			api: "openai-responses",
			provider: "groq",
			baseUrl: "https://api.groq.com/openai/v1",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for OpenAI GPT-5.1 Codex Max (frontier agentic coding model)
// Only available via Responses API - optimized for long-horizon agentic coding
const OPENAI_CODEX_OVERLAY = {
	openai: {
		"gpt-5.1-codex-max": {
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		} as Model<"openai-responses">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for OpenAI GPT-5.2 (flagship coding/agentic model, Dec 11 2025)
const OPENAI_GPT52_OVERLAY = {
	openai: {
		"gpt-5.2": {
			id: "gpt-5.2",
			name: "GPT-5.2",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 1.75,
				output: 14,
				cacheRead: 0.175,
				cacheWrite: 0,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		} as Model<"openai-completions">,
		"gpt-5.2-2025-12-11": {
			id: "gpt-5.2-2025-12-11",
			name: "GPT-5.2 (Dec 11 2025 Snapshot)",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 1.75,
				output: 14,
				cacheRead: 0.175,
				cacheWrite: 0,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		} as Model<"openai-completions">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for direct xAI (Grok) models (OpenAI-compatible API).
const XAI_OVERLAY = {
	xai: {
		"grok-4": {
			id: "grok-4",
			name: "Grok 4",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.75,
				cacheWrite: 0,
			},
			contextWindow: 256000,
			maxTokens: 64000,
		} as Model<"openai-completions">,
		"grok-4-fast": {
			id: "grok-4-fast",
			name: "Grok 4 Fast",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0.2,
				output: 0.5,
				cacheRead: 0.05,
				cacheWrite: 0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		} as Model<"openai-completions">,
		"grok-4-fast-non-reasoning": {
			id: "grok-4-fast-non-reasoning",
			name: "Grok 4 Fast (Non-Reasoning)",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0.2,
				output: 0.5,
				cacheRead: 0.05,
				cacheWrite: 0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		} as Model<"openai-completions">,
		"grok-code-fast-1": {
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 0.2,
				output: 1.5,
				cacheRead: 0.02,
				cacheWrite: 0,
			},
			contextWindow: 256000,
			maxTokens: 10000,
		} as Model<"openai-completions">,
		"grok-3": {
			id: "grok-3",
			name: "Grok 3",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.75,
				cacheWrite: 0,
			},
			contextWindow: 131072,
			maxTokens: 8192,
		} as Model<"openai-completions">,
		"grok-3-fast": {
			id: "grok-3-fast",
			name: "Grok 3 Fast",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 1.25,
				cacheWrite: 0,
			},
			contextWindow: 131072,
			maxTokens: 8192,
		} as Model<"openai-completions">,
		"grok-3-mini": {
			id: "grok-3-mini",
			name: "Grok 3 Mini",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 0.3,
				output: 0.5,
				cacheRead: 0.075,
				cacheWrite: 0,
			},
			contextWindow: 131072,
			maxTokens: 8192,
		} as Model<"openai-completions">,
		"grok-2-vision": {
			id: "grok-2-vision",
			name: "Grok 2 Vision",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 2,
				output: 10,
				cacheRead: 2,
				cacheWrite: 0,
			},
			contextWindow: 8192,
			maxTokens: 4096,
		} as Model<"openai-completions">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

const GITHUB_COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

const GITHUB_COPILOT_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
} as const;

// Manual overlay for GitHub Copilot (OpenAI-compatible API).
const GITHUB_COPILOT_OVERLAY = {
	"github-copilot": {
		"claude-haiku-4.5": {
			id: "claude-haiku-4.5",
			name: "Claude Haiku 4.5",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16000,
		} as Model<"openai-completions">,
		"claude-opus-4.5": {
			id: "claude-opus-4.5",
			name: "Claude Opus 4.5",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16000,
		} as Model<"openai-completions">,
		"claude-sonnet-4": {
			id: "claude-sonnet-4",
			name: "Claude Sonnet 4",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16000,
		} as Model<"openai-completions">,
		"claude-sonnet-4.5": {
			id: "claude-sonnet-4.5",
			name: "Claude Sonnet 4.5",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16000,
		} as Model<"openai-completions">,
		"gemini-2.5-pro": {
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		} as Model<"openai-completions">,
		"gemini-3-flash-preview": {
			id: "gemini-3-flash-preview",
			name: "Gemini 3 Flash",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		} as Model<"openai-completions">,
		"gemini-3-pro-preview": {
			id: "gemini-3-pro-preview",
			name: "Gemini 3 Pro Preview",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		} as Model<"openai-completions">,
		"gpt-4.1": {
			id: "gpt-4.1",
			name: "GPT-4.1",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		} as Model<"openai-completions">,
		"gpt-4o": {
			id: "gpt-4o",
			name: "GPT-4o",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64000,
			maxTokens: 16384,
		} as Model<"openai-completions">,
		"gpt-5": {
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		} as Model<"openai-responses">,
		"gpt-5-codex": {
			id: "gpt-5-codex",
			name: "GPT-5-Codex",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		} as Model<"openai-responses">,
		"gpt-5-mini": {
			id: "gpt-5-mini",
			name: "GPT-5-mini",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
		"gpt-5.1": {
			id: "gpt-5.1",
			name: "GPT-5.1",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		} as Model<"openai-responses">,
		"gpt-5.1-codex": {
			id: "gpt-5.1-codex",
			name: "GPT-5.1-Codex",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		} as Model<"openai-responses">,
		"gpt-5.1-codex-max": {
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1-Codex-max",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		} as Model<"openai-responses">,
		"gpt-5.1-codex-mini": {
			id: "gpt-5.1-codex-mini",
			name: "GPT-5.1-Codex-mini",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 100000,
		} as Model<"openai-responses">,
		"gpt-5.2": {
			id: "gpt-5.2",
			name: "GPT-5.2",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
		"grok-code-fast-1": {
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			compat: GITHUB_COPILOT_COMPAT,
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		} as Model<"openai-completions">,
		"oswe-vscode-prime": {
			id: "oswe-vscode-prime",
			name: "Raptor Mini (Preview)",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			headers: GITHUB_COPILOT_HEADERS,
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for Google Gemini CLI (Cloud Code Assist) models
const GOOGLE_GEMINI_CLI_OVERLAY = {
	"google-gemini-cli": {
		"gemini-2.0-flash": {
			id: "gemini-2.0-flash",
			name: "Gemini 2.0 Flash (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 8192,
		} as Model<"google-gemini-cli">,
		"gemini-2.5-flash": {
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		} as Model<"google-gemini-cli">,
		"gemini-2.5-pro": {
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		} as Model<"google-gemini-cli">,
		"gemini-3-flash-preview": {
			id: "gemini-3-flash-preview",
			name: "Gemini 3 Flash Preview (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		} as Model<"google-gemini-cli">,
		"gemini-3-pro-preview": {
			id: "gemini-3-pro-preview",
			name: "Gemini 3 Pro Preview (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		} as Model<"google-gemini-cli">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for Google Antigravity (Cloud Code Assist sandbox) models
const GOOGLE_ANTIGRAVITY_OVERLAY = {
	"google-antigravity": {
		"gemini-3-pro-high": {
			id: "gemini-3-pro-high",
			name: "Gemini 3 Pro High (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		} as Model<"google-gemini-cli">,
		"gemini-3-pro-low": {
			id: "gemini-3-pro-low",
			name: "Gemini 3 Pro Low (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		} as Model<"google-gemini-cli">,
		"gemini-3-flash": {
			id: "gemini-3-flash",
			name: "Gemini 3 Flash (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		} as Model<"google-gemini-cli">,
		"claude-sonnet-4-5": {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5 (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"google-gemini-cli">,
		"claude-sonnet-4-5-thinking": {
			id: "claude-sonnet-4-5-thinking",
			name: "Claude Sonnet 4.5 Thinking (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"google-gemini-cli">,
		"claude-opus-4-5-thinking": {
			id: "claude-opus-4-5-thinking",
			name: "Claude Opus 4.5 Thinking (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"google-gemini-cli">,
		"gpt-oss-120b-medium": {
			id: "gpt-oss-120b-medium",
			name: "GPT-OSS 120B Medium (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 32768,
		} as Model<"google-gemini-cli">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Writer AI Palmyra models - OpenAI-compatible API with 1M context window
// https://dev.writer.com/home/models
const WRITER_OVERLAY = {
	writer: {
		"palmyra-x5": {
			id: "palmyra-x5",
			name: "Palmyra X5",
			api: "openai-completions",
			provider: "writer",
			baseUrl: "https://api.writer.com/v1",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 0.6,
				output: 6.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1040000,
			maxTokens: 8192,
		} as Model<"openai-completions">,
		"palmyra-x4": {
			id: "palmyra-x4",
			name: "Palmyra X4",
			api: "openai-completions",
			provider: "writer",
			baseUrl: "https://api.writer.com/v1",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 0.5,
				output: 5.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 8192,
		} as Model<"openai-completions">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// AWS Bedrock models - uses SigV4 authentication
// https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html
const BEDROCK_OVERLAY = {
	bedrock: {
		// Writer Palmyra X5 on Bedrock
		"writer.palmyra-x5-v1:0": {
			id: "writer.palmyra-x5-v1:0",
			name: "Palmyra X5 (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 0.6,
				output: 6.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1040000,
			maxTokens: 8192,
		} as Model<"bedrock-converse">,
		// Claude models on Bedrock
		"anthropic.claude-3-5-sonnet-20241022-v2:0": {
			id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			name: "Claude 3.5 Sonnet v2 (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 3.0,
				output: 15.0,
				cacheRead: 0.3,
				cacheWrite: 3.75,
			},
			contextWindow: 200000,
			maxTokens: 8192,
		} as Model<"bedrock-converse">,
		"anthropic.claude-3-5-haiku-20241022-v1:0": {
			id: "anthropic.claude-3-5-haiku-20241022-v1:0",
			name: "Claude 3.5 Haiku (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 1.0,
				output: 5.0,
				cacheRead: 0.1,
				cacheWrite: 1.25,
			},
			contextWindow: 200000,
			maxTokens: 8192,
		} as Model<"bedrock-converse">,
		"anthropic.claude-3-opus-20240229-v1:0": {
			id: "anthropic.claude-3-opus-20240229-v1:0",
			name: "Claude 3 Opus (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 15.0,
				output: 75.0,
				cacheRead: 1.5,
				cacheWrite: 18.75,
			},
			contextWindow: 200000,
			maxTokens: 4096,
		} as Model<"bedrock-converse">,
		// Meta Llama models on Bedrock
		"meta.llama3-1-405b-instruct-v1:0": {
			id: "meta.llama3-1-405b-instruct-v1:0",
			name: "Llama 3.1 405B Instruct (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 5.32,
				output: 16.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 4096,
		} as Model<"bedrock-converse">,
		"meta.llama3-1-70b-instruct-v1:0": {
			id: "meta.llama3-1-70b-instruct-v1:0",
			name: "Llama 3.1 70B Instruct (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 0.99,
				output: 2.99,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 4096,
		} as Model<"bedrock-converse">,
		// Amazon Nova models
		"amazon.nova-premier-v1:0": {
			id: "amazon.nova-premier-v1:0",
			name: "Nova Premier (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 2.5,
				output: 12.5,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 40000,
		} as Model<"bedrock-converse">,
		"amazon.nova-pro-v1:0": {
			id: "amazon.nova-pro-v1:0",
			name: "Nova Pro (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0.8,
				output: 3.2,
				cacheRead: 0.2,
				cacheWrite: 0,
			},
			contextWindow: 300000,
			maxTokens: 5000,
		} as Model<"bedrock-converse">,
		"amazon.nova-lite-v1:0": {
			id: "amazon.nova-lite-v1:0",
			name: "Nova Lite (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0.06,
				output: 0.24,
				cacheRead: 0.02,
				cacheWrite: 0,
			},
			contextWindow: 300000,
			maxTokens: 5000,
		} as Model<"bedrock-converse">,
		"amazon.nova-micro-v1:0": {
			id: "amazon.nova-micro-v1:0",
			name: "Nova Micro (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 0.035,
				output: 0.14,
				cacheRead: 0.009,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 5000,
		} as Model<"bedrock-converse">,
		// Mistral models on Bedrock
		"mistral.mistral-large-2407-v1:0": {
			id: "mistral.mistral-large-2407-v1:0",
			name: "Mistral Large 2407 (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 2.0,
				output: 6.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 8192,
		} as Model<"bedrock-converse">,
		"mistral.mistral-large-2402-v1:0": {
			id: "mistral.mistral-large-2402-v1:0",
			name: "Mistral Large 2402 (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 4.0,
				output: 12.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 32000,
			maxTokens: 8192,
		} as Model<"bedrock-converse">,
		"mistral.mixtral-8x7b-instruct-v0:1": {
			id: "mistral.mixtral-8x7b-instruct-v0:1",
			name: "Mixtral 8x7B Instruct (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: false,
			input: ["text"],
			cost: {
				input: 0.45,
				output: 0.7,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 32000,
			maxTokens: 4096,
		} as Model<"bedrock-converse">,
		// Cohere models on Bedrock
		"cohere.command-r-plus-v1:0": {
			id: "cohere.command-r-plus-v1:0",
			name: "Command R+ (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 2.5,
				output: 10.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 4096,
		} as Model<"bedrock-converse">,
		"cohere.command-r-v1:0": {
			id: "cohere.command-r-v1:0",
			name: "Command R (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: false,
			input: ["text"],
			cost: {
				input: 0.15,
				output: 0.6,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 4096,
		} as Model<"bedrock-converse">,
		// AI21 models on Bedrock
		"ai21.jamba-1-5-large-v1:0": {
			id: "ai21.jamba-1-5-large-v1:0",
			name: "Jamba 1.5 Large (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 2.0,
				output: 8.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 256000,
			maxTokens: 4096,
		} as Model<"bedrock-converse">,
		"ai21.jamba-instruct-v1:0": {
			id: "ai21.jamba-instruct-v1:0",
			name: "Jamba Instruct (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: false,
			input: ["text"],
			cost: {
				input: 0.5,
				output: 0.7,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 256000,
			maxTokens: 4096,
		} as Model<"bedrock-converse">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Cached converted models (built lazily on first access)
let BUILTIN_MODELS: Record<string, Model<Api>[]> | null = null;
const CODEX_MODEL_PATTERN = /codex/i;

// Map provider names from models.dev to our internal names
const PROVIDER_ALIASES: Record<string, string> = {
	"amazon-bedrock": "bedrock",
};

// Provider-specific overrides for models imported from models.dev
// These fix incorrect api/baseUrl values in the generated data
interface ProviderOverride {
	api: Api;
	baseUrl: string;
}
const PROVIDER_OVERRIDES: Record<string, ProviderOverride> = {
	"amazon-bedrock": {
		api: "bedrock-converse",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	},
};

/**
 * Convert generated models to our format (called lazily on first access)
 */
function convertGeneratedModels(): Record<string, Model<Api>[]> {
	const converted: Record<string, Model<Api>[]> = {};

	// Start with generated models
	for (const [rawProvider, models] of Object.entries(GENERATED_MODELS)) {
		// Map provider name (e.g., "amazon-bedrock" -> "bedrock")
		const provider = PROVIDER_ALIASES[rawProvider] ?? rawProvider;
		const override = PROVIDER_OVERRIDES[rawProvider];
		if (!converted[provider]) {
			converted[provider] = [];
		}
		converted[provider].push(
			...Object.values(models)
				.filter((model) => !CODEX_MODEL_PATTERN.test(model.id))
				.map((model) => {
					const base = {
						...model,
						// Remap provider name to match our internal naming
						provider,
					};
					// Apply provider-specific overrides (e.g., Bedrock needs different api/baseUrl)
					if (override) {
						return {
							...base,
							api: override.api,
							baseUrl: override.baseUrl,
						} as Model<Api>;
					}
					return {
						...base,
						// Ensure baseUrl format consistency across providers
						baseUrl: normalizeModelBaseUrl(model),
					};
				}),
		);
	}

	// Apply overlay additions
	const overlays: Record<string, Record<string, Model<Api>>>[] = [
		ANTHROPIC_OPUS_45_OVERLAY,
		OPENROUTER_RESPONSES_OVERLAY,
		GROQ_RESPONSES_OVERLAY,
		OPENAI_CODEX_OVERLAY,
		OPENAI_GPT52_OVERLAY,
		XAI_OVERLAY,
		GITHUB_COPILOT_OVERLAY,
		GOOGLE_GEMINI_CLI_OVERLAY,
		GOOGLE_ANTIGRAVITY_OVERLAY,
		WRITER_OVERLAY,
		BEDROCK_OVERLAY,
	];

	for (const overlay of overlays) {
		for (const [provider, models] of Object.entries(overlay)) {
			if (!converted[provider]) {
				converted[provider] = [];
			}
			for (const model of Object.values(models)) {
				converted[provider] = converted[provider].filter(
					(m) => m.id !== model.id,
				);
				converted[provider].push({
					...model,
					baseUrl: normalizeModelBaseUrl(model),
				});
			}
		}
	}

	return converted;
}

/**
 * Ensure models are converted (call this early in app startup for predictable timing)
 * The import is static, but conversion is deferred until first access.
 */
export async function ensureModelsLoaded(): Promise<void> {
	if (BUILTIN_MODELS !== null) return;
	BUILTIN_MODELS = convertGeneratedModels();
}

/**
 * Check if models have been converted
 */
export function areModelsLoaded(): boolean {
	return BUILTIN_MODELS !== null;
}

/**
 * Get models, converting them lazily if needed
 */
function getBuiltinModels(): Record<string, Model<Api>[]> {
	if (BUILTIN_MODELS === null) {
		BUILTIN_MODELS = convertGeneratedModels();
	}
	return BUILTIN_MODELS;
}

export function getProviders(): string[] {
	return Object.keys(getBuiltinModels());
}

export function getModels(provider: string): Model<Api>[] {
	return getBuiltinModels()[provider] || [];
}

export function getModel(provider: string, modelId: string): Model<Api> | null {
	const models = getModels(provider);
	return models.find((m) => m.id === modelId) || null;
}
