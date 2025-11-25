import * as vscode from "vscode";

import { buildComposerUrl } from "./lib/actions";

import { ComposerPanel } from "./panel/composerPanel";

export function activate(context: vscode.ExtensionContext) {
	const openPanel = vscode.commands.registerCommand(
		"composer.openPanel",
		() => {
			ComposerPanel.render(context.extensionUri);
		},
	);

	const openDocs = vscode.commands.registerCommand(
		"composer.openDocs",
		async () => {
			await vscode.env.openExternal(vscode.Uri.parse(buildComposerUrl("docs")));
		},
	);

	context.subscriptions.push(openPanel, openDocs);

	vscode.commands.executeCommand("setContext", "composer.isActive", true);
	context.subscriptions.push({
		dispose: () =>
			vscode.commands.executeCommand("setContext", "composer.isActive", false),
	});
}

export function deactivate() {}
