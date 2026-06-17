import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

function resolveMaestroHome(): string {
	return (
		process.env.MAESTRO_HOME ??
		join(
			process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
			".maestro",
		)
	);
}

export function trustProjectInGlobalConfig(workspaceDir: string): void {
	const maestroHome = resolveMaestroHome();
	mkdirSync(maestroHome, { recursive: true });
	appendFileSync(
		join(maestroHome, "config.toml"),
		`\n[projects.${JSON.stringify(resolve(workspaceDir))}]\ntrust_level = "trusted"\n`,
	);
}
