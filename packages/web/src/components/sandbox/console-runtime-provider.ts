import type { SandboxRuntimeProvider } from "./sandbox-runtime-provider.js";

export interface ConsoleLog {
	level: "log" | "warn" | "error" | "info";
	text: string;
	ts: number;
	args?: unknown[];
}

export interface SandboxConsoleSnapshot {
	logs: ConsoleLog[];
	lastError: { message: string; stack?: string; ts: number } | null;
	updatedAt: number;
}

const STORE = new Map<string, SandboxConsoleSnapshot>();
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const MAX_SNAPSHOTS = 200;

function pruneStore(now = Date.now()): void {
	for (const [key, snap] of STORE.entries()) {
		if (now - snap.updatedAt > SNAPSHOT_TTL_MS) {
			STORE.delete(key);
		}
	}
	if (STORE.size <= MAX_SNAPSHOTS) return;
	const entries = Array.from(STORE.entries()).sort(
		(a, b) => a[1].updatedAt - b[1].updatedAt,
	);
	const excess = STORE.size - MAX_SNAPSHOTS;
	for (let i = 0; i < excess; i += 1) {
		const entry = entries[i];
		if (entry) {
			STORE.delete(entry[0]);
		}
	}
}

export function clearSandboxConsoleSnapshot(sandboxId: string): void {
	STORE.set(sandboxId, { logs: [], lastError: null, updatedAt: Date.now() });
	pruneStore();
}

export function getSandboxConsoleSnapshot(
	sandboxId: string,
): SandboxConsoleSnapshot | null {
	pruneStore();
	return STORE.get(sandboxId) ?? null;
}

function ensureSnapshot(sandboxId: string): SandboxConsoleSnapshot {
	pruneStore();
	const existing = STORE.get(sandboxId);
	if (existing) return existing;
	const next: SandboxConsoleSnapshot = {
		logs: [],
		lastError: null,
		updatedAt: Date.now(),
	};
	STORE.set(sandboxId, next);
	return next;
}

type ConsoleMethod = "log" | "warn" | "error" | "info";
type OriginalConsole = Record<ConsoleMethod, (...args: unknown[]) => void>;

export class ConsoleRuntimeProvider implements SandboxRuntimeProvider {
	getData(): Record<string, unknown> {
		return {};
	}

	getDescription(): string {
		return "";
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			type SandboxWindow = Window &
				typeof globalThis & {
					__composerOriginalConsole?: OriginalConsole;
					__composerErrorHandlersAttached?: boolean;
					__composerErrorHandler?: (event: ErrorEvent) => void;
					__composerRejectionHandler?: (event: PromiseRejectionEvent) => void;
					__composerPostRuntimeMessage?: (message: unknown) => void;
					postRuntimeMessage?: (message: unknown) => void;
				};
			const w = window as unknown as SandboxWindow;

			if (!w.__composerOriginalConsole) {
				w.__composerOriginalConsole = {
					log: console.log.bind(console),
					error: console.error.bind(console),
					warn: console.warn.bind(console),
					info: console.info.bind(console),
				};
			}

			const originalConsole = w.__composerOriginalConsole;

			const defaultPost = (message: unknown) => {
				try {
					window.parent.postMessage(message, "*");
				} catch {
					// ignore
				}
			};

			w.__composerPostRuntimeMessage = w.postRuntimeMessage ?? defaultPost;

			const post = (message: unknown) => {
				try {
					(w.__composerPostRuntimeMessage ?? defaultPost)(message);
				} catch {
					// ignore
				}
			};

			const c = console as unknown as Record<
				ConsoleMethod,
				(...args: unknown[]) => void
			>;
			const methods: ConsoleMethod[] = ["log", "warn", "error", "info"];
			for (const method of methods) {
				c[method] = (...args: unknown[]) => {
					try {
						originalConsole[method](...args);
					} catch {
						// ignore
					}

					const text = args
						.map((arg) => {
							try {
								return typeof arg === "object"
									? JSON.stringify(arg)
									: String(arg);
							} catch {
								return String(arg);
							}
						})
						.join(" ");

					post({
						type: "console",
						method,
						text,
						args,
					});
				};
			}

			const postError = (err: unknown) => {
				const maybeErr = err as { message?: unknown; stack?: unknown } | null;
				const message =
					typeof maybeErr?.message === "string"
						? maybeErr.message
						: typeof err === "string"
							? err
							: "Unknown error";
				const stack =
					typeof maybeErr?.stack === "string" ? maybeErr.stack : undefined;
				post({
					type: "sandbox-error",
					error: { message, stack },
				});
			};

			if (!w.__composerErrorHandlersAttached) {
				w.__composerErrorHandlersAttached = true;
				w.__composerErrorHandler = (e) => {
					const evt = e as ErrorEvent;
					postError(evt.error ?? evt.message);
				};
				w.__composerRejectionHandler = (e) => {
					const evt = e as PromiseRejectionEvent;
					postError(evt.reason);
				};
				window.addEventListener("error", w.__composerErrorHandler);
				window.addEventListener(
					"unhandledrejection",
					w.__composerRejectionHandler,
				);
			}
		};
	}

	async handleMessage(
		message: unknown,
		respond: (response: unknown) => void,
	): Promise<void> {
		if (!message || typeof message !== "object") return;
		const m = message as Record<string, unknown>;

		if (m.type === "console") {
			const sandboxId =
				typeof m.sandboxId === "string" ? m.sandboxId : "sandbox";
			const snap = ensureSnapshot(sandboxId);
			const method = m.method;
			const level =
				method === "warn"
					? "warn"
					: method === "error"
						? "error"
						: method === "info"
							? "info"
							: "log";
			snap.logs.push({
				level,
				text: typeof m.text === "string" ? m.text : "",
				ts: Date.now(),
				args: Array.isArray(m.args) ? (m.args as unknown[]) : undefined,
			});
			snap.updatedAt = Date.now();
			pruneStore();
			respond({ success: true });
			return;
		}

		if (m.type === "sandbox-error") {
			const sandboxId =
				typeof m.sandboxId === "string" ? m.sandboxId : "sandbox";
			const snap = ensureSnapshot(sandboxId);
			const err = m.error;
			if (err && typeof err === "object") {
				const rec = err as Record<string, unknown>;
				snap.lastError = {
					message:
						typeof rec.message === "string" ? rec.message : "Unknown error",
					stack: typeof rec.stack === "string" ? rec.stack : undefined,
					ts: Date.now(),
				};
			} else {
				snap.lastError = { message: "Unknown error", ts: Date.now() };
			}
			snap.updatedAt = Date.now();
			pruneStore();
			respond({ success: true });
		}
	}
}
