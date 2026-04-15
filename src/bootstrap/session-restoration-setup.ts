/**
 * Session Restoration Setup - Restore previous session state and gather startup info.
 *
 * Extracts session restoration from main.ts Phase 13:
 * message/model/thinking-level restoration, context file logging,
 * changelog summary, and update check.
 *
 * @module bootstrap/session-restoration-setup
 */

import chalk from "chalk";
import type { Agent, ThinkingLevel } from "../agent/index.js";
import { loadProjectContextFiles } from "../cli/system-prompt.js";
import type { RegisteredModel } from "../models/registry.js";
import { resolveModel } from "../models/registry.js";
import { resolveModelScope } from "../models/scope.js";
import { isKnownProvider } from "../providers/api-keys.js";
import type { SessionManager } from "../session/manager.js";
import {
	formatChangelogVersion,
	getChangelogPath,
	getLatestEntry,
	getNewEntries,
	isChangelogHiddenFromEnv,
	parseChangelog,
	readLastShownChangelogVersion,
	summarizeChangelogEntry,
	writeLastShownChangelogVersion,
} from "../update/changelog.js";
import { type UpdateCheckResult, checkForUpdate } from "../update/check.js";

export interface SessionRestorationResult {
	startupChangelogSummary: string | null;
	updateNotice: UpdateCheckResult | null;
	scopedModels: RegisteredModel[];
}

/**
 * Restore session state, log context files, compute changelog summary,
 * and check for updates.
 */
export async function restoreSessionState(params: {
	agent: Agent;
	sessionManager: SessionManager;
	shouldRestoreSession: boolean;
	isContinueOrResume: boolean;
	shouldPrintMessages: boolean;
	isFreshInteractiveSession: boolean;
	version: string;
	models?: string[];
}): Promise<SessionRestorationResult> {
	const {
		agent,
		sessionManager,
		shouldRestoreSession,
		isContinueOrResume,
		shouldPrintMessages,
		isFreshInteractiveSession,
		version,
		models,
	} = params;

	// ── Session restoration ──────────────────────────────────────────────────

	if (shouldRestoreSession) {
		const messages = sessionManager.loadMessages();
		if (messages.length > 0) {
			if (shouldPrintMessages) {
				console.log(
					chalk.dim(`Loaded ${messages.length} messages from previous session`),
				);
			}
			agent.replaceMessages(messages);
		}

		// Restore model
		const savedModel = sessionManager.loadModel();
		if (savedModel) {
			const [savedProvider, savedModelId] = savedModel.split("/");
			if (savedProvider && savedModelId && isKnownProvider(savedProvider)) {
				try {
					const restoredModel = resolveModel(savedProvider, savedModelId);
					if (restoredModel) {
						agent.setModel(restoredModel);
					}
					if (shouldPrintMessages) {
						console.log(chalk.dim(`Restored model: ${savedModel}`));
					}
				} catch (error: unknown) {
					if (shouldPrintMessages) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error(
							chalk.yellow(
								`Warning: Could not restore model ${savedModel}: ${message}`,
							),
						);
					}
				}
			} else if (shouldPrintMessages) {
				console.error(
					chalk.yellow(
						`Warning: Could not restore model ${savedModel}: unknown provider`,
					),
				);
			}
		}

		// Restore thinking level
		const thinkingLevel = sessionManager.loadThinkingLevel() as ThinkingLevel;
		if (thinkingLevel) {
			agent.setThinkingLevel(thinkingLevel);
			if (shouldPrintMessages) {
				console.log(chalk.dim(`Restored thinking level: ${thinkingLevel}`));
			}
		}
	}

	// ── Context file logging ─────────────────────────────────────────────────

	if (shouldPrintMessages && !isContinueOrResume) {
		const contextFiles = loadProjectContextFiles();
		if (contextFiles.length > 0) {
			console.log(chalk.dim("Loaded project context from:"));
			for (const { path: filePath } of contextFiles) {
				console.log(chalk.dim(`  - ${filePath}`));
			}
		}
	}

	// ── Model scoping ────────────────────────────────────────────────────────

	let scopedModels: RegisteredModel[] = [];
	if (models && models.length > 0) {
		scopedModels = resolveModelScope(models);
		if (scopedModels.length === 0 && shouldPrintMessages) {
			console.log(
				chalk.yellow(
					`Warning: --models patterns (${models.join(", ")}) did not match any registered models`,
				),
			);
		}
	}

	// ── Changelog summary ────────────────────────────────────────────────────

	let startupChangelogSummary: string | null = null;
	let latestEntryVersion: string | null = null;
	if (isFreshInteractiveSession && !isChangelogHiddenFromEnv()) {
		const changelogEntries = parseChangelog(getChangelogPath());
		const lastVersion = readLastShownChangelogVersion();
		const latestEntry = lastVersion
			? getLatestEntry(getNewEntries(changelogEntries, lastVersion))
			: getLatestEntry(changelogEntries);
		if (latestEntry) {
			const versionLabel = formatChangelogVersion(latestEntry);
			const summaryLine = summarizeChangelogEntry(latestEntry);
			startupChangelogSummary = summaryLine
				? `v${versionLabel} — ${summaryLine}`
				: `v${versionLabel}`;
			latestEntryVersion = versionLabel;
		}
		if (latestEntryVersion) {
			writeLastShownChangelogVersion(latestEntryVersion);
		}
	}

	// ── Update check ─────────────────────────────────────────────────────────

	let updateNotice: UpdateCheckResult | null = null;
	if (isFreshInteractiveSession) {
		try {
			updateNotice = await Promise.race([
				checkForUpdate(version),
				new Promise<UpdateCheckResult | null>((resolve) =>
					setTimeout(() => resolve(null), 1_000),
				),
			]);
		} catch {
			updateNotice = null;
		}
		if (updateNotice && !updateNotice.isUpdateAvailable) {
			updateNotice = null;
		}
	}

	return { startupChangelogSummary, updateNotice, scopedModels };
}
