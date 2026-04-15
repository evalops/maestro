import type { SandboxRuntimeProvider } from "./sandbox-runtime-provider.js";

export interface ArtifactLike {
	filename: string;
	content: string;
}

type ArtifactAction = "list" | "get" | "createOrUpdate" | "delete";

export class ArtifactsRuntimeProvider implements SandboxRuntimeProvider {
	constructor(
		private getArtifacts: () => ArtifactLike[],
		private opts?: {
			createOrUpdate?: (
				filename: string,
				content: string,
			) => Promise<void> | void;
			delete?: (filename: string) => Promise<void> | void;
		},
	) {}

	getData(): Record<string, unknown> {
		const snapshot: Record<string, string> = {};
		for (const a of this.getArtifacts()) {
			if (!a?.filename) continue;
			snapshot[a.filename] = a.content ?? "";
		}
		return { artifacts: snapshot };
	}

	getDescription(): string {
		const rw =
			this.opts?.createOrUpdate || this.opts?.delete
				? "\n- createOrUpdateArtifact(filename: string, content: any): Promise<void>\n- deleteArtifact(filename: string): Promise<void>"
				: "";
		return `Artifacts Runtime (read-only)
- listArtifacts(): Promise<string[]>
- getArtifact(filename: string): Promise<string>${rw}`;
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			type RuntimeResponse = { response?: unknown };
			type ArtifactOpResult =
				| { success: true; result?: unknown }
				| { success: false; error?: string };
			type SandboxWindow = Window &
				typeof globalThis & {
					sendRuntimeMessage?: (message: unknown) => Promise<RuntimeResponse>;
					artifacts?: Record<string, string>;
					listArtifacts?: () => Promise<string[]>;
					getArtifact?: (filename: string) => Promise<unknown>;
					createOrUpdateArtifact?: (
						filename: string,
						content: unknown,
					) => Promise<void>;
					deleteArtifact?: (filename: string) => Promise<void>;
				};

			const w = window as SandboxWindow;
			const isJsonFile = (filename: string) => filename.endsWith(".json");

			w.listArtifacts = async (): Promise<string[]> => {
				if (w.sendRuntimeMessage) {
					const res = await w.sendRuntimeMessage({
						type: "artifact-operation",
						action: "list",
					});
					const payload = res?.response as ArtifactOpResult | undefined;
					if (!payload?.success) {
						throw new Error(payload?.error || "listArtifacts failed");
					}
					return Array.isArray(payload.result)
						? (payload.result as string[])
						: [];
				}
				return Object.keys(w.artifacts || {});
			};

			w.getArtifact = async (filename: string): Promise<unknown> => {
				let content: string;
				if (w.sendRuntimeMessage) {
					const res = await w.sendRuntimeMessage({
						type: "artifact-operation",
						action: "get",
						filename,
					});
					const payload = res?.response as ArtifactOpResult | undefined;
					if (!payload?.success) {
						throw new Error(payload?.error || "getArtifact failed");
					}
					content =
						typeof payload.result === "string"
							? (payload.result as string)
							: "";
				} else {
					const offline = w.artifacts?.[filename];
					if (typeof offline !== "string") {
						throw new Error("Artifact not found (offline mode)");
					}
					content = offline;
				}

				if (isJsonFile(filename)) {
					try {
						return JSON.parse(content);
					} catch (e) {
						throw new Error(`Failed to parse JSON from ${filename}: ${e}`);
					}
				}
				return content;
			};

			w.createOrUpdateArtifact = async (
				filename: string,
				content: unknown,
			): Promise<void> => {
				if (!w.sendRuntimeMessage) {
					throw new Error("createOrUpdateArtifact requires runtime bridge");
				}
				const finalContent =
					typeof content === "string"
						? content
						: JSON.stringify(content, null, 2);
				const res = await w.sendRuntimeMessage({
					type: "artifact-operation",
					action: "createOrUpdate",
					filename,
					content: finalContent,
				});
				const payload = res?.response as ArtifactOpResult | undefined;
				if (!payload?.success) {
					throw new Error(payload?.error || "createOrUpdateArtifact failed");
				}
			};

			w.deleteArtifact = async (filename: string): Promise<void> => {
				if (!w.sendRuntimeMessage) {
					throw new Error("deleteArtifact requires runtime bridge");
				}
				const res = await w.sendRuntimeMessage({
					type: "artifact-operation",
					action: "delete",
					filename,
				});
				const payload = res?.response as ArtifactOpResult | undefined;
				if (!payload?.success) {
					throw new Error(payload?.error || "deleteArtifact failed");
				}
			};
		};
	}

	async handleMessage(
		message: unknown,
		respond: (response: unknown) => void,
	): Promise<void> {
		if (!message || typeof message !== "object") return;
		const m = message as Record<string, unknown>;
		if (m.type !== "artifact-operation") return;

		const action = m.action as ArtifactAction | undefined;
		const artifacts = this.getArtifacts();

		if (action === "list") {
			respond({ success: true, result: artifacts.map((a) => a.filename) });
			return;
		}

		if (action === "get") {
			const filename = typeof m.filename === "string" ? m.filename : "";
			const found = artifacts.find((a) => a.filename === filename);
			if (!found) {
				respond({ success: false, error: `Artifact not found: ${filename}` });
				return;
			}
			respond({ success: true, result: found.content ?? "" });
			return;
		}

		if (action === "createOrUpdate") {
			if (!this.opts?.createOrUpdate) {
				respond({ success: false, error: "Artifacts runtime is read-only" });
				return;
			}
			const filename = typeof m.filename === "string" ? m.filename : "";
			const content = typeof m.content === "string" ? m.content : "";
			await this.opts.createOrUpdate(filename, content);
			respond({ success: true });
			return;
		}

		if (action === "delete") {
			if (!this.opts?.delete) {
				respond({ success: false, error: "Artifacts runtime is read-only" });
				return;
			}
			const filename = typeof m.filename === "string" ? m.filename : "";
			await this.opts.delete(filename);
			respond({ success: true });
		}
	}
}
