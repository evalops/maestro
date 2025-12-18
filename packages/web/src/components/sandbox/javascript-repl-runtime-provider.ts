import type { SandboxRuntimeProvider } from "./sandbox-runtime-provider.js";

export class JavascriptReplRuntimeProvider implements SandboxRuntimeProvider {
	constructor(
		private code: string,
		private opts?: { timeoutMs?: number },
	) {}

	getData(): Record<string, unknown> {
		return {
			__composerReplCode: this.code,
			__composerReplTimeoutMs: this.opts?.timeoutMs ?? 10_000,
		};
	}

	getDescription(): string {
		return `JavaScript REPL Runtime
- Runs your code in an async function (supports await)
- Sends execution-complete/execution-error to the host`;
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			type SandboxWindow = Window &
				typeof globalThis & {
					__composerReplCode?: unknown;
					__composerReplTimeoutMs?: unknown;
					postRuntimeMessage?: (message: unknown) => void;
				};
			const w = window as unknown as SandboxWindow;

			const post =
				w.postRuntimeMessage ??
				((message: unknown) => {
					try {
						window.parent.postMessage(message, "*");
					} catch {
						// ignore
					}
				});

			const timeoutMs =
				typeof w.__composerReplTimeoutMs === "number"
					? w.__composerReplTimeoutMs
					: 10_000;

			const code =
				typeof w.__composerReplCode === "string" ? w.__composerReplCode : "";

			const safeSerialize = (value: unknown): string => {
				if (typeof value === "string") return value;
				try {
					return JSON.stringify(value, null, 2);
				} catch {
					return String(value);
				}
			};

			const run = async (): Promise<void> => {
				let timeout: number | undefined;
				try {
					const work = (async () => {
						const fn = new Function(
							`return (async () => {\\n${code}\\n})();`,
						) as () => Promise<unknown>;
						return await fn();
					})();

					const result = await new Promise<unknown>((resolve, reject) => {
						timeout = window.setTimeout(() => {
							reject(new Error("Execution timed out"));
						}, timeoutMs);
						void work.then(resolve, reject);
					});

					post({
						type: "execution-complete",
						returnValue: safeSerialize(result),
					});
				} catch (err) {
					const maybeErr = err as { message?: unknown; stack?: unknown } | null;
					post({
						type: "execution-error",
						error: {
							message:
								typeof maybeErr?.message === "string"
									? maybeErr.message
									: String(err),
							stack: typeof maybeErr?.stack === "string" ? maybeErr.stack : "",
						},
					});
				} finally {
					if (timeout !== undefined) {
						window.clearTimeout(timeout);
					}
				}
			};

			void run();
		};
	}
}
