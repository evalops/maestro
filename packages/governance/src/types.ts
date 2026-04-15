/**
 * Agent-agnostic governance types.
 *
 * These types define the public API surface of the governance engine.
 * They deliberately avoid Composer-internal types so that any MCP-compatible
 * agent can use the governance library without importing Composer internals.
 *
 * @module governance/types
 */

/**
 * A tool call to be evaluated by the governance engine.
 * Agent-agnostic representation of a tool invocation.
 */
export interface GovernanceToolCall {
	/** Name of the tool being invoked */
	toolName: string;
	/** Arguments for the tool call */
	args: Record<string, unknown>;
	/** Optional metadata for policy evaluation */
	metadata?: {
		/** MCP tool annotations */
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			idempotentHint?: boolean;
			openWorldHint?: boolean;
		};
	};
	/** Optional user context for org-level policies */
	user?: {
		id: string;
		orgId: string;
	};
	/** Optional session context for time-scoped policies */
	session?: {
		id: string;
		startedAt: Date;
	};
	/** Optional user intent for semantic analysis */
	userIntent?: string;
}

/**
 * Verdict from the governance engine after evaluating a tool call.
 */
export type GovernanceVerdict = "allow" | "require_approval" | "block";

/**
 * Full evaluation result from the governance engine.
 */
export interface GovernanceEvaluationResult {
	/** The final verdict */
	verdict: GovernanceVerdict;
	/** Rule that triggered the verdict (if not "allow") */
	ruleId?: string;
	/** Human-readable reason for the verdict */
	reason?: string;
	/** Suggested remediation steps */
	remediation?: string;
	/** Which subsystem triggered the verdict */
	triggeredBy?: "firewall" | "middleware" | "policy";
	/** Sanitized arguments safe for logging */
	sanitizedArgs?: Record<string, unknown>;
}

/**
 * Result of scanning a payload for credentials/PII.
 */
export interface GovernanceScanResult {
	/** Whether any sensitive content was found */
	hasSensitiveContent: boolean;
	/** Number of findings */
	findingCount: number;
	/** Types of findings (e.g., "aws_key", "github_token") */
	findingTypes: string[];
	/** The sanitized (redacted) payload */
	sanitizedPayload: unknown;
	/** Whether the payload was blocked outright */
	blocked: boolean;
	/** Reason for blocking (if blocked) */
	blockReason?: string;
}

/**
 * Result of analyzing a bash command for safety.
 */
export interface GovernanceCommandAnalysis {
	/** Whether the command is considered safe */
	safe: boolean;
	/** Whether the command is destructive */
	destructive: boolean;
	/** Whether the command has egress primitives (curl, wget, etc.) */
	hasEgress: boolean;
	/** Human-readable reason if unsafe */
	reason?: string;
	/** Detailed analysis from tree-sitter (when available) */
	details?: {
		parserAvailable: boolean;
	};
}

/**
 * Result of checking a tool call against enterprise policy.
 */
export interface GovernancePolicyCheckResult {
	/** Whether the tool call is allowed by policy */
	allowed: boolean;
	/** Reason for denial (if not allowed) */
	reason?: string;
}

/**
 * Current policy configuration info (safe to expose).
 */
export interface GovernancePolicyInfo {
	/** Whether a policy file is loaded */
	loaded: boolean;
	/** Organization ID from policy (if set) */
	orgId?: string;
	/** Whether tool restrictions are configured */
	hasToolRestrictions: boolean;
	/** Whether path restrictions are configured */
	hasPathRestrictions: boolean;
	/** Whether network restrictions are configured */
	hasNetworkRestrictions: boolean;
	/** Whether dependency restrictions are configured */
	hasDependencyRestrictions: boolean;
	/** Whether session limits are configured */
	hasSessionLimits: boolean;
}

/**
 * An audit event recorded by the governance engine.
 */
export interface GovernanceAuditEvent {
	/** Timestamp of the event */
	timestamp: Date;
	/** Type of event */
	type:
		| "evaluation"
		| "scan"
		| "command_analysis"
		| "policy_check"
		| "execution";
	/** Tool name involved */
	toolName: string;
	/** The verdict or outcome */
	verdict?: GovernanceVerdict;
	/** Additional details */
	details?: Record<string, unknown>;
}

/**
 * Configuration for the governance engine.
 */
export interface GovernanceEngineConfig {
	/** Whether to enable loop detection (default: true) */
	enableLoopDetection?: boolean;
	/** Whether to enable sequence analysis (default: true) */
	enableSequenceAnalysis?: boolean;
	/** Whether to enable context firewall (default: true) */
	enableContextFirewall?: boolean;
	/** Callback for audit events */
	onAuditEvent?: (event: GovernanceAuditEvent) => void;
}
