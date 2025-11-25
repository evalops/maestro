import * as vscode from "vscode";
import { buildComposerUrl } from "../lib/actions";
import { ApiClient, type Message } from "../lib/api-client";
import type { ThinkingManager } from "../lib/decorations";

export class ComposerSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "composer.chatView";

	private _view?: vscode.WebviewView;
	private _apiClient: ApiClient;
	private _messages: Message[] = [];
	private _currentSessionId?: string;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _thinkingManager: ThinkingManager,
	) {
		this._apiClient = new ApiClient();
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

		webviewView.webview.onDidReceiveMessage((data) => {
			switch (data.type) {
				case "openDocs": {
					vscode.env.openExternal(vscode.Uri.parse(buildComposerUrl("docs")));
					break;
				}
				case "getEditorContext": {
					this._sendEditorContext();
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
			}
		});

		vscode.window.onDidChangeActiveTextEditor(() => {
			this._sendEditorContext();
		});

		vscode.workspace.onDidChangeTextDocument((e) => {
			if (
				e.document === vscode.window.activeTextEditor?.document &&
				e.contentChanges.length > 0
			) {
				this._sendEditorContext();
			}
		});
	}

	private async _handleUserMessage(text: string) {
		if (!this._view) return;

		// Add user message to history
		const userMsg: Message = {
			role: "user",
			content: text,
			timestamp: new Date().toISOString(),
		};
		this._messages.push(userMsg);

		// Ensure session
		if (!this._currentSessionId) {
			try {
				const session = await this._apiClient.createSession("VS Code Chat");
				this._currentSessionId = session.id;
			} catch (e) {
				vscode.window.showErrorMessage(
					"Failed to create session. Is the Composer server running on port 8080?",
				);
				this._view.webview.postMessage({
					type: "error",
					value: "Connection failed",
				});
				return;
			}
		}

		// Prepare assistant message placeholder
		const assistantMsg: Message = {
			role: "assistant",
			content: "",
			timestamp: new Date().toISOString(),
		};
		this._messages.push(assistantMsg);

		let thinkingLine: number | undefined;
		if (vscode.window.activeTextEditor) {
			thinkingLine = vscode.window.activeTextEditor.selection.active.line;
		}

		try {
			// Stream response
			const stream = this._apiClient.chatWithEvents({
				model: "claude-sonnet-4-5", // default
				messages: this._messages.slice(0, -1),
				sessionId: this._currentSessionId,
			});

			for await (const event of stream) {
				if (event.type === "text_delta" && event.text) {
					assistantMsg.content += event.text;
					this._view.webview.postMessage({
						type: "token",
						value: event.text,
					});
				} else if (event.type === "thinking_start") {
					if (vscode.window.activeTextEditor && thinkingLine !== undefined) {
						this._thinkingManager.setThinking(
							vscode.window.activeTextEditor,
							thinkingLine,
						);
					}
					this._view.webview.postMessage({ type: "thinking_start" });
				} else if (event.type === "thinking_end") {
					if (vscode.window.activeTextEditor && thinkingLine !== undefined) {
						this._thinkingManager.clearThinking(
							vscode.window.activeTextEditor,
							thinkingLine,
						);
					}
					this._view.webview.postMessage({ type: "thinking_end" });
				}
			}

			this._view.webview.postMessage({ type: "done" });
		} catch (e) {
			console.error(e);
			this._view.webview.postMessage({
				type: "error",
				value: e instanceof Error ? e.message : "Unknown error",
			});
			if (vscode.window.activeTextEditor && thinkingLine !== undefined) {
				this._thinkingManager.clearThinking(
					vscode.window.activeTextEditor,
					thinkingLine,
				);
			}
		}
	}

	private _sendEditorContext() {
		if (!this._view) return;

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this._view.webview.postMessage({
				type: "contextUpdate",
				data: { hasContext: false },
			});
			return;
		}

		const document = editor.document;
		const selection = editor.selection;
		const text = document.getText(selection);
		const fullText = document.getText();
		const filename = document.fileName;
		const languageId = document.languageId;

		this._view.webview.postMessage({
			type: "contextUpdate",
			data: {
				hasContext: true,
				filename,
				languageId,
				selection: text || null,
				fullText: text ? null : fullText,
				cursorLine: selection.active.line,
			},
		});
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src http://localhost:*; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Composer Chat</title>
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
						white-space: pre-wrap;
					}

                    .context-bar {
                        font-size: 11px;
                        padding: 6px 12px;
                        background: var(--vscode-editor-lineHighlightBackground);
                        border-bottom: 1px solid var(--border-color);
                        display: flex;
                        align-items: center;
                        gap: 8px;
						color: var(--text-secondary);
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
				</style>
			</head>
			<body>
                <div class="container">
                    <div class="header">
                        <h2>Composer Agent</h2>
						<div id="status-dot" class="status-dot"></div>
                    </div>
                    
                    <div id="context-bar" class="context-bar">
						<span style="opacity: 0.7">Reading:</span>
                        <span id="context-text">No active file</span>
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

				<script nonce="${nonce}">
					const vscode = acquireVsCodeApi();
                    let currentAssistantMessage = null;
					let thinkingEl = null;

                    // Initial context request
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
							case 'thinking_end':
								hideThinking();
								break;
							case 'done':
								currentAssistantMessage = null;
								break;
							case 'error':
								showError(message.value);
								break;
                        }
                    });

                    function updateContextUI(data) {
                        const dot = document.getElementById('status-dot');
                        const text = document.getElementById('context-text');
                        
                        if (data.hasContext) {
                            dot.className = 'status-dot active';
                            const name = data.filename.split(/[\\\\/]/).pop();
                            const extra = data.selection ? '(selection)' : '';
                            text.innerHTML = \`\${name} <span class="context-pill">\${data.languageId}</span> \${extra}\`;
                        } else {
                            dot.className = 'status-dot';
                            text.textContent = 'No active file';
                        }
                    }

					function showThinking() {
						if (!currentAssistantMessage) createAssistantMessage();
						if (thinkingEl) return;
						
						thinkingEl = document.createElement('div');
						thinkingEl.className = 'thinking';
						thinkingEl.innerHTML = 'Thinking<span class="thinking-dots"></span>';
						
						// Insert before content or append
						const content = currentAssistantMessage.querySelector('.message-content');
						content.insertBefore(thinkingEl, content.firstChild);
					}

					function hideThinking() {
						if (thinkingEl) {
							thinkingEl.remove();
							thinkingEl = null;
						}
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
						messages.scrollTop = messages.scrollHeight;
						return div;
					}

					function appendToken(text) {
						if (!currentAssistantMessage) createAssistantMessage();
						const content = currentAssistantMessage.querySelector('.message-content');
						const textNode = document.createTextNode(text);
						content.appendChild(textNode);
						
						const messages = document.getElementById('messages');
						messages.scrollTop = messages.scrollHeight;
					}

					function showError(text) {
						const messages = document.getElementById('messages');
						const div = document.createElement('div');
						div.className = 'message assistant';
						div.style.borderColor = '#ef4444';
						div.innerHTML = \`
							<div class="avatar" style="background:#ef4444">!</div>
							<div class="message-content">\${text}</div>
						\`;
						messages.appendChild(div);
						messages.scrollTop = messages.scrollHeight;
					}

					// Auto-resize textarea
					const textarea = document.querySelector('textarea');
					textarea.addEventListener('input', function() {
						this.style.height = 'auto';
						this.style.height = (this.scrollHeight) + 'px';
					});

					function sendMessage() {
						const text = textarea.value.trim();
						if (!text) return;

						// Add user message to UI
						const messages = document.getElementById('messages');
						const div = document.createElement('div');
						div.className = 'message user';
						div.innerHTML = \`
							<div class="avatar">U</div>
							<div class="message-content">\${text.replace(/</g, '&lt;')}</div>
						\`;
						messages.appendChild(div);
						messages.scrollTop = messages.scrollHeight;

						// Clear input
						textarea.value = '';
						textarea.style.height = 'auto';

						// Send to extension
						vscode.postMessage({ type: 'sendMessage', text });
					}

                    document.getElementById('send-btn').addEventListener('click', sendMessage);
					
					textarea.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							sendMessage();
						}
					});
				</script>
			</body>
			</html>`;
	}
}

function getNonce() {
	let text = "";
	const possible =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
