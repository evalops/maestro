import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type DetectedServer = {
	serverId:
		| "typescript"
		| "pyright"
		| "gopls"
		| "rust-analyzer"
		| "vue"
		| "eslint";
	root: string;
};

const LOCKFILES = [
	"package-lock.json",
	"bun.lockb",
	"bun.lock",
	"pnpm-lock.yaml",
	"yarn.lock",
];

const VUE_FILES = ["vue.config.js", "nuxt.config.ts", "nuxt.config.js"];

async function nearestRoot(
	targets: string[],
	start: string,
	stop: string,
): Promise<string | null> {
	let dir = start;
	const stopDir = stop;
	while (true) {
		for (const target of targets) {
			const candidate = join(dir, target);
			if (existsSync(candidate)) {
				return dirname(candidate);
			}
		}
		if (dir === stopDir) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

async function detectTypescriptRoot(cwd: string): Promise<string | null> {
	return nearestRoot(LOCKFILES, cwd, process.cwd());
}

async function detectVueRoot(cwd: string): Promise<string | null> {
	return nearestRoot([...LOCKFILES, ...VUE_FILES], cwd, process.cwd());
}

async function detectGoRoot(cwd: string): Promise<string | null> {
	const work = await nearestRoot(["go.work"], cwd, process.cwd());
	if (work) return work;
	return nearestRoot(["go.mod", "go.sum"], cwd, process.cwd());
}

async function detectRustRoot(cwd: string): Promise<string | null> {
	return nearestRoot(["Cargo.toml"], cwd, process.cwd());
}

async function detectPyRoot(cwd: string): Promise<string | null> {
	return nearestRoot(
		["pyproject.toml", "poetry.lock", "requirements.txt"],
		cwd,
		process.cwd(),
	);
}

async function detectEslintRoot(cwd: string): Promise<string | null> {
	return nearestRoot(
		[
			".eslintrc",
			".eslintrc.js",
			".eslintrc.cjs",
			"eslint.config.js",
			"eslint.config.cjs",
			...LOCKFILES,
		],
		cwd,
		process.cwd(),
	);
}

function hasBin(bin: string): boolean {
	const pathVar = process.env.PATH ?? "";
	for (const dir of pathVar.split(process.platform === "win32" ? ";" : ":")) {
		if (!dir) continue;
		if (existsSync(join(dir, bin))) return true;
	}
	return false;
}

export async function detectLspServers(cwd: string): Promise<DetectedServer[]> {
	const detections: DetectedServer[] = [];

	const tsRoot = await detectTypescriptRoot(cwd);
	if (tsRoot && hasBin("typescript-language-server")) {
		detections.push({ serverId: "typescript", root: tsRoot });
	}

	const vueRoot = await detectVueRoot(cwd);
	if (vueRoot && hasBin("vue-language-server")) {
		detections.push({ serverId: "vue", root: vueRoot });
	}

	const pyRoot = await detectPyRoot(cwd);
	if (pyRoot && hasBin("pyright-langserver")) {
		detections.push({ serverId: "pyright", root: pyRoot });
	}

	const goRoot = await detectGoRoot(cwd);
	if (goRoot && hasBin("gopls")) {
		detections.push({ serverId: "gopls", root: goRoot });
	}

	const rustRoot = await detectRustRoot(cwd);
	if (rustRoot && hasBin("rust-analyzer")) {
		detections.push({ serverId: "rust-analyzer", root: rustRoot });
	}

	const eslintRoot = await detectEslintRoot(cwd);
	if (eslintRoot && hasBin("vscode-eslint-language-server")) {
		detections.push({ serverId: "eslint", root: eslintRoot });
	}

	return detections;
}
