import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildMagicDocsAutomationPrompt,
	buildMagicDocsAutomationTemplate,
	detectMagicDocHeader,
	discoverMagicDocs,
} from "../../src/server/automations/magic-docs.js";

describe("Magic Docs discovery", () => {
	it("detects Magic Doc titles and optional italic instructions", () => {
		expect(
			detectMagicDocHeader(
				[
					"# MAGIC DOC: Release Checklist",
					"",
					"_Keep this focused on release gates._",
					"",
					"More content",
				].join("\n"),
			),
		).toEqual({
			title: "Release Checklist",
			instructions: "Keep this focused on release gates.",
		});

		expect(
			detectMagicDocHeader("# MAGIC DOC: Architecture\nRegular paragraph"),
		).toEqual({
			title: "Architecture",
		});
	});

	it("discovers Magic Docs in markdown files and builds an automation template", () => {
		const root = mkdtempSync(join(tmpdir(), "magic-docs-"));
		mkdirSync(join(root, "docs"), { recursive: true });
		mkdirSync(join(root, "notes"), { recursive: true });
		writeFileSync(
			join(root, "docs", "architecture.md"),
			[
				"# MAGIC DOC: Architecture",
				"_Track major subsystem decisions._",
				"",
				"Current notes",
			].join("\n"),
		);
		writeFileSync(
			join(root, "notes", "todo.mdx"),
			["# MAGIC DOC: Team TODOs", "", "Track working agreements."].join("\n"),
		);
		writeFileSync(join(root, "README.md"), "# Plain README");
		writeFileSync(
			join(root, "docs", "binary.md"),
			"# MAGIC DOC: Ignored\u0000binary",
		);

		const docs = discoverMagicDocs(root);
		expect(docs).toEqual([
			{
				path: "docs/architecture.md",
				title: "Architecture",
				instructions: "Track major subsystem decisions.",
			},
			{
				path: "notes/todo.mdx",
				title: "Team TODOs",
			},
		]);

		const template = buildMagicDocsAutomationTemplate(root);
		expect(template.magicDocs).toEqual(docs);
		expect(template.template).toEqual({
			name: "Magic Docs Sync",
			prompt: buildMagicDocsAutomationPrompt(docs),
			contextPaths: ["docs/architecture.md", "notes/todo.mdx"],
		});
		expect(template.template?.prompt).toContain(
			"Only edit the selected Magic Doc markdown files provided as context.",
		);
		expect(template.template?.prompt).toContain(
			"docs/architecture.md — Architecture",
		);
	});
});
