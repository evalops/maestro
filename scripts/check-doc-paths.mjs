#!/usr/bin/env node
/**
 * Fails CI when a doc under docs/ references a repo-relative path that does not
 * exist on disk. Catches drift like docs describing packages/paths that were
 * deleted or renamed without the docs being updated.
 *
 * Scope, deliberately narrow to keep the false-positive rate low:
 *   - Markdown files: only path-like tokens inside inline code spans (`like/this`)
 *     or fenced code blocks. Prose such as "docs/OSS" or "proto/JSON surface"
 *     (slash used as "and/or") is never inside backticks and is ignored.
 *   - JSON files: every string value that looks like a repo-relative path.
 *
 * A path is "known top-level" if it starts with one of TOP_LEVEL_DIRS. This
 * avoids false-matching relative markdown links (../foo) or arbitrary prose.
 *
 * Allowlist: docs/doc-path-allowlist.json lists source/path pairs that are
 * intentionally illustrative/aspirational and should not resolve on disk.
 * Exemptions are scoped to one document so they cannot mask new drift elsewhere.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = join(root, "docs");
const allowlistPath = join(docsDir, "doc-path-allowlist.json");

const TOP_LEVEL_DIRS = [
	"packages",
	"src",
	"scripts",
	"proto",
	"test",
	"tools",
	"docs",
	"deploy",
	"evals",
	"examples",
	"skills",
];

// A repo-relative path token: one of the known top-level dirs, then one or
// more /segment components. Segments are word chars, dash, dot, underscore.
// The negative lookbehind keeps this from matching a top-level dir name that
// is actually a trailing segment of a longer path, e.g. the "skills/README.md"
// inside "cookbook/skills/README.md" (a real, resolvable relative link).
const PATH_TOKEN_RE = new RegExp(
	`(?<![\\w./-])(?:${TOP_LEVEL_DIRS.join("|")})(?:/[A-Za-z0-9_.\\-]+)+`,
	"g",
);

export function parseAllowlist(raw, sourcePath = allowlistPath) {
	if (!Array.isArray(raw)) {
		throw new Error(
			`${sourcePath} must be a JSON array of {"source", "path", "reason"} entries`,
		);
	}
	const set = new Set();
	for (const entry of raw) {
		const keys =
			entry && typeof entry === "object" ? Object.keys(entry).sort() : [];
		if (
			!entry ||
			keys.join(",") !== "path,reason,source" ||
			typeof entry.source !== "string" ||
			!entry.source.trim() ||
			typeof entry.path !== "string" ||
			!entry.path.trim() ||
			typeof entry.reason !== "string" ||
			!entry.reason.trim()
		) {
			throw new Error(`${sourcePath}: invalid entry ${JSON.stringify(entry)}`);
		}
		const key = `${entry.source}\0${entry.path}`;
		if (set.has(key)) {
			throw new Error(
				`${sourcePath}: duplicate source/path entry ${JSON.stringify({
					source: entry.source,
					path: entry.path,
				})}`,
			);
		}
		set.add(key);
	}
	return set;
}

function loadAllowlist() {
	if (!existsSync(allowlistPath)) return new Set();
	return parseAllowlist(JSON.parse(readFileSync(allowlistPath, "utf8")));
}

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

function extractCodeSpans(markdown) {
	// Fenced code blocks (```...```), then inline code spans (`...`).
	const spans = [];
	const fenceRe = /```[\s\S]*?```/g;
	let m;
	while ((m = fenceRe.exec(markdown))) spans.push(m[0]);
	// Strip fenced blocks before scanning for inline spans so we don't double
	// count, then scan the remainder for inline code spans.
	const withoutFences = markdown.replace(fenceRe, "");
	const inlineRe = /`([^`\n]+)`/g;
	while ((m = inlineRe.exec(withoutFences))) spans.push(m[0]);
	return spans;
}

function extractLinkTargets(markdown) {
	const targets = [];
	// Markdown link targets: [text](path) — the target is not always in
	// backticks (e.g. [`test/x.json`](../../test/x.json)).
	// Skip external links (http(s)://, mailto:, etc) — a URL path segment like
	// ".../docs/guides/foo" is not a repo-relative path.
	const linkRe = /\]\(([^)\s]+)\)/g;
	let m;
	while ((m = linkRe.exec(markdown))) {
		if (/^[a-z][a-z0-9+.\-]*:/i.test(m[1])) continue; // has a URL scheme
		targets.push(m[1]);
	}
	return targets;
}

function findPathTokens(text) {
	const found = new Set();
	// Drop whitespace-delimited words that are (or contain) a URL — a path
	// segment inside "https://host/docs/guides/foo" is not a repo-relative
	// path. Do this per-word so we don't lose real paths on the same line.
	const scrubbed = text
		.split(/\s+/)
		.filter((word) => !/:\/\//.test(word))
		.join(" ");
	const matches = scrubbed.match(PATH_TOKEN_RE);
	if (!matches) return found;
	for (const raw of matches) {
		const cleaned = raw.replace(/[).,:;'"`]+$/, "");
		if (/[*{}]/.test(cleaned)) continue; // glob patterns, not literal paths
		found.add(cleaned);
	}
	return found;
}

function collectJsonPathStrings(value, found) {
	if (typeof value === "string") {
		for (const token of findPathTokens(value)) found.add(token);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) collectJsonPathStrings(v, found);
		return;
	}
	if (value && typeof value === "object") {
		for (const v of Object.values(value)) collectJsonPathStrings(v, found);
	}
}

export function checkDocPaths({ rootDir = root, allowlist = loadAllowlist() } = {}) {
	const failures = [];
	const configuredAllowlistPath = join(rootDir, "docs", "doc-path-allowlist.json");
	const files = walk(join(rootDir, "docs")).filter(
		(f) =>
			f !== configuredAllowlistPath &&
			[".md", ".mdx", ".json"].includes(extname(f)),
	);

	for (const file of files) {
		const rel = relative(rootDir, file);
		const text = readFileSync(file, "utf8");
		let tokens = new Set();

		if (extname(file) === ".json") {
			try {
				const parsed = JSON.parse(text);
				collectJsonPathStrings(parsed, tokens);
			} catch (error) {
				failures.push(`${rel}: invalid JSON (${error.message})`);
				continue;
			}
		} else {
			for (const span of extractCodeSpans(text)) {
				for (const t of findPathTokens(span)) tokens.add(t);
			}
			for (const target of extractLinkTargets(text)) {
				const withoutFragment = target.split(/[?#]/, 1)[0];
				if (!withoutFragment || withoutFragment.startsWith("/")) continue;
				const absoluteTarget = resolve(dirname(file), withoutFragment);
				const repoRelative = relative(rootDir, absoluteTarget).replaceAll("\\", "/");
				if (repoRelative.startsWith("../") || repoRelative === "..") continue;
				if (
					TOP_LEVEL_DIRS.some(
						(topLevel) =>
							repoRelative === topLevel || repoRelative.startsWith(`${topLevel}/`),
					)
				) {
					tokens.add(repoRelative);
				}
			}
		}

		for (const token of tokens) {
			if (allowlist.has(`${rel}\0${token}`)) continue;
			const absolute = resolve(rootDir, token);
			if (!existsSync(absolute)) {
				failures.push(`${rel}: references missing path \`${token}\``);
			}
		}
	}

	return failures;
}

function main() {
	const failures = checkDocPaths();
	if (failures.length > 0) {
		console.error(`Doc path check failed: ${failures.length} dangling reference(s)`);
		for (const failure of failures.sort()) {
			console.error(`  - ${failure}`);
		}
		console.error(
			"\nIf a path is an intentional illustrative example that should not exist, add it to docs/doc-path-allowlist.json.",
		);
		process.exit(1);
	}
	console.log(`Doc path check passed (${walk(docsDir).filter((f) => [".md", ".mdx", ".json"].includes(extname(f))).length} files scanned).`);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.stack : String(error));
		process.exit(1);
	}
}
