import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("./channel-release.yml", import.meta.url), "utf8");
const releaseWorkflow = await readFile(new URL("./release.yml", import.meta.url), "utf8");

test("preview schedules keep beta behind alpha", () => {
	assert.match(workflow, /"0 5 \* \* \*" # alpha/);
	assert.match(workflow, /"30 5 \* \* \*" # beta/);
	assert.match(workflow, /source_ref=origin\/main\^/);
	assert.match(workflow, /source_ref=origin\/main\n/);
});

test("preview publication uses immutable tags and the protected release workflow", () => {
	assert.match(workflow, /git push origin "refs\/tags\/\$\{tag\}"/);
	assert.match(workflow, /gh workflow run release\.yml --ref "\$tag"/);
	assert.doesNotMatch(workflow, /--force/);
	assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});

test("preview aliases carry the signed native release contract", () => {
	assert.match(releaseWorkflow, /id-token: write/);
	assert.match(releaseWorkflow, /cosign sign-blob --yes --bundle SHA256SUMS\.cosign\.bundle/);
	assert.match(releaseWorkflow, /cosign sign-blob --yes --bundle "\$\{binary\}\.cosign\.bundle"/);
	assert.match(releaseWorkflow, /release-assets\/SHA256SUMS\.cosign\.bundle/);
});
