import { parseA2AArgs } from "../../cli/commands/a2a.js";
import { inspectA2AFleet } from "../../platform/a2a-fleet.js";
import { decodeA2APeerPairingCode } from "../../platform/a2a-peer-pairing.js";
import {
	listA2APeers,
	upsertA2APeerFromPairingPayload,
} from "../../platform/a2a-peer-registry.js";
import {
	getA2ATaskLedgerPath,
	listA2ATaskEntries,
	loadA2ATaskLedger,
} from "../../platform/a2a-task-ledger.js";
import type { CommandExecutionContext } from "./types.js";

export interface A2ACommandHandlerDeps {
	addContent(text: string): void;
	requestRender(): void;
}

export async function handleA2ATuiCommand(
	context: CommandExecutionContext,
	deps: A2ACommandHandlerDeps,
): Promise<void> {
	const parsed = parseA2AArgs(splitCommandArgs(context.argumentText));
	const subcommand = parsed.positionals.shift()?.toLowerCase() ?? "help";
	if (subcommand === "peers" || subcommand === "list") {
		const { path, registry } = await listA2APeers({
			path: stringFlag(parsed.flags, "--registry"),
		});
		const entries = Object.entries(registry.peers).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		deps.addContent(
			[
				`A2A peers (${path})`,
				entries.length === 0
					? "No peers registered. Use /a2a accept <pairing-code>."
					: entries
							.map(([name, peer]) => {
								const marker = registry.defaultPeer === name ? "*" : " ";
								const token = peer.tokenEnv
									? ` auth=env:${peer.tokenEnv}`
									: peer.tokenFile
										? " auth=file"
										: "";
								return `${marker} ${name} ${peer.url}${token}`;
							})
							.join("\n"),
			].join("\n"),
		);
		deps.requestRender();
		return;
	}
	if (subcommand === "fleet") {
		const fleet = await inspectA2AFleet({
			registryPath: stringFlag(parsed.flags, "--registry"),
			tasksPath: stringFlag(parsed.flags, "--tasks"),
			timeoutMs: numberFlag(parsed.flags, "--timeout-ms"),
		});
		deps.addContent(
			[
				`A2A fleet (${fleet.registryPath})`,
				fleet.peers.length === 0
					? "No peers registered. Use /a2a accept <pairing-code>."
					: fleet.peers
							.map((peer) => {
								const last = peer.lastTask
									? ` last=${peer.lastTask.id} ${peer.lastTask.state}`
									: "";
								return `${peer.status} ${peer.name} ${peer.url}${last}`;
							})
							.join("\n"),
			].join("\n"),
		);
		deps.requestRender();
		return;
	}
	if (subcommand === "tasks") {
		const peer = parsed.positionals.shift();
		const tasksPath = stringFlag(parsed.flags, "--tasks");
		const ledger = await loadA2ATaskLedger({ path: tasksPath });
		const entries = listA2ATaskEntries(ledger, { peer });
		deps.addContent(
			[
				`A2A tasks (${getA2ATaskLedgerPath(tasksPath)})`,
				entries.length === 0
					? "No delegated tasks recorded yet."
					: entries
							.map(
								(entry) =>
									`${entry.peer} ${entry.taskId} ${entry.state} ${entry.text}`,
							)
							.join("\n"),
			].join("\n"),
		);
		deps.requestRender();
		return;
	}
	if (subcommand === "accept") {
		const code = parsed.positionals.shift();
		if (!code) {
			context.showError("Usage: /a2a accept <pairing-code>");
			return;
		}
		const payload = decodeA2APeerPairingCode(code);
		const result = await upsertA2APeerFromPairingPayload(payload, {
			name: stringFlag(parsed.flags, "--name"),
			makeDefault: parsed.flags.get("--default") === true,
			tokenEnv: stringFlag(parsed.flags, "--token-env"),
			tokenFile: stringFlag(parsed.flags, "--token-file"),
			path: stringFlag(parsed.flags, "--registry"),
		});
		context.showInfo(`Registered A2A peer ${result.name}.`);
		deps.addContent(
			[
				`Registered A2A peer ${result.name}`,
				`URL: ${result.entry.url}`,
				`Registry: ${result.path}`,
				result.entry.tokenEnv || result.entry.tokenFile
					? "Auth source configured without storing the token value."
					: "No auth source configured. Re-run accept with --token-env or --token-file if this peer requires Authorization.",
			].join("\n"),
		);
		deps.requestRender();
		return;
	}
	if (subcommand === "send") {
		context.showInfo(
			"Use `maestro a2a send <peer> <text> --wait` for native A2A sends while the TUI send panel is being wired.",
		);
		return;
	}
	if (subcommand === "delegate") {
		context.showInfo(
			"Use `maestro a2a delegate <peer> <text> --wait` for native A2A delegation while the TUI task panel is being wired.",
		);
		return;
	}
	deps.addContent(
		[
			"/a2a accept <pairing-code> [--name <peer>] [--default] [--token-env ENV]",
			"/a2a fleet",
			"/a2a peers",
			"/a2a delegate <peer> <text>",
			"/a2a tasks [peer]",
			"/a2a send <peer> <text>",
		].join("\n"),
	);
	deps.requestRender();
}

function splitCommandArgs(input: string): string[] {
	return input.match(/"[^"]*"|'[^']*'|\S+/gu)?.map(stripQuotes) ?? [];
}

function stripQuotes(input: string): string {
	if (
		(input.startsWith('"') && input.endsWith('"')) ||
		(input.startsWith("'") && input.endsWith("'"))
	) {
		return input.slice(1, -1);
	}
	return input;
}

function stringFlag(
	flags: Map<string, string | boolean>,
	name: string,
): string | undefined {
	const value = flags.get(name);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFlag(
	flags: Map<string, string | boolean>,
	name: string,
): number | undefined {
	const value = stringFlag(flags, name);
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
