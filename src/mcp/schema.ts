import { z } from "zod";

export const mcpTransportSchema = z.union([
	z.literal("stdio"),
	z.literal("http"),
	z.literal("sse"),
]);

export const mcpServerSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.regex(
				/^[a-zA-Z0-9_-]+$/,
				"Server name must use letters, numbers, _ or -",
			),
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
	});

export type McpServerInput = z.infer<typeof mcpServerSchema>;

// Accept both array format and Claude-style { mcpServers: { name: {...} } }
export const mcpConfigSchema = z.object({
	servers: z.array(mcpServerSchema).optional(),
	// allow loose objects; we normalize/validate per-entry later
	mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export type McpConfigInput = z.infer<typeof mcpConfigSchema>;
