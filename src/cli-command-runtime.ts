import {
	isDirectRuntimeCommand,
	shouldAttemptDirectRuntimeDispatch,
} from "./cli/direct-runtime-command.js";

export async function runCliCommandRuntime(args: string[]): Promise<boolean> {
	if (!shouldAttemptDirectRuntimeDispatch(args)) {
		return false;
	}
	const { parseArgs } = await import("./cli/args.js");
	const parsed = parseArgs(args);
	const { scrubLoadedSecurityOverrideEnv } = await import("./load-env.js");
	scrubLoadedSecurityOverrideEnv();
	if (parsed.error || !isDirectRuntimeCommand(parsed.command)) {
		return false;
	}

	switch (parsed.command) {
		case "hosted-runner": {
			const { handleHostedRunnerCommand } = await import(
				"./cli/commands/hosted-runner.js"
			);
			await handleHostedRunnerCommand(parsed.commandArgs ?? [], {
				defaultPort: parsed.port,
			});
			return true;
		}
		case "init": {
			const { handleInitCommand } = await import("./cli/commands/init.js");
			await handleInitCommand(parsed.commandArgs ?? []);
			return true;
		}
		case "update": {
			const { handleUpdateCommand } = await import("./cli/commands/update.js");
			await handleUpdateCommand(parsed.commandArgs ?? []);
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
