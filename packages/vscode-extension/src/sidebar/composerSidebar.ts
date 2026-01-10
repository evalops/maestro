import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as vscode from "vscode";

import { buildComposerUrl } from "../lib/actions.js";
import {
	ApiClient,
	type CommandDefinition,
	type Message,
	type Session,
} from "../lib/api-client.js";
import type { ThinkingManager } from "../lib/decorations.js";
import {
	type RawMessage,
	convertToComposerMessage,
} from "../lib/message-converter.js";
import { getWebviewHtml } from "./webview-template.js";

export class ComposerSidebarProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	public static readonly viewType = "composer.chatView";

	private _view?: vscode.WebviewView;
	private _apiClient: ApiClient;
	private _messages: Message[] = [];
	private _currentSessionId?: string;
	private _disposables: vscode.Disposable[] = [];
	private _isProcessing = false;
	private _creatingSession?: Promise<Session>;
	private _pinnedFiles: Set<string> = new Set(); // Stores fs paths of pinned files
	private _searchRequestId = 0;

	private _abortController?: AbortController;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _thinkingManager: ThinkingManager,
		private readonly _context: vscode.ExtensionContext,
	) {
		const config = vscode.workspace.getConfiguration("composer");
		const baseUrl =
			config.get<string>("apiEndpoint") || "http://localhost:8080";
		this._apiClient = new ApiClient(baseUrl);

		// Load history from state
		const savedMessages =
			this._context.workspaceState.get<Message[]>("composer.messages");
		if (savedMessages) {
			this._messages = savedMessages;
		}
		const savedSessionId =
			this._context.workspaceState.get<string>("composer.sessionId");
		if (savedSessionId) {
			this._currentSessionId = savedSessionId;
		}
	}

	public dispose() {
		this._abortController?.abort();
		this._abortController = undefined;
		this._view = undefined;
		this._isProcessing = false;
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
	}

	public clearChat() {
		this._abortController?.abort();
		this._abortController = undefined;
		this._isProcessing = false;
		this._messages = [];
		this._currentSessionId = undefined;
		this._context.workspaceState.update("composer.messages", undefined);
		this._context.workspaceState.update("composer.sessionId", undefined);
		if (this._view) {
			this._view.webview.postMessage({ type: "clear" });
			this._view.webview.postMessage({ type: "busy", value: false });
		}
	}

	public async addToContext() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage("No active editor to add to context.");
			return;
		}
		const path = editor.document.uri.fsPath;
		if (this._pinnedFiles.has(path)) {
			return;
		}
		this._pinnedFiles.add(path);
		this._updateContextUI();
	}

	public async removeFromContext(uri?: vscode.Uri) {
		if (uri) {
			this._pinnedFiles.delete(uri.fsPath);
		} else {
			// If no uri provided, maybe show picker? Or just clear all?
			// For now, let's assume this is called via command palette which might need inputs
			// Better: show quick pick of pinned files
			if (this._pinnedFiles.size === 0) {
				vscode.window.showInformationMessage("No pinned files to remove.");
				return;
			}
			const items = Array.from(this._pinnedFiles).map((p) => ({
				label: vscode.workspace.asRelativePath(p),
				path: p,
			}));
			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: "Select file to remove from context",
			});
			if (selected) {
				this._pinnedFiles.delete(selected.path);
			}
		}
		this._updateContextUI();
	}

	public async showCommandPicker() {
		try {
			const commands = await this._apiClient.getCommands();
			if (commands.length === 0) {
				vscode.window.showInformationMessage("No commands found in catalog.");
				return;
			}

			const items = commands.map((c) => ({
				label: c.name,
				description: c.description,
				detail: c.prompt,
				command: c,
			}));

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: "Select a command to run",
			});

			if (selected) {
				// Handle args
				const args = selected.command.args;
				let finalText = selected.command.prompt;

				if (args && args.length > 0) {
					for (const arg of args) {
						const value = await vscode.window.showInputBox({
							prompt: `Enter value for ${arg.name}`,
							placeHolder: arg.required ? "Required" : "Optional",
						});
						if (arg.required && !value) {
							return; // User cancelled required arg
						}
						// Replace {{arg}} with value (escape special regex chars in arg name)
						const escapedName = arg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
						finalText = finalText.replace(
							new RegExp(`\\{\\{${escapedName}\\}\\}`, "g"),
							value || "",
						);
					}
				}

				// If the prompt has other {{placeholders}} not in args, warn or leave them?
				// For now assume simple replacement.

				this._handleUserMessage(finalText);
			}
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to load commands: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	public async showSessionPicker() {
		try {
			const sessions = await this._apiClient.listSessions();
			const items = sessions.map((s) => ({
				label: s.title || s.id,
				description: s.id,
				detail: `Messages: ${s.messageCount} • Last updated: ${new Date(s.updatedAt).toLocaleString()}`,
				sessionId: s.id,
			}));

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: "Select a session to resume",
			});

			if (selected) {
				await this.switchSession(selected.sessionId);
			}
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	public async switchSession(sessionId: string) {
		// Clean up any pending operations from the previous session
		if (this._abortController) {
			this._abortController.abort();
			this._abortController = undefined;
		}
		this._isProcessing = false;

		try {
			const session = await this._apiClient.getSession(sessionId);
			this._currentSessionId = session.id;
			this._messages = session.messages;
			this._context.workspaceState.update("composer.messages", this._messages);
			this._context.workspaceState.update(
				"composer.sessionId",
				this._currentSessionId,
			);

			if (this._view) {
				this._view.webview.postMessage({
					type: "history",
					messages: this._messages,
				});
			}
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to load session: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		this._disposables.push(
			webviewView.onDidDispose(() => {
				this.dispose();
			}),
		);

		const messageDisposable = webviewView.webview.onDidReceiveMessage(
			async (data) => {
				switch (data.type) {
					case "openDocs": {
						vscode.env.openExternal(vscode.Uri.parse(buildComposerUrl("docs")));
						break;
					}
					case "getEditorContext": {
						this._updateContextUI(); // Send current context + active editor
						break;
					}
					case "getHistory": {
						if (this._messages.length > 0) {
							this._view?.webview.postMessage({
								type: "history",
								messages: this._messages,
							});
						}
						break;
					}
					case "sendMessage": {
						this._handleUserMessage(data.text);
						break;
					}
					case "onInfo": {
						if (data.value) vscode.window.showInformationMessage(data.value);
						break;
					}
					case "onError": {
						if (data.value) vscode.window.showErrorMessage(data.value);
						break;
					}
					case "submitApproval": {
						await this._apiClient.submitApproval(data.requestId, data.decision);
						break;
					}
					case "removePinnedFile": {
						this._pinnedFiles.delete(data.path);
						this._updateContextUI();
						break;
					}
					case "searchFiles": {
						const query = data.query || "";
						const requestId = ++this._searchRequestId;
						const glob = query ? `**/*${query}*` : "**/*";
						// Common excludes
						const exclude =
							"{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**}";
						try {
							const files = await vscode.workspace.findFiles(glob, exclude, 50);
							// Ignore stale results if a newer search was initiated
							if (requestId !== this._searchRequestId) break;
							const filePaths = files.map((f) =>
								vscode.workspace.asRelativePath(f),
							);
							this._view?.webview.postMessage({
								type: "searchResults",
								files: filePaths,
								query,
							});
						} catch (e) {
							console.error("File search failed", e);
						}
						break;
					}
				}
			},
		);
		this._disposables.push(messageDisposable);

		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => {
				this._updateContextUI();
			}),
		);

		this._disposables.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (
					e.document === vscode.window.activeTextEditor?.document &&
					e.contentChanges.length > 0
				) {
					this._updateContextUI();
				}
			}),
		);

		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("composer.apiEndpoint")) {
					const config = vscode.workspace.getConfiguration("composer");
					const baseUrl =
						config.get<string>("apiEndpoint") || "http://localhost:8080";
					this._apiClient = new ApiClient(baseUrl);
					this.clearChat();
					if (this._view) {
						this._view.webview.postMessage({ type: "history", messages: [] });
					}
					vscode.window.showInformationMessage(
						"Composer endpoint changed. Chat history was cleared to avoid mixing sessions.",
					);
				}
			}),
		);
	}

	private async _handleClientTool(
		id: string,
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<void> {
		const checkAbort = () => {
			if (signal?.aborted) {
				throw new Error("Request cancelled");
			}
		};
		const toPromise = <T>(value: Promise<T> | Thenable<T>): Promise<T> =>
			Promise.resolve(value);
		const raceWithAbort = <T>(promise: Promise<T>, abortSignal?: AbortSignal) =>
			new Promise<T>((resolve, reject) => {
				if (abortSignal?.aborted) {
					reject(new Error("Request cancelled"));
					return;
				}
				const onAbort = () => {
					reject(new Error("Request cancelled"));
				};
				abortSignal?.addEventListener("abort", onAbort, { once: true });
				promise
					.then((v) => {
						abortSignal?.removeEventListener("abort", onAbort);
						resolve(v);
					})
					.catch((err) => {
						abortSignal?.removeEventListener("abort", onAbort);
						reject(err);
					});
			});

		const submitResult = async (
			payload: Array<{ type: string; text?: string; [key: string]: unknown }>,
			isError: boolean,
		) => {
			checkAbort();
			await raceWithAbort(
				this._apiClient.submitClientToolResult(id, payload, isError),
				signal,
			);
		};
		checkAbort();
		// Helper to validate paths are within workspace (prevents path traversal attacks)
		const validateWorkspacePath = (filePath: string): vscode.Uri => {
			const pathExists = (p: string) => {
				try {
					return existsSync(p);
				} catch {
					return false;
				}
			};
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error("No workspace folder open");
			}

			const path = require("node:path");
			// If caller provided a workspaceFolder hint, prefer that
			const workspaceFolderHint =
				typeof args?.workspaceFolder === "string" ? args.workspaceFolder : null;
			let targetWorkspace = workspaceFolderHint
				? workspaceFolders.find(
						(wf) =>
							wf.name === workspaceFolderHint ||
							workspaceFolderHint.startsWith(wf.uri.fsPath),
					)
				: undefined;

			// Otherwise use the workspace that contains the active editor, else first
			if (!targetWorkspace) {
				targetWorkspace =
					vscode.workspace.getWorkspaceFolder(
						vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.file(""),
					) ?? workspaceFolders[0];
			}

			const tryResolve = (root: vscode.WorkspaceFolder | undefined) =>
				path.isAbsolute(filePath)
					? path.resolve(filePath)
					: path.resolve(root?.uri.fsPath ?? "", filePath);

			let normalizedPath = tryResolve(targetWorkspace);

			// If relative path doesn’t exist under that root and we have multiple roots,
			// try each workspace root to find a match.
			if (workspaceFolders.length > 1 && !pathExists(normalizedPath)) {
				for (const wf of workspaceFolders) {
					const candidate = tryResolve(wf);
					if (pathExists(candidate)) {
						normalizedPath = candidate;
						targetWorkspace = wf;
						break;
					}
				}
			}

			// Resolve relative paths against workspace root, not CWD
			// This ensures "src/file.ts" resolves to "/workspace/src/file.ts"
			// Also normalizes ".." sequences to prevent traversal attacks
			const uri = vscode.Uri.file(normalizedPath);

			// Use VS Code's built-in workspace folder check
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
			if (!workspaceFolder) {
				throw new Error(
					"File access outside workspace is not allowed for security reasons",
				);
			}

			// Double-check: ensure normalized path starts with workspace folder path
			// This catches edge cases where getWorkspaceFolder might behave unexpectedly
			const workspaceRoot = workspaceFolder.uri.fsPath;

			// Normalize for case-insensitive comparison on Windows to prevent
			// path traversal attacks via casing manipulation
			const isWindows = process.platform === "win32";
			const normalizedPathCheck = isWindows
				? normalizedPath.toLowerCase()
				: normalizedPath;
			const workspaceRootCheck = isWindows
				? workspaceRoot.toLowerCase()
				: workspaceRoot;

			if (
				!normalizedPathCheck.startsWith(workspaceRootCheck + path.sep) &&
				normalizedPathCheck !== workspaceRootCheck
			) {
				throw new Error(
					"File access outside workspace is not allowed for security reasons",
				);
			}

			return uri;
		};

		try {
			let result: Array<{
				type: string;
				text?: string;
				[key: string]: unknown;
			}> = [];
			if (name === "vscode_get_diagnostics") {
				checkAbort();
				const uriArg = typeof args.uri === "string" ? args.uri : undefined;
				const uri = uriArg ? validateWorkspacePath(uriArg) : undefined;
				let allDiagnosticItems: vscode.Diagnostic[] = [];

				if (uri) {
					// Single file: returns Diagnostic[]
					allDiagnosticItems = vscode.languages.getDiagnostics(uri);
				} else {
					// All files: returns [Uri, Diagnostic[]][]
					const allDiagnostics = vscode.languages.getDiagnostics();
					for (const [, fileDiagnostics] of allDiagnostics) {
						allDiagnosticItems.push(...fileDiagnostics);
					}
				}
				checkAbort();

				const allDiagnostics = allDiagnosticItems.map((d) => ({
					message: d.message,
					severity: d.severity,
					range: {
						start: {
							line: d.range.start.line,
							character: d.range.start.character,
						},
						end: { line: d.range.end.line, character: d.range.end.character },
					},
					source: d.source,
					code: d.code,
				}));
				result = [
					{
						type: "text",
						text: JSON.stringify(allDiagnostics, null, 2),
					},
				];
			} else if (name === "vscode_get_definition") {
				checkAbort();
				if (
					typeof args.uri !== "string" ||
					typeof args.line !== "number" ||
					typeof args.character !== "number"
				) {
					throw new Error(
						"vscode_get_definition requires uri (string), line (number), and character (number)",
					);
				}
				const uri = validateWorkspacePath(args.uri);
				const pos = new vscode.Position(args.line, args.character);
				const definitions = await raceWithAbort(
					toPromise(
						vscode.commands.executeCommand<
							(vscode.Location | vscode.LocationLink)[]
						>("vscode.executeDefinitionProvider", uri, pos),
					),
					signal,
				);
				const formatted = definitions.map((d) => {
					if ("targetUri" in d) {
						// LocationLink
						return {
							uri: d.targetUri.fsPath,
							range: {
								start: {
									line: d.targetRange.start.line,
									character: d.targetRange.start.character,
								},
								end: {
									line: d.targetRange.end.line,
									character: d.targetRange.end.character,
								},
							},
						};
					}
					// Location
					return {
						uri: d.uri.fsPath,
						range: {
							start: {
								line: d.range.start.line,
								character: d.range.start.character,
							},
							end: { line: d.range.end.line, character: d.range.end.character },
						},
					};
				});
				result = [{ type: "text", text: JSON.stringify(formatted, null, 2) }];
			} else if (name === "vscode_find_references") {
				checkAbort();
				if (
					typeof args.uri !== "string" ||
					typeof args.line !== "number" ||
					typeof args.character !== "number"
				) {
					throw new Error(
						"vscode_find_references requires uri (string), line (number), and character (number)",
					);
				}
				const uri = validateWorkspacePath(args.uri);
				const pos = new vscode.Position(args.line, args.character);
				const references =
					(await raceWithAbort(
						toPromise(
							vscode.commands.executeCommand<vscode.Location[]>(
								"vscode.executeReferenceProvider",
								uri,
								pos,
							),
						),
						signal,
					)) || [];
				const formatted = references.map((d) => ({
					uri: d.uri.fsPath,
					range: {
						start: {
							line: d.range.start.line,
							character: d.range.start.character,
						},
						end: { line: d.range.end.line, character: d.range.end.character },
					},
				}));
				result = [{ type: "text", text: JSON.stringify(formatted, null, 2) }];
			} else if (name === "vscode_read_file_range") {
				checkAbort();
				// Validate args
				if (typeof args.uri !== "string") {
					throw new Error("vscode_read_file_range requires uri (string)");
				}
				if (
					typeof args.startLine !== "number" ||
					typeof args.endLine !== "number" ||
					args.startLine < 0 ||
					args.endLine < 0
				) {
					throw new Error("Line numbers must be non-negative integers");
				}
				if (args.startLine > args.endLine) {
					throw new Error("startLine must be <= endLine");
				}
				const uri = validateWorkspacePath(args.uri);
				const doc = await raceWithAbort(
					toPromise(vscode.workspace.openTextDocument(uri)),
					signal,
				);
				checkAbort();
				const start = Math.max(0, args.startLine);
				// Use endLine + 1 since endLine is inclusive (fixes off-by-one error)
				const end = Math.min(doc.lineCount, args.endLine + 1);
				let text = "";
				for (let i = start; i < end; i++) {
					text += `${doc.lineAt(i).text}\n`;
				}
				checkAbort();
				result = [{ type: "text", text }];
			} else {
				throw new Error(`Unknown client tool: ${name}`);
			}

			await submitResult(result, false);
		} catch (e) {
			try {
				await submitResult([{ type: "text", text: String(e) }], true);
			} catch (submitError) {
				console.error("Client tool submission failed:", submitError);
			}
		}
	}

	private async _handleUserMessage(text: string) {
		if (!this._view) return;
		const trimmed = text?.trim();
		if (!trimmed) return;
		if (this._isProcessing) {
			vscode.window.showWarningMessage(
				"Composer is still responding. Please wait for it to finish.",
			);
			return;
		}

		this._abortController?.abort();
		this._abortController = new AbortController();
		const signal = this._abortController.signal;
		this._isProcessing = true;
		this._view?.webview.postMessage({ type: "busy", value: true });

		// --- Context Injection (only on first message to avoid token waste) ---
		let finalContent = trimmed;
		const isFirstMessage = this._messages.length === 0;

		if (isFirstMessage) {
			let contextBlock = "";
			const activeEditor = vscode.window.activeTextEditor;
			const pinned = Array.from(this._pinnedFiles);
			const MAX_CONTEXT_SIZE = 50000; // 50KB limit to prevent excessive token usage
			let currentSize = 0;

			// Include pinned files with size limit
			if (pinned.length > 0) {
				contextBlock += "=== USER PROVIDED CONTEXT ===\nPinned Files:\n";
				for (const path of pinned) {
					try {
						const doc = await vscode.workspace.openTextDocument(
							vscode.Uri.file(path),
						);
						const content = doc.getText();
						if (currentSize + content.length > MAX_CONTEXT_SIZE) {
							contextBlock += `File: ${vscode.workspace.asRelativePath(path)}\n(truncated - file too large)\n\n`;
							continue;
						}
						currentSize += content.length;
						contextBlock += `File: ${vscode.workspace.asRelativePath(path)}\n\`\`\`${doc.languageId}\n${content}\n\`\`\`\n\n`;
					} catch (e) {
						console.error("Failed to read pinned file", path, e);
					}
				}
			}

			// Include active file if not already pinned and within size limit
			if (activeEditor) {
				const path = activeEditor.document.uri.fsPath;
				if (!this._pinnedFiles.has(path)) {
					const content = activeEditor.document.getText();
					if (currentSize + content.length <= MAX_CONTEXT_SIZE) {
						if (!contextBlock) {
							contextBlock = "=== USER PROVIDED CONTEXT ===\n";
						}
						contextBlock += `Active File: ${vscode.workspace.asRelativePath(path)}\n\`\`\`${activeEditor.document.languageId}\n${content}\n\`\`\`\n\n`;
					} else {
						if (!contextBlock) {
							contextBlock = "=== USER PROVIDED CONTEXT ===\n";
						}
						contextBlock += `Active File: ${vscode.workspace.asRelativePath(path)}\n(truncated - file too large)\n\n`;
					}
				}
			}

			if (contextBlock) {
				contextBlock += "=== END CONTEXT ===\n\n";
				// Use unique delimiter unlikely to appear in user messages
				finalContent = `${contextBlock}<<< USER_MESSAGE_START >>>\n${trimmed}`;
			}
		}
		// -------------------------

		const userMsg: Message = {
			role: "user",
			content: finalContent,
			timestamp: new Date().toISOString(),
		};
		// Note: We might want to show just the 'trimmed' text in UI but send 'finalContent' to backend
		// But for now, let's keep it simple and show what we send, or maybe just show trimmed in history?
		// To show trimmed in history but send context, we'd need to diverge the UI model from the API model slightly
		// or use a hidden field.
		// For transparency, showing context is good, but it can be huge.
		// Let's store the full message for now.

		this._messages.push(userMsg);
		this._context.workspaceState.update("composer.messages", this._messages);

		const thinkingEditor = vscode.window.activeTextEditor;
		const thinkingLine = thinkingEditor?.selection.active.line;

		let assistantMsg: Message | undefined;
		let assistantHasContent = false;

		try {
			await this._ensureSession();

			assistantMsg = {
				role: "assistant",
				content: "",
				timestamp: new Date().toISOString(),
			};
			this._messages.push(assistantMsg);
			this._context.workspaceState.update("composer.messages", this._messages);

			const config = vscode.workspace.getConfiguration("composer");
			const model = config.get<string>("model") || "claude-sonnet-4-5";

			const stream = this._apiClient.chatWithEvents(
				{
					model,
					messages: this._messages.slice(0, -1),
					sessionId: this._currentSessionId,
				},
				signal,
			);

			for await (const event of stream) {
				if (signal.aborted) break;

				// Type helper for event properties (handles index signature returning unknown)
				const getEventProp = <T>(key: string): T | undefined =>
					(event as Record<string, unknown>)[key] as T | undefined;

				if (event.type === "message_update") {
					const evt = getEventProp<{ type: string; delta?: string }>(
						"assistantMessageEvent",
					);
					if (!evt) continue;
					if (evt.type === "text_delta" && evt.delta) {
						if (typeof assistantMsg.content !== "string") {
							assistantMsg.content = "";
						}
						assistantMsg.content += evt.delta;
						assistantHasContent = true;
						this._view?.webview.postMessage({
							type: "token",
							value: evt.delta,
						});
					} else if (evt.type === "thinking_start") {
						if (thinkingEditor && thinkingLine !== undefined) {
							this._thinkingManager.setThinking(thinkingEditor, thinkingLine);
						}
						this._view?.webview.postMessage({ type: "thinking_start" });
					} else if (evt.type === "thinking_delta" && evt.delta) {
						this._view?.webview.postMessage({
							type: "thinking_token",
							value: evt.delta,
						});
					} else if (evt.type === "thinking_end") {
						if (thinkingEditor && thinkingLine !== undefined) {
							this._thinkingManager.clearThinking(thinkingEditor, thinkingLine);
						}
						this._view?.webview.postMessage({ type: "thinking_end" });
					}
				} else if (event.type === "message_end") {
					// Update history with the authoritative message
					const message = getEventProp<RawMessage>("message");
					if (!message) continue;
					const msg = convertToComposerMessage(message);
					if (msg.role === "assistant") {
						// Update the assistant message we are building
						// We replace it in the array to ensure we have tools/usage etc.
						const index = this._messages.indexOf(assistantMsg);
						if (index !== -1) {
							this._messages[index] = msg;
							// Update reference
							assistantMsg = msg;
						}
					} else {
						// Append other messages (e.g. tool results)
						this._messages.push(msg);
					}
					// Persist state
					this._context.workspaceState.update(
						"composer.messages",
						this._messages,
					);
				} else if (event.type === "tool_execution_start") {
					this._view?.webview.postMessage({
						type: "tool_start",
						id: getEventProp<string>("toolCallId"),
						name: getEventProp<string>("toolName"),
						args: getEventProp<Record<string, unknown>>("args"),
					});
				} else if (event.type === "tool_execution_end") {
					this._view?.webview.postMessage({
						type: "tool_end",
						id: getEventProp<string>("toolCallId"),
						result: getEventProp<unknown>("result"),
						isError: getEventProp<boolean>("isError"),
					});
				} else if (event.type === "text_delta") {
					// Fallback for flat events if any
					const text = getEventProp<string>("text");
					if (text) {
						if (typeof assistantMsg.content !== "string") {
							assistantMsg.content = "";
						}
						assistantMsg.content += text;
						assistantHasContent = true;
						this._view?.webview.postMessage({
							type: "token",
							value: text,
						});
					}
				} else if (event.type === "thinking_start") {
					if (thinkingEditor && thinkingLine !== undefined) {
						this._thinkingManager.setThinking(thinkingEditor, thinkingLine);
					}
					this._view?.webview.postMessage({ type: "thinking_start" });
				} else if (event.type === "thinking_end") {
					if (thinkingEditor && thinkingLine !== undefined) {
						this._thinkingManager.clearThinking(thinkingEditor, thinkingLine);
					}
					this._view?.webview.postMessage({ type: "thinking_end" });
				} else if (event.type === "action_approval_required") {
					const request = getEventProp<{
						id: string;
						toolName: string;
						args: Record<string, unknown>;
						reason: string;
					}>("request");
					if (request) {
						this._view?.webview.postMessage({
							type: "approval_required",
							requestId: request.id,
							toolName: request.toolName,
							args: request.args,
							reason: request.reason,
						});
					}
				} else if (event.type === "action_approval_resolved") {
					const request = getEventProp<{ id: string }>("request");
					const decision = getEventProp<string>("decision");
					if (request) {
						this._view?.webview.postMessage({
							type: "approval_resolved",
							requestId: request.id,
							decision,
						});
					}
				} else if (event.type === "client_tool_request") {
					// Execute client tool - await to catch and report errors properly
					const toolCallId = getEventProp<string>("toolCallId");
					const toolName = getEventProp<string>("toolName");
					const args = getEventProp<Record<string, unknown>>("args") ?? {};
					if (!toolCallId || !toolName) continue;
					this._handleClientTool(toolCallId, toolName, args, signal).catch(
						(err) => {
							console.error("Client tool execution failed:", err);
							// Try to submit error result so backend doesn't wait forever
							this._apiClient
								.submitClientToolResult(
									toolCallId,
									[{ type: "text", text: String(err) }],
									true,
								)
								.catch(() => {
									// Ignore if submission fails - backend will timeout
								});
						},
					);
				} else if (event.type === "error" || event.type === "stream_error") {
					const errorMsg = getEventProp<string>("message") || "Stream error";
					throw new Error(errorMsg);
				}
			}

			if (!signal.aborted) {
				this._context.workspaceState.update(
					"composer.messages",
					this._messages,
				);
				this._view?.webview.postMessage({ type: "done" });
			} else if (!assistantHasContent) {
				this._removeAssistantMessage(assistantMsg);
			}
		} catch (error) {
			if (!signal.aborted) {
				if (!assistantHasContent) {
					this._removeAssistantMessage(assistantMsg);
				}
				const message =
					error instanceof Error ? error.message : "Unknown error";
				this._view?.webview.postMessage({ type: "error", value: message });
				vscode.window.showErrorMessage(message);
			}
		} finally {
			if (thinkingEditor && thinkingLine !== undefined) {
				this._thinkingManager.clearThinking(thinkingEditor, thinkingLine);
			}
			this._isProcessing = false;
			this._abortController = undefined;
			this._view?.webview.postMessage({ type: "busy", value: false });
		}
	}

	private _updateContextUI() {
		if (!this._view) return;

		const editor = vscode.window.activeTextEditor;
		const pinnedFiles = Array.from(this._pinnedFiles).map((p) => ({
			path: p,
			name: vscode.workspace.asRelativePath(p),
		}));

		let activeFile = null;
		if (editor) {
			const document = editor.document;
			const selection = editor.selection;
			const text = document.getText(selection);
			activeFile = {
				filename: document.fileName,
				languageId: document.languageId,
				selection: text || null,
				cursorLine: selection.active.line,
			};
		}

		this._view?.webview.postMessage({
			type: "contextUpdate",
			data: {
				activeFile,
				pinnedFiles,
			},
		});
	}

	private async _ensureSession() {
		if (this._currentSessionId) return;
		if (!this._creatingSession) {
			this._creatingSession = this._apiClient.createSession("VS Code Chat");
		}
		try {
			const session = await this._creatingSession;
			this._currentSessionId = session.id;
			this._context.workspaceState.update(
				"composer.sessionId",
				this._currentSessionId,
			);
		} finally {
			this._creatingSession = undefined;
		}
	}

	private _removeAssistantMessage(target?: Message) {
		if (!target) return;
		const index = this._messages.indexOf(target);
		if (index !== -1) {
			this._messages.splice(index, 1);
			this._context.workspaceState.update("composer.messages", this._messages);
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const nonce = getNonce();
		const vendorUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, "media", "vendor.js"),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, "media", "highlight.css"),
		);

		const config = vscode.workspace.getConfiguration("composer");
		const apiEndpoint =
			config.get<string>("apiEndpoint") || "http://localhost:8080";
		let cspConnect = "http://localhost:8080";
		try {
			const parsed = new URL(apiEndpoint);
			cspConnect = parsed.origin;
		} catch (error) {
			console.warn(
				"Invalid composer.apiEndpoint; falling back to localhost.",
				error,
			);
		}

		return getWebviewHtml({
			nonce,
			vendorUri,
			styleUri,
			cspSource: webview.cspSource,
			cspConnect,
		});
	}
}

function getNonce() {
	return randomBytes(16).toString("base64");
}

export { convertToComposerMessage } from "../lib/message-converter";
