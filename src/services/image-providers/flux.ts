import type { GenerateOptions, ImageProvider, ImageResult } from "./types.js";

/**
 * FLUX image provider via fal.ai.
 *
 * fal.run FLUX is generate-only here. It returns image URLs (not base64), so
 * the provider fetches each URL and hands the bytes to the same `writeImage`
 * callback the OpenAI provider uses. Masked editing is not supported (FLUX
 * inpainting is a separate endpoint on fal; left for a follow-up).
 *
 * Stub-tested only: there is no live FAL_KEY in this environment, so the
 * request/response mapping is unit-tested with an injected transport. Verify
 * against your fal.ai account before relying on it.
 */

const DEFAULT_MODEL = "fal-ai/flux/schnell";
const FAL_BASE = "https://fal.run";

interface FalImage {
	url?: string;
	content_type?: string;
}

interface FalResponse {
	images?: FalImage[];
}

export interface FluxTransport {
	post(url: string, body: unknown, signal?: AbortSignal): Promise<FalResponse>;
	get(url: string, signal?: AbortSignal): Promise<Buffer>;
}

export interface FluxImageProviderOptions {
	apiKey: string;
	model?: string;
	writeImage: (bytes: Buffer, ext: string) => Promise<{ path: string }>;
	/** Test seam; defaults to a fetch-backed transport. */
	transport?: FluxTransport;
}

/** Map our size strings to fal's image_size enum. */
export function mapSizeToFlux(size?: string): string {
	switch (size) {
		case "1024x1024":
			return "square";
		case "1536x1024":
		case "1792x1024":
			return "landscape_4_3";
		case "1024x1536":
		case "1024x1792":
			return "portrait_4_3";
		default:
			return "square_hd";
	}
}

function defaultTransport(apiKey: string): FluxTransport {
	const headers = {
		Authorization: `Key ${apiKey}`,
		"Content-Type": "application/json",
	};
	return {
		async post(url, body, signal) {
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			if (!res.ok) {
				throw new Error(
					`fal.ai request failed (${res.status}): ${await res.text()}`,
				);
			}
			return (await res.json()) as FalResponse;
		},
		async get(url, signal) {
			const res = await fetch(url, { signal });
			if (!res.ok) {
				throw new Error(`fal.ai image fetch failed (${res.status})`);
			}
			return Buffer.from(await res.arrayBuffer());
		},
	};
}

export class FluxImageProvider implements ImageProvider {
	readonly id = "flux";
	readonly supports = { generate: true, edit: false, mask: false } as const;

	private readonly apiKey: string;
	private readonly model: string;
	private readonly writeImage: FluxImageProviderOptions["writeImage"];
	private readonly transport: FluxTransport;

	constructor(options: FluxImageProviderOptions) {
		this.apiKey = options.apiKey;
		this.model = options.model ?? DEFAULT_MODEL;
		this.writeImage = options.writeImage;
		this.transport = options.transport ?? defaultTransport(this.apiKey);
	}

	async generate(options: GenerateOptions): Promise<ImageResult> {
		const body = {
			prompt: options.prompt,
			image_size: mapSizeToFlux(options.size),
			num_images: Math.max(1, options.n ?? 1),
			output_format: "png" as const,
			enable_safety_checker: true,
		};
		const response = await this.transport.post(
			`${FAL_BASE}/${this.model}`,
			body,
			options.signal,
		);

		const items = response.images ?? [];
		if (items.length === 0) {
			throw new Error("FLUX provider returned no images.");
		}

		const images = [];
		for (const item of items) {
			if (!item.url) continue;
			const bytes = await this.transport.get(item.url, options.signal);
			const { path } = await this.writeImage(bytes, "png");
			images.push({
				path,
				mimeType: item.content_type ?? "image/png",
			});
		}
		if (images.length === 0) {
			throw new Error("FLUX provider returned no downloadable image URLs.");
		}
		return { images, provider: this.id, model: this.model };
	}

	async edit(): Promise<ImageResult> {
		throw new Error(
			"FLUX provider does not support editing (generate only). Use the OpenAI provider for edits.",
		);
	}
}
