import chalk from "chalk";
import { importFactoryConfig } from "../factory/index.js";

async function main(): Promise<void> {
	try {
		const result = importFactoryConfig();
		console.log(
			chalk.green(
				`Imported ${result.modelCount} model${result.modelCount === 1 ? "" : "s"} from Factory (${result.providerCount} provider${result.providerCount === 1 ? "" : "s"}) into ${result.targetPath}`,
			),
		);
	} catch (error: unknown) {
		console.error(
			chalk.red(
				`Factory import failed: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
		process.exit(1);
	}
}

main();
