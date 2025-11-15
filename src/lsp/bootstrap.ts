import { applyServerOverrides, getLspConfig } from "../config/lsp-config.js";
import { createDefaultServers } from "../lsp/servers.js";
import { resolveWorkspaceRoot } from "../workspace/root-resolver.js";
import {
	collectDiagnostics,
	configureRootResolver,
	configureServers,
} from "./index.js";

export async function bootstrapLsp(): Promise<void> {
	// Configure the workspace root resolver for LSP
	configureRootResolver(resolveWorkspaceRoot);

	// Get LSP configuration (with blocking severity)
	const lspConfig = getLspConfig();

	// Create default servers with workspace root resolver
	const defaultServers = await createDefaultServers(resolveWorkspaceRoot);

	// Apply user overrides from ~/.composer/config.json
	const finalServers = applyServerOverrides(defaultServers);

	// Configure servers in LSP
	await configureServers(finalServers);

	// Configure blocking severity in safe-mode if specified
	if (lspConfig.blockingSeverity) {
		process.env.COMPOSER_SAFE_LSP_SEVERITY = String(lspConfig.blockingSeverity);
	}
}

export { collectDiagnostics };
