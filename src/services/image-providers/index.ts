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

export interface CreateImageProviderOptions {
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
 * Build the configured image provider. Today only OpenAI is shipped; the
 * `ImageProvider` interface is in place so additional providers can be added
 * without touching the Painter tool.
 */
export function createImageProvider(
	options: CreateImageProviderOptions,
): ImageProvider {
	return new OpenAIImageProvider(options);
}
