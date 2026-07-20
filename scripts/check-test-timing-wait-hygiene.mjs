#!/usr/bin/env node
// @ts-check

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REQUIRED_ISSUE = "evalops/maestro-internal#2582";

const ALLOWLISTED_TIMING_WAIT_FILES = new Set([
	"packages/slack-agent/test/agent-runner.test.ts",
	"packages/slack-agent/test/api-queue.test.ts",
	"packages/slack-agent/test/approval.test.ts",
	"packages/slack-agent/test/bot.test.ts",
	"packages/slack-agent/test/graceful-shutdown.test.ts",
	"packages/slack-agent/test/health-check.test.ts",
	"packages/slack-agent/test/integration-resilience.test.ts",
	"packages/slack-agent/test/logger.test.ts",
	"packages/slack-agent/test/metrics.test.ts",
	"packages/slack-agent/test/response-state.test.ts",
	"packages/slack-agent/test/sandbox.test.ts",
	"packages/slack-agent/test/scheduler.test.ts",
	"packages/slack-agent/test/typed-emitter.test.ts",
	"packages/web/src/components/admin-audit-tab.test.ts",
	"packages/web/src/components/admin-directories-tab.test.ts",
	"packages/web/src/components/admin-models-tab.test.ts",
	"packages/web/src/components/admin-policy-tab.test.ts",
	"packages/web/src/components/admin-security-tab.test.ts",
	"packages/web/src/components/admin-users-tab.test.ts",
	"packages/web/src/components/composer-input.test.ts",
	"packages/web/src/components/composer-settings.test.ts",
	"packages/web/src/components/fleet-dashboard.test.ts",
	"packages/github-agent/src/orchestrator.test.ts",
	"test/agent/action-approval-timing.test.ts",
	"test/agent/auto-retry.test.ts",
	"test/agent/context-manager.test.ts",
	"test/agent/mcp-manager-transports.test.ts",
	"test/agent/provider-transport-parallelism-gated.test.ts",
	"test/agent/provider-transport-provider-tools.test.ts",
	"test/agent/provider-transport-tool-concurrency.test.ts",
	"test/agent/swarm-executor.test.ts",
	"test/agent/tool-execution-retry.test.ts",
	"test/agent/tool-safety-pipeline-approval-telemetry.test.ts",
	"test/agent/workflow-state-integration.test.ts",
	"test/app-server/host-control-api.test.ts",
	"test/cli/cli.integration.test.ts",
	"test/cli/headless-runtime.test.ts",
	"test/codex/app-server-client.test.ts",
	"test/config/feature-flags.test.ts",
	"test/config/network-config.test.ts",
	"test/config/stream-idle-timeout.test.ts",
	"test/desktop/api-client.test.ts",
	"test/desktop/automations-view-ui.test.tsx",
	"test/desktop/input-area-ui.test.tsx",
	"test/desktop/memory-section-ui.test.tsx",
	"test/desktop/tools-runtime-section-ui.test.tsx",
	"test/desktop/use-chat-runtime-status.test.ts",
	"test/document-extractor.test.ts",
	"test/extension-tool-registration.test.ts",
	"test/headless/runtime-conformance.test.ts",
	"test/integration/security-pipeline.test.ts",
	"test/lsp/lsp-integration.test.ts",
	"test/lsp/lsp-manager.test.ts",
	"test/oauth-device-identity-timeout.test.ts",
	"test/packages/core/consumer-integration.test.ts",
	"test/packages/core/cross-module-contracts.test.ts",
	"test/packages/core/restart-policy.test.ts",
	"test/packages/maestro-packages.test.ts",
	"test/safety/adaptive-thresholds.test.ts",
	"test/safety/circuit-breaker.test.ts",
	"test/safety/edge-cases.test.ts",
	"test/safety/loop-detector.test.ts",
	"test/scripts/codex-a2a-peer.test.ts",
	"test/scripts/native-host-browser-control.test.ts",
	"test/scripts/run-command-with-heartbeat.test.ts",
	"test/scripts/run-vitest.test.ts",
	"test/server/approval-service.test.ts",
	"test/server/hosted-agent-runtime-progress.test.ts",
	"test/server/hosted-session-export.test.ts",
	"test/services/usage-analytics.test.ts",
	"test/session-endpoints.test.ts",
	"test/session/fresh-exec-session-manager.test.ts",
	"test/session/session-manager.test.ts",
	"test/shared-session-attachments-endpoints.test.ts",
	"test/slack-agent/retry-logic.test.ts",
	"test/telemetry/agent-workforce-native-event-client.test.ts",
	"test/telemetry/maestro-event-bus.test.ts",
	"test/tools/background-task-types.test.ts",
	"test/tools/background-tasks.test.ts",
	"test/tools/bash.test.ts",
	"test/tools/file-watcher.test.ts",
	"test/tools/inline-tools.test.ts",
	"test/tools/oracle.test.ts",
	"test/tools/process-tree.test.ts",
	"test/tools/restart-policy.test.ts",
	"test/tools/tool-dsl.test.ts",
	"test/tools/webfetch.test.ts",
	"test/utils/async.test.ts",
	"test/utils/clock.test.ts",
	"test/utils/downstream-http.test.ts",
	"test/utils/fetch-with-pinned-address.test.ts",
	"test/web/chat-handler.test.ts",
	"test/web/composer-chat-approval-queue.test.ts",
	"test/web/composer-chat-session-pending-requests.test.ts",
	"test/web/composer-chat-tool-retry-queue.test.ts",
	"test/web/composer-chat-user-input-queue.test.ts",
]);

const TIMING_WAIT_PATTERN = /\b(setTimeout|sleep\(|delayMs)\b/;
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|mjs)$/;
const ROOTS = ["test", "packages"];
const failures = [];
const seenAllowlistedFiles = new Set();

function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const relativePath = normalizePath(relative(process.cwd(), path));
		if (
			relativePath === "packages/vscode-extension/media/vendor.js" ||
			relativePath.includes("/node_modules/") ||
			relativePath.includes("/dist/")
		) {
			continue;
		}

		const stats = statSync(path);
		if (stats.isDirectory()) {
			walk(path);
			continue;
		}

		if (!TEST_FILE_PATTERN.test(relativePath)) {
			continue;
		}

		const source = readFileSync(path, "utf8");
		if (!TIMING_WAIT_PATTERN.test(source)) {
			continue;
		}

		if (!ALLOWLISTED_TIMING_WAIT_FILES.has(relativePath)) {
			failures.push(
				`${relativePath} uses timing waits but is not allowlisted for ${REQUIRED_ISSUE}`,
			);
			continue;
		}
		seenAllowlistedFiles.add(relativePath);
	}
}

function normalizePath(path) {
	return path.split(sep).join("/");
}

for (const root of ROOTS) {
	walk(join(process.cwd(), root));
}

for (const file of ALLOWLISTED_TIMING_WAIT_FILES) {
	if (!seenAllowlistedFiles.has(file)) {
		failures.push(`${file} is allowlisted for ${REQUIRED_ISSUE} but no longer uses timing waits`);
	}
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(failure);
	}
	process.exit(1);
}

console.log(
	`Test timing wait hygiene passed (${ALLOWLISTED_TIMING_WAIT_FILES.size} files allowlisted for ${REQUIRED_ISSUE}).`,
);
