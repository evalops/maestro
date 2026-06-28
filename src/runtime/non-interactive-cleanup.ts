const NON_INTERACTIVE_CLEANUP_GRACE_MS = 5_000;

export async function cleanupNonInteractiveRuntimeResources(): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeout = setTimeout(
			() => resolve("timeout"),
			NON_INTERACTIVE_CLEANUP_GRACE_MS,
		);
	});
	const cleanupPromise = (async (): Promise<"done"> => {
		try {
			const [{ mcpManager }, { lspManager }] = await Promise.all([
				import("../mcp/manager.js"),
				import("../lsp/manager.js"),
			]);
			await Promise.allSettled([
				mcpManager.disconnectAll(),
				lspManager.shutdownAll(),
			]);
		} catch {
			// Best-effort shutdown must not mask the command's original result.
		}
		return "done";
	})();
	try {
		const result = await Promise.race([cleanupPromise, timeoutPromise]);
		if (result === "timeout") {
			await cleanupPromise;
		}
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}
