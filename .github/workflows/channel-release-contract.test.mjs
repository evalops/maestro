import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("./channel-release.yml", import.meta.url), "utf8");
const releaseWorkflow = await readFile(new URL("./release.yml", import.meta.url), "utf8");

test("preview schedules finalize only staged signed candidates", () => {
 assert.match(workflow, /"0 5 \* \* \*" # alpha/);
 assert.match(workflow, /"30 5 \* \* \*" # beta/);
 assert.match(workflow, /MONO_SHA256SUMS\.cosign\.bundle/);
 assert.match(workflow, /select\(\.draft/);
 assert.match(workflow, /contents: read/);
 assert.doesNotMatch(workflow, /contents: write/);
 assert.match(workflow, /gh workflow run release\.yml --ref main/);
 assert.match(workflow, /No staged signed/);
 assert.doesNotMatch(workflow, /git (?:push|tag|commit)/);
 assert.doesNotMatch(workflow, /scripts\/version\.js/);
 assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});

test("channel pointers carry the signed native release contract", () => {
	assert.match(releaseWorkflow, /id-token: write/);
	assert.match(releaseWorkflow, /verify-staged-release\.mjs/);
 assert.match(releaseWorkflow, /\.receipt\.sourceSha/);
 assert.doesNotMatch(releaseWorkflow, /create-release-metadata\.mjs/);
	assert.match(releaseWorkflow, /create-release-channel-manifest\.mjs/);
	assert.match(releaseWorkflow, /softprops\/action-gh-release@[0-9a-f]{40}/);
	assert.match(releaseWorkflow, /release-assets\/channel-manifest\.json/);
	assert.match(releaseWorkflow, /release-assets\/manifest\.json/);
	assert.match(releaseWorkflow, /release-assets\/version\.json/);
	assert.match(releaseWorkflow, /cosign sign-blob --yes --bundle SHA256SUMS\.cosign\.bundle/);
	assert.match(releaseWorkflow, /cosign sign-blob --yes --bundle "\$\{binary\}\.cosign\.bundle"/);
	assert.match(releaseWorkflow, /files: \|\n\s+release-assets\/\*\.json/);
	assert.doesNotMatch(releaseWorkflow, /\.\/\.github\/actions\/gcs-artifacts/);
	assert.doesNotMatch(releaseWorkflow, /MAESTRO_RELEASES_PREFIX/);
	assert.doesNotMatch(releaseWorkflow, /gcloud storage/);
	assert.doesNotMatch(releaseWorkflow, /target_commitish/);
	assert.doesNotMatch(releaseWorkflow, /maestro-\$\{RELEASE_CHANNEL\}-channel/);
	assert.doesNotMatch(releaseWorkflow, /gh release upload "\$channel_tag"/);
});
