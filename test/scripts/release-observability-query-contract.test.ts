import { describe, expect, it } from "vitest";
import {
	RELEASE_OBSERVABILITY_QUERY_SCHEMA,
	REQUIRED_OBSERVABILITY_QUERY_TRACES,
	releaseObservabilityQueryDescriptor,
	releaseObservabilityQueryDescriptorIsValid,
} from "../../scripts/release-observability-query-contract.js";

describe("release observability query contract", () => {
	it("publishes descriptors for every release-gated trace type", () => {
		expect(REQUIRED_OBSERVABILITY_QUERY_TRACES).toEqual([
			"install",
			"session",
			"tool",
			"search",
			"approval",
			"error",
			"artifact",
			"agent-runtime-lifecycle",
			"final-status",
		]);

		for (const traceType of REQUIRED_OBSERVABILITY_QUERY_TRACES) {
			const descriptor = releaseObservabilityQueryDescriptor(traceType);
			expect(descriptor).toMatchObject({
				schemaVersion: RELEASE_OBSERVABILITY_QUERY_SCHEMA,
				traceType,
			});
			expect(descriptor?.subjects.length).toBeGreaterThan(0);
			expect(descriptor?.platformConsumers.length).toBeGreaterThan(0);
			expect(descriptor?.filterFields.length).toBeGreaterThan(0);
			expect(
				releaseObservabilityQueryDescriptorIsValid(
					{ query: descriptor },
					traceType,
				),
			).toBe(true);
		}
	});

	it("returns cloned descriptor arrays so producer mutations cannot change the contract", () => {
		const first = releaseObservabilityQueryDescriptor("tool");
		first?.subjects.push("maestro.events.unexpected");

		const second = releaseObservabilityQueryDescriptor("tool");
		expect(second?.subjects).not.toContain("maestro.events.unexpected");
		expect(
			releaseObservabilityQueryDescriptorIsValid({ query: first }, "tool"),
		).toBe(true);
		expect(
			releaseObservabilityQueryDescriptorIsValid({ query: second }, "tool"),
		).toBe(true);
	});

	it("rejects query descriptors with missing release-gate consumers", () => {
		const descriptor = releaseObservabilityQueryDescriptor(
			"agent-runtime-lifecycle",
		);
		if (!descriptor) {
			throw new Error("Expected agent-runtime-lifecycle descriptor");
		}
		descriptor.platformConsumers = ["release.maestro-session-final-state"];

		expect(
			releaseObservabilityQueryDescriptorIsValid(
				{ query: descriptor },
				"agent-runtime-lifecycle",
			),
		).toBe(false);
	});

	it("rejects query descriptors promoted outside the query entry", () => {
		const descriptor = releaseObservabilityQueryDescriptor("tool");
		if (!descriptor) {
			throw new Error("Expected tool descriptor");
		}

		expect(releaseObservabilityQueryDescriptorIsValid(descriptor, "tool")).toBe(
			false,
		);
		expect(
			releaseObservabilityQueryDescriptorIsValid({ query: descriptor }, "tool"),
		).toBe(true);
	});
});
