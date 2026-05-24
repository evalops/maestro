import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ActionApprovalService,
	ApprovalMode,
} from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import type { ToolRetryService } from "../agent/tool-retry.js";
import type { ClientToolExecutionService } from "../agent/transport.js";
import type { PlatformToolExecutionBridge } from "../agent/transport/tool-execution-bridge.js";
import type { ThinkingLevel } from "../agent/types.js";
import type { RegisteredModel } from "../models/registry.js";
import type { AuthCredential } from "../providers/auth.js";
import type { HeadlessRuntimeService } from "./headless-runtime-service.js";
import type { HostedRunnerLeaseSnapshot } from "./hosted-runner-lease.js";

export interface WebServerConfig {
	corsHeaders: Record<string, string>;
	staticMaxAge: number;
	defaultApprovalMode: ApprovalMode;
	defaultProvider: string;
	defaultModelId: string;
	hostedRunner?: HostedRunnerContext;
}

export interface HostedRunnerContext {
	enabled: true;
	runnerSessionId: string;
	ownerInstanceId?: string;
	workspaceRoot: string;
	snapshotRoot?: string;
	restoreManifestPath?: string;
	listenHost?: string;
	listenPort?: number;
	workspaceId?: string;
	agentId?: string;
	agentRunId?: string;
	agentRuntimeLeaseToken?: string;
	a2aMessageId?: string;
	a2aTaskId?: string;
	lastPlatformA2APush?: {
		kind: "statusUpdate" | "artifactUpdate" | "task" | "message";
		taskId?: string;
		contextId?: string;
		state?: string;
		final?: boolean;
		receivedAt: string;
		runtimeEventId?: string;
		runtimeEventType?: string;
	};
	agentRuntimeWorkerQueue?: string;
	agentRuntimeCorrelationPath?: string;
	attachAudience?: string;
	configuredMaestroSessionId?: string;
	activeMaestroSessionId?: string;
	runtimeLease?: HostedRunnerLeaseSnapshot;
	draining?: boolean;
	lastDrain?: {
		status: string;
		manifestPath: string;
		drainedAt: string;
		reason?: string;
		requestedBy?: string;
	};
}

export interface WebServerServices {
	createAgent: (
		model: RegisteredModel,
		thinking: ThinkingLevel,
		approval: ApprovalMode,
		options?: {
			cwd?: string;
			enableClientTools?: boolean;
			useClientAskUser?: boolean;
			includeVscodeTools?: boolean;
			includeJetBrainsTools?: boolean;
			includeConductorTools?: boolean;
			approvalService?: ActionApprovalService;
			clientToolService?: ClientToolExecutionService;
			toolRetryService?: ToolRetryService;
			platformToolExecutionBridge?: PlatformToolExecutionBridge | false;
		},
	) => Promise<Agent>;
	createBackgroundAgent: (
		model: RegisteredModel,
		options?: {
			cwd?: string;
			systemPrompt?: string;
		},
	) => Promise<Agent>;
	getRegisteredModel: (
		input: string | null | undefined,
	) => Promise<RegisteredModel>;
	getCurrentSelection: () => { provider: string; modelId: string };
	ensureCredential: (provider: string) => Promise<AuthCredential>;
	setModelSelection: (model: RegisteredModel) => void;
	acquireSse: () => symbol | null;
	releaseSse: (token: symbol | null) => void;
	headlessRuntimeService: HeadlessRuntimeService;
}

export type WebServerContext = WebServerConfig & WebServerServices;
