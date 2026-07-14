import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { createImageProvider } from "../services/image-providers/index.js";
import type {
	ImageQuality,
	ImageSize,
} from "../services/image-providers/types.js";
import { createLogger } from "../utils/logger.js";
import { createTool } from "./tool-dsl.js";

const logger = createLogger("tools:painter");

const DEFAULT_PAINTER_TIMEOUT_MS = 180_000;
const DEFAULT_MODEL = "gpt-image-2";

export function painterTimeoutMs(): number {
	const raw = process.env.MAESTRO_PAINTER_TIMEOUT_MS;
	if (!raw) return DEFAULT_PAINTER_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_PAINTER_TIMEOUT_MS;
}

export function painterOutputDir(): string {
	const override = process.env.MAESTRO_PAINTER_OUTPUT_DIR?.trim();
	if (override) return resolve(override);
	return join(homedir(), ".maestro", "assets", "painter");
}

export function resolvePainterModel(): string {
	return process.env.MAESTRO_PAINTER_MODEL?.trim() || DEFAULT_MODEL;
}

export async function persistImage(
	bytes: Buffer,
	ext: string,
): Promise<{ path: string }> {
	const dir = painterOutputDir();
	await mkdir(dir, { recursive: true });
	const name = `painter-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
	const path = join(dir, name);
	await writeFile(path, bytes);
	return { path };
}

/** Errno-style codes that indicate a transient network fault worth retrying. */
const TRANSIENT_ERRNO_CODES = new Set([
	"ETIMEDOUT",
	"ECONNRESET",
	"ENOTFOUND",
	"ECONNREFUSED",
	"EAI_AGAIN",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
]);

/**
 * Classify whether an image-API failure is worth one retry. Image generation
 * is expensive, so we retry only on clearly transient network/rate-limit
 * faults and never on validation or content-policy rejections.
 */
export function isTransientImageError(err: unknown): boolean {
	const code = (err as { code?: unknown })?.code;
	if (
		typeof code === "string" &&
		TRANSIENT_ERRNO_CODES.has(code.toUpperCase())
	) {
		return true;
	}
	const msg = err instanceof Error ? err.message : String(err);
	return /rate limit|too many requests|timeout|timed out|econnreset|enotfound|etimedout|econnrefused|service unavailable|bad gateway|5\d{2}/i.test(
		msg,
	);
}

const painterSchema = Type.Object({
	mode: Type.Union([Type.Literal("generate"), Type.Literal("edit")], {
		description:
			"generate = create a new image from a text prompt. edit = modify one or more existing images using a prompt (and optional mask).",
	}),
	prompt: Type.String({
		description:
			"The image prompt. For edit mode, describe the desired change. Be concrete about subject, style, composition, and any text to render.",
	}),
	images: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Edit mode only. 1-3 absolute or workspace-relative paths to input images to edit.",
		}),
	),
	mask: Type.Optional(
		Type.String({
			description:
				"Edit mode only. Path to a mask image; transparent regions mark areas the model may change. Omit to edit the whole image.",
		}),
	),
	size: Type.Optional(
		Type.String({
			description:
				"Output size. Standard: 1024x1024, 1536x1024, 1024x1536, 1792x1024, 1024x1792, or auto. gpt-image-2 also accepts arbitrary WxH divisible by 16 with aspect ratio 1:3 to 3:1.",
		}),
	),
	quality: Type.Optional(
		Type.Union(
			[
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("auto"),
			],
			{
				description:
					"Output quality. Higher quality is slower and more expensive. Defaults to auto.",
			},
		),
	),
	n: Type.Optional(
		Type.Integer({
			description: "Number of images to produce (1-4). Defaults to 1.",
			minimum: 1,
			maximum: 4,
		}),
	),
});

export interface PainterToolDetails {
	provider: string;
	model: string;
	mode: "generate" | "edit";
	paths: string[];
}

export const painterTool = createTool<typeof painterSchema, PainterToolDetails>(
	{
		name: "painter",
		description:
			"Generate or edit images via an image model (default gpt-image-2). Use for UI mockups, app icons, illustrations, and editing existing images (e.g. redacting a screenshot). Outputs are persisted to disk and returned as absolute paths; reference them by path in later turns. Requires OPENAI_API_KEY.",
		schema: painterSchema,
		maxRetries: 1,
		retryDelayMs: 2000,
		shouldRetry: isTransientImageError,
		getToolUseSummary: (params) => `painter ${params.mode}`,
		getActivityDescription: (params) =>
			params.mode === "edit" ? "Editing image" : "Generating image",
		async run(params, { respond, signal }) {
			const apiKey = process.env.OPENAI_API_KEY;
			if (!apiKey) {
				throw new Error(
					"Painter requires OPENAI_API_KEY to be set in the environment where the agent runs.",
				);
			}

			if (
				params.mode === "edit" &&
				(!params.images || params.images.length === 0)
			) {
				throw new Error(
					"Painter edit mode requires at least one input image path (the `images` parameter).",
				);
			}

			const provider = createImageProvider({
				apiKey,
				baseURL: process.env.MAESTRO_PAINTER_BASE_URL?.trim() || undefined,
				model: resolvePainterModel(),
				writeImage: persistImage,
			});

			// Combine the tool's abort signal with a hard timeout, without relying
			// on AbortSignal.any so this works on any lib target.
			const timeoutCtl = new AbortController();
			const onCallerAbort = () => timeoutCtl.abort();
			if (signal) {
				if (signal.aborted) {
					timeoutCtl.abort();
				} else {
					signal.addEventListener("abort", onCallerAbort, { once: true });
				}
			}
			const timer = setTimeout(() => timeoutCtl.abort(), painterTimeoutMs());

			try {
				const shared = {
					prompt: params.prompt,
					size: params.size as ImageSize | undefined,
					quality: params.quality as ImageQuality | undefined,
					n: params.n,
					signal: timeoutCtl.signal,
				};

				const result =
					params.mode === "edit"
						? await provider.edit({
								...shared,
								images: params.images ?? [],
								maskPath: params.mask,
							})
						: await provider.generate(shared);

				const lines = result.images.map(
					(img, i) =>
						`  ${i + 1}. ${img.path}${img.revisedPrompt ? `\n      revised prompt: ${img.revisedPrompt}` : ""}`,
				);

				logger.info("painter produced images", {
					mode: params.mode,
					model: result.model,
					count: result.images.length,
				});

				return respond
					.text(
						[
							`Painter (${result.provider}/${result.model}) produced ${result.images.length} image(s):`,
							...lines,
							"Outputs are on disk. Reference them by the absolute paths above.",
						].join("\n"),
					)
					.detail({
						provider: result.provider,
						model: result.model,
						mode: params.mode,
						paths: result.images.map((i) => i.path),
					});
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onCallerAbort);
			}
		},
	},
);
