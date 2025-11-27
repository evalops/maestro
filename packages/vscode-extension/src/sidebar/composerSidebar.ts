import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { buildComposerUrl } from "../lib/actions";
import {
	ApiClient,
	type CommandDefinition,
	type Message,
	type Session,
} from "../lib/api-client";
import type { ThinkingManager } from "../lib/decorations";
import { convertToComposerMessage } from "../lib/message-converter";

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
				}
			}),
		);
	}

	private async _handleClientTool(
		id: string,
		name: string,
		args: any,
	): Promise<void> {
		// Helper to validate paths are within workspace (prevents path traversal attacks)
		const validateWorkspacePath = (filePath: string): vscode.Uri => {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error("No workspace folder open");
			}

			const path = require("node:path");
			const primaryWorkspace = workspaceFolders[0].uri.fsPath;

			// Resolve relative paths against workspace root, not CWD
			// This ensures "src/file.ts" resolves to "/workspace/src/file.ts"
			// Also normalizes ".." sequences to prevent traversal attacks
			const normalizedPath = path.isAbsolute(filePath)
				? path.resolve(filePath)
				: path.resolve(primaryWorkspace, filePath);
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
			let result: any[] = [];
			if (name === "vscode_get_diagnostics") {
				const uri = args.uri ? validateWorkspacePath(args.uri) : undefined;
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
				const uri = validateWorkspacePath(args.uri);
				const pos = new vscode.Position(args.line, args.character);
				const definitions =
					(await vscode.commands.executeCommand<
						(vscode.Location | vscode.LocationLink)[]
					>("vscode.executeDefinitionProvider", uri, pos)) || [];
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
				const uri = validateWorkspacePath(args.uri);
				const pos = new vscode.Position(args.line, args.character);
				const references =
					(await vscode.commands.executeCommand<vscode.Location[]>(
						"vscode.executeReferenceProvider",
						uri,
						pos,
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
				// Validate line numbers
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
				const doc = await vscode.workspace.openTextDocument(uri);
				const start = Math.max(0, args.startLine);
				// Use endLine + 1 since endLine is inclusive (fixes off-by-one error)
				const end = Math.min(doc.lineCount, args.endLine + 1);
				let text = "";
				for (let i = start; i < end; i++) {
					text += `${doc.lineAt(i).text}\n`;
				}
				result = [{ type: "text", text }];
			} else {
				throw new Error(`Unknown client tool: ${name}`);
			}

			await this._apiClient.submitClientToolResult(id, result, false);
		} catch (e) {
			await this._apiClient.submitClientToolResult(
				id,
				[{ type: "text", text: String(e) }],
				true,
			);
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
						console.error(`Failed to read pinned file ${path}`, e);
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

				if (event.type === "message_update") {
					const evt = event.assistantMessageEvent;
					if (evt.type === "text_delta" && evt.delta) {
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
					const msg = convertToComposerMessage(event.message);
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
						id: event.toolCallId,
						name: event.toolName,
						args: event.args,
					});
				} else if (event.type === "tool_execution_end") {
					this._view?.webview.postMessage({
						type: "tool_end",
						id: event.toolCallId,
						result: event.result,
						isError: event.isError,
					});
				} else if (event.type === "text_delta" && event.text) {
					// Fallback for flat events if any
					assistantMsg.content += event.text;
					assistantHasContent = true;
					this._view?.webview.postMessage({
						type: "token",
						value: event.text,
					});
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
					this._view?.webview.postMessage({
						type: "approval_required",
						requestId: event.request.id,
						toolName: event.request.toolName,
						args: event.request.args,
						reason: event.request.reason,
					});
				} else if (event.type === "action_approval_resolved") {
					this._view?.webview.postMessage({
						type: "approval_resolved",
						requestId: event.request.id,
						decision: event.decision,
					});
				} else if (event.type === "client_tool_request") {
					// Execute client tool - await to catch and report errors properly
					this._handleClientTool(
						event.toolCallId,
						event.toolName,
						event.args,
					).catch((err) => {
						console.error("Client tool execution failed:", err);
						// Try to submit error result so backend doesn't wait forever
						this._apiClient
							.submitClientToolResult(
								event.toolCallId,
								[{ type: "text", text: String(err) }],
								true,
							)
							.catch(() => {
								// Ignore if submission fails - backend will timeout
							});
					});
				} else if (event.type === "error" || event.type === "stream_error") {
					throw new Error(event.message || "Stream error");
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

		return /* html */ `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${cspConnect}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Composer Chat</title>
				<link href="${styleUri}" rel="stylesheet">
				<style>
					:root {
						--bg-primary: var(--vscode-editor-background);
						--bg-secondary: var(--vscode-sideBar-background);
						--text-primary: var(--vscode-editor-foreground);
						--text-secondary: var(--vscode-descriptionForeground);
						--border-color: var(--vscode-panel-border);
						--accent-color: var(--vscode-button-background);
						--accent-hover: var(--vscode-button-hoverBackground);
					}

					body {
						padding: 0;
						margin: 0;
						font-family: var(--vscode-font-family);
						color: var(--text-primary);
						background-color: var(--bg-secondary);
						height: 100vh;
						display: flex;
						flex-direction: column;
					}

					.container {
                        display: flex;
                        flex-direction: column;
                        height: 100%;
						position: relative;
                    }

                    .header {
                        padding: 12px 16px;
						border-bottom: 1px solid var(--border-color);
						display: flex;
						align-items: center;
						justify-content: space-between;
						background: var(--bg-secondary);
                    }

                    h2 {
                        margin: 0;
                        font-size: 11px;
                        font-weight: 600;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                        color: var(--text-secondary);
                    }

					.status-dot {
						width: 6px;
						height: 6px;
						border-radius: 50%;
						background: #6b7280;
						transition: all 0.3s ease;
					}

					.status-dot.active {
						background: #10b981;
						box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
					}

					.messages {
						flex: 1;
						overflow-y: auto;
						padding: 16px;
						display: flex;
						flex-direction: column;
						gap: 16px;
					}

					.message {
						display: flex;
						gap: 12px;
						font-size: 13px;
						line-height: 1.5;
					}

					.message.assistant {
						background: rgba(255, 255, 255, 0.03);
						border-radius: 8px;
						padding: 12px;
						border: 1px solid var(--border-color);
					}

					.message .avatar {
						width: 24px;
						height: 24px;
						border-radius: 4px;
						background: var(--accent-color);
						display: flex;
						align-items: center;
						justify-content: center;
						font-weight: bold;
						font-size: 12px;
						flex-shrink: 0;
					}

					.message.user .avatar {
						background: #6b7280;
					}

					.message-content {
						flex: 1;
						min-width: 0;
						word-wrap: break-word;
					}

					/* Markdown Content Styles */
					.message-content p { margin: 0.5em 0; }
					.message-content p:first-child { margin-top: 0; }
					.message-content p:last-child { margin-bottom: 0; }
					.message-content pre {
						background: var(--vscode-editor-background);
						padding: 8px;
						border-radius: 4px;
						overflow-x: auto;
						border: 1px solid var(--border-color);
					}
					.message-content code {
						font-family: var(--vscode-editor-font-family);
						font-size: 0.9em;
						background: rgba(127, 127, 127, 0.1);
						padding: 0.2em 0.4em;
						border-radius: 3px;
					}
					.message-content pre code {
						background: transparent;
						padding: 0;
					}

					.context-bar {
                        font-size: 11px;
                        padding: 6px 12px;
                        background: var(--vscode-editor-lineHighlightBackground);
                        border-bottom: 1px solid var(--border-color);
                        display: flex;
						flex-direction: column;
                        gap: 4px;
						color: var(--text-secondary);
                    }

					.context-row {
						display: flex;
						align-items: center;
						gap: 8px;
					}

					.input-area {
						padding: 16px;
						background: var(--bg-secondary);
						border-top: 1px solid var(--border-color);
					}

					.input-container {
						position: relative;
						background: var(--vscode-input-background);
						border: 1px solid var(--vscode-input-border);
						border-radius: 6px;
					}

					textarea {
						width: 100%;
						background: transparent;
						border: none;
						color: var(--text-primary);
						font-family: inherit;
						padding: 10px;
						resize: none;
						min-height: 40px;
						box-sizing: border-box;
						outline: none;
					}

					.input-actions {
						display: flex;
						justify-content: space-between;
						padding: 4px 8px 8px;
					}

                    button {
                        background: var(--accent-color);
                        color: white;
                        border: none;
                        padding: 6px 12px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-family: inherit;
                        font-weight: 500;
						font-size: 12px;
						transition: opacity 0.2s;
                    }
                    button:hover {
                        opacity: 0.9;
                    }

					.context-pill {
						font-size: 10px;
						padding: 2px 6px;
						background: var(--vscode-badge-background);
						color: var(--vscode-badge-foreground);
						border-radius: 10px;
						display: inline-flex;
						align-items: center;
						gap: 4px;
					}

					.context-pill .remove-btn {
						cursor: pointer;
						font-weight: bold;
						margin-left: 2px;
					}

					.thinking {
						font-style: italic;
						color: var(--text-secondary);
						margin-bottom: 8px;
						display: flex;
						align-items: center;
						gap: 6px;
					}
					.thinking-dots::after {
						content: '';
						animation: dots 1.5s infinite;
					}
					@keyframes dots {
						0% { content: ''; }
						33% { content: '.'; }
						66% { content: '..'; }
						100% { content: '...'; }
					}

                    .tool-call {
                        margin: 8px 0;
                        border: 1px solid var(--border-color);
                        border-radius: 6px;
                        overflow: hidden;
                        background: rgba(255, 255, 255, 0.02);
                    }

                    .tool-header {
                        padding: 8px 12px;
                        background: rgba(255, 255, 255, 0.05);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-size: 11px;
                        cursor: pointer;
                        user-select: none;
                    }

                    .tool-header:hover {
                        background: rgba(255, 255, 255, 0.08);
                    }

                    .tool-name {
                        font-family: var(--vscode-editor-font-family);
                        font-weight: 600;
                        color: var(--accent-color);
                    }

                    .tool-status {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        color: var(--text-secondary);
                    }

                    .tool-body {
                        display: none;
                        padding: 12px;
                        font-family: var(--vscode-editor-font-family);
                        font-size: 11px;
                        border-top: 1px solid var(--border-color);
                    }

                    .tool-call.expanded .tool-body {
                        display: block;
                    }

                    .tool-section {
                        margin-bottom: 8px;
                    }
                    .tool-section:last-child { margin-bottom: 0; }
                    .tool-section-title {
                        font-weight: 600;
                        margin-bottom: 4px;
                        color: var(--text-secondary);
                        text-transform: uppercase;
                        font-size: 10px;
                    }
                    .tool-code {
                        white-space: pre-wrap;
                        word-break: break-all;
                        color: var(--text-primary);
                    }

                    .approval-request {
                        border: 1px solid var(--accent-color);
                        border-radius: 6px;
                        background: rgba(255, 255, 255, 0.05);
                        margin: 8px 0;
                        padding: 12px;
                    }

                    .approval-header {
                        font-weight: 600;
                        margin-bottom: 8px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        color: var(--accent-color);
                    }

                    .approval-reason {
                        font-size: 11px;
                        margin-bottom: 12px;
                        color: var(--text-secondary);
                    }

                    .approval-actions {
                        display: flex;
                        gap: 8px;
                    }

                    .approval-actions button {
                        flex: 1;
                    }

                    .btn-approve {
                        background: #10b981;
                    }
                    .btn-deny {
                        background: #ef4444;
                    }
				</style>
			</head>
			<body>
                <div class="container">
                    <div class="header">
                        <h2>Composer Agent</h2>
						<div id="status-dot" class="status-dot"></div>
                    </div>

                    <div id="context-bar" class="context-bar">
						<!-- Populated by JS -->
                    </div>

                    <div class="messages" id="messages"></div>

					<div class="input-area">
						<div class="input-container">
							<textarea placeholder="Ask anything... (Enter to send)" rows="1"></textarea>
							<div class="input-actions">
								<span style="font-size: 10px; color: var(--text-secondary); display: flex; align-items: center;">
									↵ to send
								</span>
								<button id="send-btn">Send</button>
							</div>
						</div>
					</div>
                </div>

				<script src="${vendorUri}"></script>
				<script nonce="${nonce}">
					const vscode = acquireVsCodeApi();
                    let currentAssistantMessage = null;
					let currentAssistantContentRaw = "";
					let thinkingEl = null;
					let isBusy = false;
					let assistantHasContent = false;
					let activeToolCalls = new Map(); // id -> element

					const textarea = document.querySelector('textarea');
					const sendButton = document.getElementById('send-btn');

					function setBusy(state) {
						isBusy = state;
						if (sendButton) {
							sendButton.disabled = state;
							sendButton.textContent = state ? 'Working…' : 'Send';
						}
						if (textarea) {
							textarea.disabled = state;
						}
					}

					setBusy(false);

					// Configure Markdown
					if (window.marked && window.hljs) {
						window.marked.setOptions({
							highlight: function(code, lang) {
								if (lang && window.hljs.getLanguage(lang)) {
									return window.hljs.highlight(code, { language: lang }).value;
								}
								return window.hljs.highlightAuto(code).value;
							}
						});
					}

                    // Restore history
                    vscode.postMessage({ type: 'getHistory' });
                    // Initial context
                    vscode.postMessage({ type: 'getEditorContext' });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'contextUpdate':
                                updateContextUI(message.data);
                                break;
							case 'token':
								appendToken(message.value);
								break;
							case 'thinking_start':
								showThinking();
								break;
                            case 'thinking_token':
                                appendThinkingToken(message.value);
                                break;
							case 'thinking_end':
								hideThinking();
								break;
                            case 'tool_start':
                                createToolCall(message.id, message.name, message.args);
                                break;
                            case 'tool_end':
                                updateToolResult(message.id, message.result, message.isError);
                                break;
                            case 'approval_required':
                                showApprovalRequest(message);
                                break;
                            case 'approval_resolved':
                                updateApprovalStatus(message.requestId, message.decision);
                                break;
							case 'done':
								resetAssistantState();
								break;
							case 'error':
								discardPendingAssistantMessage();
								showError(message.value);
								break;
							case 'history':
								loadHistory(message.messages);
								break;
							case 'clear':
								const list = document.getElementById('messages');
								if (list) {
									list.innerHTML = '';
								}
								resetAssistantState();
                                activeToolCalls.clear();
								setBusy(false);
								break;
							case 'busy':
								setBusy(Boolean(message.value));
								break;
                        }
                    });

                    function updateContextUI(data) {
                        const dot = document.getElementById('status-dot');
                        const container = document.getElementById('context-bar');
						container.innerHTML = '';

						const active = data.activeFile;
						const pinned = data.pinnedFiles || [];

						if (active || pinned.length > 0) {
							dot.className = 'status-dot active';
						} else {
							dot.className = 'status-dot';
							container.innerHTML = '<span style="opacity: 0.7">No context</span>';
							return;
						}

						if (active) {
							const row = document.createElement('div');
							row.className = 'context-row';
							const labelSpan = document.createElement('span');
							labelSpan.style.opacity = '0.7';
							labelSpan.textContent = 'Active:';
							row.appendChild(labelSpan);
							row.appendChild(document.createTextNode(' ' + active.filename.split(/[\\\\/]/).pop()));
							if (active.selection) {
								const selectionPill = document.createElement('span');
								selectionPill.className = 'context-pill';
								selectionPill.textContent = 'Selection';
								row.appendChild(document.createTextNode(' '));
								row.appendChild(selectionPill);
							}
							container.appendChild(row);
						}

						if (pinned.length > 0) {
							const row = document.createElement('div');
							row.className = 'context-row';
							row.style.flexWrap = 'wrap';
							const pinnedLabel = document.createElement('span');
							pinnedLabel.style.opacity = '0.7';
							pinnedLabel.textContent = 'Pinned:';
							row.appendChild(pinnedLabel);
							pinned.forEach(p => {
								const pill = document.createElement('span');
								pill.className = 'context-pill';
								const nameNode = document.createTextNode(p.name + ' ');
								const removeButton = document.createElement('span');
								removeButton.className = 'remove-btn';
								removeButton.textContent = '×';
								removeButton.addEventListener('click', () => removePinned(p.path));
								pill.appendChild(nameNode);
								pill.appendChild(removeButton);
								row.appendChild(pill);
							});
							container.appendChild(row);
						}
                    }

					window.removePinned = (path) => {
						vscode.postMessage({ type: 'removePinnedFile', path });
					};

					function renderMarkdown(text) {
						if (window.marked && window.DOMPurify) {
							return window.DOMPurify.sanitize(window.marked.parse(text));
						}
						return text.replace(/</g, '&lt;');
					}

					function loadHistory(messages) {
						const container = document.getElementById('messages');
						if (!container) return;
						container.innerHTML = '';
						messages.forEach(msg => {
                            if (msg.role === 'toolResult') return;
                            if (msg.role === 'tool') return;

							const div = document.createElement('div');
							div.className = 'message ' + msg.role;
							const avatar = document.createElement('div');
							avatar.className = 'avatar';
							avatar.textContent = msg.role === 'user' ? 'U' : 'AI';

							const content = document.createElement('div');
							content.className = 'message-content';
							if (msg.role === 'assistant') {
								content.innerHTML = renderMarkdown(msg.content || '');
                                if (msg.tools && Array.isArray(msg.tools)) {
                                    msg.tools.forEach(tool => {
                                        const toolDiv = document.createElement('div');
                                        toolDiv.className = 'tool-call';
                                        toolDiv.innerHTML = \`
                                            <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
                                                <span class="tool-name">\${tool.name}</span>
                                                <span class="tool-status">Completed</span>
                                            </div>
                                            <div class="tool-body">
                                                <div class="tool-section">
                                                    <div class="tool-section-title">Arguments</div>
                                                    <div class="tool-code">\${JSON.stringify(tool.args, null, 2)}</div>
                                                </div>
                                                <div class="tool-section">
                                                    <div class="tool-section-title">Result</div>
                                                    <div class="tool-code">\${JSON.stringify(tool.result, null, 2)}</div>
                                                </div>
                                            </div>
                                        \`;
                                        content.appendChild(toolDiv);
                                    });
                                }
							} else {
								// User message: strip context block if present for display
								let text = msg.content || '';
								const delimiter = '<<< USER_MESSAGE_START >>>';
								if (text.includes(delimiter)) {
									const parts = text.split(delimiter);
									text = parts[parts.length - 1].trim();
								}
								content.textContent = text;
							}

							div.appendChild(avatar);
							div.appendChild(content);
							container.appendChild(div);
						});
						container.scrollTop = container.scrollHeight;
						resetAssistantState();
					}


					function showThinking() {
						if (!currentAssistantMessage) createAssistantMessage();
						if (thinkingEl) return;

						thinkingEl = document.createElement('div');
						thinkingEl.className = 'thinking';
						thinkingEl.innerHTML = 'Thinking<span class="thinking-dots"></span>';

						const content = currentAssistantMessage.querySelector('.message-content');
						// Insert before actual content
						if (content.firstChild) {
							content.insertBefore(thinkingEl, content.firstChild);
						} else {
							content.appendChild(thinkingEl);
						}
					}

                    function appendThinkingToken(text) {
                        if (!thinkingEl) showThinking();
                        // Optional: show text in thinking block if expanded?
                        // For now just keep dots
                    }

					function hideThinking() {
						if (thinkingEl) {
							thinkingEl.remove();
							thinkingEl = null;
						}
					}

                    function createToolCall(id, name, args) {
                        if (!currentAssistantMessage) createAssistantMessage();
                        const content = currentAssistantMessage.querySelector('.message-content');

                        const toolDiv = document.createElement('div');
                        toolDiv.className = 'tool-call';
                        toolDiv.innerHTML = \`
                            <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
                                <span class="tool-name">\${name}</span>
                                <span class="tool-status">Running...</span>
                            </div>
                            <div class="tool-body">
                                <div class="tool-section">
                                    <div class="tool-section-title">Arguments</div>
                                    <div class="tool-code">\${JSON.stringify(args, null, 2)}</div>
                                </div>
                            </div>
                        \`;
                        content.appendChild(toolDiv);
                        activeToolCalls.set(id, toolDiv);

                        const messages = document.getElementById('messages');
                        messages.scrollTop = messages.scrollHeight;
                    }

                    function updateToolResult(id, result, isError) {
                        const toolDiv = activeToolCalls.get(id);
                        if (!toolDiv) return;

                        const status = toolDiv.querySelector('.tool-status');
                        status.textContent = isError ? 'Error' : 'Completed';
                        if (isError) status.style.color = '#ef4444';
                        else status.style.color = '#10b981';

                        const body = toolDiv.querySelector('.tool-body');
                        const resultSection = document.createElement('div');
                        resultSection.className = 'tool-section';

                        let resultText = '';
                        if (result && result.content && Array.isArray(result.content)) {
                             resultText = result.content.map(c => c.text).join('\\n');
                        } else {
                            resultText = JSON.stringify(result, null, 2);
                        }

                        // Use textContent to prevent XSS from tool results
                        const titleEl = document.createElement('div');
                        titleEl.className = 'tool-section-title';
                        titleEl.textContent = 'Result';
                        resultSection.appendChild(titleEl);

                        const codeEl = document.createElement('div');
                        codeEl.className = 'tool-code';
                        codeEl.textContent = resultText;
                        resultSection.appendChild(codeEl);

                        body.appendChild(resultSection);

                        activeToolCalls.delete(id);
                    }

                    function showApprovalRequest(msg) {
                        if (!currentAssistantMessage) createAssistantMessage();
                        const content = currentAssistantMessage.querySelector('.message-content');

                        const div = document.createElement('div');
                        div.id = 'approval-' + msg.requestId;
                        div.className = 'approval-request';
                        div.innerHTML = \`
                            <div class="approval-header">
                                <span>Approval Required</span>
                                <span class="tool-name">\${msg.toolName}</span>
                            </div>
                            <div class="tool-code" style="margin-bottom: 8px; font-size: 11px">\${JSON.stringify(msg.args, null, 2)}</div>
                            <div class="approval-reason">\${msg.reason || 'Requires confirmation'}</div>
                            <div class="approval-actions">
                                <button class="btn-approve" onclick="submitApproval('\${msg.requestId}', 'approved')">Approve</button>
                                <button class="btn-deny" onclick="submitApproval('\${msg.requestId}', 'denied')">Deny</button>
                            </div>
                        \`;
                        content.appendChild(div);
                        const messages = document.getElementById('messages');
                        messages.scrollTop = messages.scrollHeight;
                    }

                    function updateApprovalStatus(requestId, decision) {
                        const div = document.getElementById('approval-' + requestId);
                        if (!div) return;

                        const isApproved = decision.approved;
                        div.style.borderColor = isApproved ? '#10b981' : '#ef4444';
                        div.innerHTML = \`
                            <div class="approval-header">
                                <span>\${isApproved ? 'Approved' : 'Denied'}</span>
                                <span class="tool-name"></span>
                            </div>
                            <div class="approval-reason">\${decision.reason || ''}</div>
                        \`;
                    }

                    window.submitApproval = (requestId, decision) => {
                        const div = document.getElementById('approval-' + requestId);
                        if (div) {
                            const btns = div.querySelectorAll('button');
                            btns.forEach(b => b.disabled = true);
                            btns.forEach(b => b.textContent = 'Sending...');
                        }
                        vscode.postMessage({ type: 'submitApproval', requestId, decision });
                    };

					function resetAssistantState() {
						currentAssistantMessage = null;
						currentAssistantContentRaw = '';
						assistantHasContent = false;
						hideThinking();
                        activeToolCalls.clear();
					}

					function discardPendingAssistantMessage() {
						if (currentAssistantMessage && !assistantHasContent) {
							currentAssistantMessage.remove();
						}
						resetAssistantState();
					}

					function createAssistantMessage() {
						const messages = document.getElementById('messages');
						const div = document.createElement('div');
						div.className = 'message assistant';
						div.innerHTML = \`
							<div class="avatar">AI</div>
							<div class="message-content"></div>
						\`;
						messages.appendChild(div);
						currentAssistantMessage = div;
						currentAssistantContentRaw = '';
						assistantHasContent = false;
						messages.scrollTop = messages.scrollHeight;
						return div;
					}

					function appendToken(text) {
						if (!currentAssistantMessage) createAssistantMessage();
						currentAssistantContentRaw += text;
						assistantHasContent = true;

						const contentDiv = currentAssistantMessage.querySelector('.message-content');

                        // Let's separate them.
                        // Implementation:
                        // 1. Find or create text-container
                        let textContainer = contentDiv.querySelector('.text-container');
                        if (!textContainer) {
                             textContainer = document.createElement('div');
                             textContainer.className = 'text-container';
                             // Insert at beginning (but after thinking)
                             if (thinkingEl && thinkingEl.parentElement === contentDiv) {
                                 contentDiv.insertBefore(textContainer, thinkingEl.nextSibling);
                             } else {
                                 contentDiv.insertBefore(textContainer, contentDiv.firstChild);
                             }
                        }

                        textContainer.innerHTML = renderMarkdown(currentAssistantContentRaw);

						const messages = document.getElementById('messages');
						messages.scrollTop = messages.scrollHeight;
					}

					function showError(text) {
						const messages = document.getElementById('messages');
						if (!messages) return;
						const div = document.createElement('div');
						div.className = 'message assistant';
						div.style.borderColor = '#ef4444';

						const avatar = document.createElement('div');
						avatar.className = 'avatar';
						avatar.style.background = '#ef4444';
						avatar.textContent = '!';

						const content = document.createElement('div');
						content.className = 'message-content';
						content.textContent = text || '';

						div.appendChild(avatar);
						div.appendChild(content);
						messages.appendChild(div);
						messages.scrollTop = messages.scrollHeight;
					}


					// Auto-resize textarea
					if (textarea) {
						textarea.addEventListener('input', function() {
							this.style.height = 'auto';
							this.style.height = (this.scrollHeight) + 'px';
						});
					}

					function sendMessage() {
						if (!textarea || isBusy) return;
						const text = textarea.value.trim();
						if (!text) return;

						const messages = document.getElementById('messages');
						if (messages) {
							const div = document.createElement('div');
							div.className = 'message user';

							const avatar = document.createElement('div');
							avatar.className = 'avatar';
							avatar.textContent = 'U';

							const content = document.createElement('div');
							content.className = 'message-content';
							content.textContent = text;

							div.appendChild(avatar);
							div.appendChild(content);
							messages.appendChild(div);
							messages.scrollTop = messages.scrollHeight;
						}

						textarea.value = '';
						textarea.style.height = 'auto';

						vscode.postMessage({ type: 'sendMessage', text });
					}


					if (sendButton) {
						sendButton.addEventListener('click', sendMessage);
					}

					if (textarea) {
						textarea.addEventListener('keydown', (e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								sendMessage();
							}
						});
					}
				</script>
			</body>
			</html>`;
	}
}

function getNonce() {
	return randomBytes(16).toString("base64");
}

export { convertToComposerMessage } from "../lib/message-converter";
