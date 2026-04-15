/**
 * GovernanceEngine - Main entry point for the governance library.
 *
 * Wraps ActionFirewall + SafetyMiddleware + enterprise policy behind
 * a clean, agent-agnostic API. This is the class that consumers
 * (including the MCP server) interact with.
 *
 * @module governance/engine
 */

import {
	ActionFirewall,
	defaultFirewallRules,
} from "../../../src/safety/action-firewall.js";
import {
	analyzeCommandSafety,
	hasEgressPrimitives,
	isDestructiveSimpleCommand,
	isParserAvailable,
	tokenizeSimple,
} from "../../../src/safety/bash-safety-analyzer.js";
import {
	detectSensitiveContent,
	sanitizePayload,
} from "../../../src/safety/context-firewall.js";
import { checkContextFirewall } from "../../../src/safety/firewall-check.js";
import { checkPolicy, getCurrentPolicy } from "../../../src/safety/policy.js";
import {
	SafetyMiddleware,
	type SafetyMiddlewareConfig,
} from "../../../src/safety/safety-middleware.js";
import { toApprovalContext, toGovernanceVerdict } from "./mappers.js";
import type {
	GovernanceAuditEvent,
	GovernanceCommandAnalysis,
	GovernanceEngineConfig,
	GovernanceEvaluationResult,
	GovernancePolicyCheckResult,
	GovernancePolicyInfo,
	GovernanceScanResult,
	GovernanceToolCall,
} from "./types.js";

/** Maximum audit log entries retained in memory. */
const MAX_AUDIT_LOG_SIZE = 10_000;

export class GovernanceEngine {
	private firewall: ActionFirewall;
	private middleware: SafetyMiddleware;
	private auditLog: GovernanceAuditEvent[] = [];
	private onAuditEvent?: (event: GovernanceAuditEvent) => void;

	constructor(config?: GovernanceEngineConfig) {
		this.firewall = new ActionFirewall(defaultFirewallRules);
		this.onAuditEvent = config?.onAuditEvent;

		const middlewareConfig: SafetyMiddlewareConfig = {
			enableLoopDetection: config?.enableLoopDetection ?? true,
			enableSequenceAnalysis: config?.enableSequenceAnalysis ?? true,
			enableContextFirewall: config?.enableContextFirewall ?? true,
		};
		this.middleware = new SafetyMiddleware(middlewareConfig);
	}

	/**
	 * Full governance pipeline evaluation (middleware + firewall).
	 *
	 * Runs the complete safety pipeline:
	 * 1. SafetyMiddleware.preExecution (loop detection, sequence analysis, context firewall)
	 * 2. ActionFirewall.evaluate (rule-based policy enforcement)
	 *
	 * Returns the most restrictive verdict from either subsystem.
	 */
	async evaluate(
		toolCall: GovernanceToolCall,
	): Promise<GovernanceEvaluationResult> {
		const context = toApprovalContext(toolCall);

		// 1. Run middleware pre-execution checks
		const middlewareResult = this.middleware.preExecution(
			toolCall.toolName,
			toolCall.args,
		);

		if (!middlewareResult.allowed) {
			const result: GovernanceEvaluationResult = {
				verdict: middlewareResult.requiresApproval
					? "require_approval"
					: "block",
				reason: middlewareResult.reason,
				triggeredBy: "middleware",
				sanitizedArgs: middlewareResult.sanitizedArgs,
			};
			this.recordAuditEvent({
				type: "evaluation",
				toolName: toolCall.toolName,
				verdict: result.verdict,
				details: { triggeredBy: middlewareResult.triggeredBy },
			});
			return result;
		}

		// 2. Run firewall evaluation
		const firewallVerdict = await this.firewall.evaluate(context);

		const verdict = toGovernanceVerdict(firewallVerdict.action);
		const result: GovernanceEvaluationResult = {
			verdict,
			sanitizedArgs: middlewareResult.sanitizedArgs,
		};

		if (firewallVerdict.action !== "allow") {
			result.ruleId =
				"ruleId" in firewallVerdict ? firewallVerdict.ruleId : undefined;
			result.reason =
				"reason" in firewallVerdict ? firewallVerdict.reason : undefined;
			result.remediation =
				"remediation" in firewallVerdict
					? firewallVerdict.remediation
					: undefined;
			result.triggeredBy = "firewall";
		}

		this.recordAuditEvent({
			type: "evaluation",
			toolName: toolCall.toolName,
			verdict: result.verdict,
			details: {
				ruleId: result.ruleId,
				triggeredBy: result.triggeredBy,
			},
		});

		return result;
	}

	/**
	 * Scan a payload for credentials, PII, and sensitive content.
	 */
	scanPayload(payload: unknown): GovernanceScanResult {
		const findings = detectSensitiveContent(payload);
		const firewallResult = checkContextFirewall(
			payload as Record<string, unknown>,
		);
		const sanitized = sanitizePayload(payload);

		const result: GovernanceScanResult = {
			hasSensitiveContent: findings.length > 0,
			findingCount: findings.length,
			findingTypes: [...new Set(findings.map((f: { type: string }) => f.type))],
			sanitizedPayload: sanitized,
			blocked: firewallResult.blocked ?? false,
			blockReason: firewallResult.blockReason,
		};

		this.recordAuditEvent({
			type: "scan",
			toolName: "scan_payload",
			details: {
				findingCount: result.findingCount,
				findingTypes: result.findingTypes,
				blocked: result.blocked,
			},
		});

		return result;
	}

	/**
	 * Analyze a bash command for safety concerns.
	 */
	analyzeCommand(command: string): GovernanceCommandAnalysis {
		const parserAvailable = isParserAvailable();
		const tokens = tokenizeSimple(command);
		const destructive = isDestructiveSimpleCommand(tokens);
		const hasEgress = hasEgressPrimitives(command);

		let safe = true;
		let reason: string | undefined;

		if (destructive) {
			safe = false;
			reason = "Command contains destructive or mutating operations";
		}

		if (parserAvailable) {
			const analysis = analyzeCommandSafety(command);
			if (!analysis.safe) {
				safe = false;
				reason =
					analysis.reason ?? "Command failed tree-sitter safety analysis";
			}
		}

		const result: GovernanceCommandAnalysis = {
			safe,
			destructive,
			hasEgress,
			reason,
			details: { parserAvailable },
		};

		this.recordAuditEvent({
			type: "command_analysis",
			toolName: "bash",
			details: {
				safe: result.safe,
				destructive: result.destructive,
				hasEgress: result.hasEgress,
			},
		});

		return result;
	}

	/**
	 * Check a tool call against enterprise policy only.
	 */
	async checkPolicy(
		toolCall: GovernanceToolCall,
	): Promise<GovernancePolicyCheckResult> {
		const context = toApprovalContext(toolCall);
		const result = await checkPolicy(context);

		this.recordAuditEvent({
			type: "policy_check",
			toolName: toolCall.toolName,
			details: { allowed: result.allowed, reason: result.reason },
		});

		return result;
	}

	/**
	 * Get information about the current policy configuration.
	 */
	getPolicy(): GovernancePolicyInfo {
		const policy = getCurrentPolicy();
		if (!policy) {
			return {
				loaded: false,
				hasToolRestrictions: false,
				hasPathRestrictions: false,
				hasNetworkRestrictions: false,
				hasDependencyRestrictions: false,
				hasSessionLimits: false,
			};
		}

		return {
			loaded: true,
			orgId: policy.orgId,
			hasToolRestrictions: !!(policy.tools?.allowed || policy.tools?.blocked),
			hasPathRestrictions: !!(policy.paths?.allowed || policy.paths?.blocked),
			hasNetworkRestrictions: !!(
				policy.network?.allowedHosts ||
				policy.network?.blockedHosts ||
				policy.network?.blockLocalhost ||
				policy.network?.blockPrivateIPs
			),
			hasDependencyRestrictions: !!(
				policy.dependencies?.allowed || policy.dependencies?.blocked
			),
			hasSessionLimits: !!(
				policy.limits?.maxTokensPerSession ||
				policy.limits?.maxSessionDurationMinutes ||
				policy.limits?.maxConcurrentSessions
			),
		};
	}

	/**
	 * Log an audit event.
	 */
	logAuditEvent(event: Omit<GovernanceAuditEvent, "timestamp">): void {
		this.recordAuditEvent(event);
	}

	/**
	 * Retrieve the audit log.
	 */
	getAuditLog(): GovernanceAuditEvent[] {
		return [...this.auditLog];
	}

	/**
	 * Reset internal state (loop detector, sequence analyzer).
	 */
	reset(): void {
		this.middleware.reset();
		this.auditLog = [];
	}

	/**
	 * Record a tool execution outcome for state updates.
	 */
	recordExecution(
		toolName: string,
		args: Record<string, unknown>,
		success: boolean,
	): void {
		this.middleware.postExecution(toolName, args, success);
		this.recordAuditEvent({
			type: "execution",
			toolName,
			details: { success },
		});
	}

	private recordAuditEvent(
		event: Omit<GovernanceAuditEvent, "timestamp">,
	): void {
		const fullEvent: GovernanceAuditEvent = {
			...event,
			timestamp: new Date(),
		};
		this.auditLog.push(fullEvent);
		if (this.auditLog.length > MAX_AUDIT_LOG_SIZE) {
			this.auditLog = this.auditLog.slice(-MAX_AUDIT_LOG_SIZE);
		}
		this.onAuditEvent?.(fullEvent);
	}
}
