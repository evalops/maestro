export async function runCliRuntime(args: string[]): Promise<void> {
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
