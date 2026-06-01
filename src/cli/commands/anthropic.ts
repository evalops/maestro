import chalk from "chalk";

export async function handleAnthropicCommand(): Promise<void> {
	console.error(
		chalk.red(
			"Anthropic OAuth login has been removed. Set ANTHROPIC_API_KEY to use Anthropic models, or run `maestro codex login` for the default Codex flow.",
		),
	);
	process.exit(1);
}
