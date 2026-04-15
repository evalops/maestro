import { FEATURES } from "../config/constants.js";
import { applyServerOverrides, getLspConfig } from "../config/lsp-config.js";
import { resolveWorkspaceRoot } from "../workspace/root-resolver.js";
import { autostartLspServers } from "./autostart.js";
import {
	collectDiagnostics,
	configureRootResolver,
	configureServers,
} from "./index.js";
import { createDefaultServers } from "./servers.js";

export async function bootstrapLsp(): Promise<void> {
	// Configure the workspace root resolver for LSP
	configureRootResolver(resolveWorkspaceRoot);

	// Get LSP configuration (with blocking severity)
	const lspConfig = getLspConfig();

	// Create default servers with workspace root resolver
	const defaultServers = await createDefaultServers(resolveWorkspaceRoot);

	// Apply user overrides from ~/.maestro/config.json
	const finalServers = applyServerOverrides(defaultServers);

	// Configure servers in LSP
	await configureServers(finalServers);

	if (FEATURES.LSP_AUTOSTART && FEATURES.LSP_ENABLED) {
		await autostartLspServers(process.cwd());
	}

	// Configure blocking severity in safe-mode if specified
	if (lspConfig.blockingSeverity) {
		process.env.MAESTRO_SAFE_LSP_SEVERITY = String(lspConfig.blockingSeverity);
	}
}

export { collectDiagnostics };
