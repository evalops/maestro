import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { PATHS } from "../config/constants.js";
import { writeTextFileAtomic } from "../utils/fs.js";

export type SpecialistProfileScope = "project" | "user";

export interface SpecialistProfile {
	name: string;
	description?: string;
	prompt: string;
	tools?: string[];
	model?: string;
	scope: SpecialistProfileScope;
	path: string;
	createdAt?: string;
	updatedAt?: string;
}

export function normalizeSpecialistProfileName(name: string): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-");
	const stripped = normalized.replace(/^-+|-+$/g, "");
	if (!stripped || stripped.length > 64) {
		throw new Error(
			"profile name must be 1-64 lowercase letters, numbers, or hyphens",
		);
	}
	return stripped;
}

export function getSpecialistProfileDir(
	scope: SpecialistProfileScope,
	workspaceDir = process.cwd(),
): string {
	return scope === "project"
		? join(workspaceDir, ".maestro", "agent-profiles")
		: join(PATHS.MAESTRO_HOME, "agent-profiles");
}

export function getSpecialistProfilePath(
	name: string,
	scope: SpecialistProfileScope,
	workspaceDir = process.cwd(),
): string {
	return join(
		getSpecialistProfileDir(scope, workspaceDir),
		`${normalizeSpecialistProfileName(name)}.md`,
	);
}

export function createSpecialistProfile(options: {
	name: string;
	description?: string;
	prompt: string;
	tools?: string[];
	model?: string;
	scope?: SpecialistProfileScope;
	workspaceDir?: string;
	now?: string;
	overwrite?: boolean;
}): SpecialistProfile {
	const scope = options.scope ?? "project";
	const name = normalizeSpecialistProfileName(options.name);
	const path = getSpecialistProfilePath(name, scope, options.workspaceDir);
	if (existsSync(path) && !options.overwrite) {
		throw new Error(`specialist profile already exists: ${name}`);
	}
	const now = options.now ?? new Date().toISOString();
	const prompt = options.prompt.trim();
	if (!prompt) {
		throw new Error("profile prompt is required");
	}
	mkdirSync(getSpecialistProfileDir(scope, options.workspaceDir), {
		recursive: true,
	});
	const frontmatter = YAML.stringify({
		name,
		description: options.description,
		tools: options.tools,
		model: options.model,
		createdAt: now,
		updatedAt: now,
	});
	writeTextFileAtomic(path, `---\n${frontmatter}---\n\n${prompt}\n`);
	return {
		name,
		description: options.description,
		prompt,
		tools: options.tools,
		model: options.model,
		scope,
		path,
		createdAt: now,
		updatedAt: now,
	};
}

export function readSpecialistProfile(
	path: string,
	scope: SpecialistProfileScope,
): SpecialistProfile {
	const content = readFileSync(path, "utf-8");
	const parsed = parseProfileMarkdown(content);
	const name =
		typeof parsed.metadata.name === "string"
			? normalizeSpecialistProfileName(parsed.metadata.name)
			: normalizeSpecialistProfileName(basename(path, ".md"));
	return {
		name,
		description:
			typeof parsed.metadata.description === "string"
				? parsed.metadata.description
				: undefined,
		prompt: parsed.body.trim(),
		tools: Array.isArray(parsed.metadata.tools)
			? parsed.metadata.tools.filter(
					(tool): tool is string => typeof tool === "string",
				)
			: undefined,
		model:
			typeof parsed.metadata.model === "string"
				? parsed.metadata.model
				: undefined,
		scope,
		path,
		createdAt:
			typeof parsed.metadata.createdAt === "string"
				? parsed.metadata.createdAt
				: undefined,
		updatedAt:
			typeof parsed.metadata.updatedAt === "string"
				? parsed.metadata.updatedAt
				: undefined,
	};
}

export function listSpecialistProfiles(
	workspaceDir = process.cwd(),
): SpecialistProfile[] {
	const byName = new Map<string, SpecialistProfile>();
	for (const scope of ["user", "project"] as const) {
		const dir = getSpecialistProfileDir(scope, workspaceDir);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			try {
				const profile = readSpecialistProfile(join(dir, entry.name), scope);
				byName.set(profile.name, profile);
			} catch {}
		}
	}
	return [...byName.values()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

export function resolveSpecialistProfile(
	name: string,
	workspaceDir = process.cwd(),
): SpecialistProfile | null {
	const normalized = normalizeSpecialistProfileName(name);
	return (
		listSpecialistProfiles(workspaceDir).find(
			(profile) => profile.name === normalized,
		) ?? null
	);
}

export function deleteSpecialistProfile(options: {
	name: string;
	scope?: SpecialistProfileScope;
	workspaceDir?: string;
}): boolean {
	const scope = options.scope ?? "project";
	const path = getSpecialistProfilePath(
		options.name,
		scope,
		options.workspaceDir,
	);
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

export function applySpecialistProfileToPrompt(
	prompt: string,
	profile: SpecialistProfile | null | undefined,
): string {
	if (!profile) return prompt;
	return [
		`Specialist profile: ${profile.name}`,
		profile.description ? `Description: ${profile.description}` : "",
		"Profile instructions:",
		profile.prompt,
		"",
		"Assigned task:",
		prompt,
	]
		.filter(Boolean)
		.join("\n");
}

function parseProfileMarkdown(content: string): {
	metadata: Record<string, unknown>;
	body: string;
} {
	if (!content.startsWith("---\n")) {
		return { metadata: {}, body: content };
	}
	const end = content.indexOf("\n---", 4);
	if (end === -1) return { metadata: {}, body: content };
	const frontmatter = content.slice(4, end);
	const body = content.slice(end + 4).replace(/^\r?\n/u, "");
	const metadata = YAML.parse(frontmatter);
	return {
		metadata:
			metadata && typeof metadata === "object"
				? (metadata as Record<string, unknown>)
				: {},
		body,
	};
}
