import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { SwarmExecutor } from "../../src/agent/swarm/executor.js";
import type { SwarmEvent } from "../../src/agent/swarm/types.js";
import {
	type FeatureClaim,
	type ValidationContract,
	createEmptyContract,
} from "../../src/agent/validation-contract.js";

function contractWith(assertionIds: string[]): ValidationContract {
	const contract = createEmptyContract({ id: "c1", surface: "api" });
	contract.areas.push({
		name: "core",
		assertions: assertionIds.map((id) => ({
			id,
			description: id,
			status: "pending" as const,
		})),
	});
	return contract;
}

describe("SwarmExecutor coverage gate", () => {
	it("refuses to dispatch when the contract is not fully covered", async () => {
		const executor = new SwarmExecutor({
			teammateCount: 1,
			planFile: "plan.md",
			cwd: process.cwd(),
			tasks: [{ id: "t1", prompt: "do the thing" }],
			validationContract: contractWith(["a1"]),
			featureClaims: [],
		});
		const events: SwarmEvent[] = [];
		executor.onEvent((event) => events.push(event));

		const state = await executor.execute();

		expect(state.status).toBe("failed");
		expect(state.error).toContain("Unclaimed assertions");
		expect(state.completedAt).toEqual(expect.any(Number));
		expect(events.map((event) => event.type)).toEqual([
			"swarm_fail",
			"swarm_complete",
		]);
		expect(events[1]).toMatchObject({
			type: "swarm_complete",
			state: { status: "failed", completedAt: state.completedAt },
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("returns a defensive copy when the coverage gate fails", async () => {
		const executor = new SwarmExecutor({
			teammateCount: 1,
			planFile: "plan.md",
			cwd: process.cwd(),
			tasks: [{ id: "t1", prompt: "do the thing" }],
			validationContract: contractWith(["a1"]),
			featureClaims: [],
		});

		const state = await executor.execute();
		state.config.validationContract?.areas.push({
			name: "mutated",
			assertions: [],
		});
		state.config.featureClaims?.push({ id: "mutated", fulfills: [] });

		const internalState = executor.getState();
		expect(internalState.config.validationContract?.areas).toHaveLength(1);
		expect(internalState.config.featureClaims).toEqual([]);
	});

	it("reports malformed claims with missing fulfills arrays instead of throwing", async () => {
		const executor = new SwarmExecutor({
			teammateCount: 1,
			planFile: "plan.md",
			cwd: process.cwd(),
			tasks: [{ id: "t1", prompt: "do the thing" }],
			validationContract: contractWith(["a1"]),
			featureClaims: [{ id: "f1" }] as unknown as FeatureClaim[],
		});

		const state = await executor.execute();

		expect(state.status).toBe("failed");
		expect(state.error).toContain("Unclaimed assertions");
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
