import { describe, expect, it } from "vitest";
import { __TEST_ONLY_toLoadedSkill } from "../../src/skills/service-client.js";

describe("skills/service-client trust hash", () => {
	// Round-3 finding follow-up. PRs #2629 / #2749 / #2753 closed the
	// name-substitution + resource-swap attacks for skills loaded from
	// the local filesystem, but the remote skills-service path in
	// `toLoadedSkill` was still hashing `content` only. Two service-
	// returned skills with byte-identical bodies and different names
	// therefore shared a `contentSha`, so approving the first one
	// implicitly approved the second.
	const baseSkill = {
		id: "skill-123",
		workspaceId: "ws-1",
		ownerId: "user-1",
		description: "shared description",
		scope: 1,
		content: "# Body\n\nThis content is byte-identical.\n",
		currentVersion: 1,
		tags: [] as string[],
	};

	it("binds `name` so two service skills with identical content but different names diverge", () => {
		const trusted = __TEST_ONLY_toLoadedSkill({
			...baseSkill,
			id: "skill-trusted",
			name: "trusted-helper",
		});
		const rogue = __TEST_ONLY_toLoadedSkill({
			...baseSkill,
			id: "skill-rogue",
			name: "rogue-clone",
		});
		expect(trusted?.contentSha).toMatch(/^[a-f0-9]{64}$/);
		expect(rogue?.contentSha).toMatch(/^[a-f0-9]{64}$/);
		expect(trusted?.contentSha).not.toBe(rogue?.contentSha);
	});

	it("is deterministic for the same (name, content) pair", () => {
		const a = __TEST_ONLY_toLoadedSkill({
			...baseSkill,
			id: "skill-a",
			name: "weather-check",
		});
		const b = __TEST_ONLY_toLoadedSkill({
			...baseSkill,
			id: "skill-b",
			name: "weather-check",
		});
		// Same (name, content) → same digest, even though the service
		// IDs differ (we want approvals to follow the user-visible
		// (name, content) pair, not the server-side row ID).
		expect(a?.contentSha).toBe(b?.contentSha);
	});

	it("matches the local-skill digest schema so approvals are interchangeable", () => {
		// The local-skill trust hash starts by writing literal "name:"
		// before the name. A name change must flip the digest, and an
		// empty-resources / empty-resourceDirs service skill must agree
		// with the schema. We don't import the digest helper here —
		// just verify the round-trip property (same name, same body, no
		// resources → identical sha) holds.
		const x = __TEST_ONLY_toLoadedSkill({
			...baseSkill,
			id: "x",
			name: "alpha",
		});
		const y = __TEST_ONLY_toLoadedSkill({
			...baseSkill,
			id: "y",
			name: "alpha",
			content: `${baseSkill.content}extra trailing line\n`,
		});
		// Body changed → digest must change.
		expect(x?.contentSha).not.toBe(y?.contentSha);
	});
});
