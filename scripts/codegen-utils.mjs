import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function formatTsWithBiome(
	source,
	outputPath,
	{ rootDir, label, tempPrefix = ".codegen-" },
) {
	mkdirSync(dirname(outputPath), { recursive: true });
	const tempDir = mkdtempSync(join(dirname(outputPath), tempPrefix));
	const tempPath = join(tempDir, basename(outputPath));
	try {
		writeFileSync(tempPath, source, "utf8");
		const localBiome = join(rootDir, "node_modules/.bin/biome");
		const command = existsSync(localBiome) ? localBiome : "bunx";
		const args = existsSync(localBiome)
			? ["check", "--write", "--unsafe", tempPath]
			: ["@biomejs/biome@1.9.4", "check", "--write", "--unsafe", tempPath];
		const result = spawnSync(command, args, {
			cwd: rootDir,
			encoding: "utf8",
		});
		if (result.error) {
			throw new Error(
				`Failed to launch Biome while formatting ${label}: ${result.error.message}`,
			);
		}
		if (result.status !== 0) {
			throw new Error(
				`Failed to format ${label}: ${result.stderr || result.stdout}`,
			);
		}
		return readFileSync(tempPath, "utf8");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function resolveRustfmt(envNames) {
	for (const envName of envNames) {
		const command = process.env[envName];
		if (command) {
			return command;
		}
	}
	return process.env.MAESTRO_RUSTFMT ?? "rustfmt";
}

const RUSTFMT_DISABLED_VALUES = new Set(["0", "false", "none", "off", "skip"]);

function rustfmtDisabled(command) {
	return RUSTFMT_DISABLED_VALUES.has(command.trim().toLowerCase());
}

export function formatRustWithRustfmt(
	source,
	outputPath,
	{
		rootDir,
		label,
		check = false,
		envNames = [],
		tempPrefix = ".codegen-",
	} = {},
) {
	const rustfmt = resolveRustfmt(envNames);
	if (rustfmtDisabled(rustfmt)) {
		return { content: source, rustfmtAvailable: false };
	}

	mkdirSync(dirname(outputPath), { recursive: true });
	const tempDir = mkdtempSync(join(dirname(outputPath), tempPrefix));
	const tempPath = join(tempDir, basename(outputPath));
	try {
		writeFileSync(tempPath, source, "utf8");
		const result = spawnSync(rustfmt, [tempPath], {
			cwd: rootDir,
			encoding: "utf8",
		});
		if (result.error?.code === "ENOENT") {
			if (!check) {
				throw new Error(
					`${rustfmt} is required to write ${label}. Install rustfmt or run with --check.`,
				);
			}
			return { content: source, rustfmtAvailable: false };
		}
		if (result.error) {
			throw result.error;
		}
		if (result.status !== 0) {
			throw new Error(
				`Failed to format ${label}: ${result.stderr || result.stdout}`,
			);
		}
		return { content: readFileSync(tempPath, "utf8"), rustfmtAvailable: true };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function stripRustWhitespaceOutsideStrings(source) {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === ",") {
			let nextIndex = index + 1;
			while (/\s/.test(source[nextIndex] ?? "")) {
				nextIndex += 1;
			}
			if (/[\])}]/.test(source[nextIndex] ?? "")) {
				continue;
			}
		}
		if (!/\s/.test(char)) {
			output += char;
		}
	}
	return output;
}

export function rustGeneratedMatches(current, expected, { rustfmtAvailable }) {
	if (rustfmtAvailable) {
		return current === expected;
	}
	return (
		stripRustWhitespaceOutsideStrings(current) ===
		stripRustWhitespaceOutsideStrings(expected)
	);
}

export async function checkOrWriteGeneratedTargets(
	targets,
	{ check, outOfDateLabel },
) {
	if (check) {
		let failed = false;
		for (const target of targets) {
			const current = await readFile(target.path, "utf8").catch(() => null);
			const matches = target.matches ?? ((current, expected) => current === expected);
			if (current === null || !matches(current, target.content)) {
				failed = true;
				console.error(`${outOfDateLabel}: ${target.path}`);
			}
		}
		if (failed) {
			process.exitCode = 1;
		}
		return;
	}

	for (const target of targets) {
		await mkdir(dirname(target.path), { recursive: true });
		await writeFile(target.path, target.content);
	}
}
