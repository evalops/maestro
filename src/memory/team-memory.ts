import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PATHS } from "../config/constants.js";
import { scanOutboundSensitiveContent } from "../safety/outbound-secret-preflight.js";
import { getGitRoot } from "../utils/git.js";

const TEAM_MEMORY_TEMPLATE = `# Team Memory

Use this repo-scoped memory for durable team knowledge.

- Keep stable conventions, environment facts, deployment notes, and ownership here.
- Do not store secrets, API keys, tokens, passwords, or private keys here.
- Do not use this file for one-off session notes or temporary scratch work.
`;

const TEAM_MEMORY_ENTRYPOINT = "MEMORY.md";
const TEAM_MEMORY_PROMPT_MAX_BYTES = 12_000;
const TEAM_MEMORY_MAX_FILES = 12;

export interface TeamMemoryLocation {
	gitRoot: string;
	projectId: string;
	projectName: string;
	directory: string;
	entrypoint: string;
}

export interface TeamMemoryStatus extends TeamMemoryLocation {
	exists: boolean;
	fileCount: number;
	files: string[];
}

interface TeamMemoryFileEntry {
	absolutePath: string;
	relativePath: string;
}

function createProjectId(gitRoot: string): string {
	return createHash("sha1").update(gitRoot).digest("hex").slice(0, 16);
}

function isPromptEligibleTeamMemoryFile(relativePath: string): boolean {
	return /\.(md|mdx|txt)$/i.test(relativePath);
}

function isPathWithinDirectory(candidate: string, directory: string): boolean {
	return candidate === directory || candidate.startsWith(`${directory}${sep}`);
}

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf-8");
	if (buffer.length <= maxBytes) {
		return text;
	}

	let end = Math.min(maxBytes, buffer.length);
	while (end > 0 && ((buffer[end - 1] ?? 0) & 0b1100_0000) === 0b1000_0000) {
		end -= 1;
	}
	if (end <= 0) {
		return "";
	}
	return buffer.subarray(0, end).toString("utf-8");
}

function realpathDeepestExistingSync(absolutePath: string): string {
	const tail: string[] = [];
	let current = absolutePath;

	for (
		let parent = dirname(current);
		current !== parent;
		parent = dirname(current)
	) {
		try {
			const realCurrent = realpathSync(current);
			return tail.length === 0
				? realCurrent
				: join(realCurrent, ...tail.reverse());
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? String((error as { code?: unknown }).code)
					: "";
			if (code === "ENOENT") {
				try {
					const stats = lstatSync(current);
					if (stats.isSymbolicLink()) {
						throw new Error(
							`Dangling symlink detected in team memory path: ${current}`,
						);
					}
				} catch (nestedError) {
					if (
						nestedError instanceof Error &&
						nestedError.message.includes("Dangling symlink")
					) {
						throw nestedError;
					}
				}
			} else if (code === "ELOOP") {
				throw new Error(
					`Symlink loop detected in team memory path: ${current}`,
				);
			} else if (
				code !== "ENOTDIR" &&
				code !== "ENAMETOOLONG" &&
				code !== "ENOENT"
			) {
				throw new Error(
					`Unable to validate team memory path (${code || "unknown"}): ${current}`,
				);
			}
			tail.push(current.slice(parent.length + sep.length));
			current = parent;
		}
	}

	return absolutePath;
}

function isRealPathWithinTeamMemoryDirectory(
	realCandidate: string,
	directory: string,
): boolean {
	try {
		const realDirectory = realpathSync(directory);
		return isPathWithinDirectory(realCandidate, realDirectory);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String((error as { code?: unknown }).code)
				: "";
		if (code === "ENOENT" || code === "ENOTDIR") {
			return true;
		}
		return false;
	}
}

function listTeamMemoryFilesRecursive(
	directory: string,
): TeamMemoryFileEntry[] {
	if (!existsSync(directory)) {
		return [];
	}

	const entries: TeamMemoryFileEntry[] = [];
	const walk = (currentDir: string) => {
		const dirents = readdirSync(currentDir, { withFileTypes: true }).sort(
			(left, right) => left.name.localeCompare(right.name),
		);
		for (const dirent of dirents) {
			const absolutePath = join(currentDir, dirent.name);
			if (dirent.isDirectory()) {
				walk(absolutePath);
				continue;
			}
			if (!dirent.isFile()) {
				continue;
			}
			entries.push({
				absolutePath,
				relativePath: absolutePath.slice(directory.length + 1),
			});
		}
	};

	walk(directory);
	return entries;
}

export function getTeamMemoryLocation(
	cwd: string = process.cwd(),
): TeamMemoryLocation | null {
	const gitRoot = getGitRoot(cwd);
	if (!gitRoot) {
		return null;
	}

	const normalizedRoot = resolve(gitRoot);
	const projectId = createProjectId(normalizedRoot);
	const directory = join(
		PATHS.MAESTRO_HOME,
		"memory",
		"projects",
		projectId,
		"team",
	);

	return {
		gitRoot: normalizedRoot,
		projectId,
		projectName: basename(normalizedRoot),
		directory,
		entrypoint: join(directory, TEAM_MEMORY_ENTRYPOINT),
	};
}

export function getTeamMemoryStatus(
	cwd: string = process.cwd(),
): TeamMemoryStatus | null {
	const location = getTeamMemoryLocation(cwd);
	if (!location) {
		return null;
	}

	const files = listTeamMemoryFilesRecursive(location.directory).map(
		(entry) => entry.relativePath,
	);

	return {
		...location,
		exists: existsSync(location.directory),
		fileCount: files.length,
		files,
	};
}

export function ensureTeamMemoryEntrypoint(
	cwd: string = process.cwd(),
): TeamMemoryLocation | null {
	const location = getTeamMemoryLocation(cwd);
	if (!location) {
		return null;
	}

	mkdirSync(location.directory, { recursive: true });
	if (!existsSync(location.entrypoint)) {
		writeFileSync(location.entrypoint, TEAM_MEMORY_TEMPLATE, "utf-8");
	}

	return location;
}

export function isTeamMemoryFilePath(
	filePath: string,
	cwd: string = dirname(filePath),
): boolean {
	const location = getTeamMemoryLocation(cwd);
	if (!location) {
		return false;
	}

	const resolvedPath = resolve(filePath);
	if (!isPathWithinDirectory(resolvedPath, location.directory)) {
		return false;
	}

	try {
		const realPath = realpathDeepestExistingSync(resolvedPath);
		return isRealPathWithinTeamMemoryDirectory(realPath, location.directory);
	} catch {
		return false;
	}
}

export function assertTeamMemoryContentSafe(
	filePath: string,
	content: string,
	cwd: string = dirname(filePath),
): void {
	if (!isTeamMemoryFilePath(filePath, cwd)) {
		return;
	}

	const scan = scanOutboundSensitiveContent(content);
	if (scan.blockingFindings.length === 0) {
		return;
	}

	const labels = Array.from(
		new Set(scan.blockingFindings.map((finding) => finding.description)),
	).join(", ");
	throw new Error(
		`Potential secrets detected in team memory content (${labels}). Team memory files cannot store secrets.`,
	);
}

export function buildTeamMemoryPromptContext(
	cwd: string = process.cwd(),
): string | null {
	const location = getTeamMemoryLocation(cwd);
	if (!location) {
		return null;
	}

	const files = listTeamMemoryFilesRecursive(location.directory)
		.filter((entry) => isPromptEligibleTeamMemoryFile(entry.relativePath))
		.slice(0, TEAM_MEMORY_MAX_FILES);
	if (files.length === 0) {
		return null;
	}

	const lines = [
		"# Team Memory",
		`Repository-scoped durable notes for ${location.projectName}.`,
	];
	let usedBytes = Buffer.byteLength(lines.join("\n\n"), "utf-8");
	let includedFiles = 0;

	for (const file of files) {
		const content = readFileSync(file.absolutePath, "utf-8").trim();
		if (!content) {
			continue;
		}

		const heading = `## ${file.relativePath}`;
		const section = `${heading}\n${content}`;
		const sectionBytes = Buffer.byteLength(`\n\n${section}`, "utf-8");

		if (usedBytes + sectionBytes <= TEAM_MEMORY_PROMPT_MAX_BYTES) {
			lines.push(section);
			usedBytes += sectionBytes;
			includedFiles += 1;
			continue;
		}

		const remainingBytes =
			TEAM_MEMORY_PROMPT_MAX_BYTES -
			usedBytes -
			Buffer.byteLength(`\n\n${heading}\n`, "utf-8");
		if (remainingBytes <= 0) {
			break;
		}

		const truncatedContent = truncateUtf8ToBytes(
			content,
			remainingBytes,
		).trim();
		if (!truncatedContent) {
			break;
		}

		lines.push(`${heading}\n${truncatedContent}\n…`);
		includedFiles += 1;
		break;
	}

	return includedFiles > 0 ? lines.join("\n\n") : null;
}
