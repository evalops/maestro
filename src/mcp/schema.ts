import { z } from "zod";

const mcpNameSchema = z
	.string()
	.min(1)
	.regex(/^[a-zA-Z0-9_-]+$/, "Name must use letters, numbers, _ or -");

export const mcpTransportSchema = z.union([
	z.literal("stdio"),
	z.literal("http"),
	z.literal("sse"),
]);

export const mcpAuthPresetSchema = z
	.object({
		name: mcpNameSchema,
		headers: z.record(z.string(), z.string()).optional(),
		headersHelper: z.string().optional(),
	})
	.strict()
	.superRefine((cfg, ctx) => {
		if (!cfg.headers && !cfg.headersHelper) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Auth preset requires headers and/or headersHelper",
			});
		}
	});

export const mcpServerSchema = z
	.object({
		name: mcpNameSchema,
		transport: mcpTransportSchema.optional(),
		// stdio
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
		cwd: z.string().optional(),
		// http/sse
		url: z.string().url().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		headersHelper: z.string().optional(),
		authPreset: mcpNameSchema.optional(),
		// common
		timeout: z.number().int().positive().optional(),
		enabled: z.boolean().optional(),
		disabled: z.boolean().optional(),
	})
	.strict()
	.superRefine((cfg, ctx) => {
		const transport = cfg.transport ?? (cfg.url ? "http" : "stdio");
		if (transport === "stdio" && !cfg.command) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["command"],
				message: "Stdio transport requires command",
			});
		}
		if ((transport === "http" || transport === "sse") && !cfg.url) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["url"],
				message: "HTTP/SSE transport requires url",
			});
		}
		if (transport === "stdio" && cfg.authPreset) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["authPreset"],
				message: "Stdio transport does not support auth presets",
			});
		}
	});

export type McpAuthPresetInput = z.infer<typeof mcpAuthPresetSchema>;
export type McpServerInput = z.infer<typeof mcpServerSchema>;

// Accept both array format and Claude-style { mcpServers: { name: {...} } }
export const mcpConfigSchema = z.object({
	servers: z.array(mcpServerSchema).optional(),
	// allow loose objects; we normalize/validate per-entry later
	mcpServers: z.record(z.string(), z.unknown()).optional(),
	authPresets: z.record(z.string(), z.unknown()).optional(),
});

export type McpConfigInput = z.infer<typeof mcpConfigSchema>;
