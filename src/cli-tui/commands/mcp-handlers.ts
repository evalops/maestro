import chalk from "chalk";
import { mcpManager } from "../../mcp/index.js";

export interface McpRenderContext {
	rawInput: string;
	addContent(content: string): void;
	showError(message: string): void;
	requestRender(): void;
}

export function handleMcpCommand(renderCtx: McpRenderContext): void {
	const args = renderCtx.rawInput.replace(/^\/mcp\s*/, "").trim();
	const parts = args.split(/\s+/);
	const subcommand = parts[0]?.toLowerCase() || "";

	if (subcommand === "resources") {
		handleMcpResourcesCommand(parts.slice(1), renderCtx);
		return;
	}
	if (subcommand === "prompts") {
		handleMcpPromptsCommand(parts.slice(1), renderCtx);
		return;
	}

	// Default: show status
	const status = mcpManager.getStatus();
	const lines: string[] = ["Model Context Protocol", ""];

	if (status.servers.length === 0) {
		lines.push(
			"No MCP servers configured.",
			"",
			"Add servers to ~/.maestro/mcp.json or .maestro/mcp.json:",
			"",
			'  { "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "@example/mcp-server"] } } }',
		);
	} else {
		for (const server of status.servers) {
			const statusIcon = server.connected ? chalk.green("●") : chalk.red("○");
			lines.push(`${statusIcon} ${server.name}`);
			if (server.connected) {
				if (server.tools.length > 0) {
					lines.push(
						`    Tools: ${server.tools.map((t) => t.name).join(", ")}`,
					);
				}
				if (server.resources.length > 0) {
					lines.push(`    Resources: ${server.resources.length}`);
				}
				if (server.prompts.length > 0) {
					lines.push(`    Prompts: ${server.prompts.join(", ")}`);
				}
			} else {
				lines.push(`    ${chalk.dim("Not connected")}`);
			}
		}
		lines.push("");
		lines.push(chalk.dim("Subcommands: /mcp resources, /mcp prompts"));
	}

	renderCtx.addContent(lines.join("\n"));
	renderCtx.requestRender();
}

export function handleMcpResourcesCommand(
	args: string[],
	renderCtx: McpRenderContext,
): void {
	const status = mcpManager.getStatus();
	const lines: string[] = ["MCP Resources", ""];

	// /mcp resources [server] [uri] - read a specific resource
	if (args.length >= 2) {
		const serverName = args[0]!;
		const uri = args.slice(1).join(" ");
		const server = status.servers.find((s) => s.name === serverName);
		if (!server?.connected) {
			lines.push(`Server '${serverName}' not connected`);
		} else {
			mcpManager
				.readResource(serverName, uri)
				.then((result) => {
					const resourceLines = [`Resource: ${uri}`, ""];
					for (const content of result.contents) {
						if (content.text) {
							resourceLines.push(content.text);
						} else if (content.blob) {
							resourceLines.push(
								`[Binary data: ${content.mimeType || "unknown type"}]`,
							);
						}
					}
					renderCtx.addContent(resourceLines.join("\n"));
					renderCtx.requestRender();
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					renderCtx.showError(`Failed to read resource: ${message}`);
				});
			return;
		}
	} else {
		// List all resources from all servers
		let hasResources = false;
		for (const server of status.servers) {
			if (!server.connected || server.resources.length === 0) continue;
			hasResources = true;
			lines.push(`${chalk.bold(server.name)}:`);
			for (const uri of server.resources) {
				lines.push(`  ${uri}`);
			}
			lines.push("");
		}
		if (!hasResources) {
			lines.push("No resources available from connected servers.");
		}
		lines.push("");
		lines.push(chalk.dim("Usage: /mcp resources <server> <uri>"));
	}

	renderCtx.addContent(lines.join("\n"));
	renderCtx.requestRender();
}

export function handleMcpPromptsCommand(
	args: string[],
	renderCtx: McpRenderContext,
): void {
	const status = mcpManager.getStatus();
	const lines: string[] = ["MCP Prompts", ""];

	// /mcp prompts [server] [name] - get a specific prompt
	if (args.length >= 2) {
		const serverName = args[0]!;
		const promptName = args[1]!;
		const server = status.servers.find((s) => s.name === serverName);
		if (!server?.connected) {
			lines.push(`Server '${serverName}' not connected`);
		} else if (!server.prompts.includes(promptName)) {
			lines.push(`Prompt '${promptName}' not found on server '${serverName}'`);
		} else {
			mcpManager
				.getPrompt(serverName, promptName)
				.then((result) => {
					const promptLines = [`Prompt: ${promptName}`, ""];
					if (result.description) {
						promptLines.push(`Description: ${result.description}`, "");
					}
					for (const msg of result.messages) {
						promptLines.push(`[${msg.role}]`);
						promptLines.push(msg.content);
						promptLines.push("");
					}
					renderCtx.addContent(promptLines.join("\n"));
					renderCtx.requestRender();
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					renderCtx.showError(`Failed to get prompt: ${message}`);
				});
			return;
		}
	} else {
		// List all prompts from all servers
		let hasPrompts = false;
		for (const server of status.servers) {
			if (!server.connected || server.prompts.length === 0) continue;
			hasPrompts = true;
			lines.push(`${chalk.bold(server.name)}:`);
			for (const prompt of server.prompts) {
				lines.push(`  ${prompt}`);
			}
			lines.push("");
		}
		if (!hasPrompts) {
			lines.push("No prompts available from connected servers.");
		}
		lines.push("");
		lines.push(chalk.dim("Usage: /mcp prompts <server> <name>"));
	}

	renderCtx.addContent(lines.join("\n"));
	renderCtx.requestRender();
}
