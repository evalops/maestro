import { describe, expect, it } from "vitest";
import type { OperatingPlaneInspection } from "../../src/platform/operating-plane-client.js";
import {
	formatOperatingPlaneStatusReport,
	summarizeOperatingPlaneInspection,
} from "../../src/platform/operating-plane-summary.js";

describe("operating plane status summary", () => {
	it("turns operating-plane inspections into content-free operator value proof", () => {
		const inspection: OperatingPlaneInspection = {
			contract_version: "agent-operating-plane.v1",
			generated_at: "2026-05-17T06:05:00Z",
			unavailable_sources: ["meter"],
			runs: [
				{
					agent_run_id: "run_1",
					title: "Slack answer",
					status: "succeeded",
					surface: "slack",
					channel_thread_id: "C123:1740000000.000100",
					trace_id: "trace-1",
					identity: {
						workspace_id: "ws_evalops",
						tenant_id: "tenant_1",
						gateway_authenticated_subject: "user:alice",
						gateway_authenticated_token_type: "agent",
					},
					canonical_attributes: {
						"evalops.raw_prompt": "SECRET raw customer prompt",
						"evalops.evidence.body": "SECRET raw evidence body",
					},
					evidence_refs: [
						{
							id: "gateway:req_123",
							source: "llm_gateway",
							kind: "model_event",
							revision: "rev_1",
							available: true,
							summary: "SECRET raw evidence summary",
						},
					],
					work_items: [
						{
							id: "work_1",
							kind: "followup",
							state: "waiting",
							title: "Post operator proof",
							next_action: "Post allowed evidence revision to operator",
							blocker: "approval pending",
						},
					],
					usage: {
						total_tokens: 1234,
						estimated_cost_micros: 4567,
						currency: "USD",
					},
					value_proof: {
						operation_id: "run_1",
						operator_summary: "Gateway request is tied to Slack thread",
						identity_bound: true,
						model_observed: true,
						tool_observed: false,
						approval_observed: false,
						trace_linked: true,
						evidence_linked: true,
						cost_attributed: true,
						missing_proof: ["tool ledger", "approval ledger"],
					},
					withholding_reasons: ["customer_content"],
					unavailable_sources: ["tool-execution"],
					redaction_count: 2,
				},
			],
		};

		const report = summarizeOperatingPlaneInspection(inspection);
		expect(report).toMatchObject({
			contractVersion: "agent-operating-plane.v1",
			generatedAt: "2026-05-17T06:05:00Z",
			runCount: 1,
			unavailableSources: ["meter"],
			runs: [
				{
					runId: "run_1",
					title: "Slack answer",
					status: "succeeded",
					surface: "slack",
					channelThreadId: "C123:1740000000.000100",
					traceId: "trace-1",
					identitySubject: "user:alice",
					operatorSummary: "Gateway request is tied to Slack thread",
					proofPresent: ["identity", "model", "trace", "evidence", "cost"],
					proofMissing: ["tool", "approval", "tool ledger", "approval ledger"],
					evidenceRefs: [
						{
							id: "gateway:req_123",
							source: "llm_gateway",
							kind: "model_event",
							revision: "rev_1",
							available: true,
						},
					],
					nextActions: ["Post allowed evidence revision to operator"],
					blockers: ["approval pending"],
					withheld: ["customer_content", "2 redactions", "tool-execution"],
					usage: {
						totalTokens: 1234,
						estimatedCostMicros: 4567,
						currency: "USD",
					},
				},
			],
		});

		const formatted = formatOperatingPlaneStatusReport(report);
		expect(formatted).toContain("Agent operating-plane value proof");
		expect(formatted).toContain("run_1");
		expect(formatted).toContain("Identity: user:alice");
		expect(formatted).toContain(
			"Proof present: identity, model, trace, evidence, cost",
		);
		expect(formatted).toContain(
			"Missing proof: tool, approval, tool ledger, approval ledger",
		);
		expect(formatted).toContain(
			"Evidence: gateway:req_123 (llm_gateway/model_event, available, revision rev_1)",
		);
		expect(formatted).toContain(
			"Next action: Post allowed evidence revision to operator",
		);
		expect(formatted).toContain("Blocker: approval pending");
		expect(formatted).toContain(
			"Withheld/out of scope: customer_content, 2 redactions, tool-execution",
		);
		expect(formatted).not.toContain("SECRET raw customer prompt");
		expect(formatted).not.toContain("SECRET raw evidence body");
		expect(formatted).not.toContain("SECRET raw evidence summary");
	});

	it("formats empty inspections as a useful miss instead of a fake success", () => {
		const report = summarizeOperatingPlaneInspection({
			contract_version: "agent-operating-plane.v1",
			generated_at: "2026-05-17T06:05:00Z",
			runs: [],
			unavailable_sources: ["agentruntime"],
		});

		expect(report).toMatchObject({
			runCount: 0,
			unavailableSources: ["agentruntime"],
			runs: [],
		});
		expect(formatOperatingPlaneStatusReport(report)).toContain(
			"No operating-plane runs matched the query.",
		);
	});

	it("treats absent value proof as missing telemetry", () => {
		const report = summarizeOperatingPlaneInspection({
			contract_version: "agent-operating-plane.v1",
			generated_at: "2026-05-17T06:05:00Z",
			runs: [
				{
					agent_run_id: "run_partial",
					title: "Partial payload",
					status: "running",
					surface: "slack",
				},
			],
		});

		expect(report.runs[0]?.proofPresent).toEqual([]);
		expect(report.runs[0]?.proofMissing).toEqual([
			"identity",
			"model",
			"tool",
			"approval",
			"trace",
			"evidence",
			"cost",
			"value_proof unavailable",
		]);
		expect(formatOperatingPlaneStatusReport(report)).toContain(
			"Missing proof: identity, model, tool, approval, trace, evidence, cost, value_proof unavailable",
		);
	});
});
