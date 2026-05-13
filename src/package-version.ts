import { createRequire } from "node:module";

export function readPackageVersion(): string {
	try {
		const packageJson = createRequire(import.meta.url)("../package.json") as {
			version?: string;
		};
		return packageJson.version ?? "unknown";
	} catch {
		return process.env.MAESTRO_VERSION ?? "unknown";
	}
}
