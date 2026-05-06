import { describe, expect, it } from "vitest";
import {
	formatInitHelp,
	formatInitSuccess,
	parseInitArgs,
} from "../../src/cli/commands/init.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string): string => {
	let stripped = "";
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === ESC && value[index + 1] === "[") {
			index += 2;
			while (index < value.length) {
				const code = value.charCodeAt(index);
				if (code >= 0x40 && code <= 0x7e) break;
				index += 1;
			}
			continue;
		}
		stripped += value[index];
	}
	return stripped;
};

describe("maestro init command", () => {
	it("renders command-specific help for the one-flow EvalOps bootstrap", () => {
		const help = formatInitHelp();

		expect(help).toContain("maestro init");
		expect(help).toContain(
			"Login, create or reuse an API key, and register this agent",
		);
		expect(help).toContain("--rotate-key");
		expect(help).toContain("--mcp-url <url>");
		expect(help).toContain("--json");
	});

	it("still rejects unknown bootstrap options", () => {
		expect(() => parseInitArgs(["--bogus"])).toThrow(
			"Unknown maestro init option: --bogus",
		);
	});

	it("renders init as a control-plane bootstrap with proof of the first loop", () => {
		const output = formatInitSuccess({
			agentId: "agent_123",
			apiKeyCreated: true,
			approvalPolicyAttached: true,
			authenticatedAs: "jonathan@evalops.dev",
			consoleUrl: "https://app.evalops.dev/overview?env=production",
			endpoint: "https://app.evalops.dev/mcp",
			evidenceEventPublished: true,
			evidenceEvents: 1,
			governedActionsLoaded: 17,
			governedInferenceCheckRan: true,
			keyPrefix: "eoak_live_123",
			registryVisible: true,
			riskFindings: 0,
			runId: "run_123",
			stored: true,
			traceIngestionStarted: true,
		});
		const plainOutput = stripAnsi(output);

		expect(plainOutput).toContain("EvalOps Maestro bootstrap");
		expect(plainOutput).toContain("✓ Authenticated as jonathan@evalops.dev");
		expect(plainOutput).toContain("✓ Created managed inference key");
		expect(plainOutput).toContain("✓ Registered local agent runtime");
		expect(plainOutput).toContain("✓ Loaded 17 governed actions");
		expect(plainOutput).toContain("✓ Attached default approval policy");
		expect(plainOutput).toContain("✓ Started trace ingestion");
		expect(plainOutput).toContain("✓ Ran first governed inference check");
		expect(plainOutput).toContain("✓ Published evidence event");
		expect(plainOutput).toContain("Open console:");
		expect(plainOutput).toContain(
			"https://app.evalops.dev/overview?env=production",
		);
	});
});
