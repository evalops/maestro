import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/tag-release.yml", import.meta.url), "utf8");

test("internal tag-release dispatches public-release-mirror after creating a tag", () => {
	assert.match(workflow, /dispatch-public-release-mirror:/);
	assert.match(workflow, /github\.repository == 'evalops\/maestro-internal'/);
	assert.match(workflow, /needs\.tag-current-version\.outputs\.tag_exists != 'true'/);
	assert.match(workflow, /gh workflow run public-release-mirror/);
	assert.match(workflow, /--field "publish_npm=false"/);
	assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});
