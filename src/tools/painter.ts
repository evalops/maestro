import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { getPainterBudget } from "../services/image-providers/cost.js";
import { createImageProvider } from "../services/image-providers/index.js";
import {
	type ImageDimensions,
	type MaskRegion,
	encodeMaskPng,
	readPngDimensions,
} from "../services/image-providers/masks.js";
import type {
	ImageQuality,
	ImageSize,
} from "../services/image-providers/types.js";
import { writeTextFileAtomic } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { getImageMetadata } from "./image-processor.js";
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

/** Resolve the image provider. "openai" (default) or "flux" via fal.ai. */
export function resolvePainterProvider(): "openai" | "flux" {
	const raw = process.env.MAESTRO_PAINTER_PROVIDER?.trim().toLowerCase();
	return raw === "flux" ? "flux" : "openai";
}

export async function persistImage(
	bytes: Buffer,
	ext: string,
): Promise<{ path: string }> {
	const dir = painterOutputDir();
	const name = `painter-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
	const path = join(dir, name);
	writeTextFileAtomic(path, bytes.toString("latin1"), { encoding: "latin1" });
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

export type MaskDimensionSource = "png-header" | "sharp" | "explicit";

/**
 * Resolve a pixel bounding box into a mask file path, writing the synthesized
 * mask into the painter output directory. Dimensions come from (in order):
 * the PNG header (no deps), the optional `sharp` package, or an explicit
 * caller-supplied size. Returns the temp mask path plus how dims were found.
 */
export async function buildMaskPath(
	images: string[],
	region: MaskRegion,
	explicitSize?: ImageDimensions,
): Promise<{
	maskPath: string;
	dimensions: ImageDimensions;
	source: MaskDimensionSource;
}> {
	if (images.length === 0) {
		throw new Error("mask synthesis requires at least one input image path.");
	}
	const inputPath = images[0];
	if (!inputPath) {
		throw new Error("mask synthesis received an undefined input image path.");
	}
	const buf = await readFile(inputPath);

	let dimensions: ImageDimensions | null = readPngDimensions(buf);
	let source: MaskDimensionSource = "png-header";

	if (!dimensions) {
		if (explicitSize) {
			dimensions = explicitSize;
			source = "explicit";
		} else {
			const meta = await getImageMetadata(buf);
			if (meta?.width && meta.height) {
				dimensions = { width: meta.width, height: meta.height };
				source = "sharp";
			}
		}
	}

	if (!dimensions) {
		throw new Error(
			"Could not determine input image dimensions for mask synthesis. Use a PNG input, enable Sharp, or pass maskSize explicitly.",
		);
	}

	const maskBuf = encodeMaskPng(dimensions, region);
	const dir = painterOutputDir();
	const maskPath = join(
		dir,
		`mask-${Date.now()}-${randomBytes(4).toString("hex")}.png`,
	);
	writeTextFileAtomic(maskPath, maskBuf.toString("latin1"), {
		encoding: "latin1",
	});
	return { maskPath, dimensions, source };
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
				"Edit mode only. Path to a mask image; transparent regions mark areas the model may change. Omit to edit the whole image. Mutually exclusive with maskRegion (which synthesizes the mask for you).",
		}),
	),
	maskRegion: Type.Optional(
		Type.Object(
			{
				x: Type.Number({ description: "Region left edge, in pixels." }),
				y: Type.Number({ description: "Region top edge, in pixels." }),
				width: Type.Number({ description: "Region width, in pixels." }),
				height: Type.Number({ description: "Region height, in pixels." }),
			},
			{
				description:
					"Edit mode only. A pixel bounding box; the mask is synthesized automatically (transparent = editable). Coordinates outside the image are clipped.",
			},
		),
	),
	maskSize: Type.Optional(
		Type.Object(
			{
				width: Type.Integer({ minimum: 1 }),
				height: Type.Integer({ minimum: 1 }),
			},
			{
				description:
					"Explicit input image dimensions, used only for mask synthesis when the input is not a PNG and Sharp is unavailable. Optional.",
			},
		),
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
			const providerName = resolvePainterProvider();
			const apiKeyEnv = providerName === "flux" ? "FAL_KEY" : "OPENAI_API_KEY";
			const apiKey = process.env[apiKeyEnv];
			if (!apiKey) {
				throw new Error(
					`Painter provider "${providerName}" requires ${apiKeyEnv} to be set in the environment where the agent runs.`,
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

			const budget = getPainterBudget().checkAndReserve({
				model: resolvePainterModel(),
				size: params.size,
				quality: params.quality,
				n: params.n,
			});
			if (!budget.ok) {
				throw new Error(budget.reason ?? "painter cost ceiling exceeded");
			}
			if (budget.enforced) {
				logger.info("painter budget", {
					estimated: budget.estimatedCents,
					cumulative: budget.cumulativeCents,
					ceiling: budget.ceilingCents,
				});
			}

			const provider = createImageProvider({
				provider: providerName,
				apiKey,
				baseURL: process.env.MAESTRO_PAINTER_BASE_URL?.trim() || undefined,
				model: resolvePainterModel(),
				writeImage: persistImage,
			});

			if (!provider.supports[params.mode]) {
				throw new Error(
					params.mode === "edit"
						? `Painter provider "${provider.id}" does not support editing. Use the OpenAI provider (MAESTRO_PAINTER_PROVIDER=openai) for edits.`
						: `Painter provider "${provider.id}" does not support generation.`,
				);
			}

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

			let synthesizedMask: string | null = null;
			try {
				const shared = {
					prompt: params.prompt,
					size: params.size as ImageSize | undefined,
					quality: params.quality as ImageQuality | undefined,
					n: params.n,
					signal: timeoutCtl.signal,
				};

				let maskPath = params.mask;
				if (params.mode === "edit" && params.maskRegion) {
					const built = await buildMaskPath(
						params.images ?? [],
						params.maskRegion,
						params.maskSize,
					);
					maskPath = built.maskPath;
					synthesizedMask = built.maskPath;
					logger.info("synthesized edit mask", {
						source: built.source,
						...built.dimensions,
					});
				}

				const result =
					params.mode === "edit"
						? await provider.edit({
								...shared,
								images: params.images ?? [],
								maskPath,
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
			} catch (err) {
				// The provider did not produce images (transient retry exhausted,
				// timeout, content-policy, mask failure, unsupported mode). Release
				// the reserved estimate so failed calls don't permanently consume
				// the spend ceiling — the provider did not charge for these.
				if (budget.enforced && budget.estimatedCents) {
					getPainterBudget().release(budget.estimatedCents);
				}
				throw err;
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onCallerAbort);
				// Best-effort cleanup of the synthesized mask; user-supplied mask
				// paths are left untouched.
				if (synthesizedMask) {
					await unlink(synthesizedMask).catch(() => {});
				}
			}
		},
	},
);
