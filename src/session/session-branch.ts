/**
 * Session Branching
 * Pure functions for creating branched session files from an existing session.
 */

import { appendFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { AgentState } from "../agent/types.js";
import type { SessionModelMetadata } from "./metadata-cache.js";
import { generateEntryId } from "./session-context.js";
import type { SessionContextSnapshot } from "./session-context.js";
import type {
	LabelEntry,
	SessionHeaderEntry,
	SessionMessageEntry,
	SessionTreeEntry,
} from "./types.js";
import { CURRENT_SESSION_VERSION } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BranchFromLeafContext {
	sessionDir: string;
	sessionId: string;
	sessionFile: string;
	branch: SessionTreeEntry[];
	context: SessionContextSnapshot;
	header: SessionHeaderEntry | null;
	labelsById: Map<string, string>;
}

export interface BranchFromStateContext {
	sessionDir: string;
	sessionId: string;
	sessionFile: string;
	lastModelMetadata?: SessionModelMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch Creation
// ─────────────────────────────────────────────────────────────────────────────

export function createBranchedSessionFromLeaf(
	leafId: string,
	ctx: BranchFromLeafContext,
): string {
	const path = ctx.branch;
	if (path.length === 0) {
		throw new Error(`Entry ${leafId} not found`);
	}

	const pathWithoutLabels = path.filter((e) => e.type !== "label");
	const newSessionId = uuidv4();
	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const newSessionFile = join(
		ctx.sessionDir,
		`${fileTimestamp}_${newSessionId}.jsonl`,
	);

	const header: SessionHeaderEntry = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: newSessionId,
		timestamp,
		cwd: process.cwd(),
		model: ctx.context.model ?? ctx.header?.model,
		modelMetadata: ctx.context.modelMetadata ?? ctx.header?.modelMetadata,
		thinkingLevel: ctx.context.thinkingLevel,
		systemPrompt: ctx.header?.systemPrompt,
		promptMetadata: ctx.header?.promptMetadata,
		tools: ctx.header?.tools,
		branchedFrom: ctx.sessionFile,
		parentSession: ctx.sessionId,
	};

	const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
	const labelsToWrite: Array<{ targetId: string; label: string }> = [];
	for (const [targetId, label] of ctx.labelsById) {
		if (pathEntryIds.has(targetId)) {
			labelsToWrite.push({ targetId, label });
		}
	}

	appendFileSync(newSessionFile, `${JSON.stringify(header)}\n`);
	for (const entry of pathWithoutLabels) {
		appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
	}
	let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id ?? null;
	for (const { targetId, label } of labelsToWrite) {
		const labelEntry: LabelEntry = {
			type: "label",
			id: generateEntryId(pathEntryIds),
			parentId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		appendFileSync(newSessionFile, `${JSON.stringify(labelEntry)}\n`);
		pathEntryIds.add(labelEntry.id);
		parentId = labelEntry.id;
	}

	return newSessionFile;
}

export function createBranchedSessionFromState(
	state: AgentState,
	branchFromIndex: number,
	ctx: BranchFromStateContext,
): string {
	if (branchFromIndex < 0 || branchFromIndex > state.messages.length) {
		throw new Error(
			`Invalid branchFromIndex: ${branchFromIndex}. Must be between 0 and ${state.messages.length}`,
		);
	}

	const newSessionId = uuidv4();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const newSessionFile = join(
		ctx.sessionDir,
		`${timestamp}_${newSessionId}.jsonl`,
	);
	const tempFile = `${newSessionFile}.tmp`;

	try {
		const modelKey = state.model
			? `${state.model.provider}/${state.model.id}`
			: "unknown/unknown";
		const entry: SessionHeaderEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			model: modelKey,
			modelMetadata: ctx.lastModelMetadata,
			thinkingLevel: state.thinkingLevel,
			systemPrompt: state.systemPrompt,
			promptMetadata: state.promptMetadata,
			branchedFrom: ctx.sessionFile,
			parentSession: ctx.sessionId,
		};
		appendFileSync(tempFile, `${JSON.stringify(entry)}\n`);

		let parentId: string | null = null;
		if (branchFromIndex > 0) {
			const messagesToWrite = state.messages.slice(0, branchFromIndex);
			const ids = new Set<string>();
			for (const message of messagesToWrite) {
				const messageEntry: SessionMessageEntry = {
					type: "message",
					id: generateEntryId(ids),
					parentId,
					timestamp: new Date().toISOString(),
					message,
				};
				ids.add(messageEntry.id);
				parentId = messageEntry.id;
				appendFileSync(tempFile, `${JSON.stringify(messageEntry)}\n`);
			}
		}

		renameSync(tempFile, newSessionFile);
	} catch (error) {
		try {
			if (existsSync(tempFile)) {
				unlinkSync(tempFile);
			}
		} catch (_cleanupError) {
			// Ignore cleanup errors
		}
		throw error;
	}

	return newSessionFile;
}
