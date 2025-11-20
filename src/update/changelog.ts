import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

const CHANGELOG_STATE_ENV = "COMPOSER_CHANGELOG_STATE";

const resolveStatePath = (): string => {
	const override = process.env[CHANGELOG_STATE_ENV];
	if (override) {
		return override;
	}
	return join(homedir(), ".composer", "agent", "changelog-state.json");
};

export function getChangelogPath(): string {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	return join(__dirname, "../../CHANGELOG.md");
}

export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}
	const content = readFileSync(changelogPath, "utf-8");
	const lines = content.split("\n");
	const entries: ChangelogEntry[] = [];
	let currentLines: string[] = [];
	let currentVersion: ChangelogEntry | null = null;
	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (currentVersion && currentLines.length > 0) {
				entries.push({
					...currentVersion,
					content: currentLines.join("\n").trim(),
				});
			}
			const match = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
			if (match) {
				currentVersion = {
					major: Number.parseInt(match[1] ?? "0", 10),
					minor: Number.parseInt(match[2] ?? "0", 10),
					patch: Number.parseInt(match[3] ?? "0", 10),
					content: "",
				};
				currentLines = [line];
			} else {
				currentVersion = null;
				currentLines = [];
			}
			continue;
		}
		if (currentVersion) {
			currentLines.push(line);
		}
	}
	if (currentVersion && currentLines.length > 0) {
		entries.push({
			...currentVersion,
			content: currentLines.join("\n").trim(),
		});
	}
	return entries;
}

const compareEntry = (a: ChangelogEntry, b: ChangelogEntry): number => {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
};

export function getLatestEntry(
	entries: ChangelogEntry[],
): ChangelogEntry | null {
	if (entries.length === 0) {
		return null;
	}
	return entries.slice(1).reduce<ChangelogEntry>(
		(latest, entry) => {
			return compareEntry(entry, latest) > 0 ? entry : latest;
		},
		entries[0] as ChangelogEntry,
	);
}

export function getNewEntries(
	entries: ChangelogEntry[],
	lastVersion: string,
): ChangelogEntry[] {
	const parts = lastVersion
		.split(".")
		.map((value) => Number.parseInt(value, 10));
	const reference: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};
	return entries.filter((entry) => compareEntry(entry, reference) > 0);
}

export function readLastShownChangelogVersion(): string | null {
	const path = resolveStatePath();
	if (!existsSync(path)) {
		return null;
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as { version?: string };
		if (typeof parsed.version === "string" && parsed.version.trim()) {
			return parsed.version.trim();
		}
		return null;
	} catch {
		return null;
	}
}

export function writeLastShownChangelogVersion(version: string): void {
	if (!version) {
		return;
	}
	const path = resolveStatePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version }, null, 2), "utf-8");
}
