import chalk from "chalk";
import {
	formatManagedEvalOpsStatus,
	resolveManagedEvalOpsContext,
} from "../../evalops/managed-context.js";

export async function handleStatusCommand(): Promise<void> {
	const context = resolveManagedEvalOpsContext();
	console.log(chalk.bold("Maestro status"));
	console.log(formatManagedEvalOpsStatus(context));
	if (!context.authenticated) {
		console.log(
			chalk.dim('Run "maestro init" to bring EvalOps managed mode online.'),
		);
	}
}
