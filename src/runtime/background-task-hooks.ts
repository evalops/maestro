import { backgroundTaskManager } from "../tools/background-tasks.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("background-task-hooks");
const CLEANUP_TIMEOUT_MS = 2_000;

let hooksRegistered = false;
let cleanupPromise: Promise<void> | null = null;
let exitingSignal: NodeJS.Signals | null = null;

async function stopBackgroundTasks(): Promise<void> {
	if (cleanupPromise) {
		return cleanupPromise;
	}
	cleanupPromise = (async () => {
		try {
			await Promise.race([
				backgroundTaskManager.stopAll(),
				new Promise<void>((resolve) => {
					const timeout = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
					timeout.unref();
				}),
			]);
		} catch (error) {
			logger.warn("Failed to stop background tasks", { error });
		} finally {
			cleanupPromise = null;
		}
	})();
	return cleanupPromise;
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
	return signal === "SIGINT" ? 130 : 0;
}

export function registerBackgroundTaskShutdownHooks(): void {
	if (hooksRegistered) {
		return;
	}
	// Don't register signal handlers in test mode - vitest manages process lifecycle
	if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
		return;
	}
	hooksRegistered = true;
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];
	const handleSignal = (signal: NodeJS.Signals) => {
		if (exitingSignal) {
			if (signal !== exitingSignal) {
				logger.warn("Received additional signal while shutting down", {
					signal,
					exitingSignal,
				});
			}
			return;
		}
		exitingSignal = signal;
		stopBackgroundTasks()
			.catch((error) => {
				logger.warn("Background task cleanup failed", { error });
			})
			.finally(() => {
				process.exit(exitCodeForSignal(signal));
			});
	};
	for (const signal of signals) {
		process.on(signal, handleSignal);
	}
	process.once("beforeExit", () => {
		stopBackgroundTasks().catch((error) => {
			logger.warn("Background task cleanup failed", { error });
		});
	});
}
