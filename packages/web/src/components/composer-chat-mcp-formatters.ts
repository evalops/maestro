import type {
	McpPromptResponse,
	McpResourceReadResponse,
	McpServerStatus,
	McpStatus,
} from "../services/api-client.js";

function getMcpToolCount(server: McpServerStatus): number {
	if (Array.isArray(server.tools)) {
		return server.tools.length;
	}
	return typeof server.tools === "number" ? server.tools : 0;
}

export function formatMcpServers(status: McpStatus): string {
	if (status.servers.length === 0) {
		return "No MCP servers configured.";
	}

	const lines: string[] = ["# MCP Servers", ""];
	for (const server of status.servers) {
		lines.push(
			`- ${server.name}: ${server.connected ? "connected" : "disconnected"}`,
		);
		if (server.transport) {
			lines.push(`  transport: ${server.transport}`);
		}
		if (server.remoteUrl) {
			lines.push(`  remote: ${server.remoteUrl}`);
		}
		if (server.remoteTrust) {
			lines.push(`  trust: ${server.remoteTrust}`);
		}
		if (server.officialRegistry?.displayName) {
			lines.push(`  official: ${server.officialRegistry.displayName}`);
		}
		if (server.scope) {
			lines.push(`  scope: ${server.scope}`);
		}
		lines.push(`  tools: ${getMcpToolCount(server)}`);
		lines.push(`  resources: ${server.resources?.length ?? 0}`);
		lines.push(`  prompts: ${server.prompts?.length ?? 0}`);
		if (server.officialRegistry?.documentationUrl) {
			lines.push(`  docs: ${server.officialRegistry.documentationUrl}`);
		}
		if (server.officialRegistry?.permissions) {
			lines.push(`  permissions: ${server.officialRegistry.permissions}`);
		}
		if (server.error) {
			lines.push(`  error: ${server.error}`);
		}
	}
	return lines.join("\n");
}

export function formatMcpTools(
	status: McpStatus,
	serverName?: string,
): { isError: boolean; text: string } {
	const servers = serverName
		? status.servers.filter((server) => server.name === serverName)
		: status.servers;

	if (serverName && servers.length === 0) {
		return { isError: true, text: `MCP server '${serverName}' not found.` };
	}

	const disconnected = serverName
		? servers.find((server) => !server.connected)
		: null;
	if (disconnected) {
		return {
			isError: true,
			text: `MCP server '${disconnected.name}' is not connected.`,
		};
	}

	const connectedWithTools = servers
		.filter((server) => server.connected)
		.map((server) => ({
			name: server.name,
			tools: Array.isArray(server.tools) ? server.tools : [],
		}))
		.filter((server) => server.tools.length > 0);

	if (connectedWithTools.length === 0) {
		return {
			isError: false,
			text: "No MCP tools available. Either no servers are connected or they don't expose tools.",
		};
	}

	const lines: string[] = ["# Available MCP Tools", ""];
	for (const server of connectedWithTools) {
		lines.push(`## ${server.name}`);
		for (const tool of server.tools) {
			lines.push(
				tool.description
					? `- ${tool.name}: ${tool.description}`
					: `- ${tool.name}`,
			);
		}
		lines.push("");
	}

	return { isError: false, text: lines.join("\n").trimEnd() };
}

export function formatMcpResources(
	status: McpStatus,
	serverName: string | undefined,
): { isError: boolean; text: string } {
	const servers = serverName
		? status.servers.filter((server) => server.name === serverName)
		: status.servers;

	if (serverName && servers.length === 0) {
		return {
			isError: true,
			text: `MCP server '${serverName}' not found.`,
		};
	}

	const disconnected = serverName
		? servers.find((server) => !server.connected)
		: null;
	if (disconnected) {
		return {
			isError: true,
			text: `MCP server '${disconnected.name}' is not connected.`,
		};
	}

	const connectedWithResources = servers
		.filter((server) => server.connected)
		.filter((server) => (server.resources?.length ?? 0) > 0);

	if (connectedWithResources.length === 0) {
		return {
			isError: false,
			text: "No MCP resources available. Either no servers are connected or they don't expose resources.",
		};
	}

	const lines: string[] = ["# Available MCP Resources", ""];
	for (const server of connectedWithResources) {
		lines.push(`## ${server.name}`);
		for (const uri of server.resources ?? []) {
			lines.push(`- ${uri}`);
		}
		lines.push("");
	}
	return { isError: false, text: lines.join("\n").trimEnd() };
}

export function formatMcpResourceRead(
	result: McpResourceReadResponse,
	uri: string,
): string {
	if (result.contents.length === 0) {
		return `Resource '${uri}' is empty.`;
	}

	const textContents = result.contents
		.filter((content) => typeof content.text === "string")
		.map((content) => content.text as string);

	if (textContents.length > 0) {
		return textContents.join("\n---\n");
	}

	return JSON.stringify(result.contents, null, 2);
}

export function formatMcpPrompts(
	status: McpStatus,
	serverName?: string,
): { isError: boolean; text: string } {
	const servers = serverName
		? status.servers.filter((server) => server.name === serverName)
		: status.servers;

	if (serverName && servers.length === 0) {
		return { isError: true, text: `MCP server '${serverName}' not found.` };
	}

	const disconnected = serverName
		? servers.find((server) => !server.connected)
		: null;
	if (disconnected) {
		return {
			isError: true,
			text: `MCP server '${disconnected.name}' is not connected.`,
		};
	}

	const connectedWithPrompts = servers
		.filter((server) => server.connected)
		.filter((server) => (server.prompts?.length ?? 0) > 0);

	if (connectedWithPrompts.length === 0) {
		return {
			isError: false,
			text: serverName
				? `MCP server '${serverName}' does not expose prompts.`
				: "No MCP prompts available. Either no servers are connected or they don't expose prompts.",
		};
	}

	const lines: string[] = ["# Available MCP Prompts", ""];
	for (const server of connectedWithPrompts) {
		lines.push(`## ${server.name}`);
		for (const promptName of server.prompts ?? []) {
			lines.push(`- ${promptName}`);
			const prompt = server.promptDetails?.find(
				(entry) => entry.name === promptName,
			);
			const promptArguments = prompt?.arguments ?? [];
			if (prompt?.title && prompt.title !== promptName) {
				lines.push(`  Title: ${prompt.title}`);
			}
			if (prompt?.description) {
				lines.push(`  Description: ${prompt.description}`);
			}
			if (promptArguments.length > 0) {
				lines.push(
					`  Args: ${promptArguments
						.map((argument) => {
							const summary = argument.required
								? `${argument.name} (required)`
								: argument.name;
							return argument.description
								? `${summary}: ${argument.description}`
								: summary;
						})
						.join("; ")}`,
				);
			}
		}
		lines.push("");
	}

	return { isError: false, text: lines.join("\n").trimEnd() };
}

export function formatMcpPrompt(
	result: McpPromptResponse,
	promptName: string,
): string {
	const lines: string[] = [`Prompt: ${promptName}`, ""];
	if (result.description) {
		lines.push(`Description: ${result.description}`, "");
	}
	for (const message of result.messages) {
		lines.push(`[${message.role}]`);
		lines.push(message.content);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
