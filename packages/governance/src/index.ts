/**
 * @evalops/governance — Platform governance proxy.
 *
 * Exposes a small agent-facing API over Platform
 * `governance.v1.GovernanceService`.
 *
 * @example
 * ```typescript
 * import { GovernanceEngine } from "@evalops/governance";
 *
 * const engine = new GovernanceEngine({
 *   service: { baseUrl: "https://platform.example", workspaceId: "workspace-1" },
 * });
 * const result = await engine.evaluate({
 *   toolName: "bash",
 *   args: { command: "rm -rf /" },
 * });
 * console.log(result.verdict); // "block"
 * ```
 *
 * @module governance
 */

export { GovernanceEngine } from "./engine.js";
export type { GovernanceServiceConfig } from "./service-client.js";
export type {
	GovernanceAuditEvent,
	GovernanceCommandAnalysis,
	GovernanceEngineConfig,
	GovernanceEvaluationResult,
	GovernancePolicyCheckResult,
	GovernancePolicyInfo,
	GovernanceScanResult,
	GovernanceToolCall,
	GovernanceVerdict,
} from "./types.js";
