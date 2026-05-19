import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AgentMode,
	MODEL_BY_TIER,
	MODE_CONFIGS,
	type ModelProvider,
	type ModelTier,
	resolveSubagentDispatch,
} from "../../src/agent/modes.js";
import type { SubagentType } from "../../src/agent/subagent-specs.js";
import {
	CODEX_SUBAGENT_DISPATCH_TABLE,
	DEFAULT_CODEX_SUBAGENT_DELEGATION_CAPABILITY,
	codexSubagentCapabilityA2ASkillID,
	codexSubagentTypeA2ASkillID,
} from "../../src/codex/subagent-dispatch-table.js";
import { buildMaestroA2APeerProjection } from "../../src/platform/a2a-maestro-peer.js";

interface FixtureDispatchRule {
	model: string;
	reasoningEffort: string;
}

interface FixtureModeDispatch {
	primaryTier: ModelTier;
	reasoningEffort: string;
	fallbackSubagent: SubagentType;
	subagents: Record<string, FixtureDispatchRule>;
}

interface CodexSubagentDispatchFixture {
	schemaVersion: string;
	defaultCapability: string;
	modelTiers: typeof MODEL_BY_TIER;
	a2aSkillLanes: typeof CODEX_SUBAGENT_DISPATCH_TABLE.a2aSkillLanes;
	modeDispatch: Record<AgentMode, FixtureModeDispatch>;
}

const fixture = JSON.parse(
	readFileSync(
		join(process.cwd(), "docs/protocols/codex-subagent-dispatch-table-v1.json"),
		"utf8",
	),
) as CodexSubagentDispatchFixture;

function isModelTier(model: string): model is ModelTier {
	return model in MODEL_BY_TIER;
}

function splitExplicitModel(model: string): {
	provider?: ModelProvider;
	model: string;
} {
	const [provider, modelId] = model.split("/", 2);
	if (
		modelId &&
		["anthropic", "openai", "openai-codex", "google"].includes(provider)
	) {
		return { provider: provider as ModelProvider, model: modelId };
	}
	return { model };
}

describe("Codex subagent dispatch table", () => {
	it("tracks the versioned A2A subagent lane fixture", () => {
		expect(CODEX_SUBAGENT_DISPATCH_TABLE.schemaVersion).toBe(
			fixture.schemaVersion,
		);
		expect(DEFAULT_CODEX_SUBAGENT_DELEGATION_CAPABILITY).toBe(
			fixture.defaultCapability,
		);
		expect(CODEX_SUBAGENT_DISPATCH_TABLE.a2aSkillLanes).toEqual(
			fixture.a2aSkillLanes,
		);
	});

	it("routes Codex type and capability aliases through declared A2A lanes", () => {
		expect(codexSubagentTypeA2ASkillID("ci-monitor")).toBe(
			"maestro.subagent.test-runner",
		);
		expect(codexSubagentTypeA2ASkillID("people_research")).toBe(
			"maestro.subagent.repo-explorer",
		);
		expect(codexSubagentCapabilityA2ASkillID("code:write")).toBe(
			"maestro.subagent.code-writer",
		);
		expect(codexSubagentCapabilityA2ASkillID("release_manage")).toBe(
			"maestro.subagent.release-shepherd",
		);
		expect(codexSubagentTypeA2ASkillID("risk-auditor")).toBe(
			"maestro.subagent.risk-auditor",
		);
	});

	it("publishes the declared lanes as governed Platform A2A skills", () => {
		const projection = buildMaestroA2APeerProjection({
			publicEndpointUrl: "https://maestro.example/a2a/",
		});
		expect(projection.publicEndpointUrl).toBe("https://maestro.example/a2a");
		expect(projection.agentCardUrl).toBe(
			"https://maestro.example/a2a/.well-known/agent-card.json",
		);
		expect(projection.protocolVersion).toBe("1.0");
		expect(projection.supportedExtensions).toContain(
			"https://evalops.com/a2a/extensions/operating-plane/v1",
		);
		expect(projection.skills?.map((skill) => skill.id)).toEqual([
			"maestro-tui-turn",
			...fixture.a2aSkillLanes.map((lane) => lane.skillId),
		]);
		expect(
			projection.skills?.find(
				(skill) => skill.id === "maestro.subagent.release-shepherd",
			),
		).toMatchObject({
			requiredContextGrants: expect.arrayContaining(["deploy:read"]),
			allowedTaskClasses: ["release.follow-through", "deployment.smoke"],
			attributes: expect.objectContaining({
				requestMetadataPath: "evalops.subagentRequest",
			}),
		});
	});

	it("keeps TypeScript mode dispatch aligned with the protocol fixture", () => {
		expect(MODEL_BY_TIER).toEqual(fixture.modelTiers);

		for (const [mode, modeFixture] of Object.entries(fixture.modeDispatch) as [
			AgentMode,
			FixtureModeDispatch,
		][]) {
			const config = MODE_CONFIGS[mode];
			expect(config.primaryTier).toBe(modeFixture.primaryTier);
			expect(config.reasoningEffort).toBe(modeFixture.reasoningEffort);
			expect(
				Object.fromEntries(
					Object.entries(config.subagents ?? {}).map(([subagentType, rule]) => [
						subagentType,
						{
							model: rule.model,
							reasoningEffort: rule.reasoningEffort,
						},
					]),
				),
			).toEqual(modeFixture.subagents);

			for (const [subagentType, rule] of Object.entries(
				modeFixture.subagents,
			) as [SubagentType, FixtureDispatchRule][]) {
				const dispatch = resolveSubagentDispatch(
					mode,
					subagentType,
					"anthropic",
				);
				expect(dispatch.source).toBe("mode");
				expect(dispatch.reasoningEffort).toBe(rule.reasoningEffort);

				if (isModelTier(rule.model)) {
					expect(dispatch.provider).toBe("anthropic");
					expect(dispatch.modelTier).toBe(rule.model);
					expect(dispatch.model).toBe(MODEL_BY_TIER[rule.model].anthropic);
				} else {
					const explicit = splitExplicitModel(rule.model);
					expect(dispatch.provider).toBe(explicit.provider ?? "anthropic");
					expect(dispatch.model).toBe(explicit.model);
					expect(dispatch.modelTier).toBeUndefined();
				}
			}

			const fallback = resolveSubagentDispatch(
				mode,
				modeFixture.fallbackSubagent,
				"google",
			);
			expect(fallback.source).toBe("fallback");
			expect(fallback.modelTier).toBe(modeFixture.primaryTier);
			expect(fallback.model).toBe(
				MODEL_BY_TIER[modeFixture.primaryTier].google,
			);
			expect(fallback.reasoningEffort).toBe(modeFixture.reasoningEffort);
		}
	});
});
