#!/usr/bin/env node
/**
 * One-shot codemod that applies the Codex-style substitutions across the
 * web components: drop terminal-era uppercase + tight letter-spacing, swap
 * chrome `font-mono` to `font-sans`, and soften square borders with the
 * shared radius tokens. Intended to run once and then be reviewed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const componentsDir = join(here, "..", "packages/web/src/components");

const files = [
	"admin-policy-tab.ts",
	"admin-settings.ts",
	"composer-settings.ts",
	"command-drawer.ts",
	"model-selector.ts",
	"composer-approval.ts",
	"composer-artifacts-panel.ts",
	"composer-chat.ts",
	"composer-user-input.ts",
	"composer-input.ts",
	"composer-message.ts",
	"composer-session-sidebar.ts",
	"composer-session-timeline-panel.ts",
	"composer-thinking.ts",
	"composer-tool-execution.ts",
	"composer-tool-retry.ts",
	"composer-mcp-elicitation.ts",
	"composer-export-dialog.ts",
	"composer-share-dialog.ts",
	"fleet-dashboard.ts",
];

const SELECTOR_HINT_RE =
	/^(?:[^{}]*?)(?:\.(?:label|title|header|btn|button|tab|tabs|badge|pill|stat|info|section|control|field|empty|loading|error|name|provider|meta|hint|actions|action|row|grid|cell|card|row-label|row-value|count|value|tag|chip|message|panel|drawer|nav|toolbar|footer|description|summary|summary-item|item|note|notice|status|caption|breadcrumb|placeholder|column|columns|cards|list|listing|listing-item|listing-row)\b)/i;

function shouldSwapFontMono(blockBeforeDecl) {
	// Last selector chunk in the current rule
	const match = /([^{}]*)\{[^{}]*$/.exec(blockBeforeDecl);
	if (!match) return false;
	const selector = match[1];
	if (/(?:^|[\s,(>+~])(?:code|pre|kbd|samp)\b/i.test(selector)) return false;
	if (/\.(?:[\w]+[-_])*(?:code|code-block|pre|kbd|shortcut|shortcut-key|hotkey|key|mono|monospace|raw|terminal|console|json|yaml|markdown|diff|file-path|filepath|sha|hash|cwd|cmd|command|stdout|stderr)(?:[-_][\w]+)*\b/i.test(selector)) {
		return false;
	}
	if (/\.(?:prompt(?![-_\w])|(?:terminal|shell|console|command|cmd)[-_]prompt(?:[-_][\w]+)*|prompt[-_](?:line|marker|prefix)(?:[-_][\w]+)*)\b/i.test(selector)) {
		return false;
	}
	if (SELECTOR_HINT_RE.test(selector)) return true;
	// default: swap (chrome assumption)
	return true;
}

function transform(source) {
	let out = source;
	let changed = 0;

	out = out.replace(/text-transform:\s*uppercase\s*;/g, () => {
		changed += 1;
		return "text-transform: none;";
	});

	out = out.replace(/letter-spacing:\s*0\.0[3-9]+em\s*;/g, () => {
		changed += 1;
		return "letter-spacing: 0;";
	});
	out = out.replace(/letter-spacing:\s*0\.1[0-9]*em\s*;/g, () => {
		changed += 1;
		return "letter-spacing: 0;";
	});

	out = out.replace(
		/font-family:\s*var\(--font-mono[^)]*\)\s*;/g,
		(match, offset) => {
			const before = out.slice(0, offset);
			if (!shouldSwapFontMono(before)) return match;
			changed += 1;
			return "font-family: var(--font-sans, 'Inter', sans-serif);";
		},
	);

	// Soften default border colors
	out = out.replace(
		/border:\s*1px solid var\(--border-primary([^)]*)\)\s*;/g,
		(_, fallback) => {
			changed += 1;
			return `border: 1px solid var(--border-subtle${fallback});`;
		},
	);

	return { out, changed };
}

let totalChanges = 0;
for (const file of files) {
	const path = join(componentsDir, file);
	const src = readFileSync(path, "utf8");
	const { out, changed } = transform(src);
	if (changed > 0) {
		writeFileSync(path, out);
		console.log(`[codex-restyle] ${file}: ${changed} substitutions`);
		totalChanges += changed;
	}
}

console.log(`[codex-restyle] total: ${totalChanges} substitutions`);
