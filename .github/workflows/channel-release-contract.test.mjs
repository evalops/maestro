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
	assert.match(workflow, /cp scripts\/sync-package-metadata\.js "\$RUNNER_TEMP\/sync-package-metadata\.js"/);
	assert.match(workflow, /cp "\$RUNNER_TEMP\/sync-package-metadata\.js" scripts\/sync-package-metadata\.js/);
	assert.doesNotMatch(workflow, /--force/);
	assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});

test("channel pointers carry the signed native release contract", () => {
	assert.match(releaseWorkflow, /id-token: write/);
	assert.match(releaseWorkflow, /create-release-metadata\.mjs/);
	assert.match(releaseWorkflow, /create-release-channel-manifest\.mjs/);
	assert.match(releaseWorkflow, /\.\/\.github\/actions\/gcs-artifacts/);
	assert.match(releaseWorkflow, /MAESTRO_RELEASES_PREFIX.*channels/);
	assert.match(releaseWorkflow, /release-assets\/channel-manifest\.json/);
	assert.match(releaseWorkflow, /release-assets\/manifest\.json/);
	assert.match(releaseWorkflow, /release-assets\/version\.json/);
	assert.match(releaseWorkflow, /cosign sign-blob --yes --bundle SHA256SUMS\.cosign\.bundle/);
	assert.match(releaseWorkflow, /cosign sign-blob --yes --bundle "\$\{binary\}\.cosign\.bundle"/);
	assert.match(releaseWorkflow, /files: release-assets\/\*/);
	assert.doesNotMatch(releaseWorkflow, /target_commitish/);
	assert.doesNotMatch(releaseWorkflow, /maestro-\$\{RELEASE_CHANNEL\}-channel/);
	assert.doesNotMatch(releaseWorkflow, /gh release upload "\$channel_tag"/);
});
