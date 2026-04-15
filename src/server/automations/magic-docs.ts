import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

export interface MagicDocDefinition {
	path: string;
	title: string;
	instructions?: string;
}

export interface MagicDocsAutomationTemplate {
	name: string;
	prompt: string;
	contextPaths: string[];
}

export interface MagicDocsAutomationTemplateResponse {
	magicDocs: MagicDocDefinition[];
	template: MagicDocsAutomationTemplate | null;
}

const MAX_MAGIC_DOCS =
	Number.parseInt(process.env.MAESTRO_MAGIC_DOCS_MAX_FILES || "24", 10) || 24;

const skipFolders = new Set([
	".git",
	".next",
	".turbo",
	".cache",
	".nx",
	".idea",
	".vscode",
	"node_modules",
	"dist",
	"build",
	"coverage",
	"tmp",
	"out",
]);

const magicDocExtensions = new Set([".md", ".mdx", ".markdown"]);

function toWorkspacePath(root: string, filePath: string): string {
	try {
		const rel = relative(root, filePath);
		if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
			return rel;
		}
	} catch {
		// Ignore relative path errors and fall back to the absolute path.
	}
	return filePath;
}

export function detectMagicDocHeader(
	content: string,
): { title: string; instructions?: string } | null {
	const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
	const headerLine = lines[0]?.trim() ?? "";
	const headerMatch = headerLine.match(/^#\s*MAGIC\s+DOC:\s*(.+?)\s*$/i);
	if (!headerMatch?.[1]) {
		return null;
	}

	const title = headerMatch[1].trim();
	const instructionCandidate = lines[1]?.trim()
		? lines[1]?.trim()
		: lines[2]?.trim();
	if (instructionCandidate) {
		const italicsMatch = instructionCandidate.match(/^[_*](.+?)[_*]\s*$/);
		if (italicsMatch?.[1]) {
			return {
				title,
				instructions: italicsMatch[1].trim(),
			};
		}
	}

	return { title };
}

export function discoverMagicDocs(root = process.cwd()): MagicDocDefinition[] {
	const queue = [root];
	const results: MagicDocDefinition[] = [];

	while (queue.length > 0 && results.length < MAX_MAGIC_DOCS) {
		const current = queue.shift();
		if (!current) continue;

		let entries: Dirent<string>[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries.sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (results.length >= MAX_MAGIC_DOCS) break;
			const fullPath = resolve(current, entry.name);
			if (entry.isDirectory()) {
				if (skipFolders.has(entry.name)) continue;
				queue.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!magicDocExtensions.has(extname(entry.name).toLowerCase())) continue;

			let content: string;
			try {
				content = readFileSync(fullPath, "utf-8");
			} catch {
				continue;
			}
			if (content.includes("\u0000")) continue;

			const detected = detectMagicDocHeader(content);
			if (!detected) continue;

			results.push({
				path: toWorkspacePath(root, fullPath),
				title: detected.title,
				instructions: detected.instructions,
			});
		}
	}

	return results.sort((left, right) => left.path.localeCompare(right.path));
}

export function buildMagicDocsAutomationPrompt(
	magicDocs: readonly MagicDocDefinition[],
): string {
	const selectedDocs = magicDocs.length
		? magicDocs
				.map((doc) =>
					doc.instructions
						? `- ${doc.path} — ${doc.title} (${doc.instructions})`
						: `- ${doc.path} — ${doc.title}`,
				)
				.join("\n")
		: "- No Magic Docs selected.";

	return [
		"Update the selected Magic Docs to reflect the current repository state and recent work.",
		"",
		"Rules:",
		"- Only edit the selected Magic Doc markdown files provided as context.",
		"- Preserve each `# MAGIC DOC: ...` header exactly.",
		"- If a Magic Doc has an italic instruction line directly under the header, preserve it and follow it.",
		"- Keep updates concise, factual, and specific to this repository.",
		"- Do not modify source code, tests, configs, or unrelated docs.",
		"- Leave a file unchanged if it is already current.",
		"- After updating the docs, summarize what changed in your final response.",
		"",
		"Selected Magic Docs:",
		selectedDocs,
	].join("\n");
}

export function buildMagicDocsAutomationTemplate(
	root = process.cwd(),
): MagicDocsAutomationTemplateResponse {
	const magicDocs = discoverMagicDocs(root);
	return {
		magicDocs,
		template:
			magicDocs.length > 0
				? {
						name: "Magic Docs Sync",
						prompt: buildMagicDocsAutomationPrompt(magicDocs),
						contextPaths: magicDocs.map((doc) => doc.path),
					}
				: null,
	};
}
