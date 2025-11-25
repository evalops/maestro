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
			"Composer Assistant",
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

	private onMessage(message: { type: string }) {
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
		}
	}

	private getWebviewContent(webview: vscode.Webview): string {
		const cspSource = webview.cspSource;
		const actionButtons = (["web", "docs", "tui"] as const)
			.map(
				(action) =>
					`<button data-action="${action}" class="action">${getActionLabel(action)}</button>`,
			)
			.join("");

		return /* html */ `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; script-src 'nonce-inline' ${cspSource}; style-src 'unsafe-inline';" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Composer Assistant</title>
				<style>
					body {
						font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
						padding: 16px;
						color: var(--vscode-editor-foreground);
						background: var(--vscode-editor-background);
					}
					.card {
						border: 1px solid var(--vscode-panel-border);
						border-radius: 12px;
						padding: 16px;
					}
					h1 {
						font-size: 18px;
						margin-bottom: 8px;
					}
					p {
						font-size: 13px;
						margin-bottom: 16px;
					}
					.actions {
						display: flex;
						gap: 8px;
					}
					button.action {
						flex: 1;
						border: none;
						padding: 8px;
						border-radius: 6px;
						cursor: pointer;
						background: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
					}
					button.action:hover {
						background: var(--vscode-button-hoverBackground);
					}
				</style>
			</head>
			<body>
				<div class="card">
					<h1>Composer Assistant</h1>
					<p>Launch Composer's deterministic agent from VS Code. Use quick actions below to jump into the TUI, docs, or web interface.</p>
					<div class="actions">${actionButtons}</div>
				</div>
				<script nonce="inline">
					const vscode = acquireVsCodeApi();
					document.querySelectorAll('button[data-action]').forEach((button) => {
						button.addEventListener('click', () => {
							const action = button.getAttribute('data-action');
							const type = action === 'docs'
								? 'openDocs'
							: action === 'tui'
								? 'openTui'
								: 'openWeb';
							vscode.postMessage({ type });
						});
					});
				</script>
			</body>
			</html>`;
	}
}
