import { spawnSync } from "node:child_process";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import chalk from "chalk";

const TOOLS_DIR = join(homedir(), ".composer", "tools");

interface ToolConfig {
	name: string;
	repo: string;
	binaryName: string;
	tagPrefix: string;
	getAssetName: (
		version: string,
		plat: string,
		architecture: string,
	) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			}
			if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			}
			if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			}
			if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			}
			if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(
		TOOLS_DIR,
		config.binaryName + (platform() === "win32" ? ".exe" : ""),
	);
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH
	if (commandExists(config.binaryName)) {
		return config.binaryName;
	}

	return null;
}

async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(
		`https://api.github.com/repos/${repo}/releases/latest`,
		{
			headers: { "User-Agent": "composer-coding-agent" },
		},
	);

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await finished(
		Readable.fromWeb(
			response.body as Parameters<typeof Readable.fromWeb>[0],
		).pipe(fileStream),
	);
}

async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	const version = await getLatestVersion(config.repo);

	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	await downloadFile(downloadUrl, archivePath);

	const extractDir = join(TOOLS_DIR, "extract_tmp");
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			spawnSync("tar", ["xzf", archivePath, "-C", extractDir], {
				stdio: "pipe",
			});
		} else if (assetName.endsWith(".zip")) {
			spawnSync("unzip", ["-o", archivePath, "-d", extractDir], {
				stdio: "pipe",
			});
		}

		const extractedDir = join(
			extractDir,
			assetName.replace(/\.(tar\.gz|zip)$/, ""),
		);
		const extractedBinary = join(extractedDir, config.binaryName + binaryExt);

		if (existsSync(extractedBinary)) {
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: ${extractedBinary}`);
		}

		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

export async function ensureTool(
	tool: "fd" | "rg",
	silent = false,
): Promise<string | null> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return null;

	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return path;
	} catch (e) {
		if (!silent) {
			console.log(
				chalk.yellow(
					`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`,
				),
			);
		}
		return null;
	}
}
