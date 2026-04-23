/**
 * @evalops/governance — Agent governance library.
 *
 * Wraps the Composer safety pipeline (ActionFirewall, SafetyMiddleware,
 * enterprise policy) behind a clean, agent-agnostic API.
 *
 * @example
 * ```typescript
 * import { GovernanceEngine } from "@evalops/governance";
 *
 * const engine = new GovernanceEngine();
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
