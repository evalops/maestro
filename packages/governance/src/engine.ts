/**
 * GovernanceEngine - thin Platform governance proxy.
 *
 * This package no longer re-hosts Maestro's local safety pipeline. Maestro's
 * in-process firewall remains in src/safety for standalone operation; this
 * package is the MCP/package edge over Platform governance services.
 *
 * @module governance/engine
 */

import {
	type GovernanceServiceConfig,
	detectPIIWithGovernanceService,
	evaluateActionWithGovernanceService,
	getSafetyPolicyWithGovernanceService,
	resolveGovernanceServiceConfig,
} from "./service-client.js";
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

const MAX_AUDIT_LOG_SIZE = 1_000;
const EGRESS_COMMAND_PATTERN =
	/(?:^|[;&|()\s])(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet|rsync)(?:\s|$)/u;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class GovernanceEngine {
	private auditLog: GovernanceAuditEvent[] = [];
	private onAuditEvent?: (event: GovernanceAuditEvent) => void;
	private serviceConfig: GovernanceServiceConfig | false | undefined;

	constructor(config?: GovernanceEngineConfig) {
		this.onAuditEvent = config?.onAuditEvent;
		this.serviceConfig = config?.service;
	}

	async evaluate(
		toolCall: GovernanceToolCall,
	): Promise<GovernanceEvaluationResult> {
		const config = this.resolveConfig(toolCall);
		if (!config) {
			return this.notConfiguredEvaluation(toolCall.toolName);
		}

		try {
			const result = await evaluateActionWithGovernanceService(
				config,
				toolCall,
			);
			this.recordAuditEvent({
				type: "evaluation",
				toolName: toolCall.toolName,
				verdict: result.verdict,
				details: {
					ruleId: result.ruleId,
					triggeredBy: "platform-governance",
				},
			});
			return result;
		} catch (error) {
			const message = errorMessage(error);
			const result: GovernanceEvaluationResult = {
				reason: `Governance service unavailable: ${message}`,
				ruleId: "governance-service-unavailable",
				triggeredBy: "policy",
				verdict: "block",
			};
			this.recordAuditEvent({
				type: "evaluation",
				toolName: toolCall.toolName,
				verdict: result.verdict,
				details: { error: message, triggeredBy: "platform-governance" },
			});
			return result;
		}
	}

	async scanPayload(payload: unknown): Promise<GovernanceScanResult> {
		const config = this.resolveConfig();
		if (!config) {
			return {
				blockReason: "Platform governance service is not configured",
				blocked: true,
				findingCount: 0,
				findingTypes: [],
				hasSensitiveContent: false,
				sanitizedPayload: payload,
			};
		}

		try {
			const result = await detectPIIWithGovernanceService(config, payload);
			this.recordAuditEvent({
				type: "scan",
				toolName: "scan_payload",
				details: {
					findingCount: result.findingCount,
					findingTypes: result.findingTypes,
					triggeredBy: "platform-governance",
				},
			});
			return result;
		} catch (error) {
			const message = errorMessage(error);
			const result: GovernanceScanResult = {
				blockReason: `Governance service unavailable: ${message}`,
				blocked: true,
				findingCount: 0,
				findingTypes: [],
				hasSensitiveContent: false,
				sanitizedPayload: payload,
			};
			this.recordAuditEvent({
				type: "scan",
				toolName: "scan_payload",
				details: { error: message, triggeredBy: "platform-governance" },
			});
			return result;
		}
	}

	async analyzeCommand(command: string): Promise<GovernanceCommandAnalysis> {
		const evaluation = await this.evaluate({
			args: { command },
			toolName: "bash",
			userIntent: "Analyze command safety through Platform governance",
		});
		return {
			destructive: evaluation.verdict !== "allow",
			hasEgress: EGRESS_COMMAND_PATTERN.test(command),
			reason: evaluation.reason,
			safe: evaluation.verdict === "allow",
			details: { parserAvailable: false },
		};
	}

	async checkPolicy(
		toolCall: GovernanceToolCall,
	): Promise<GovernancePolicyCheckResult> {
		const result = await this.evaluate(toolCall);
		return {
			allowed: result.verdict === "allow",
			reason: result.reason,
		};
	}

	async getPolicy(): Promise<GovernancePolicyInfo> {
		const config = this.resolveConfig();
		if (!config) {
			return {
				loaded: false,
				hasDependencyRestrictions: false,
				hasNetworkRestrictions: false,
				hasPathRestrictions: false,
				hasSessionLimits: false,
				hasToolRestrictions: false,
			};
		}

		try {
			const summary = await getSafetyPolicyWithGovernanceService(config);
			return {
				loaded: true,
				orgId: summary.workspaceId ?? config.workspaceId,
				hasDependencyRestrictions: false,
				hasNetworkRestrictions: false,
				hasPathRestrictions: false,
				hasSessionLimits: false,
				hasToolRestrictions: summary.ruleCount > 0,
			};
		} catch (error) {
			return {
				error: `Governance service unavailable: ${errorMessage(error)}`,
				loaded: false,
				orgId: config.workspaceId,
				hasDependencyRestrictions: false,
				hasNetworkRestrictions: false,
				hasPathRestrictions: false,
				hasSessionLimits: false,
				hasToolRestrictions: false,
			};
		}
	}

	logAuditEvent(event: Omit<GovernanceAuditEvent, "timestamp">): void {
		this.recordAuditEvent({
			...event,
			details: {
				...event.details,
				note: "local process audit only; durable audit belongs in Platform audit service",
			},
		});
	}

	getAuditLog(): GovernanceAuditEvent[] {
		return [...this.auditLog];
	}

	reset(): void {
		this.auditLog = [];
	}

	recordExecution(
		toolName: string,
		_args: Record<string, unknown>,
		success: boolean,
	): void {
		this.recordAuditEvent({
			type: "execution",
			toolName,
			details: {
				success,
				note: "execution outcome was not written to Platform audit",
			},
		});
	}

	private resolveConfig(toolCall?: GovernanceToolCall) {
		return resolveGovernanceServiceConfig(this.serviceConfig, toolCall);
	}

	private notConfiguredEvaluation(
		toolName: string,
	): GovernanceEvaluationResult {
		const result: GovernanceEvaluationResult = {
			reason: "Platform governance service is not configured",
			ruleId: "governance-service-not-configured",
			triggeredBy: "policy",
			verdict: "block",
		};
		this.recordAuditEvent({
			type: "evaluation",
			toolName,
			verdict: result.verdict,
			details: { triggeredBy: "platform-governance" },
		});
		return result;
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
