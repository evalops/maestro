import { join } from "node:path";
import { detectLspServers } from "./autodetect.js";
import { lspManager } from "./manager.js";

/**
 * Autostart LSP servers by probing detected roots with a dummy file per extension group.
 * This reuses lspManager.getClientsForFile to trigger spawn without editing files.
 */
export async function autostartLspServers(cwd: string): Promise<void> {
	const detections = await detectLspServers(cwd);
	for (const detection of detections) {
		const dummyFile = makeDummyFile(detection.serverId, detection.root);
		if (!dummyFile) continue;
		try {
			await lspManager.getClientsForFile(dummyFile);
		} catch {
			// Best-effort; ignore individual spawn errors
		}
	}
}

function makeDummyFile(serverId: string, root: string): string | null {
	switch (serverId) {
		case "typescript":
		case "eslint":
			return join(root, "composer-autostart.ts");
		case "vue":
			return join(root, "composer-autostart.vue");
		case "pyright":
			return join(root, "composer-autostart.py");
		case "gopls":
			return join(root, "composer-autostart.go");
		case "rust-analyzer":
			return join(root, "composer-autostart.rs");
		default:
			return null;
	}
}
