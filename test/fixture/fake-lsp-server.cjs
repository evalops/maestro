#!/usr/bin/env node
/**
 * A minimal fake LSP server for testing purposes.
 * Responds to LSP protocol messages via stdin/stdout.
 */

const readline = require("node:readline");

let buffer = "";
let contentLength = 0;
const diagnosticsEnabled = process.env.FAKE_LSP_DIAGNOSTICS === "1";
const symbolsEnabled = process.env.FAKE_LSP_SYMBOLS === "1";

const openFiles = new Map();

function sendMessage(msg) {
	const content = JSON.stringify(msg);
	const header = `Content-Length: ${content.length}\r\n\r\n`;
	try {
		process.stdout.write(header + content);
	} catch (err) {
		// Pipe closed, exit gracefully
		process.exit(0);
	}
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
	if (method === "initialized") {
		// Server is now initialized
		return;
	}

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
			}, 50);
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
				}, 50);
			}
		}
		return;
	}

	if (method === "textDocument/didClose") {
		openFiles.delete(params.textDocument.uri);
		return;
	}

	if (method === "exit") {
		process.exit(0);
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

// Read from stdin with proper LSP protocol parsing
let headerMode = true;

process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();

	while (true) {
		if (headerMode) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const headers = buffer.slice(0, headerEnd);
			const match = headers.match(/Content-Length: (\d+)/);
			if (match) {
				contentLength = Number.parseInt(match[1], 10);
			}

			buffer = buffer.slice(headerEnd + 4);
			headerMode = false;
		} else {
			if (buffer.length < contentLength) break;

			const message = buffer.slice(0, contentLength);
			buffer = buffer.slice(contentLength);
			headerMode = true;
			contentLength = 0;

			try {
				const msg = JSON.parse(message);
				processMessage(msg);
			} catch (err) {
				// Ignore parse errors
			}
		}
	}
});

process.stdin.on("end", () => {
	process.exit(0);
});

process.on("SIGTERM", () => {
	process.exit(0);
});

process.on("SIGINT", () => {
	process.exit(0);
});

// Handle EPIPE errors gracefully
process.stdout.on("error", (err) => {
	if (err.code === "EPIPE") {
		process.exit(0);
	}
});

process.stdin.resume();
