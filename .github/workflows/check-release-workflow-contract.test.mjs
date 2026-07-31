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
  group: \${{ github.workflow }}-\${{ github.event_name == 'workflow_dispatch' && (startsWith(inputs.version, 'v') && inputs.version || format('v{0}', inputs.version)) || github.ref_name }}
jobs:
  prepare:
    runs-on: \${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}
    permissions:
      contents: read
    outputs:
      package_name: \${{ steps.release.outputs.package_name }}
      release_sha: \${{ steps.release.outputs.release_sha }}
      release_tag: \${{ steps.release.outputs.release_tag }}
      release_version: \${{ steps.release.outputs.release_version }}
    steps:
      - uses: actions/checkout@sha
        with:
          fetch-depth: 1
      - id: release
        name: Resolve immutable release tag
        env:
          EVENT_NAME: \${{ github.event_name }}
          REQUESTED: \${{ github.event.inputs.version || github.ref_name }}
          TRIGGER_SHA: \${{ github.sha }}
        run: |
          release_sha="$TRIGGER_SHA"
          if [[ "$EVENT_NAME" == "workflow_dispatch" ]]; then
          for attempt in 1 2 3; do
            if timeout 60s git \\
              -c http.lowSpeedLimit=1000 \\
              -c http.lowSpeedTime=30 \\
              fetch --force --no-tags origin "refs/tags/\${release_tag}:refs/tags/\${release_tag}"; then
              break
            fi
            if [[ "$attempt" -eq 3 ]]; then
              exit 1
            fi
            sleep 2
          done
          release_sha="$(git rev-list -n 1 "$release_tag")"
          elif [[ "$EVENT_NAME" != "push" ]]; then
            exit 1
          fi
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
    runs-on: \${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}
    environment:
      name: npm-release
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@sha
        with:
          ref: ${releaseSha}
      - uses: actions/setup-node@sha
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - name: Verify native package inputs
        run: |
          set -euo pipefail
          test "$(node -p "require('./package.json').version")" = "$RELEASE_VERSION"
          test -f packages/web/dist/index.html
          npm run check:rust-only-runtime
      - name: Publish to npm
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
          PACKAGE_NAME: \${{ needs.prepare.outputs.package_name }}
          PACKED_INTEGRITY: \${{ steps.pack.outputs.integrity }}
          RELEASE_VERSION: \${{ needs.prepare.outputs.release_version }}
          TARBALL: \${{ steps.pack.outputs.tarball }}
          NPM_CONFIG_FETCH_RETRIES: "1"
          NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "2000"
          NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "1000"
          NPM_CONFIG_FETCH_TIMEOUT: "30000"
          NPM_CONFIG_REGISTRY: https://registry.npmjs.org
        run: |
          set -euo pipefail
          publish_with_oidc() {
            npx --yes npm@11.10.0 publish "\$TARBALL" --access public --registry "$NPM_CONFIG_REGISTRY"
          }
          publish_with_token() {
            if [[ -z "\${NODE_AUTH_TOKEN:-}" ]]; then
              return 1
            fi
            NPM_CONFIG_USERCONFIG="\$RUNNER_TEMP/npmrc" \\
              NODE_AUTH_TOKEN="\$NODE_AUTH_TOKEN" \\
              npx --yes npm@11.10.0 publish "\$TARBALL" --access public --registry "$NPM_CONFIG_REGISTRY"
          }
          verify_published_tarball() {
            registry_integrity="\$(
              command npm view "\${PACKAGE_NAME}@\${RELEASE_VERSION}" --registry "$NPM_CONFIG_REGISTRY" dist.integrity 2>/dev/null
            )" || return 1
            if [[ -z "\$registry_integrity" ]]; then
              return 1
            fi
            if [[ "\$registry_integrity" != "\$PACKED_INTEGRITY" ]]; then
              return 2
            fi
          }
          publish_or_verify() {
            local publisher="$1"
            local publish_status=0
            local registry_status=0
            "\$1" || publish_status=\$?
            if [[ "\$publish_status" -eq 0 ]]; then
              return 0
            fi
            verify_published_tarball || registry_status=\$?
            if [[ "\$registry_status" -eq 0 ]]; then
              return 0
            fi
            if [[ "\$registry_status" -eq 2 ]]; then
              return 2
            fi
            return "\$publish_status"
          }
          registry_status=0
          verify_published_tarball || registry_status=\$?
          if [[ "\$registry_status" -eq 0 ]]; then
            exit 0
          fi
          if [[ "\$registry_status" -eq 2 ]]; then
            exit 2
          fi
          if publish_or_verify publish_with_oidc; then
            exit 0
          fi
          publish_or_verify publish_with_token
      - name: Smoke packed package without JS runtime
        env:
          NPM_CONFIG_FETCH_RETRIES: "1"
          NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "2000"
          NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "1000"
          NPM_CONFIG_FETCH_TIMEOUT: "30000"
          NPM_CONFIG_REGISTRY: https://registry.npmjs.org
        run: node scripts/smoke-packed-cli.js package.tgz
      - uses: actions/upload-artifact@sha
        with:
          name: npm-tarball-\${{ needs.prepare.outputs.release_tag }}
          overwrite: true
          path: package.tgz
      - uses: actions/upload-artifact@sha
        with:
          name: release-web-dist-\${{ needs.prepare.outputs.release_tag }}
          overwrite: true
          path: maestro-web-dist.tar.gz
  github-release:
    needs: [prepare, binaries, publish]
    runs-on: \${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@sha
        with:
          ref: ${releaseSha}
      - uses: actions/download-artifact@sha
        with:
          name: npm-tarball-\${{ needs.prepare.outputs.release_tag }}
          path: release-assets
      - uses: actions/download-artifact@sha
        with:
          pattern: maestro-*
          path: release-assets
          merge-multiple: true
      - uses: actions/download-artifact@sha
        with:
          name: release-web-dist-\${{ needs.prepare.outputs.release_tag }}
          path: release-assets
      - name: Verify release tag has not moved
        env:
          EXPECTED_RELEASE_SHA: \${{ needs.prepare.outputs.release_sha }}
          RELEASE_TAG: \${{ needs.prepare.outputs.release_tag }}
        run: |
          for attempt in 1 2 3; do
            if timeout 60s git \\
              -c http.lowSpeedLimit=1000 \\
              -c http.lowSpeedTime=30 \\
              fetch --force --no-tags origin "refs/tags/\${RELEASE_TAG}:refs/tags/\${RELEASE_TAG}"; then
              break
            fi
            if [[ "$attempt" -eq 3 ]]; then
              exit 1
            fi
            sleep 2
          done
          current_release_sha="$(git rev-list -n 1 "$RELEASE_TAG")"
          if [[ "$current_release_sha" != "$EXPECTED_RELEASE_SHA" ]]; then
            exit 1
          fi
      - uses: softprops/action-gh-release@sha
        with:
          tag_name: \${{ needs.prepare.outputs.release_tag }}
          target_commitish: \${{ needs.prepare.outputs.release_sha }}
          name: Maestro \${{ needs.prepare.outputs.release_version }}
          files: release-assets/*
  post-publish-canary:
    needs:
      - prepare
      - publish
    runs-on: \${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@sha
        with:
          ref: ${releaseSha}
      - uses: actions/setup-node@sha
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - name: Verify published package from npm
        env:
          NPM_CONFIG_FETCH_RETRIES: "1"
          NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "2000"
          NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "1000"
          NPM_CONFIG_FETCH_TIMEOUT: "30000"
          NPM_CONFIG_REGISTRY: https://registry.npmjs.org
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
      - name: Upload published replay evidence
        uses: actions/upload-artifact@sha
        with:
          name: published-replay-evidence-\${{ needs.prepare.outputs.release_tag }}
          overwrite: true
          path: published-replay-evidence/*.json
`;

test("accepts mapping-form environment and the complete release contract", () => {
	assert.deepEqual(validateReleaseWorkflow(completeWorkflow), []);
});

test("rejects dormant npm publish helpers", () => {
	const dormant = completeWorkflow.replace(
		"          publish_or_verify publish_with_token\n",
		"          true\n",
	);
	assert.ok(
		validateReleaseWorkflow(dormant).some((failure) =>
			failure.includes("token-backed npm publication"),
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
		.replace(
			"  publish:\n    needs: [prepare, binaries]\n    runs-on: ${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}\n    environment:\n      name: npm-release\n    permissions:\n      contents: read\n      id-token: write\n",
			"  publish:\n    needs: [prepare, binaries]\n    runs-on: ${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}\n    environment:\n      name: npm-release\n    permissions:\n      # contents: read\n      id-token: write\n",
		)
		.replace("    environment:\n      name: npm-release\n", "    # environment: npm-release\n")
		.replace("      - publish\n", "      # - publish # needs: publish\n");
	const failures = validateReleaseWorkflow(spoofed);
	assert.ok(failures.some((failure) => failure.includes("npm-release environment")));
	assert.ok(failures.some((failure) => failure.includes("publish permissions")));
	assert.ok(failures.some((failure) => failure.includes("must need prepare and publish")));
});

test("rejects broad build permissions and non-serialized releases", () => {
	const broadened = completeWorkflow
		.replace("permissions:\n  contents: read\n", "permissions:\n  contents: write\n")
		.replace(
			"  group: ${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && (startsWith(inputs.version, 'v') && inputs.version || format('v{0}', inputs.version)) || github.ref_name }}\n",
			"  group: ${{ github.workflow }}\n",
		)
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

test("rejects publish checkout without contents read", () => {
	const unreadablePublish = completeWorkflow.replace(
		"  publish:\n    needs: [prepare, binaries]\n    runs-on: ${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}\n    environment:\n      name: npm-release\n    permissions:\n      contents: read\n      id-token: write\n",
		"  publish:\n    needs: [prepare, binaries]\n    runs-on: ${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}\n    environment:\n      name: npm-release\n    permissions:\n      id-token: write\n",
	);
	assert.ok(
		validateReleaseWorkflow(unreadablePublish).some((failure) =>
			failure.includes("publish permissions"),
		),
	);
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

test("rejects a full-history prepare checkout before bounded tag resolution", () => {
	const fullHistory = completeWorkflow.replace(
		"          fetch-depth: 1\n",
		"          fetch-depth: 0\n",
	);
	assert.ok(
		validateReleaseWorkflow(fullHistory).some((failure) =>
			failure.includes("prepare checkout must be shallow"),
		),
	);
});

test("rejects tag-push source replacement with a freshly resolved tag", () => {
	const movedTag = completeWorkflow
		.replace('          release_sha="$TRIGGER_SHA"\n', "")
		.replace(
			'          if [[ "$EVENT_NAME" == "workflow_dispatch" ]]; then\n',
			"",
		)
		.replace(
			'          elif [[ "$EVENT_NAME" != "push" ]]; then\n            exit 1\n          fi\n',
			"",
		);
	assert.ok(
		validateReleaseWorkflow(movedTag).some((failure) =>
			failure.includes("tag pushes must preserve the triggering SHA"),
		),
	);
});

test("rejects an unbound triggering event or SHA", () => {
	const reboundTrigger = completeWorkflow.replace(
		"          TRIGGER_SHA: ${{ github.sha }}",
		"          TRIGGER_SHA: ${{ github.ref_name }}",
	);
	assert.ok(
		validateReleaseWorkflow(reboundTrigger).some((failure) =>
			failure.includes("bind the triggering event and SHA"),
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

	const dormantBranch = completeWorkflow.replace(
		"          publish_or_verify publish_with_token\n",
		"          if false; then\n            publish_or_verify publish_with_token\n          fi\n",
	);
	assert.ok(
		validateReleaseWorkflow(dormantBranch).some((failure) =>
			failure.includes("token-backed npm publication"),
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

test("rejects unauthorized early success or a shell function that shadows npm", () => {
	const earlyExit = completeWorkflow.replace(
		"          publish_or_verify publish_with_token\n",
		"          exit 0\n          publish_or_verify publish_with_token\n",
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

	const swallowedTokenFailure = completeWorkflow.replace(
		'            npx --yes npm@11.10.0 publish "$TARBALL" --access public --registry "$NPM_CONFIG_REGISTRY"\n',
		'            npx --yes npm@11.10.0 publish "$TARBALL" --access public --registry "$NPM_CONFIG_REGISTRY"\n            return 0\n',
	);
	assert.ok(
		validateReleaseWorkflow(swallowedTokenFailure).some((failure) =>
			failure.includes("reconcile the exact registry tarball"),
		),
	);
});

test("requires exact registry reconciliation after errors and on reruns", () => {
	const noPreflight = completeWorkflow.replace(
		"          registry_status=0\n          verify_published_tarball || registry_status=$?\n",
		"          registry_status=0\n          false || registry_status=$?\n",
	);
	assert.ok(
		validateReleaseWorkflow(noPreflight).some((failure) =>
			failure.includes("must not be bypassed"),
		),
	);

	const noErrorRecovery = completeWorkflow.replace(
		'            fi\n            verify_published_tarball || registry_status=$?\n            if [[ "$registry_status" -eq 0 ]]; then\n',
		'            fi\n            false || registry_status=$?\n            if [[ "$registry_status" -eq 0 ]]; then\n',
	);
	assert.ok(
		validateReleaseWorkflow(noErrorRecovery).some((failure) =>
			failure.includes("reconcile the exact registry tarball"),
		),
	);

	const noIntegrityBinding = completeWorkflow.replace(
		"          PACKED_INTEGRITY: \${{ steps.pack.outputs.integrity }}\n",
		"",
	);
	assert.ok(
		validateReleaseWorkflow(noIntegrityBinding).some((failure) =>
			failure.includes("exact package identity"),
		),
	);
});

test("rejects npm publication or reconciliation without the public registry", () => {
	const inheritedRegistry = completeWorkflow.replaceAll(
		' --registry "$NPM_CONFIG_REGISTRY"',
		"",
	);
	assert.ok(
		validateReleaseWorkflow(inheritedRegistry).some((failure) =>
			failure.includes("exact unswallowed npm publish commands"),
		),
	);

	const unboundRegistry = completeWorkflow.replaceAll(
		"          NPM_CONFIG_REGISTRY: https://registry.npmjs.org\n",
		"",
	);
	assert.ok(
		validateReleaseWorkflow(unboundRegistry).some((failure) =>
			failure.includes("bounded npm network configuration"),
		),
	);

	const setupRegistryMissing = completeWorkflow.replaceAll(
		"          registry-url: https://registry.npmjs.org\n",
		"",
	);
	assert.ok(
		validateReleaseWorkflow(setupRegistryMissing).some((failure) =>
			failure.includes("pin setup-node to the public npm registry"),
		),
	);
});

test("rejects removing the token-backed publish fallback", () => {
	const trusted = completeWorkflow.replace(
		"          publish_with_token() {\n",
		"          publish_with_trusted_publisher() {\n",
	);
	assert.ok(
		validateReleaseWorkflow(trusted).some((failure) =>
			failure.includes("token-backed npm publication"),
		),
	);
});

test("rejects a GitHub release job without npm publication dependency", () => {
	const outOfOrder = completeWorkflow.replace(
		"    needs: [prepare, binaries, publish]\n",
		"    needs: [prepare, binaries]\n",
	);
	assert.ok(
		validateReleaseWorkflow(outOfOrder).some((failure) =>
			failure.includes("github-release must need"),
		),
	);
});

test("rejects an unbounded immutable tag fetch", () => {
	const unbounded = completeWorkflow.replace(
		`          for attempt in 1 2 3; do
            if timeout 60s git \\
              -c http.lowSpeedLimit=1000 \\
              -c http.lowSpeedTime=30 \\
              fetch --force --no-tags origin "refs/tags/\${release_tag}:refs/tags/\${release_tag}"; then
              break
            fi
            if [[ "$attempt" -eq 3 ]]; then
              exit 1
            fi
            sleep 2
          done
`,
		`          git fetch --force --no-tags origin "refs/tags/\${release_tag}:refs/tags/\${release_tag}"
`,
	);
	assert.ok(
		validateReleaseWorkflow(unbounded).some((failure) =>
			failure.includes("bounded retries"),
		),
	);
});

test("rejects release control jobs outside the public release runner", () => {
	const wrongRunner = completeWorkflow.replace(
		"    runs-on: ${{ vars.PUBLIC_RELEASE_RUNNER || 'ubuntu-latest' }}",
		"    runs-on: ubuntu-latest",
	);
	assert.ok(
		validateReleaseWorkflow(wrongRunner).some((failure) =>
			failure.includes("must run on PUBLIC_RELEASE_RUNNER"),
		),
	);
});

test("rejects unbounded npm registry calls in publish and canary", () => {
	const unboundedPublish = completeWorkflow.replace(
		'          NPM_CONFIG_FETCH_TIMEOUT: "30000"\n          NPM_CONFIG_REGISTRY: https://registry.npmjs.org\n',
		'          NPM_CONFIG_REGISTRY: https://registry.npmjs.org\n',
	);
	assert.ok(
		validateReleaseWorkflow(unboundedPublish).some((failure) =>
			failure.includes("publish must set bounded npm network configuration"),
		),
	);

	const lastTimeout = completeWorkflow.lastIndexOf(
		'          NPM_CONFIG_FETCH_TIMEOUT: "30000"\n',
	);
	const unboundedCanary =
		completeWorkflow.slice(0, lastTimeout) +
		completeWorkflow
			.slice(lastTimeout)
			.replace('          NPM_CONFIG_FETCH_TIMEOUT: "30000"\n', "");
	assert.ok(
		validateReleaseWorkflow(unboundedCanary).some((failure) =>
			failure.includes(
				"post-publish canary must set bounded npm network configuration",
			),
		),
	);

	const smokeName = "      - name: Smoke packed package without JS runtime\n";
	const smokeStart = completeWorkflow.indexOf(smokeName);
	const unboundedSmoke =
		completeWorkflow.slice(0, smokeStart) +
		completeWorkflow
			.slice(smokeStart)
			.replace('          NPM_CONFIG_FETCH_TIMEOUT: "30000"\n', "");
	assert.ok(
		validateReleaseWorkflow(unboundedSmoke).some((failure) =>
			failure.includes(
				"packed-package smoke must set bounded npm network configuration",
			),
		),
	);
});

test("rejects a non-retryable or incomplete GitHub release job", () => {
	const inPublish = completeWorkflow
		.replace(
			`      - uses: softprops/action-gh-release@sha
        with:
          tag_name: \${{ needs.prepare.outputs.release_tag }}
          target_commitish: \${{ needs.prepare.outputs.release_sha }}
          name: Maestro \${{ needs.prepare.outputs.release_version }}
          files: release-assets/*
`,
			"",
		)
		.replace(
			"      - name: Publish to npm\n",
			`      - uses: softprops/action-gh-release@sha
        with:
          tag_name: \${{ needs.prepare.outputs.release_tag }}
          target_commitish: \${{ needs.prepare.outputs.release_sha }}
          name: Maestro \${{ needs.prepare.outputs.release_version }}
          files: release-assets/*
      - name: Publish to npm
`,
		);
	assert.ok(
		validateReleaseWorkflow(inPublish).some((failure) =>
			failure.includes("retryable github-release job"),
		),
	);

	const missingArtifact = completeWorkflow.replace(
		"          name: release-web-dist-${{ needs.prepare.outputs.release_tag }}",
		"          name: wrong-web-artifact",
	);
	assert.ok(
		validateReleaseWorkflow(missingArtifact).some((failure) =>
			failure.includes("retryable artifact") ||
			failure.includes("exact immutable release artifacts"),
		),
	);

	const nonReplaceableArtifact = completeWorkflow.replace(
		"          overwrite: true\n          path: package.tgz",
		"          path: package.tgz",
	);
	assert.ok(
		validateReleaseWorkflow(nonReplaceableArtifact).some((failure) =>
			failure.includes("persist retryable artifact"),
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
			failure.includes("metadata and files must bind"),
		),
	);
});

test("rejects GitHub release creation after a moved tag", () => {
	const noTagCheck = completeWorkflow.replace(
		'          if [[ "$current_release_sha" != "$EXPECTED_RELEASE_SHA" ]]; then\n',
		'          if [[ "$current_release_sha" == "$EXPECTED_RELEASE_SHA" ]]; then\n',
	);
	assert.ok(
		validateReleaseWorkflow(noTagCheck).some((failure) =>
			failure.includes("fail closed if the release tag moved"),
		),
	);

	const unboundTagCheck = completeWorkflow.replace(
		"          EXPECTED_RELEASE_SHA: ${{ needs.prepare.outputs.release_sha }}",
		"          EXPECTED_RELEASE_SHA: ${{ github.sha }}",
	);
	assert.ok(
		validateReleaseWorkflow(unboundTagCheck).some((failure) =>
			failure.includes("verify the current tag immediately"),
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

test("rejects non-replaceable post-publish replay evidence", () => {
	const nonReplaceable = completeWorkflow.replace(
		"          name: published-replay-evidence-${{ needs.prepare.outputs.release_tag }}\n          overwrite: true\n",
		"          name: published-replay-evidence-${{ needs.prepare.outputs.release_tag }}\n",
	);
	assert.ok(
		validateReleaseWorkflow(nonReplaceable).some((failure) =>
			failure.includes("replace exact-tag replay evidence"),
		),
	);
});

test("current release workflow satisfies the parsed contract", async () => {
	assert.deepEqual(await checkReleaseWorkflow(), []);
});

test("required actionlint lane runs the version workflow regression suite", async () => {
	const actionlintWorkflow = await readFile(
		new URL("./actionlint.yml", import.meta.url),
		"utf8",
	);
	assert.match(
		actionlintWorkflow,
		/name: Run release workflow contract tests[\s\S]*?node --test scripts\/version\.test\.mjs/u,
	);
});

test("versioned browser asset is present in the release source tree", async () => {
	const html = await readFile(
		new URL("../../packages/web/dist/index.html", import.meta.url),
		"utf8",
	);
	assert.match(html, /<!doctype html>/iu);
});
