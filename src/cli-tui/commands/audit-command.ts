import { isDatabaseConfigured } from "../../db/client.js";
import { isHelpRequest } from "./grouped/utils.js";
import type { CommandExecutionContext } from "./types.js";

const AUDIT_USAGE = [
	"Audit logging:",
	"  /audit           Show audit log status",
	"  /audit status    Show audit log status",
	"  /audit help      Show this help",
].join("\n");

export function handleAuditCommand(
	context: CommandExecutionContext,
	options?: { isDatabaseConfigured?: () => boolean },
): void {
	const args = context.argumentText.trim().split(/\s+/).filter(Boolean);
	const subcommand = (args[0] || "").toLowerCase();

	if (!subcommand) {
		showAuditStatus(context, options?.isDatabaseConfigured);
		return;
	}

	if (isHelpRequest(subcommand)) {
		context.showInfo(AUDIT_USAGE);
		return;
	}

	if (subcommand === "status" || subcommand === "info") {
		showAuditStatus(context, options?.isDatabaseConfigured);
		return;
	}

	context.showError("Unknown audit subcommand.");
	context.showInfo(AUDIT_USAGE);
}

function showAuditStatus(
	context: CommandExecutionContext,
	isConfiguredOverride?: () => boolean,
): void {
	const configured = isConfiguredOverride?.() ?? isDatabaseConfigured();
	if (configured) {
		context.showInfo(
			"Audit Log (Enterprise): Database connected.\nUse web API for full audit log access.",
		);
		return;
	}

	context.showInfo(
		"Audit Log: Enterprise feature - database not configured.\nSet MAESTRO_DATABASE_URL to enable.",
	);
}
