import {
	isDirectRuntimeCommand,
	isNativeUtilityCommand,
	shouldAttemptDirectRuntimeDispatch,
} from "./cli/direct-runtime-command.js";

export async function runCliCommandRuntime(args: string[]): Promise<boolean> {
	if (!shouldAttemptDirectRuntimeDispatch(args)) {
		return false;
	}
	const { parseArgs } = await import("./cli/args.js");
	const parsed = parseArgs(args);
	const { finalizeLoadedEnv } = await import("./load-env.js");
	finalizeLoadedEnv();
	if (parsed.error || !isDirectRuntimeCommand(parsed.command)) {
		return false;
	}

	if (isNativeUtilityCommand(parsed.command)) {
		const { launchNativeCli } = await import("./cli/native-tui-launcher.js");
		const exitCode = await launchNativeCli(args);
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return true;
	}

	switch (parsed.command) {
		case "hosted-runner": {
			const { buildNativeHostedRunnerArgs, launchNativeCli } = await import(
				"./cli/native-tui-launcher.js"
			);
			const exitCode = await launchNativeCli(
				buildNativeHostedRunnerArgs(parsed.commandArgs ?? [], parsed.port),
				{ forwardSignals: true },
			);
			if (exitCode !== 0) {
				process.exitCode = exitCode;
			}
			return true;
		}
		case "init": {
			const { handleInitCommand } = await import("./cli/commands/init.js");
			await handleInitCommand(parsed.commandArgs ?? []);
			return true;
		}
		case "skill": {
			const { buildCliConfigOverrides } = await import(
				"./config/runtime-config.js"
			);
			const { handleSkillCommand } = await import("./cli/commands/skill.js");
			const cliOverrides = buildCliConfigOverrides(parsed);
			const overrideProfile =
				typeof cliOverrides.profile === "string"
					? cliOverrides.profile
					: undefined;
			const profileName = parsed.profile ?? overrideProfile;
			await handleSkillCommand(parsed.subcommand, parsed.commandArgs ?? [], {
				profileName,
				cliOverrides,
			});
			return true;
		}
	}
	return false;
}
