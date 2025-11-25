import * as vscode from "vscode";

import { buildComposerUrl } from "./lib/actions";
import { ThinkingManager } from "./lib/decorations";
import { ComposerPanel } from "./panel/composerPanel";
import { ComposerSidebarProvider } from "./sidebar/composerSidebar";

export function activate(context: vscode.ExtensionContext) {
	const thinkingManager = new ThinkingManager();
	context.subscriptions.push(thinkingManager);

	const sidebarProvider = new ComposerSidebarProvider(
		context.extensionUri,
		thinkingManager,
		context,
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ComposerSidebarProvider.viewType,
			sidebarProvider,
		),
	);

	// Command to simulate thinking for demo purposes
	const simulateThinking = vscode.commands.registerCommand(
		"composer.simulateThinking",
		() => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const line = editor.selection.active.line;
				thinkingManager.setThinking(editor, line);
				// Clear after 3 seconds
				setTimeout(() => thinkingManager.clearThinking(editor, line), 3000);
			}
		},
	);
	context.subscriptions.push(simulateThinking);

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

	const clearChat = vscode.commands.registerCommand(
		"composer.clearChat",
		() => {
			sidebarProvider.clearChat();
		},
	);

	context.subscriptions.push(openPanel, openDocs, clearChat);

	vscode.commands.executeCommand("setContext", "composer.isActive", true);
	context.subscriptions.push({
		dispose: () =>
			vscode.commands.executeCommand("setContext", "composer.isActive", false),
	});
}

export function deactivate() {}
