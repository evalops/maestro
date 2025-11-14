import chalk from "chalk";
import { exportFactoryConfig } from "../factory-sync.js";

async function main(): Promise<void> {
	try {
		const result = exportFactoryConfig();
		const createdExtra = result.createdSettings
			? " and created Factory settings file."
			: ".";
		console.log(
			chalk.green(
				`Exported ${result.modelCount} model${result.modelCount === 1 ? "" : "s"} to ${result.configPath}${createdExtra}`,
			),
		);
	} catch (error: unknown) {
		console.error(
			chalk.red(
				`Factory export failed: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
		process.exit(1);
	}
}

main();
