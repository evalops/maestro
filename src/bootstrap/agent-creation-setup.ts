/**
 * Agent Creation Setup - Agent instance construction and composer activation.
 *
 * Extracts the Agent factory from main.ts Phase 11:
 * lazy module loaders, session token counter, audit logger,
 * Agent construction, composer initialization, and activation.
 *
 * @module bootstrap/agent-creation-setup
 */

import chalk from "chalk";
import type { ActionApprovalService } from "../agent/action-approval.js";
import {
	BackgroundTaskContextSource,
	FrameworkPreferenceContextSource,
	GitSnapshotContextSource,
	IDEContextSource,
	LspContextSource,
	TodoContextSource,
} from "../agent/context-providers.js";
import { Agent, ProviderTransport } from "../agent/index.js";
import type { ToolRetryConfig, ToolRetryService } from "../agent/tool-retry.js";
import type { ClientToolExecutionService } from "../agent/transport.js";
import type { AgentTool, Api, Model } from "../agent/types.js";
import { composerManager } from "../composers/index.js";
import type { AuthCredential } from "../providers/auth.js";
import type { Sandbox } from "../sandbox/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent-creation");

// ─── Lazy module loaders ─────────────────────────────────────────────────────
// These IIFE closures ensure enterprise/billing/db modules are only loaded
// when actually needed (e.g., enterprise features are enabled).

const getAuditModule = (() => {
	let promise: Promise<
		typeof import("../enterprise/audit-integration.js")
	> | null = null;
	return () => {
		if (!promise) {
			promise = import("../enterprise/audit-integration.js");
		}
		return promise;
	};
})();

const getBillingModule = (() => {
	let promise: Promise<typeof import("../billing/token-tracker.js")> | null =
		null;
	return () => {
		if (!promise) {
			promise = import("../billing/token-tracker.js");
		}
		return promise;
	};
})();

const getDbModule = (() => {
	let promise: Promise<typeof import("../db/client.js")> | null = null;
	return () => {
		if (!promise) {
			promise = import("../db/client.js");
		}
		return promise;
	};
})();

// ─── Public API ──────────────────────────────────────────────────────────────

export interface AgentCreationResult {
	agent: Agent;
}

/**
 * Create the main Agent instance with enterprise integrations,
 * initialize the composer manager, and optionally activate a composer.
 */
export function createAgentInstance(params: {
	systemPrompt: string;
	model: Model<Api>;
	reasoningSummary: "auto" | "detailed" | "concise" | null | undefined;
	allTools: AgentTool[];
	sandbox: Sandbox | undefined;
	sandboxMode: string | null | undefined;
	approvalService: ActionApprovalService;
	toolRetryService: ToolRetryService;
	toolRetryConfig?: ToolRetryConfig;
	clientToolService?: ClientToolExecutionService;
	requireCredential: (
		providerName: string,
		fatal: boolean,
	) => Promise<AuthCredential>;
	enterpriseUser?: { id: string; orgId: string };
	readonly?: boolean;
	composer?: string;
	cwd: string;
}): AgentCreationResult {
	const {
		systemPrompt,
		model,
		reasoningSummary,
		allTools,
		sandbox,
		sandboxMode,
		approvalService,
		toolRetryService,
		toolRetryConfig,
		clientToolService,
		requireCredential,
		enterpriseUser,
		cwd,
	} = params;

	// Build session token counter for billing/policy enforcement
	const sessionTokenCounter = async (sessionId: string) => {
		try {
			const { isDatabaseConfigured } = await getDbModule();
			if (!isDatabaseConfigured()) return null;
			const { getSessionTokenCount } = await getBillingModule();
			return await getSessionTokenCount(sessionId);
		} catch (error) {
			logger.warn("Failed to get session token count", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	};

	// Build audit logger for enterprise tool execution tracking
	const auditLogger = async (entry: {
		toolName: string;
		args: Record<string, unknown>;
		status: "success" | "failure" | "denied";
		durationMs: number;
		error?: string;
	}) => {
		try {
			const { logSensitiveToolExecution } = await getAuditModule();
			await logSensitiveToolExecution(
				entry.toolName,
				entry.args,
				entry.status,
				entry.durationMs,
				entry.error,
			);
		} catch (error) {
			logger.warn("Failed to log tool execution", {
				error: error instanceof Error ? error.message : String(error),
				toolName: entry.toolName,
			});
		}
	};

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			reasoningSummary,
			tools: allTools,
			sandbox,
			sandboxMode: sandboxMode ?? null,
			sandboxEnabled: Boolean(sandbox),
			user: enterpriseUser,
		},
		transport: new ProviderTransport({
			getAuthContext: (providerName) => requireCredential(providerName, false),
			approvalService,
			toolRetryService,
			toolRetryConfig,
			clientToolService,
			sessionTokenCounter,
			auditLogger,
		}),
		contextSources: [
			new TodoContextSource(),
			new BackgroundTaskContextSource(),
			new GitSnapshotContextSource(cwd),
			new LspContextSource(),
			new FrameworkPreferenceContextSource(),
			new IDEContextSource(),
		],
	});

	// Initialize composer manager for multi-agent orchestration
	composerManager.initialize(agent, systemPrompt, allTools, cwd);

	// Activate composer if specified via CLI flags
	if (params.readonly) {
		const success = composerManager.activate("explore", cwd);
		if (!success) {
			console.warn(
				chalk.yellow(
					'Warning: Could not activate read-only mode. The "explore" composer may not be available.',
				),
			);
		}
	} else if (params.composer) {
		const success = composerManager.activate(params.composer, cwd);
		if (!success) {
			console.warn(
				chalk.yellow(
					`Warning: Could not activate composer "${params.composer}". Check that it exists.`,
				),
			);
		}
	}

	return { agent };
}
