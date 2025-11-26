import * as vscode from "vscode";

import { buildComposerUrl, getActionLabel } from "../lib/actions";

export class ComposerPanel {
	private static currentPanel: ComposerPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly extensionUri: vscode.Uri,
	) {
		this.panel.webview.html = this.getWebviewContent(this.panel.webview);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(
			this.onMessage,
			this,
			this.disposables,
		);
	}

	public static render(extensionUri: vscode.Uri) {
		if (ComposerPanel.currentPanel) {
			ComposerPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"composerPanel",
			"Composer",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri],
			},
		);

		ComposerPanel.currentPanel = new ComposerPanel(panel, extensionUri);
	}

	private dispose() {
		ComposerPanel.currentPanel = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private onMessage(message: { type: string; url?: string }) {
		switch (message.type) {
			case "openDocs":
				vscode.env.openExternal(vscode.Uri.parse(buildComposerUrl("docs")));
				break;
			case "openWeb":
				vscode.env.openExternal(vscode.Uri.parse(buildComposerUrl("web")));
				break;
			case "openTui":
				vscode.env.openExternal(vscode.Uri.parse(buildComposerUrl("tui")));
				break;
			case "openLocal":
				if (message.url) {
					vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				break;
		}
	}

	private getWebviewContent(webview: vscode.Webview): string {
		const cspSource = webview.cspSource;
		// Generate a nonce for the script
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src http://localhost:*; img-src https: data:; script-src 'nonce-${nonce}' ${cspSource}; style-src 'unsafe-inline';" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Composer Assistant</title>
				<style>
					:root {
                        --bg-primary: var(--vscode-editor-background);
                        --bg-secondary: var(--vscode-sideBar-background);
                        --text-primary: var(--vscode-editor-foreground);
                        --text-secondary: var(--vscode-descriptionForeground);
                        --accent-color: var(--vscode-button-background);
                        --accent-hover: var(--vscode-button-hoverBackground);
                        --border-color: var(--vscode-panel-border);
                        --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    }

					body {
						font-family: var(--font-sans);
						padding: 0;
                        margin: 0;
						color: var(--text-primary);
						background: var(--bg-primary);
                        height: 100vh;
                        display: flex;
                        flex-direction: column;
					}

                    .container {
                        max-width: 600px;
                        margin: 0 auto;
                        padding: 24px;
                        width: 100%;
                        box-sizing: border-box;
                    }

					.header {
                        margin-bottom: 32px;
                        text-align: center;
                    }

					h1 {
						font-size: 24px;
                        font-weight: 600;
						margin: 0 0 8px 0;
                        background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        background-clip: text;
                        color: transparent;
					}

					p {
						font-size: 14px;
						margin: 0;
                        color: var(--text-secondary);
                        line-height: 1.5;
					}

                    .card {
                        background: var(--bg-secondary);
                        border: 1px solid var(--border-color);
                        border-radius: 12px;
                        padding: 20px;
                        margin-bottom: 16px;
                        transition: transform 0.2s, box-shadow 0.2s;
                    }

                    .card:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                    }

                    .card-header {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        margin-bottom: 12px;
                    }

                    .card-title {
                        font-weight: 600;
                        font-size: 16px;
                    }

                    .status-badge {
                        font-size: 11px;
                        padding: 2px 8px;
                        border-radius: 12px;
                        background: var(--vscode-badge-background);
                        color: var(--vscode-badge-foreground);
                    }

                    .status-badge.online {
                        background: #10b981;
                        color: white;
                    }

                    .status-badge.offline {
                        background: #6b7280;
                        color: white;
                    }

					.actions {
						display: grid;
						grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
						gap: 12px;
					}

					button.action {
						border: none;
						padding: 12px;
						border-radius: 8px;
						cursor: pointer;
						background: var(--accent-color);
						color: white;
                        font-weight: 500;
                        font-size: 13px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        transition: background 0.2s;
                        text-decoration: none;
					}

					button.action:hover {
						background: var(--accent-hover);
					}

                    button.action.secondary {
                        background: var(--bg-secondary);
                        border: 1px solid var(--border-color);
                        color: var(--text-primary);
                    }

                    button.action.secondary:hover {
                        background: var(--vscode-list-hoverBackground);
                    }

                    .server-status {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        font-size: 13px;
                        color: var(--text-secondary);
                        margin-top: 12px;
                        padding-top: 12px;
                        border-top: 1px solid var(--border-color);
                    }

                    .indicator {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        background: #ef4444;
                        transition: all 0.3s ease;
                    }

                    .indicator.active {
                        background: #10b981;
                        box-shadow: 0 0 8px #10b981;
                    }
				</style>
			</head>
			<body>
				<div class="container">
                    <div class="header">
                        <h1>Composer</h1>
                        <p>Deterministic AI Agent for Engineering</p>
                    </div>

					<div class="card">
                        <div class="card-header">
                            <span class="card-title">Local Workspace</span>
                            <span id="server-badge" class="status-badge offline">Offline</span>
                        </div>
                        <p style="margin-bottom: 16px;">Connect to your local Composer instance for full file access and terminal control.</p>

                        <div id="local-actions" class="actions" style="display:none">
                             <button id="btn-open-local" class="action">
                                Open Web UI
                            </button>
                        </div>
                        <div id="local-placeholder" style="font-size: 13px; color: var(--text-secondary); font-style: italic;">
                            Server not detected on port 8080. Run <code>npm run web</code> to start.
                        </div>

                        <div class="server-status">
                            <span id="server-indicator" class="indicator"></span>
                            <span id="server-text">Checking server status...</span>
                        </div>
					</div>

                    <div class="card">
                        <div class="card-header">
                            <span class="card-title">Resources</span>
                        </div>
    					<div class="actions">
                            <button data-action="tui" class="action secondary">Launch TUI</button>
                            <button data-action="docs" class="action secondary">Documentation</button>
                            <button data-action="web" class="action secondary">Cloud Dashboard</button>
                        </div>
                    </div>
				</div>

				<script nonce="${nonce}">
					const vscode = acquireVsCodeApi();

                    // Button handlers
					document.querySelectorAll('button[data-action]').forEach((button) => {
						button.addEventListener('click', () => {
							const action = button.getAttribute('data-action');
							const type = action === 'docs' ? 'openDocs' : action === 'tui' ? 'openTui' : 'openWeb';
							vscode.postMessage({ type });
						});
					});

                    const btnOpenLocal = document.getElementById('btn-open-local');
                    if (btnOpenLocal) {
                        btnOpenLocal.addEventListener('click', () => {
                            vscode.postMessage({ type: 'openLocal', url: 'http://localhost:8080' });
                        });
                    }

                    // Status check
                    async function checkServer() {
                        const badge = document.getElementById('server-badge');
                        const indicator = document.getElementById('server-indicator');
                        const text = document.getElementById('server-text');
                        const localActions = document.getElementById('local-actions');
                        const localPlaceholder = document.getElementById('local-placeholder');

                        try {
                            // Try to fetch models or health endpoint
                            const controller = new AbortController();
                            const timeoutId = setTimeout(() => controller.abort(), 1000);

                            const res = await fetch('http://localhost:8080/api/models', {
                                method: 'GET',
                                signal: controller.signal
                            });
                            clearTimeout(timeoutId);

                            if (res.ok) {
                                badge.textContent = 'Active';
                                badge.className = 'status-badge online';
                                indicator.className = 'indicator active';
                                text.textContent = 'Server running at localhost:8080';
                                localActions.style.display = 'grid';
                                localPlaceholder.style.display = 'none';
                            } else {
                                throw new Error('Status not ok');
                            }
                        } catch (e) {
                            badge.textContent = 'Offline';
                            badge.className = 'status-badge offline';
                            indicator.className = 'indicator';
                            text.textContent = 'Server not detected';
                            localActions.style.display = 'none';
                            localPlaceholder.style.display = 'block';
                        }
                    }

                    // Check immediately and then every 5s
                    checkServer();
                    setInterval(checkServer, 5000);
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
