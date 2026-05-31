import { readFileSync } from "node:fs";
import { join } from "node:path";

interface SessionWireManifest {
	sessionHeaderFields: string[];
	fieldAliases: {
		session?: Record<string, string>;
	};
}

const root = process.cwd();
const manifest = JSON.parse(
	readFileSync(join(root, "src/session/wire-format.manifest.json"), "utf8"),
) as SessionWireManifest;
const tsTypes = readFileSync(join(root, "src/session/types.ts"), "utf8");
const rustEntries = readFileSync(
	join(root, "packages/tui-rs/src/session/entries.rs"),
	"utf8",
);

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

function rustFieldWindow(fieldName: string): string {
	const pattern = new RegExp(`\\bpub\\s+${fieldName}\\s*:`, "u");
	const match = pattern.exec(rustEntries);
	assert(match, `Rust SessionHeader missing field ${fieldName}`);
	const before = rustEntries.slice(0, match.index);
	const lines = before.split("\n").slice(-12);
	return lines.join("\n");
}

const tsHeader = extractTsInterfaceBody(tsTypes, "SessionHeaderEntry");
const sessionAliases = manifest.fieldAliases.session ?? {};
const reverseAliases = new Map(
	Object.entries(sessionAliases).map(([alias, canonical]) => [canonical, alias]),
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
	const rustWindow = rustFieldWindow(rustField);
	const alias = reverseAliases.get(field);
	if (alias) {
		assert(
			rustWindow.includes(`rename = "${field}"`) &&
				rustWindow.includes(`alias = "${alias}"`),
			`Rust SessionHeader field ${rustField} must rename ${field} and alias ${alias}`,
		);
	}
}

console.log("Session wire TS/Rust contract check passed.");
