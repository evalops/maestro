import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import OpenAI, { toFile } from "openai";
import type {
	EditOptions,
	GenerateOptions,
	ImageProvider,
	ImageQuality,
	ImageResult,
	ImageSize,
} from "./types.js";

/** Default model. gpt-image-2 does NOT support transparency. */
const DEFAULT_MODEL = "gpt-image-2";

interface RawImageItem {
	b64_json?: string | null;
	revised_prompt?: string | null;
}

interface ImagesResponseLike {
	data?: RawImageItem[];
}

function mimeTypeForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

/** Narrow the images.edit/generate response union to its non-streaming member. */
function extractItems(response: unknown): RawImageItem[] {
	if (response && typeof response === "object" && "data" in response) {
		const data = (response as ImagesResponseLike).data;
		return Array.isArray(data) ? data : [];
	}
	return [];
}

export interface OpenAIImageProviderOptions {
	apiKey?: string;
	baseURL?: string;
	model?: string;
	/**
	 * Optional pre-built client, primarily for tests. When omitted the provider
	 * constructs `new OpenAI(...)` from `apiKey`/`baseURL`.
	 */
	client?: OpenAI;
	/**
	 * Persist decoded image bytes to disk and return the absolute path.
	 * Kept as a callback so the provider stays free of filesystem policy.
	 */
	writeImage: (bytes: Buffer, ext: string) => Promise<{ path: string }>;
}

export class OpenAIImageProvider implements ImageProvider {
	readonly id = "openai";
	readonly supports = { generate: true, edit: true, mask: true } as const;

	private readonly client: OpenAI;
	private readonly model: string;
	private readonly writeImage: OpenAIImageProviderOptions["writeImage"];

	constructor(options: OpenAIImageProviderOptions) {
		this.client =
			options.client ??
			new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
		this.model = options.model ?? DEFAULT_MODEL;
		this.writeImage = options.writeImage;
	}

	async generate(options: GenerateOptions): Promise<ImageResult> {
		const response = await this.client.images.generate(
			{
				model: this.model,
				prompt: options.prompt,
				size: options.size as ImageSize | undefined,
				quality: options.quality as ImageQuality | undefined,
				background: options.background,
				n: options.n ?? 1,
			},
			{ signal: options.signal },
		);
		return this.toResult(extractItems(response));
	}

	async edit(options: EditOptions): Promise<ImageResult> {
		if (!this.supports.edit) {
			throw new Error("OpenAI image provider does not support editing.");
		}
		if (options.images.length === 0) {
			throw new Error("Edit mode requires at least one input image path.");
		}

		const imageFiles = await Promise.all(
			options.images.slice(0, 3).map(async (p) =>
				toFile(await readFile(p), basename(p), {
					type: mimeTypeForPath(p),
				}),
			),
		);

		const params: Parameters<OpenAI["images"]["edit"]>[0] = {
			model: this.model,
			image: imageFiles,
			prompt: options.prompt,
			size: options.size as Parameters<OpenAI["images"]["edit"]>[0]["size"],
			quality: options.quality as ImageQuality | undefined,
			n: options.n ?? 1,
		};

		if (options.maskPath) {
			params.mask = await toFile(
				await readFile(options.maskPath),
				basename(options.maskPath),
				{ type: mimeTypeForPath(options.maskPath) },
			);
		}

		const response = await this.client.images.edit(params, {
			signal: options.signal,
		});
		return this.toResult(extractItems(response));
	}

	private async toResult(items: RawImageItem[]): Promise<ImageResult> {
		const images = [];
		for (const item of items) {
			if (!item.b64_json) continue;
			const buf = Buffer.from(item.b64_json, "base64");
			const { path } = await this.writeImage(buf, "png");
			images.push({
				path,
				mimeType: "image/png",
				revisedPrompt: item.revised_prompt ?? undefined,
			});
		}
		if (images.length === 0) {
			throw new Error("OpenAI image API returned no image data.");
		}
		return { images, provider: this.id, model: this.model };
	}
}
