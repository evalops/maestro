import * as vscode from "vscode";
import { buildComposerUrl } from "../lib/actions";

export class ComposerSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "composer.chatView";

	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			// Allow scripts in the webview
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

		// Listen for editor changes to keep context fresh
		vscode.window.onDidChangeActiveTextEditor(() => {
			this._sendEditorContext();
		});

		vscode.workspace.onDidChangeTextDocument((e) => {
			if (
				e.document === vscode.window.activeTextEditor?.document &&
				e.contentChanges.length > 0
			) {
				// Debounce could be added here
				this._sendEditorContext();
			}
		});
	}

	private _sendEditorContext() {
		if (!this._view) return;

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this._view.webview.postMessage({
				type: "contextUpdate",
				data: {
					hasContext: false,
				},
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
				selection: text || null, // Only send if non-empty
				fullText: text ? null : fullText, // Send full text only if no selection (simplified strategy)
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
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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

                    <div class="messages" id="messages">
						<div class="message assistant">
							<div class="avatar">AI</div>
							<div class="message-content">
								Hello! I'm ready to help you with your code. I can see your current file and selection.
							</div>
						</div>
                    </div>

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
                    
                    // Initial context request
                    vscode.postMessage({ type: 'getEditorContext' });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'contextUpdate':
                                updateContextUI(message.data);
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

					// Auto-resize textarea
					const textarea = document.querySelector('textarea');
					textarea.addEventListener('input', function() {
						this.style.height = 'auto';
						this.style.height = (this.scrollHeight) + 'px';
					});

					// Send message handling
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

						// Simulate response (mock for now)
						setTimeout(() => {
							const responseDiv = document.createElement('div');
							responseDiv.className = 'message assistant';
							responseDiv.innerHTML = \`
								<div class="avatar">AI</div>
								<div class="message-content">I received your message: "\${text}". This is a mock response until the backend is fully connected.</div>
							\`;
							messages.appendChild(responseDiv);
							messages.scrollTop = messages.scrollHeight;
						}, 1000);
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
