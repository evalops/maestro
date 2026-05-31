export async function runCliRuntime(args: string[]): Promise<void> {
	if (args[0] === "a2a") {
		const { handleA2ACommand } = await import("./cli/commands/a2a.js");
		await handleA2ACommand(args.slice(1));
		return;
	}
	const { runCliCommandRuntime } = await import("./cli-command-runtime.js");
	if (await runCliCommandRuntime(args)) {
		return;
	}

	const loadMain = async () => {
		if (process.versions?.bun) {
			const tsEntry = "./main." + "ts";
			try {
				return await import(tsEntry);
			} catch {
				return await import("./main.js");
			}
		}
		return await import("./main.js");
	};

	const { main } = await loadMain();
	await main(args);
}
