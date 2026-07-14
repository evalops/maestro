import { FluxImageProvider } from "./flux.js";
import { OpenAIImageProvider } from "./openai.js";
import type { ImageProvider } from "./types.js";

export type {
	ImageBackground,
	ImageOutput,
	ImageProvider,
	ImageQuality,
	ImageResult,
	ImageSize,
} from "./types.js";

export type PainterProviderName = "openai" | "flux";

export interface CreateImageProviderOptions {
	provider?: PainterProviderName;
	apiKey?: string;
	baseURL?: string;
	model?: string;
	/**
	 * Persist decoded image bytes to disk and return the absolute path.
	 * Forwarded to the provider so it stays free of filesystem policy.
	 */
	writeImage: (bytes: Buffer, ext: string) => Promise<{ path: string }>;
}

/**
 * Build the configured image provider. Selection via the `provider` field
 * (the painter resolves this from MAESTRO_PAINTER_PROVIDER, default "openai").
 * Each provider declares its own `supports` map; the painter must respect it
 * before calling generate/edit.
 */
export function createImageProvider(
	options: CreateImageProviderOptions,
): ImageProvider {
	if (options.provider === "flux") {
		if (!options.apiKey) {
			throw new Error("FLUX provider requires FAL_KEY to be set.");
		}
		return new FluxImageProvider({
			apiKey: options.apiKey,
			model: options.model,
			writeImage: options.writeImage,
		});
	}
	return new OpenAIImageProvider({
		apiKey: options.apiKey,
		baseURL: options.baseURL,
		model: options.model,
		writeImage: options.writeImage,
	});
}
