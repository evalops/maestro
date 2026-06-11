import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSessionEntry } from "../src/session/types.js";

interface SessionWireManifest {
	sessionHeaderFields: string[];
	fieldAliases: {
		session?: Record<string, string>;
	};
}

const root = process.cwd();

function assert(condition: unknown, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

function camelToSnake(value: string): string {
	return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function extractTsInterfaceBody(source: string, name: string): string {
	const marker = `export interface ${name} {`;
	const start = source.indexOf(marker);
	assert(start >= 0, `Missing TypeScript interface ${name}`);
	const bodyStart = start + marker.length;
	let depth = 1;
	for (let index = bodyStart; index < source.length; index++) {
		const char = source[index];
		if (char === "{") depth++;
		if (char === "}") depth--;
		if (depth === 0) return source.slice(bodyStart, index);
	}
	throw new Error(`Could not parse TypeScript interface ${name}`);
}

function rustFieldWindow(rustEntries: string, fieldName: string): string {
	const pattern = new RegExp(`\\bpub\\s+${fieldName}\\s*:`, "u");
	const match = pattern.exec(rustEntries);
	assert(match, `Rust SessionHeader missing field ${fieldName}`);
	const before = rustEntries.slice(0, match.index);
	const lines = before.split("\n").slice(-12);
	return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractToolCallIds(content: unknown): string[] {
	if (!Array.isArray(content)) {
		return [];
	}
	return content
		.filter(
			(block): block is { type: string; id: string } =>
				isRecord(block) && block.type === "toolCall" && typeof block.id === "string",
		)
		.map((block) => block.id);
}

export function validateSessionToolResultCompleteness(
	content: string,
	label: string,
): void {
	const toolCalls = new Set<string>();
	const toolResults = new Set<string>();
	const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);

	for (const [index, line] of lines.entries()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`${label}:${index + 1} is not valid JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		const entry = normalizeSessionEntry(parsed);
		if (!entry || entry.type !== "message") {
			continue;
		}
		const message = entry.message;
		if (message.role === "assistant") {
			for (const id of extractToolCallIds(message.content)) {
				toolCalls.add(id);
			}
			continue;
		}
		if (message.role === "toolResult" && message.toolCallId) {
			toolResults.add(message.toolCallId);
		}
	}

	const missing = Array.from(toolCalls).filter((id) => !toolResults.has(id));
	assert(
		missing.length === 0,
		`${label} contains assistant tool call(s) without toolResult: ${missing.join(
			", ",
		)}`,
	);
}

export function runSessionWireContractCheck(baseDir = root): void {
	const manifest = JSON.parse(
		readFileSync(
			join(baseDir, "src/session/wire-format.manifest.json"),
			"utf8",
		),
	) as SessionWireManifest;
	const tsTypes = readFileSync(join(baseDir, "src/session/types.ts"), "utf8");
	const rustEntries = readFileSync(
		join(baseDir, "packages/tui-rs/src/session/entries.rs"),
		"utf8",
	);
	const tsHeader = extractTsInterfaceBody(tsTypes, "SessionHeaderEntry");
	const sessionAliases = manifest.fieldAliases.session ?? {};
	const reverseAliases = new Map(
		Object.entries(sessionAliases).map(([alias, canonical]) => [
			canonical,
			alias,
		]),
	);

	for (const field of manifest.sessionHeaderFields) {
		assert(
			new RegExp(`\\b${field}\\??\\s*:`, "u").test(tsHeader),
			`SessionHeaderEntry missing manifest field ${field}`,
		);

		if (field === "type") {
			continue;
		}

		const rustField = camelToSnake(field);
		const rustWindow = rustFieldWindow(rustEntries, rustField);
		const alias = reverseAliases.get(field);
		if (alias) {
			assert(
				rustWindow.includes(`rename = "${field}"`) &&
					rustWindow.includes(`alias = "${alias}"`),
				`Rust SessionHeader field ${rustField} must rename ${field} and alias ${alias}`,
			);
		}
	}

	const fixturesDir = join(baseDir, "test/fixtures/session-wire");
	if (existsSync(fixturesDir)) {
		for (const name of readdirSync(fixturesDir)) {
			if (!name.endsWith(".jsonl")) {
				continue;
			}
			const path = join(fixturesDir, name);
			validateSessionToolResultCompleteness(
				readFileSync(path, "utf8"),
				`test/fixtures/session-wire/${name}`,
			);
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runSessionWireContractCheck();
	console.log("Session wire TS/Rust contract check passed.");
}
