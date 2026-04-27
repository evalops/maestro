import { describe, expect, it } from "vitest";
import {
	INITIAL_SCHEMA_BASELINE_MARKERS,
	type InitialSchemaMarker,
	classifyInitialSchemaMarkers,
} from "../../src/db/migrate.js";

function markers(existing: string[]): InitialSchemaMarker[] {
	const existingMarkers = new Set(existing);
	return INITIAL_SCHEMA_BASELINE_MARKERS.map((marker) => ({
		...marker,
		exists: existingMarkers.has(`${marker.kind}:${marker.name}`),
	}));
}

describe("legacy migration reconciliation", () => {
	it("does not treat an empty marker list as an existing baseline", () => {
		const state = classifyInitialSchemaMarkers([]);

		expect(state).toMatchObject({
			exists: false,
			partial: false,
			present: [],
			missing: [],
		});
	});

	it("treats a database with no baseline markers as fresh", () => {
		const state = classifyInitialSchemaMarkers(markers([]));

		expect(state).toMatchObject({
			exists: false,
			partial: false,
			present: [],
		});
	});

	it("does not treat a generic users table as the Maestro baseline", () => {
		const state = classifyInitialSchemaMarkers(markers(["table:users"]));

		expect(state.exists).toBe(false);
		expect(state.partial).toBe(true);
		expect(state.present).toEqual(["table:users"]);
		expect(state.missing).toContain("type:alert_severity");
		expect(state.missing).toContain("table:sessions");
		expect(state.missing).toContain("index:user_email_idx");
	});

	it("does not accept an initial schema with non-exempt baseline gaps", () => {
		const existingMarkers = INITIAL_SCHEMA_BASELINE_MARKERS.map(
			(marker) => `${marker.kind}:${marker.name}`,
		).filter((marker) => marker !== "table:api_keys");
		const state = classifyInitialSchemaMarkers(markers(existingMarkers));

		expect(state.exists).toBe(false);
		expect(state.partial).toBe(true);
		expect(state.missing).toEqual(["table:api_keys"]);
	});

	it("accepts an existing baseline only when all distinctive markers are present", () => {
		const state = classifyInitialSchemaMarkers(
			markers(
				INITIAL_SCHEMA_BASELINE_MARKERS.map(
					(marker) => `${marker.kind}:${marker.name}`,
				),
			),
		);

		expect(state).toMatchObject({
			exists: true,
			partial: false,
			missing: [],
		});
		expect(state.present).toHaveLength(INITIAL_SCHEMA_BASELINE_MARKERS.length);
		expect(state.present).not.toContain("table:audit_hash_cache");
		expect(state.present).not.toContain(
			"constraint:audit_hash_cache_org_id_organizations_id_fk",
		);
	});
});
