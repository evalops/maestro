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
					body {
						padding: 0;
						margin: 0;
						font-family: var(--vscode-font-family);
						color: var(--vscode-editor-foreground);
						background-color: var(--vscode-sideBar-background);
					}
                    .container {
                        padding: 16px;
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        box-sizing: border-box;
                    }
                    .header {
                        margin-bottom: 20px;
                        text-align: center;
                    }
                    h2 {
                        margin: 0;
                        font-size: 14px;
                        font-weight: 600;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                        color: var(--vscode-descriptionForeground);
                    }
                    .chat-placeholder {
                        flex: 1;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                        border: 1px dashed var(--vscode-input-border);
                        border-radius: 6px;
                        padding: 20px;
                        margin-bottom: 20px;
                    }
                    .context-bar {
                        font-size: 11px;
                        padding: 4px 8px;
                        background: var(--vscode-editor-lineHighlightBackground);
                        border-radius: 4px;
                        margin-bottom: 12px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .context-dot {
                        width: 6px;
                        height: 6px;
                        border-radius: 50%;
                        background: #6b7280;
                    }
                    .context-dot.active {
                        background: #10b981;
                        box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
                    }
                    button {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 12px;
                        border-radius: 4px;
                        cursor: pointer;
                        width: 100%;
                        font-family: inherit;
                        font-weight: 500;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
				</style>
			</head>
			<body>
                <div class="container">
                    <div class="header">
                        <h2>Composer Agent</h2>
                    </div>
                    
                    <div id="context-bar" class="context-bar">
                        <div id="context-dot" class="context-dot"></div>
                        <span id="context-text">No active file</span>
                    </div>

                    <div class="chat-placeholder">
                        <p>Chat interface coming soon.</p>
                        <p style="font-size: 12px; opacity: 0.7;">Now listening to editor events...</p>
                    </div>
                    <button id="docs-btn">View Documentation</button>
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
                        const dot = document.getElementById('context-dot');
                        const text = document.getElementById('context-text');
                        
                        if (data.hasContext) {
                            dot.className = 'context-dot active';
                            const name = data.filename.split(/[\\\\/]/).pop();
                            const extra = data.selection ? '(selection)' : '';
                            text.textContent = \`Reading: \${name} \${extra}\`;
                        } else {
                            dot.className = 'context-dot';
                            text.textContent = 'No active file';
                        }
                    }

                    document.getElementById('docs-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'openDocs' });
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
