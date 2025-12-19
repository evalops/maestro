/**
 * Inline Tool Definitions - Load custom tools from .composer/tools.json
 *
 * Allows users to define shell-based tools without requiring full MCP server setup.
 * Tools receive parameters as JSON via stdin and return results via stdout.
 *
 * ## Configuration
 *
 * Project-level: `.composer/tools.json`
 * User-level: `~/.composer/tools.json`
 *
 * Project tools override user tools with the same name.
 *
 * ## Format
 *
 * ```json
 * {
 *   "tools": [
 *     {
 *       "name": "deploy",
 *       "description": "Deploy to an environment",
 *       "command": "./scripts/deploy.sh",
 *       "parameters": {
 *         "environment": {
 *           "type": "string",
 *           "enum": ["staging", "prod"],
 *           "description": "Target environment"
 *         }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * @module tools/inline-tools
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type TSchema, Type } from "@sinclair/typebox";
import type { AgentTool, ToolAnnotations } from "../agent/types.js";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { createTool } from "./tool-dsl.js";

const logger = createLogger("inline-tools");

/**
 * JSON Schema parameter definition (simplified subset)
 */
interface InlineParameterDef {
	type: "string" | "number" | "integer" | "boolean" | "array" | "object";
	description?: string;
	enum?: (string | number)[];
	default?: unknown;
	items?: InlineParameterDef;
}

/**
 * Inline tool definition from .composer/tools.json
 */
interface InlineToolDef {
	name: string;
	description: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	parameters?: Record<string, InlineParameterDef>;
	timeout?: number;
	/** Tool behavior hints */
	annotations?: {
		readOnly?: boolean;
		destructive?: boolean;
		requiresApproval?: boolean;
	};
}

/**
 * Configuration file format
 */
interface InlineToolsConfig {
	tools: InlineToolDef[];
}

/**
 * Convert a parameter definition to a TypeBox schema
 */
function parameterToTypeBox(name: string, param: InlineParameterDef): TSchema {
	const options: Record<string, unknown> = {};
	if (param.description) {
		options.description = param.description;
	}
	if (param.default !== undefined) {
		options.default = param.default;
	}

	switch (param.type) {
		case "string":
			if (param.enum) {
				return Type.Union(
					param.enum.map((v) => Type.Literal(v as string)),
					options,
				);
			}
			return Type.String(options);
		case "number":
			return Type.Number(options);
		case "integer":
			return Type.Integer(options);
		case "boolean":
			return Type.Boolean(options);
		case "array":
			if (param.items) {
				return Type.Array(
					parameterToTypeBox(`${name}[]`, param.items),
					options,
				);
			}
			return Type.Array(Type.Unknown(), options);
		case "object":
			return Type.Object({}, options);
		default:
			return Type.Unknown(options);
	}
}

/**
 * Build a TypeBox schema from inline tool parameters
 */
function buildSchema(parameters?: Record<string, InlineParameterDef>): TSchema {
	if (!parameters || Object.keys(parameters).length === 0) {
		return Type.Object({});
	}

	const properties: Record<string, TSchema> = {};
	const required: string[] = [];

	for (const [name, param] of Object.entries(parameters)) {
		properties[name] = parameterToTypeBox(name, param);
		// Parameters without defaults are required
		if (param.default === undefined) {
			required.push(name);
		}
	}

	return Type.Object(properties, { required });
}

/**
 * Execute a command with parameters passed via stdin
 */
async function executeCommand(
	command: string,
	params: Record<string, unknown>,
	options: {
		cwd?: string;
		env?: Record<string, string>;
		timeout?: number;
		signal?: AbortSignal;
	},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
		const timeout = options.timeout ?? 120000; // 2 minute default

		// Merge environment: inherit from process, overlay tool-specific env
		const env = {
			...process.env,
			...options.env,
		};

		// Spawn the command in shell mode for compatibility
		const child = spawn(command, [], {
			shell: true,
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;

		const resolveOnce = (value: {
			stdout: string;
			stderr: string;
			exitCode: number;
		}) => {
			if (settled) {
				return;
			}
			settled = true;
			resolvePromise(value);
		};

		const rejectOnce = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			rejectPromise(error);
		};

		// Handle timeout
		const timeoutId = setTimeout(() => {
			killed = true;
			child.kill("SIGTERM");
			rejectOnce(new Error(`Command timed out after ${timeout}ms`));
		}, timeout);

		// Handle abort signal
		if (options.signal) {
			options.signal.addEventListener("abort", () => {
				killed = true;
				child.kill("SIGTERM");
				clearTimeout(timeoutId);
				rejectOnce(new Error("Command aborted"));
			});
		}

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			clearTimeout(timeoutId);
			rejectOnce(error);
		});

		child.on("close", (code) => {
			clearTimeout(timeoutId);
			if (!killed) {
				resolveOnce({
					stdout,
					stderr,
					exitCode: code ?? 0,
				});
			}
		});

		// Send parameters as JSON via stdin
		const input = JSON.stringify(params);
		if (child.stdin) {
			child.stdin.on("error", (error) => {
				// If the child exits quickly (e.g. `exit 1`), stdin may be closed before
				// we can write. Treat EPIPE as non-fatal and rely on the exit code.
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error as { code?: string }).code === "EPIPE"
				) {
					return;
				}
				clearTimeout(timeoutId);
				rejectOnce(error instanceof Error ? error : new Error(String(error)));
			});

			child.stdin.write(input, (err) => {
				if (!err) {
					return;
				}
				if (
					typeof err === "object" &&
					err !== null &&
					"code" in err &&
					(err as { code?: string }).code === "EPIPE"
				) {
					return;
				}
				clearTimeout(timeoutId);
				rejectOnce(err instanceof Error ? err : new Error(String(err)));
			});
			child.stdin.end();
		}
	});
}

/**
 * Create an AgentTool from an inline tool definition
 */
function createInlineTool(def: InlineToolDef): AgentTool {
	const schema = buildSchema(def.parameters);

	// Map annotations to tool annotations
	const annotations: ToolAnnotations | undefined = def.annotations
		? {
				readOnlyHint: def.annotations.readOnly,
				destructiveHint: def.annotations.destructive,
			}
		: undefined;

	return createTool({
		name: def.name,
		label: def.name,
		description: def.description,
		schema,
		annotations,
		toolType: "shell",
		run: async (params, context) => {
			try {
				const result = await executeCommand(
					def.command,
					params as Record<string, unknown>,
					{
						cwd: def.cwd,
						env: def.env,
						timeout: def.timeout,
						signal: context.signal,
					},
				);

				if (result.exitCode !== 0) {
					const errorMsg =
						result.stderr.trim() || `Exit code: ${result.exitCode}`;
					return context.respond.error(
						`Command failed: ${errorMsg}\n\nStdout:\n${result.stdout}`,
					);
				}

				// Return stdout as the result
				const output = result.stdout.trim();
				if (result.stderr.trim()) {
					return context.respond.text(
						`${output}\n\n[stderr]: ${result.stderr.trim()}`,
					);
				}
				return context.respond.text(output || "(no output)");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return context.respond.error(`Failed to execute command: ${message}`);
			}
		},
	}) as AgentTool;
}

/**
 * Load inline tools configuration from a file
 */
function loadConfigFile(filePath: string): InlineToolsConfig | null {
	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const contents = readFileSync(filePath, "utf8");
		const config = JSON.parse(contents) as InlineToolsConfig;

		// Basic validation
		if (!config.tools || !Array.isArray(config.tools)) {
			logger.warn("Invalid inline tools config: missing 'tools' array", {
				filePath,
			});
			return null;
		}

		return config;
	} catch (error) {
		logger.error(
			"Failed to load inline tools config",
			error instanceof Error ? error : undefined,
			{ filePath },
		);
		return null;
	}
}

/**
 * Validate an inline tool definition
 */
function validateToolDef(def: InlineToolDef, source: string): string[] {
	const errors: string[] = [];

	if (!def.name || typeof def.name !== "string") {
		errors.push(`Tool missing required 'name' field in ${source}`);
	} else if (!/^[a-z][a-z0-9_]*$/i.test(def.name)) {
		errors.push(
			`Invalid tool name '${def.name}' in ${source}: must start with letter and contain only letters, numbers, underscores`,
		);
	}

	if (!def.description || typeof def.description !== "string") {
		errors.push(
			`Tool '${def.name}' missing required 'description' in ${source}`,
		);
	}

	if (!def.command || typeof def.command !== "string") {
		errors.push(`Tool '${def.name}' missing required 'command' in ${source}`);
	}

	return errors;
}

/**
 * Load all inline tools from project and user configuration files
 *
 * @param projectDir - Project directory (defaults to cwd)
 * @returns Array of AgentTools created from inline definitions
 */
export function loadInlineTools(projectDir?: string): AgentTool[] {
	const cwd = projectDir ?? process.cwd();
	const tools: AgentTool[] = [];
	const loadedNames = new Set<string>();

	// Load project-level config first (higher priority)
	const projectConfigPath = join(cwd, ".composer", "tools.json");
	const projectConfig = loadConfigFile(projectConfigPath);

	if (projectConfig) {
		for (const def of projectConfig.tools) {
			const errors = validateToolDef(def, projectConfigPath);
			if (errors.length > 0) {
				for (const error of errors) {
					logger.warn(error);
				}
				continue;
			}

			try {
				const tool = createInlineTool(def);
				tools.push(tool);
				loadedNames.add(def.name);
				logger.debug("Loaded inline tool", {
					name: def.name,
					source: "project",
				});
			} catch (error) {
				logger.error(
					`Failed to create inline tool '${def.name}'`,
					error instanceof Error ? error : undefined,
				);
			}
		}
	}

	// Load user-level config (lower priority, skip if name already loaded)
	const userConfigPath = join(PATHS.COMPOSER_HOME, "tools.json");
	const userConfig = loadConfigFile(userConfigPath);

	if (userConfig) {
		for (const def of userConfig.tools) {
			// Skip if project already defined a tool with this name
			if (loadedNames.has(def.name)) {
				logger.debug("Skipping user tool (overridden by project)", {
					name: def.name,
				});
				continue;
			}

			const errors = validateToolDef(def, userConfigPath);
			if (errors.length > 0) {
				for (const error of errors) {
					logger.warn(error);
				}
				continue;
			}

			try {
				const tool = createInlineTool(def);
				tools.push(tool);
				loadedNames.add(def.name);
				logger.debug("Loaded inline tool", { name: def.name, source: "user" });
			} catch (error) {
				logger.error(
					`Failed to create inline tool '${def.name}'`,
					error instanceof Error ? error : undefined,
				);
			}
		}
	}

	if (tools.length > 0) {
		logger.info("Loaded inline tools", { count: tools.length });
	}

	return tools;
}

/**
 * Get the paths where inline tools config files are expected
 */
export function getInlineToolsConfigPaths(projectDir?: string): {
	project: string;
	user: string;
} {
	const cwd = projectDir ?? process.cwd();
	return {
		project: join(cwd, ".composer", "tools.json"),
		user: join(PATHS.COMPOSER_HOME, "tools.json"),
	};
}
