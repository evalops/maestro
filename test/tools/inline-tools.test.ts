/**
 * Tests for inline tool definitions from .composer/tools.json
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getInlineToolsConfigPaths,
	loadInlineTools,
} from "../../src/tools/inline-tools.js";

beforeEach(() => {
	vi.useRealTimers();
});

describe("loadInlineTools", () => {
	let testDir: string;
	let composerDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `inline-tools-test-${Date.now()}`);
		composerDir = join(testDir, ".composer");
		mkdirSync(composerDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("returns empty array when no config exists", () => {
		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(0);
	});

	it("loads simple tool definition", () => {
		const config = {
			tools: [
				{
					name: "hello",
					description: "Say hello",
					command: "echo hello",
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("hello");
		expect(tools[0]!.description).toBe("Say hello");
	});

	it("loads tool with parameters", () => {
		const config = {
			tools: [
				{
					name: "greet",
					description: "Greet someone",
					command: "echo",
					parameters: {
						name: {
							type: "string",
							description: "Name to greet",
						},
						loud: {
							type: "boolean",
							default: false,
						},
					},
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("greet");

		// Check schema has parameters
		const schema = tools[0]!.parameters;
		expect(schema).toBeDefined();
		expect(schema.properties).toHaveProperty("name");
		expect(schema.properties).toHaveProperty("loud");
	});

	it("loads tool with enum parameter", () => {
		const config = {
			tools: [
				{
					name: "deploy",
					description: "Deploy to environment",
					command: "./deploy.sh",
					parameters: {
						environment: {
							type: "string",
							enum: ["staging", "prod"],
							description: "Target environment",
						},
					},
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("deploy");
	});

	it("loads tool with annotations", () => {
		const config = {
			tools: [
				{
					name: "dangerous",
					description: "A dangerous operation",
					command: "rm -rf /",
					annotations: {
						destructive: true,
						requiresApproval: true,
					},
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.annotations?.destructiveHint).toBe(true);
	});

	it("skips invalid tool definitions", () => {
		const config = {
			tools: [
				{
					// Missing name
					description: "Invalid tool",
					command: "echo",
				},
				{
					name: "valid",
					description: "Valid tool",
					command: "echo valid",
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("valid");
	});

	it("validates tool name format", () => {
		const config = {
			tools: [
				{
					name: "123invalid", // Starts with number
					description: "Invalid name",
					command: "echo",
				},
				{
					name: "valid_name",
					description: "Valid name",
					command: "echo",
				},
				{
					name: "valid-name",
					description: "Valid name with hyphen",
					command: "echo",
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(2);
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"valid-name",
			"valid_name",
		]);
	});

	it("handles malformed JSON gracefully", () => {
		writeFileSync(join(composerDir, "tools.json"), "{ invalid json }");

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(0);
	});

	it("handles missing tools array gracefully", () => {
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify({}));

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(0);
	});
});

describe("getInlineToolsConfigPaths", () => {
	it("returns correct paths", () => {
		const paths = getInlineToolsConfigPaths("/some/project");
		expect(paths.project).toBe("/some/project/.composer/tools.json");
		expect(paths.user).toContain(".composer/tools.json");
	});
});

describe("inline tool execution", () => {
	let testDir: string;
	let composerDir: string;
	let scriptsDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `inline-tools-exec-test-${Date.now()}`);
		composerDir = join(testDir, ".composer");
		scriptsDir = join(testDir, "scripts");
		mkdirSync(composerDir, { recursive: true });
		mkdirSync(scriptsDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("executes simple command", async () => {
		const config = {
			tools: [
				{
					name: "echo_test",
					description: "Echo test",
					command: "echo 'hello world'",
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(1);

		// Execute the tool
		const result = await tools[0]!.execute("test-call", {});
		expect(result.isError).toBeFalsy();
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "hello world",
		});
	});

	it("passes parameters via stdin", async () => {
		// Create a script that reads JSON from stdin
		const scriptContent = `#!/bin/bash
read -r input
echo "Received: $input"
`;
		const scriptPath = join(scriptsDir, "read-stdin.sh");
		writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

		const config = {
			tools: [
				{
					name: "stdin_test",
					description: "Test stdin",
					command: `bash ${scriptPath}`,
					parameters: {
						name: { type: "string" },
					},
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		const result = await tools[0]!.execute("test-call", { name: "world" });

		expect(result.isError).toBeFalsy();
		expect(result.content[0]).toHaveProperty("text");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Received:");
		expect(text).toContain("world");
	});

	it("handles command failure", async () => {
		const config = {
			tools: [
				{
					name: "fail_test",
					description: "Failing command",
					command: "exit 1",
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		const result = await tools[0]!.execute("test-call", {});

		expect(result.isError).toBe(true);
	});

	it("truncates large output", async () => {
		const quotedNode = JSON.stringify(process.execPath);
		const config = {
			tools: [
				{
					name: "large_output",
					description: "Large output",
					command: `${quotedNode} -e "process.stdout.write('x'.repeat(50000))"`,
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		const result = await tools[0]!.execute("test-call", {});

		expect(result.isError).toBeFalsy();
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Warning: Output truncated");
	});

	it("respects timeout", async () => {
		const quotedNode = JSON.stringify(process.execPath);
		const config = {
			tools: [
				{
					name: "timeout_test",
					description: "Long running command",
					command: `${quotedNode} -e "setTimeout(() => {}, 10000)"`,
					timeout: 100, // 100ms timeout
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		const result = await tools[0]!.execute("test-call", {});

		expect(result.isError).toBe(true);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("timed out");
	});

	it("uses custom working directory", async () => {
		const quotedNode = JSON.stringify(process.execPath);
		const config = {
			tools: [
				{
					name: "cwd_test",
					description: "Test cwd",
					command: `${quotedNode} -e "console.log(process.cwd())"`,
					cwd: scriptsDir,
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const tools = loadInlineTools(testDir);
		const result = await tools[0]!.execute("test-call", {});

		expect(result.isError).toBeFalsy();
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("scripts");
	});

	it("expands tilde in working directory", async () => {
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		const homeDir = mkdtempSync(join(tmpdir(), "inline-tools-home-"));
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;

		const tildeDir = join(homeDir, "tilde-cwd");
		mkdirSync(tildeDir, { recursive: true });

		const quotedNode = JSON.stringify(process.execPath);
		const config = {
			tools: [
				{
					name: "tilde_cwd",
					description: "Tilde cwd",
					command: `${quotedNode} -e "console.log(process.cwd())"`,
					cwd: "~/tilde-cwd",
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		try {
			const tools = loadInlineTools(testDir);
			const result = await tools[0]!.execute("test-call", {});

			expect(result.isError).toBeFalsy();
			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("tilde-cwd");
		} finally {
			process.env.HOME = originalHome;
			process.env.USERPROFILE = originalUserProfile;
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
