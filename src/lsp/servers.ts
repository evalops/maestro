import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LspServerConfig, RootResolver } from "./types.js";

const TS_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
];
const PYTHON_EXTENSIONS = [".py", ".pyi"];
const GO_EXTENSIONS = [".go"];
const RUST_EXTENSIONS = [".rs"];
const VUE_EXTENSIONS = [".vue"];

function which(binary: string): string | undefined {
	const { env } = process;
	const separator = process.platform === "win32" ? ";" : ":";
	const paths = (env.PATH ?? "").split(separator);
	const winSuffix = process.platform === "win32" ? ".cmd" : "";
	for (const entry of paths) {
		const candidate = resolve(entry, binary + winSuffix);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

async function ensureTsserver(): Promise<string | undefined> {
	return which("typescript-language-server");
}

async function ensurePyright(): Promise<string | undefined> {
	return which("pyright-langserver");
}

async function ensureGopls(): Promise<string | undefined> {
	return which("gopls");
}

async function ensureRustAnalyzer(): Promise<string | undefined> {
	return which("rust-analyzer");
}

async function ensureVueServer(): Promise<string | undefined> {
	return which("vue-language-server");
}

export async function createDefaultServers(
	rootResolver?: RootResolver,
): Promise<LspServerConfig[]> {
	const servers: LspServerConfig[] = [];

	// TypeScript/JavaScript
	const tsServer = await ensureTsserver();
	if (tsServer) {
		servers.push({
			id: "typescript",
			name: "TypeScript Language Server",
			command: tsServer,
			args: ["--stdio"],
			extensions: TS_EXTENSIONS,
			rootResolver,
		});
	}

	// Python
	const pyright = await ensurePyright();
	if (pyright) {
		servers.push({
			id: "python",
			name: "Pyright Language Server",
			command: pyright,
			args: ["--stdio"],
			extensions: PYTHON_EXTENSIONS,
			rootResolver,
		});
	}

	// Go
	const gopls = await ensureGopls();
	if (gopls) {
		servers.push({
			id: "go",
			name: "Go Language Server",
			command: gopls,
			args: ["serve"],
			extensions: GO_EXTENSIONS,
			rootResolver,
		});
	}

	// Rust
	const rustAnalyzer = await ensureRustAnalyzer();
	if (rustAnalyzer) {
		servers.push({
			id: "rust",
			name: "Rust Analyzer",
			command: rustAnalyzer,
			args: [],
			extensions: RUST_EXTENSIONS,
			rootResolver,
		});
	}

	// Vue
	const vueServer = await ensureVueServer();
	if (vueServer) {
		servers.push({
			id: "vue",
			name: "Vue Language Server",
			command: vueServer,
			args: ["--stdio"],
			extensions: VUE_EXTENSIONS,
			rootResolver,
		});
	}

	return servers;
}
