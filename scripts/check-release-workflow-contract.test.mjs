import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
	checkReleaseWorkflow,
	validateReleaseWorkflow,
} from "./check-release-workflow-contract.mjs";

const releaseSha = "${{ needs.prepare.outputs.release_sha }}";
const completeWorkflow = `
permissions:
  contents: read
concurrency:
  group: \${{ github.workflow }}
jobs:
  prepare:
    permissions:
      contents: read
    outputs:
      package_name: \${{ steps.release.outputs.package_name }}
      release_sha: \${{ steps.release.outputs.release_sha }}
      release_tag: \${{ steps.release.outputs.release_tag }}
      release_version: \${{ steps.release.outputs.release_version }}
    steps:
      - uses: actions/checkout@sha
      - id: release
        name: Resolve immutable release tag
        run: |
          git fetch --force --no-tags origin "refs/tags/\${release_tag}:refs/tags/\${release_tag}"
          release_sha="$(git rev-list -n 1 "$release_tag")"
          git checkout --detach "$release_sha"
          {
            echo "package_name=$package_name"
            echo "release_sha=$release_sha"
            echo "release_tag=$release_tag"
            echo "release_version=$release_version"
          } >> "$GITHUB_OUTPUT"
  binaries:
    needs: prepare
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@sha
        with:
          ref: ${releaseSha}
  publish:
    needs: [prepare, binaries]
    environment:
      name: npm-release
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@sha
        with:
          ref: ${releaseSha}
      - name: Verify native package inputs
        run: |
          set -euo pipefail
          test "$(node -p "require('./package.json').version")" = "$RELEASE_VERSION"
          test -f packages/web/dist/index.html
          npm run check:rust-only-runtime
      - name: Publish to npm
        env:
          NPM_PUBLISH_AUTH_MODE: \${{ vars.NPM_PUBLISH_AUTH_MODE || 'auto' }}
        run: |
          publish_with_token() {
            command npm publish "\${{ steps.pack.outputs.tarball }}" --access public --provenance
          }
          publish_with_trusted_publisher() {
            command npm publish "\${{ steps.pack.outputs.tarball }}" --access public
          }
          case "$NPM_PUBLISH_AUTH_MODE" in
            auto)
              publish_with_trusted_publisher || trusted_status=$?
              publish_with_token
              ;;
            trusted)
              publish_with_trusted_publisher
              ;;
            token)
              publish_with_token
              ;;
            *)
              echo "::error::Unsupported NPM_PUBLISH_AUTH_MODE '$NPM_PUBLISH_AUTH_MODE'. Use auto, trusted, or token."
              exit 1
              ;;
          esac
      - uses: softprops/action-gh-release@sha
        with:
          tag_name: \${{ needs.prepare.outputs.release_tag }}
          name: Maestro \${{ needs.prepare.outputs.release_version }}
  post-publish-canary:
    needs:
      - prepare
      - publish
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@sha
        with:
          ref: ${releaseSha}
      - name: Verify published package from npm
        env:
          PACKAGE_NAME: \${{ needs.prepare.outputs.package_name }}
          RELEASE_VERSION: \${{ needs.prepare.outputs.release_version }}
        run: |
          set -euo pipefail
          node scripts/smoke-registry-install.js \\
            --package "$PACKAGE_NAME" \\
            --version "$RELEASE_VERSION" \\
            --cli-command "$CLI_COMMAND"
      - name: Validate published replay evidence
        run: node scripts/verify-published-replay-evidence.js --evidence-dir published-replay-evidence
`;

test("accepts mapping-form environment and the complete release contract", () => {
	assert.deepEqual(validateReleaseWorkflow(completeWorkflow), []);
});

test("rejects dormant npm publish helpers", () => {
	const dormant = completeWorkflow
		.replace(
			"              publish_with_trusted_publisher || trusted_status=$?\n",
			"              true\n",
		)
		.replaceAll("              publish_with_token\n", "              true\n")
		.replace("              publish_with_trusted_publisher\n", "              true\n");
	assert.ok(
		validateReleaseWorkflow(dormant).some((failure) =>
			failure.includes("helpers must be invoked"),
		),
	);
});

test("rejects swallowed npm publish failures", () => {
	const swallowed = completeWorkflow.replaceAll(
		" --access public",
		" --access public || true",
	);
	assert.ok(
		validateReleaseWorkflow(swallowed).some((failure) =>
			failure.includes("exact unswallowed"),
		),
	);
});

test("comments cannot spoof environment, permissions, or dependencies", () => {
	const spoofed = completeWorkflow
		.replace("    environment:\n      name: npm-release\n", "    # environment: npm-release\n")
		.replace("      id-token: write\n", "      # id-token: write\n")
		.replace("      - publish\n", "      # - publish # needs: publish\n");
	const failures = validateReleaseWorkflow(spoofed);
	assert.ok(failures.some((failure) => failure.includes("npm-release environment")));
	assert.ok(failures.some((failure) => failure.includes("id-token")));
	assert.ok(failures.some((failure) => failure.includes("must need prepare and publish")));
});

test("rejects broad build permissions and non-serialized releases", () => {
	const broadened = completeWorkflow
		.replace("permissions:\n  contents: read\n", "permissions:\n  contents: write\n")
		.replace("  group: ${{ github.workflow }}\n", "  group: ${{ github.workflow }}-${{ github.ref }}\n")
		.replace(
			"  binaries:\n    needs: prepare\n    permissions:\n      contents: read\n",
			"  binaries:\n    needs: prepare\n    permissions:\n      contents: write\n",
		);
	const failures = validateReleaseWorkflow(broadened);
	assert.ok(failures.some((failure) => failure.includes("default permissions")));
	assert.ok(failures.some((failure) => failure.includes("serialize")));
	assert.ok(failures.some((failure) => failure.includes("binaries permissions")));
});

test("rejects extra workflow or job write permissions", () => {
	const broadened = completeWorkflow
		.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  packages: write\n")
		.replace(
			"  binaries:\n    needs: prepare\n    permissions:\n      contents: read\n",
			"  binaries:\n    needs: prepare\n    permissions:\n      contents: read\n      actions: write\n",
		);
	const failures = validateReleaseWorkflow(broadened);
	assert.ok(failures.some((failure) => failure.includes("default permissions")));
	assert.ok(failures.some((failure) => failure.includes("binaries permissions")));
});

test("rejects workflow_dispatch work from an unbound ref", () => {
	const unbound = completeWorkflow.replaceAll(
		`          ref: ${releaseSha}`,
		"          ref: main",
	);
	assert.ok(
		validateReleaseWorkflow(unbound).some((failure) =>
			failure.includes("immutable release SHA"),
		),
	);
});

test("rejects a later checkout that replaces the immutable release source", () => {
	const secondCheckout = completeWorkflow.replace(
		`      - name: Verify native package inputs
`,
		`      - uses: actions/checkout@sha
        with:
          ref: main
      - name: Verify native package inputs
`,
	);
	assert.ok(
		validateReleaseWorkflow(secondCheckout).some((failure) =>
			failure.includes("publish checkout must bind"),
		),
	);
});

test("rejects a rebound prepare release SHA output", () => {
	const rebound = completeWorkflow.replace(
		"      release_sha: ${{ steps.release.outputs.release_sha }}",
		"      release_sha: ${{ github.sha }}",
	);
	assert.ok(
		validateReleaseWorkflow(rebound).some((failure) =>
			failure.includes("outputs must bind exactly"),
		),
	);
});

test("rejects rebound or replaced immutable release metadata", () => {
	const reboundTag = completeWorkflow.replace(
		"      release_tag: ${{ steps.release.outputs.release_tag }}",
		"      release_tag: ${{ github.ref_name }}",
	);
	assert.ok(
		validateReleaseWorkflow(reboundTag).some((failure) =>
			failure.includes("outputs must bind exactly"),
		),
	);

	const replacedTag = completeWorkflow.replace(
		'            echo "release_tag=$release_tag"',
		'            echo "release_tag=$GITHUB_REF_NAME"',
	);
	assert.ok(
		validateReleaseWorkflow(replacedTag).some((failure) =>
			failure.includes("emit release_tag exactly once"),
		),
	);

	const replacedPackage = completeWorkflow.replace(
		'            echo "package_name=$package_name"',
		'            echo "package_name=@attacker/package"',
	);
	assert.ok(
		validateReleaseWorkflow(replacedPackage).some((failure) =>
			failure.includes("emit package_name exactly once"),
		),
	);
});

test("rejects a fake release output step split from the immutable resolver", () => {
	const splitIdentity = completeWorkflow
		.replace(
			"      - id: release\n",
			`      - id: release
        run: echo "release_sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"
      - id: immutable_release
`,
		);
	assert.ok(
		validateReleaseWorkflow(splitIdentity).some((failure) =>
			failure.includes("step id must be release"),
		),
	);
});

test("rejects resolver output replacement and conditional jobs", () => {
	const replacedOutput = completeWorkflow.replace(
		'          echo "release_sha=$release_sha"',
		'          echo "release_sha=$GITHUB_SHA"',
	);
	assert.ok(
		validateReleaseWorkflow(replacedOutput).some((failure) =>
			failure.includes("emit release_sha exactly once"),
		),
	);

	const skippedPublish = completeWorkflow.replace(
		"  publish:\n",
		"  publish:\n    if: ${{ false }}\n",
	);
	assert.ok(
		validateReleaseWorkflow(skippedPublish).some((failure) =>
			failure.includes("publish job must not be conditional"),
		),
	);
});

test("rejects disabled or shell-dormant npm publication", () => {
	const disabledStep = completeWorkflow.replace(
		"      - name: Publish to npm\n",
		"      - name: Publish to npm\n        if: ${{ false }}\n",
	);
	assert.ok(
		validateReleaseWorkflow(disabledStep).some((failure) =>
			failure.includes("publication must not be conditional or ignored"),
		),
	);

	const dormantBranch = completeWorkflow
		.replace(
			'          case "$NPM_PUBLISH_AUTH_MODE" in\n',
			'          if false; then\n            case "$NPM_PUBLISH_AUTH_MODE" in\n',
		)
		.replace("          esac\n", "            esac\n          fi\n");
	assert.ok(
		validateReleaseWorkflow(dormantBranch).some((failure) =>
			failure.includes("top shell level"),
		),
	);
});

test("rejects continue-on-error on required release steps", () => {
	for (const stepName of [
		"Resolve immutable release tag",
		"Publish to npm",
		"Verify published package from npm",
	]) {
		const property = `        name: ${stepName}
`;
		const stepStart = `      - name: ${stepName}
`;
		const ignored = completeWorkflow.includes(property)
			? completeWorkflow.replace(
					property,
					`${property}        continue-on-error: true
`,
				)
			: completeWorkflow.replace(
					stepStart,
					`${stepStart}        continue-on-error: true
`,
				);
		assert.notDeepEqual(
			validateReleaseWorkflow(ignored),
			[],
			`${stepName} must not allow ignored failures`,
		);
	}
});

test("rejects a replay validation step that does not execute the verifier", () => {
	const bypassed = completeWorkflow.replace(
		"        run: node scripts/verify-published-replay-evidence.js --evidence-dir published-replay-evidence\n",
		"        run: true\n",
	);
	assert.ok(
		validateReleaseWorkflow(bypassed).some((failure) =>
			failure.includes("exact evidence verifier"),
		),
	);
});

test("rejects early success before replay or registry validation", () => {
	const replayExit = completeWorkflow.replace(
		"        run: node scripts/verify-published-replay-evidence.js --evidence-dir published-replay-evidence\n",
		"        run: |\n          exit 0\n          node scripts/verify-published-replay-evidence.js --evidence-dir published-replay-evidence\n",
	);
	assert.ok(
		validateReleaseWorkflow(replayExit).some((failure) =>
			failure.includes("exact evidence verifier"),
		),
	);

	const canaryExit = completeWorkflow.replace(
		"          set -euo pipefail\n          node scripts/smoke-registry-install.js",
		"          exit 0\n          set -euo pipefail\n          node scripts/smoke-registry-install.js",
	);
	assert.ok(
		validateReleaseWorkflow(canaryExit).some((failure) =>
			failure.includes("exact registry smoke"),
		),
	);
});

test("rejects alternate publish failure swallowing", () => {
	const swallowed = completeWorkflow.replaceAll(
		" --access public",
		" --access public || :",
	);
	assert.ok(
		validateReleaseWorkflow(swallowed).some((failure) =>
			failure.includes("exact unswallowed"),
		),
	);
});

test("rejects early success or a shell function that shadows npm", () => {
	const earlyExit = completeWorkflow.replace(
		'          case "$NPM_PUBLISH_AUTH_MODE" in\n',
		'          exit 0\n          case "$NPM_PUBLISH_AUTH_MODE" in\n',
	);
	assert.ok(
		validateReleaseWorkflow(earlyExit).some((failure) =>
			failure.includes("must not be bypassed"),
		),
	);

	const shadowed = completeWorkflow.replace(
		"          publish_with_token() {\n",
		"          npm() { return 0; }\n          publish_with_token() {\n",
	);
	assert.ok(
		validateReleaseWorkflow(shadowed).some((failure) =>
			failure.includes("must not be bypassed"),
		),
	);

	const swallowedTrustedFailure = completeWorkflow.replace(
		'            command npm publish "${{ steps.pack.outputs.tarball }}" --access public\n',
		'            command npm publish "${{ steps.pack.outputs.tarball }}" --access public\n            return 0\n',
	);
	assert.ok(
		validateReleaseWorkflow(swallowedTrustedFailure).some((failure) =>
			failure.includes("must not be bypassed"),
		),
	);
});

test("rejects successful completion for an unsupported npm auth mode", () => {
	const acceptedTypo = completeWorkflow.replace(
		"              exit 1\n",
		"              exit 0\n",
	);
	assert.ok(
		validateReleaseWorkflow(acceptedTypo).some((failure) =>
			failure.includes("unsupported npm auth modes"),
		),
	);
});

test("rejects release creation before npm publication", () => {
	const releaseStep = "      - uses: softprops/action-gh-release@sha\n";
	const outOfOrder = completeWorkflow
		.replace(releaseStep, "")
		.replace("      - name: Publish to npm\n", `${releaseStep}      - name: Publish to npm\n`);
	assert.ok(
		validateReleaseWorkflow(outOfOrder).some((failure) =>
			failure.includes("before GitHub release"),
		),
	);
});

test("rejects a GitHub release detached from immutable prepare metadata", () => {
	const wrongTag = completeWorkflow.replace(
		"          tag_name: ${{ needs.prepare.outputs.release_tag }}",
		"          tag_name: main",
	);
	assert.ok(
		validateReleaseWorkflow(wrongTag).some((failure) =>
			failure.includes("tag and name must bind"),
		),
	);
});

test("rejects an additional GitHub release action with a different tag", () => {
	const duplicate = completeWorkflow.replace(
		"  post-publish-canary:\n",
		`      - uses: softprops/action-gh-release@sha
        with:
          tag_name: v999.0.0
          name: Wrong release
  post-publish-canary:
`,
	);
	assert.ok(
		validateReleaseWorkflow(duplicate).some((failure) =>
			failure.includes("exactly one GitHub release action"),
		),
	);
});

test("current release workflow satisfies the parsed contract", async () => {
	assert.deepEqual(await checkReleaseWorkflow(), []);
});

test("versioned browser asset is present in the release source tree", async () => {
	const html = await readFile(
		new URL("../packages/web/dist/index.html", import.meta.url),
		"utf8",
	);
	assert.match(html, /<!doctype html>/iu);
});
