import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveWebRoot(options: {
	baseDir: string;
	env?: NodeJS.ProcessEnv;
}): string {
	const env = options.env ?? process.env;
	const configuredRoot = env.MAESTRO_WEB_ROOT?.trim();
	if (configuredRoot) {
		return resolve(configuredRoot);
	}

	const builtWebRoot = join(options.baseDir, "../packages/web/dist");
	if (existsSync(join(builtWebRoot, "index.html"))) {
		return builtWebRoot;
	}

	return join(options.baseDir, "../packages/web");
}
