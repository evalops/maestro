#!/usr/bin/env node
import { bootstrapLsp } from "./bootstrap.js";
import {
	collectDiagnostics,
	documentSymbol,
	touchFile,
	workspaceSymbol,
} from "./index.js";

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "help") {
		printHelp();
		process.exit(0);
	}

	// Initialize LSP
	await bootstrapLsp();

	try {
		switch (command) {
			case "diagnostics": {
				if (args.length < 2) {
					console.error("Error: diagnostics command requires a file path");
					process.exit(1);
				}
				const file = args[1];
				await touchFile(file);
				// Wait a bit for diagnostics to arrive
				await new Promise((resolve) => setTimeout(resolve, 1000));
				const diagnostics = await collectDiagnostics();
				console.log(JSON.stringify(diagnostics, null, 2));
				break;
			}

			case "symbols": {
				if (args.length < 2) {
					console.error("Error: symbols command requires a query");
					process.exit(1);
				}
				const query = args.slice(1).join(" ");
				const symbols = await workspaceSymbol(query);
				console.log(JSON.stringify(symbols, null, 2));
				break;
			}

			case "document-symbols": {
				if (args.length < 2) {
					console.error("Error: document-symbols command requires a file path");
					process.exit(1);
				}
				const file = args[1];
				await touchFile(file);
				const symbols = await documentSymbol(file);
				console.log(JSON.stringify(symbols, null, 2));
				break;
			}

			default:
				console.error(`Unknown command: ${command}`);
				printHelp();
				process.exit(1);
		}

		// Allow time for LSP operations to complete
		await new Promise((resolve) => setTimeout(resolve, 500));
		process.exit(0);
	} catch (error) {
		console.error("Error:", error);
		process.exit(1);
	}
}

function printHelp() {
	console.log(`
LSP Debug CLI

Usage: composer-lsp <command> [options]

Commands:
  diagnostics <file>     Get LSP diagnostics for a file
  symbols <query>        Search for symbols across workspace
  document-symbols <file> Get symbol outline for a file
  help                   Show this help message

Examples:
  composer-lsp diagnostics src/main.ts
  composer-lsp symbols "MyClass"
  composer-lsp document-symbols src/index.ts
`);
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
