#!/usr/bin/env node
/**
 * A minimal fake LSP server for testing purposes.
 * Responds to LSP protocol messages via stdin/stdout.
 */

const readline = require("node:readline");

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
});

let contentLength = 0;
let buffer = "";
const diagnosticsEnabled = process.env.FAKE_LSP_DIAGNOSTICS === "1";
const symbolsEnabled = process.env.FAKE_LSP_SYMBOLS === "1";

const openFiles = new Map();

function sendMessage(msg) {
	const content = JSON.stringify(msg);
	const header = `Content-Length: ${content.length}\r\n\r\n`;
	process.stdout.write(header + content);
}

function handleRequest(id, method, params) {
	if (method === "initialize") {
		sendMessage({
			jsonrpc: "2.0",
			id,
			result: {
				capabilities: {
					textDocumentSync: {
						openClose: true,
						change: 2, // Incremental
					},
					hoverProvider: true,
					documentSymbolProvider: true,
					workspaceSymbolProvider: true,
				},
			},
		});
		return;
	}

	if (method === "textDocument/hover") {
		sendMessage({
			jsonrpc: "2.0",
			id,
			result: {
				contents: {
					kind: "markdown",
					value: "**Test Hover**\n\nThis is a test hover response.",
				},
			},
		});
		return;
	}

	if (method === "textDocument/documentSymbol") {
		if (symbolsEnabled) {
			sendMessage({
				jsonrpc: "2.0",
				id,
				result: [
					{
						name: "testFunction",
						kind: 12, // Function
						range: {
							start: { line: 0, character: 0 },
							end: { line: 5, character: 0 },
						},
						selectionRange: {
							start: { line: 0, character: 9 },
							end: { line: 0, character: 21 },
						},
					},
					{
						name: "TestClass",
						kind: 5, // Class
						range: {
							start: { line: 7, character: 0 },
							end: { line: 15, character: 1 },
						},
						selectionRange: {
							start: { line: 7, character: 6 },
							end: { line: 7, character: 15 },
						},
					},
				],
			});
		} else {
			sendMessage({
				jsonrpc: "2.0",
				id,
				result: [],
			});
		}
		return;
	}

	if (method === "workspace/symbol") {
		if (symbolsEnabled) {
			const query = params.query || "";
			const symbols = [
				{
					name: "MyClass",
					kind: 5,
					location: {
						uri: "file:///test/file.ts",
						range: {
							start: { line: 10, character: 0 },
							end: { line: 20, character: 1 },
						},
					},
				},
				{
					name: "myFunction",
					kind: 12,
					location: {
						uri: "file:///test/file.ts",
						range: {
							start: { line: 5, character: 0 },
							end: { line: 8, character: 1 },
						},
					},
				},
			];
			const filtered = symbols.filter((s) =>
				s.name.toLowerCase().includes(query.toLowerCase()),
			);
			sendMessage({
				jsonrpc: "2.0",
				id,
				result: filtered,
			});
		} else {
			sendMessage({
				jsonrpc: "2.0",
				id,
				result: [],
			});
		}
		return;
	}

	// Default response for unknown methods
	sendMessage({
		jsonrpc: "2.0",
		id,
		result: null,
	});
}

function handleNotification(method, params) {
	if (method === "textDocument/didOpen") {
		const { textDocument } = params;
		openFiles.set(textDocument.uri, {
			version: textDocument.version,
			text: textDocument.text,
		});

		// Send diagnostics if enabled
		if (diagnosticsEnabled) {
			setTimeout(() => {
				const hasError = textDocument.text.includes("error");
				sendMessage({
					jsonrpc: "2.0",
					method: "textDocument/publishDiagnostics",
					params: {
						uri: textDocument.uri,
						diagnostics: hasError
							? [
									{
										range: {
											start: { line: 0, character: 0 },
											end: { line: 0, character: 5 },
										},
										severity: 1, // Error
										message: "Test error diagnostic",
										source: "fake-lsp",
									},
								]
							: [],
					},
				});
			}, 100);
		}
		return;
	}

	if (method === "textDocument/didChange") {
		const { textDocument, contentChanges } = params;
		const file = openFiles.get(textDocument.uri);
		if (file) {
			file.version = textDocument.version;
			if (contentChanges && contentChanges.length > 0) {
				file.text = contentChanges[0].text;
			}

			// Send updated diagnostics
			if (diagnosticsEnabled) {
				setTimeout(() => {
					const hasError = file.text.includes("error");
					sendMessage({
						jsonrpc: "2.0",
						method: "textDocument/publishDiagnostics",
						params: {
							uri: textDocument.uri,
							diagnostics: hasError
								? [
										{
											range: {
												start: { line: 0, character: 0 },
												end: { line: 0, character: 5 },
											},
											severity: 1,
											message: "Test error diagnostic",
											source: "fake-lsp",
										},
									]
								: [],
						},
					});
				}, 100);
			}
		}
		return;
	}

	if (method === "textDocument/didClose") {
		openFiles.delete(params.textDocument.uri);
		return;
	}
}

function processMessage(msg) {
	if (msg.method) {
		if (msg.id !== undefined) {
			// Request
			handleRequest(msg.id, msg.method, msg.params);
		} else {
			// Notification
			handleNotification(msg.method, msg.params);
		}
	}
}

rl.on("line", (line) => {
	if (line.startsWith("Content-Length:")) {
		contentLength = Number.parseInt(line.split(":")[1].trim(), 10);
	} else if (line === "") {
		// Empty line signals end of headers
		buffer = "";
	} else {
		buffer += line;
		if (Buffer.byteLength(buffer, "utf8") >= contentLength) {
			try {
				const msg = JSON.parse(buffer);
				processMessage(msg);
			} catch (err) {
				// Ignore parse errors
			}
			buffer = "";
			contentLength = 0;
		}
	}
});

// Handle raw data for proper message parsing
process.stdin.on("data", (chunk) => {
	// This is handled by readline
});

process.on("SIGTERM", () => {
	process.exit(0);
});

process.on("SIGINT", () => {
	process.exit(0);
});
