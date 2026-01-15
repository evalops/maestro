import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalMode } from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import type { ThinkingLevel } from "../agent/types.js";
import type { RegisteredModel } from "../models/registry.js";
import type { AuthCredential } from "../providers/auth.js";

export interface WebServerConfig {
	corsHeaders: Record<string, string>;
	staticMaxAge: number;
	defaultApprovalMode: ApprovalMode;
	defaultProvider: string;
	defaultModelId: string;
}

export interface WebServerServices {
	createAgent: (
		model: RegisteredModel,
		thinking: ThinkingLevel,
		approval: ApprovalMode,
		options?: {
			enableClientTools?: boolean;
			includeVscodeTools?: boolean;
			includeJetBrainsTools?: boolean;
			includeConductorTools?: boolean;
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
}

export type WebServerContext = WebServerConfig & WebServerServices;
