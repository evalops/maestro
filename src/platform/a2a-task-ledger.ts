import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { A2AMessage, A2ATask } from "./a2a-client.js";
import { getEnvValue, trimString } from "./client.js";

export type A2ATaskKind = "delegation" | "message";
export type A2ATranscriptRole = "user" | "agent";

export interface A2ATaskTranscriptEntry {
	at: string;
	role: A2ATranscriptRole;
	text: string;
	state?: string;
	messageId?: string;
}

export interface A2ATaskLedgerEntry {
	id: string;
	kind: A2ATaskKind;
	peer: string;
	peerDisplayName?: string;
	taskId: string;
	contextId?: string;
	messageId?: string;
	text: string;
	role?: string;
	cwd?: string;
	state: string;
	responseText?: string;
	metadata?: Record<string, string | number | boolean>;
	transcript: A2ATaskTranscriptEntry[];
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface A2ATaskLedgerFile {
	tasks: A2ATaskLedgerEntry[];
}

export interface A2ATaskLedgerOptions {
	path?: string;
	now?: Date;
}

export interface RecordA2ATaskStartInput extends A2ATaskLedgerOptions {
	peer: string;
	peerDisplayName?: string;
	task: A2ATask;
	text: string;
	messageId?: string;
	contextId?: string;
	kind?: A2ATaskKind;
	role?: string;
	cwd?: string;
	metadata?: Record<string, string | number | boolean | undefined>;
}

export interface UpdateA2ATaskInput extends A2ATaskLedgerOptions {
	peer: string;
	task: A2ATask;
}

const TERMINAL_STATE_PATTERN =
	/(COMPLETED|FAILED|CANCELED|CANCELLED|REJECTED|INPUT_REQUIRED|AUTH_REQUIRED)/u;

export function getA2ATaskLedgerPath(path?: string): string {
	const configured =
		trimString(path) ??
		getEnvValue(["MAESTRO_A2A_TASKS_FILE", "CODEX_A2A_TASKS_FILE"]);
	if (configured) {
		return expandHome(configured);
	}
	return join(homedir(), ".maestro", "a2a", "tasks.json");
}

export async function loadA2ATaskLedger(
	options: A2ATaskLedgerOptions = {},
): Promise<A2ATaskLedgerFile> {
	const path = getA2ATaskLedgerPath(options.path);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (hasNodeCode(error, "ENOENT")) {
			return { tasks: [] };
		}
		throw error;
	}
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`A2A task ledger at ${path} must be a JSON object`);
	}
	const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
	return {
		tasks: tasks.map((task, index) =>
			normalizeLedgerEntry(task, `tasks[${index}]`),
		),
	};
}

export async function saveA2ATaskLedger(
	ledger: A2ATaskLedgerFile,
	options: A2ATaskLedgerOptions = {},
): Promise<string> {
	const path = getA2ATaskLedgerPath(options.path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(`${path}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(`${path}.tmp`, path);
	return path;
}

export async function recordA2ATaskStart(
	input: RecordA2ATaskStartInput,
): Promise<{ entry: A2ATaskLedgerEntry; path: string }> {
	const ledger = await loadA2ATaskLedger(input);
	const now = (input.now ?? new Date()).toISOString();
	const taskId = trimString(input.task.id) ?? fail("A2A task id is required");
	const existingIndex = ledger.tasks.findIndex(
		(entry) => entry.peer === input.peer && entry.taskId === taskId,
	);
	const metadata = cleanMetadata(input.metadata);
	const userText = input.text.trim();
	const entry: A2ATaskLedgerEntry = {
		...(existingIndex >= 0 ? ledger.tasks[existingIndex] : {}),
		id:
			existingIndex >= 0
				? ledger.tasks[existingIndex]!.id
				: `maestro-a2a-task-${randomUUID()}`,
		kind: input.kind ?? "delegation",
		peer: input.peer,
		...(input.peerDisplayName
			? { peerDisplayName: input.peerDisplayName }
			: {}),
		taskId,
		...(trimString(input.task.contextId ?? input.contextId)
			? { contextId: trimString(input.task.contextId ?? input.contextId) }
			: {}),
		...(trimString(input.messageId)
			? { messageId: trimString(input.messageId) }
			: {}),
		text: userText,
		...(trimString(input.role) ? { role: trimString(input.role) } : {}),
		...(trimString(input.cwd) ? { cwd: trimString(input.cwd) } : {}),
		state: input.task.status.state,
		...(metadata ? { metadata } : {}),
		transcript: [
			{
				at: now,
				role: "user",
				text: userText,
				...(trimString(input.messageId)
					? { messageId: trimString(input.messageId) }
					: {}),
			},
		],
		createdAt:
			existingIndex >= 0 ? ledger.tasks[existingIndex]!.createdAt : now,
		updatedAt: now,
	};
	const taskText = extractA2ATaskText(input.task);
	if (taskText) {
		entry.responseText = taskText;
		entry.transcript.push({
			at: now,
			role: "agent",
			text: taskText,
			state: input.task.status.state,
			messageId: input.task.status.message?.messageId,
		});
	}
	if (isTerminalA2AState(entry.state)) {
		entry.completedAt = now;
	}
	if (existingIndex >= 0) {
		ledger.tasks[existingIndex] = entry;
	} else {
		ledger.tasks.push(entry);
	}
	const path = await saveA2ATaskLedger(ledger, input);
	return { entry, path };
}

export async function updateA2ATaskInLedger(
	input: UpdateA2ATaskInput,
): Promise<{ entry: A2ATaskLedgerEntry | null; path: string }> {
	const ledger = await loadA2ATaskLedger(input);
	const taskId = trimString(input.task.id) ?? fail("A2A task id is required");
	const index = ledger.tasks.findIndex(
		(entry) => entry.peer === input.peer && entry.taskId === taskId,
	);
	const path = getA2ATaskLedgerPath(input.path);
	if (index < 0) {
		return { entry: null, path };
	}
	const now = (input.now ?? new Date()).toISOString();
	const previous = ledger.tasks[index]!;
	const responseText = extractA2ATaskText(input.task) ?? previous.responseText;
	const entry: A2ATaskLedgerEntry = {
		...previous,
		state: input.task.status.state,
		...(trimString(input.task.contextId)
			? { contextId: trimString(input.task.contextId) }
			: {}),
		...(responseText ? { responseText } : {}),
		updatedAt: now,
		...(isTerminalA2AState(input.task.status.state)
			? { completedAt: previous.completedAt ?? now }
			: {}),
	};
	if (
		responseText &&
		!entry.transcript.some(
			(item) => item.role === "agent" && item.text === responseText,
		)
	) {
		entry.transcript = [
			...entry.transcript,
			{
				at: now,
				role: "agent",
				text: responseText,
				state: input.task.status.state,
				messageId: input.task.status.message?.messageId,
			},
		];
	}
	ledger.tasks[index] = entry;
	await saveA2ATaskLedger(ledger, input);
	return { entry, path };
}

export function listA2ATaskEntries(
	ledger: A2ATaskLedgerFile,
	options: { peer?: string } = {},
): A2ATaskLedgerEntry[] {
	const peer = trimString(options.peer);
	return ledger.tasks
		.filter((entry) => !peer || entry.peer === peer)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function latestA2ATaskForPeer(
	ledger: A2ATaskLedgerFile,
	peer: string,
): A2ATaskLedgerEntry | undefined {
	return listA2ATaskEntries(ledger, { peer })[0];
}

export function extractA2ATaskText(task: A2ATask): string | undefined {
	return (
		firstMessageText(task.status.message) ??
		task.artifacts
			?.flatMap((artifact) => artifact.parts)
			.map((part) => trimString(part.text))
			.find((text): text is string => Boolean(text)) ??
		task.history
			?.filter(isAgentMessage)
			.map(firstMessageText)
			.find((text): text is string => Boolean(text))
	);
}

export function isTerminalA2AState(state: string): boolean {
	return TERMINAL_STATE_PATTERN.test(
		state.toUpperCase().replace(/[\s-]+/gu, "_"),
	);
}

function firstMessageText(message: A2AMessage | undefined): string | undefined {
	return message?.parts.map((part) => trimString(part.text)).find(Boolean);
}

function isAgentMessage(message: A2AMessage): boolean {
	const role = message.role.toUpperCase();
	return role === "ROLE_AGENT" || role === "AGENT";
}

function normalizeLedgerEntry(
	input: unknown,
	path: string,
): A2ATaskLedgerEntry {
	if (!isRecord(input)) {
		throw new Error(`A2A task ledger ${path} must be a JSON object`);
	}
	const id = requiredString(input.id, `${path}.id`);
	const peer = requiredString(input.peer, `${path}.peer`);
	const taskId = requiredString(input.taskId, `${path}.taskId`);
	const text = requiredString(input.text, `${path}.text`);
	const state = requiredString(input.state, `${path}.state`);
	const createdAt = requiredString(input.createdAt, `${path}.createdAt`);
	const updatedAt = requiredString(input.updatedAt, `${path}.updatedAt`);
	const transcript = Array.isArray(input.transcript)
		? input.transcript.map((item, index) =>
				normalizeTranscriptEntry(item, `${path}.transcript[${index}]`),
			)
		: [];
	const entry: A2ATaskLedgerEntry = {
		id,
		kind: input.kind === "message" ? "message" : "delegation",
		peer,
		taskId,
		text,
		state,
		transcript,
		createdAt,
		updatedAt,
	};
	for (const key of [
		"peerDisplayName",
		"contextId",
		"messageId",
		"role",
		"cwd",
		"responseText",
		"completedAt",
	] as const) {
		const value = stringValue(input[key]);
		if (value) {
			entry[key] = value;
		}
	}
	if (isRecord(input.metadata)) {
		entry.metadata = cleanMetadata(input.metadata);
	}
	return entry;
}

function normalizeTranscriptEntry(
	input: unknown,
	path: string,
): A2ATaskTranscriptEntry {
	if (!isRecord(input)) {
		throw new Error(`A2A task ledger ${path} must be a JSON object`);
	}
	const role = input.role === "agent" ? "agent" : "user";
	const entry: A2ATaskTranscriptEntry = {
		at: requiredString(input.at, `${path}.at`),
		role,
		text: requiredString(input.text, `${path}.text`),
	};
	for (const key of ["state", "messageId"] as const) {
		const value = stringValue(input[key]);
		if (value) {
			entry[key] = value;
		}
	}
	return entry;
}

function cleanMetadata(
	input: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> | undefined {
	if (!input) {
		return undefined;
	}
	const entries = Object.entries(input).filter(
		(entry): entry is [string, string | number | boolean] =>
			typeof entry[1] === "string" ||
			typeof entry[1] === "number" ||
			typeof entry[1] === "boolean",
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringValue(input: unknown): string | undefined {
	return typeof input === "string" ? trimString(input) : undefined;
}

function requiredString(input: unknown, path: string): string {
	const value = stringValue(input);
	if (!value) {
		throw new Error(`A2A task ledger ${path} is required`);
	}
	return value;
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/")
		? join(homedir(), path.slice(2))
		: path;
}

function hasNodeCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
	throw new Error(message);
}
