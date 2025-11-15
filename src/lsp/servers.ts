import { existsSync } from "node:fs";
import { constants, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LspServerConfig } from "./index.js";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

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
	const local = which("typescript-language-server");
	if (local) return local;
	// fallback to npx style invocation
	return undefined;
}

export async function createDefaultServers(): Promise<LspServerConfig[]> {
	const servers: LspServerConfig[] = [];
	const tsServer = await ensureTsserver();
	if (tsServer) {
		servers.push({
			id: "typescript",
			name: "TypeScript Language Server",
			command: tsServer,
			args: ["--stdio"],
			extensions: DEFAULT_EXTENSIONS,
			rootResolver: async (file) => dirname(file),
		});
	}
	return servers;
}
