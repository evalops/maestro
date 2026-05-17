import { describe, expect, it } from "vitest";
import {
	handleOperatingPlaneCommand,
	parseOperatingPlaneArgs,
} from "../../../src/cli/commands/operating-plane.js";
import type { OperatingPlaneInspection } from "../../../src/platform/operating-plane-client.js";

const inspection: OperatingPlaneInspection = {
	contract_version: "agent-operating-plane.v1",
	generated_at: "2026-05-17T06:25:00Z",
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
				gateway_authenticated_subject: "user:alice",
			},
			canonical_attributes: {
				raw_prompt: "SECRET customer prompt",
			},
			evidence_refs: [
				{
					id: "gateway:req_123",
					source: "llm_gateway",
					kind: "model_event",
					revision: "rev_1",
					available: true,
					summary: "SECRET evidence summary",
				},
			],
			work_items: [
				{
					kind: "followup",
					state: "waiting",
					next_action: "Post allowed evidence revision to operator",
					blocker: "approval pending",
				},
			],
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
			},
			withholding_reasons: ["customer_content"],
		},
	],
};

describe("operating-plane CLI command", () => {
	it("parses status lookups without swallowing operator filters", () => {
		const parsed = parseOperatingPlaneArgs([
			"status",
			"--thread-id",
			"C123:1740000000.000100",
			"--evidence-id=gateway:req_123",
			"--auth-subject",
			"user:alice",
			"--audience",
			"audit",
			"--include-gates=false",
			"--limit",
			"5",
		]);

		expect(parsed).toMatchObject({
			subcommand: "status",
			query: {
				threadId: "C123:1740000000.000100",
				evidenceId: "gateway:req_123",
				gatewayAuthenticatedSubject: "user:alice",
				audience: "audit",
				includeGates: false,
				limit: 5,
			},
			json: false,
		});
	});

	it("fetches and prints a content-free value proof report", async () => {
		const lines: string[] = [];
		const queries: unknown[] = [];

		await handleOperatingPlaneCommand(
			[
				"status",
				"--thread-id",
				"C123:1740000000.000100",
				"--evidence-id",
				"gateway:req_123",
				"--auth-subject",
				"user:alice",
				"--audience",
				"audit",
				"--include-gates=false",
			],
			{
				inspect: async (query) => {
					queries.push(query);
					return inspection;
				},
				write: (line) => lines.push(line),
			},
		);

		expect(queries).toEqual([
			{
				threadId: "C123:1740000000.000100",
				evidenceId: "gateway:req_123",
				gatewayAuthenticatedSubject: "user:alice",
				audience: "audit",
				includeGates: false,
			},
		]);
		const output = lines.join("\n");
		expect(output).toContain("Agent operating-plane value proof");
		expect(output).toContain("Identity: user:alice");
		expect(output).toContain(
			"Evidence: gateway:req_123 (llm_gateway/model_event, available, revision rev_1)",
		);
		expect(output).toContain(
			"Next action: Post allowed evidence revision to operator",
		);
		expect(output).toContain("Withheld/out of scope: customer_content");
		expect(output).not.toContain("SECRET customer prompt");
		expect(output).not.toContain("SECRET evidence summary");
	});

	it("can emit the safe summary as JSON for Slack/web bridges", async () => {
		const lines: string[] = [];

		await handleOperatingPlaneCommand(
			["status", "--run-id", "run_1", "--json"],
			{
				inspect: async () => inspection,
				write: (line) => lines.push(line),
			},
		);

		const report = JSON.parse(lines.join("\n")) as {
			runs: Array<{ runId: string; evidenceRefs: Array<{ id: string }> }>;
		};
		expect(report.runs[0]).toMatchObject({
			runId: "run_1",
			evidenceRefs: [{ id: "gateway:req_123" }],
		});
		expect(lines.join("\n")).not.toContain("SECRET customer prompt");
		expect(lines.join("\n")).not.toContain("SECRET evidence summary");
	});
});
