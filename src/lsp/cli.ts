#!/usr/bin/env node
import { bootstrapLsp } from "./bootstrap.js";
import {
	collectDiagnostics,
	definition,
	documentSymbol,
	references,
	touchFile,
	workspaceSymbol,
} from "./index.js";
import { uriToPath } from "./utils.js";

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
				const file = args[1];
				if (file) {
					await touchFile(file);
				}
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
				const file = args[1]!;
				await touchFile(file);
				const symbols = await documentSymbol(file);
				console.log(JSON.stringify(symbols, null, 2));
				break;
			}
			case "definition": {
				if (args.length < 4) {
					console.error(
						"Error: definition command requires a file path, line, and character",
					);
					process.exit(1);
				}
				const file = args[1]!;
				const line = Number.parseInt(args[2] ?? "", 10);
				const character = Number.parseInt(args[3] ?? "", 10);
				if (Number.isNaN(line) || Number.isNaN(character)) {
					console.error("Error: line and character must be numbers");
					process.exit(1);
				}
				await touchFile(file);
				const locations = await definition(file, line, character);
				const normalized = locations.map((location) => ({
					uri: uriToPath(location.uri),
					range: location.range,
				}));
				console.log(JSON.stringify(normalized, null, 2));
				break;
			}
			case "references": {
				if (args.length < 4) {
					console.error(
						"Error: references command requires a file path, line, and character",
					);
					process.exit(1);
				}
				const file = args[1]!;
				const line = Number.parseInt(args[2] ?? "", 10);
				const character = Number.parseInt(args[3] ?? "", 10);
				if (Number.isNaN(line) || Number.isNaN(character)) {
					console.error("Error: line and character must be numbers");
					process.exit(1);
				}
				const includeDeclaration = args[4]
					? !["0", "false", "no"].includes(args[4].toLowerCase())
					: true;
				await touchFile(file);
				const locations = await references(
					file,
					line,
					character,
					includeDeclaration,
				);
				const normalized = locations.map((location) => ({
					uri: uriToPath(location.uri),
					range: location.range,
				}));
				console.log(JSON.stringify(normalized, null, 2));
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
  diagnostics [file]     Get LSP diagnostics for a file (or all available)
  symbols <query>        Search for symbols across workspace
  document-symbols <file> Get symbol outline for a file
  definition <file> <line> <character>  Get definition locations
  references <file> <line> <character> [includeDeclaration]  Get references
  help                   Show this help message

Examples:
  composer-lsp diagnostics src/main.ts
  composer-lsp diagnostics
  composer-lsp symbols "MyClass"
  composer-lsp document-symbols src/index.ts
  composer-lsp definition src/index.ts 10 4
  composer-lsp references src/index.ts 10 4 false
`);
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
