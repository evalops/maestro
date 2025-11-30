import * as vscode from "vscode";

import { buildComposerUrl } from "./lib/actions.js";
import { ThinkingManager } from "./lib/decorations.js";
import { ComposerPanel } from "./panel/composerPanel.js";
import { ComposerSidebarProvider } from "./sidebar/composerSidebar.js";

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

	const switchSession = vscode.commands.registerCommand(
		"composer.switchSession",
		() => {
			sidebarProvider.showSessionPicker();
		},
	);

	const addToContext = vscode.commands.registerCommand(
		"composer.addToContext",
		() => {
			sidebarProvider.addToContext();
		},
	);

	const removeFromContext = vscode.commands.registerCommand(
		"composer.removeFromContext",
		(uri?: vscode.Uri) => {
			sidebarProvider.removeFromContext(uri);
		},
	);

	const showCommandPicker = vscode.commands.registerCommand(
		"composer.showCommandPicker",
		() => {
			sidebarProvider.showCommandPicker();
		},
	);

	context.subscriptions.push(
		openPanel,
		openDocs,
		clearChat,
		switchSession,
		addToContext,
		removeFromContext,
		showCommandPicker,
	);

	vscode.commands.executeCommand("setContext", "composer.isActive", true);
	context.subscriptions.push({
		dispose: () =>
			vscode.commands.executeCommand("setContext", "composer.isActive", false),
	});
}

export function deactivate() {}
