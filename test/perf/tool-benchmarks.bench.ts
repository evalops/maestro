/**
 * Performance benchmarks for tool execution
 *
 * Run with: npx vitest bench test/perf/tool-benchmarks.bench.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, describe } from "vitest";
import { readTool } from "../../src/tools/read.js";
import { createToolResponseBuilder } from "../../src/tools/tool-dsl.js";

// Create temp directory for benchmarks
const benchDir = join(tmpdir(), `composer-bench-${Date.now()}`);
mkdirSync(benchDir, { recursive: true });

// Create test files of various sizes
const smallFile = join(benchDir, "small.txt");
const mediumFile = join(benchDir, "medium.txt");
const largeFile = join(benchDir, "large.txt");
const jsonFile = join(benchDir, "data.json");

writeFileSync(smallFile, "Hello, World!\n".repeat(10));
writeFileSync(mediumFile, "Line of text for medium file\n".repeat(1000));
writeFileSync(largeFile, "Large file content line\n".repeat(50000));
writeFileSync(
	jsonFile,
	JSON.stringify({
		users: Array.from({ length: 100 }, (_, i) => ({
			id: i,
			name: `User ${i}`,
			email: `user${i}@example.com`,
		})),
	}),
);

// Cleanup function
const cleanup = () => {
	try {
		rmSync(benchDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
};

// Register cleanup
process.on("exit", cleanup);

describe("Read Tool Benchmarks", () => {
	bench(
		"read small file (~150 bytes)",
		async () => {
			const respond = createToolResponseBuilder<undefined>();
			await readTool.run(
				{
					path: smallFile,
					lineNumbers: true,
					wrapInCodeFence: true,
					withDiagnostics: false,
				},
				{ respond },
			);
		},
		{ iterations: 100 },
	);

	bench(
		"read medium file (~30KB)",
		async () => {
			const respond = createToolResponseBuilder<undefined>();
			await readTool.run(
				{
					path: mediumFile,
					lineNumbers: true,
					wrapInCodeFence: true,
					withDiagnostics: false,
				},
				{ respond },
			);
		},
		{ iterations: 50 },
	);

	bench(
		"read large file with limit (~1.2MB total, 2000 lines)",
		async () => {
			const respond = createToolResponseBuilder<undefined>();
			await readTool.run(
				{
					path: largeFile,
					lineNumbers: true,
					wrapInCodeFence: true,
					withDiagnostics: false,
					limit: 2000,
				},
				{ respond },
			);
		},
		{ iterations: 20 },
	);

	bench(
		"read with pagination (offset + limit)",
		async () => {
			const respond = createToolResponseBuilder<undefined>();
			await readTool.run(
				{
					path: largeFile,
					offset: 10000,
					limit: 500,
					lineNumbers: true,
					wrapInCodeFence: true,
					withDiagnostics: false,
				},
				{ respond },
			);
		},
		{ iterations: 50 },
	);

	bench(
		"read tail mode",
		async () => {
			const respond = createToolResponseBuilder<undefined>();
			await readTool.run(
				{
					path: largeFile,
					mode: "tail",
					limit: 100,
					lineNumbers: true,
					wrapInCodeFence: true,
					withDiagnostics: false,
				},
				{ respond },
			);
		},
		{ iterations: 50 },
	);

	bench(
		"read JSON file",
		async () => {
			const respond = createToolResponseBuilder<undefined>();
			await readTool.run(
				{
					path: jsonFile,
					lineNumbers: true,
					wrapInCodeFence: true,
					withDiagnostics: false,
				},
				{ respond },
			);
		},
		{ iterations: 100 },
	);

	bench(
		"read without line numbers",
		async () => {
			const respond = createToolResponseBuilder<undefined>();
			await readTool.run(
				{
					path: mediumFile,
					lineNumbers: false,
					wrapInCodeFence: false,
					withDiagnostics: false,
				},
				{ respond },
			);
		},
		{ iterations: 100 },
	);
});

describe("Read Tool - File Not Found", () => {
	bench(
		"handle missing file",
		async () => {
			const respond = createToolResponseBuilder<undefined>();
			await readTool.run(
				{
					path: "/nonexistent/path/to/file.txt",
					withDiagnostics: false,
				},
				{ respond },
			);
		},
		{ iterations: 100 },
	);
});
