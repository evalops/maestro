export interface SlashCommandPermission {
	action: string;
	resource?: string;
}

const CONNECTOR_MUTATION_PERMISSION: SlashCommandPermission = {
	action: "execute_tool",
	resource: "connector_*",
};

const TRIGGER_MUTATION_PERMISSION: SlashCommandPermission = {
	action: "manage_triggers",
};

export function requiredPermissionForSlashCommand(
	command: string,
	text: string,
): SlashCommandPermission | null {
	const cmd = command.trim().toLowerCase();
	const trimmed = text.trim();

	switch (cmd) {
		case "/connect":
			return trimmed ? CONNECTOR_MUTATION_PERMISSION : null;
		case "/connect-credentials":
		case "/disconnect":
			return CONNECTOR_MUTATION_PERMISSION;
		case "/triggers": {
			const subcommand = trimmed.split(/\s+/)[0]?.toLowerCase() || "list";
			return subcommand === "add" ||
				subcommand === "remove" ||
				subcommand === "delete"
				? TRIGGER_MUTATION_PERMISSION
				: null;
		}
		default:
			return null;
	}
}
