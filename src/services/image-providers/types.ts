/**
 * Image provider abstraction.
 *
 * Image generation/editing is NOT symmetric across providers the way chat
 * completion is: today only OpenAI's image API cleanly supports both
 * generation and masked editing. The `supports` map keeps that asymmetry
 * honest rather than pretending every provider implements every capability.
 *
 * Add a new provider by implementing `ImageProvider` and registering it in
 * `./index.ts`. Do not weaken this interface to make a generate-only or
 * edit-only provider look symmetric — declare what it actually supports and
 * let callers fail closed.
 *
 * @module services/image-providers
 */

export type ImageSize =
	| "1024x1024"
	| "1536x1024"
	| "1024x1536"
	| "1792x1024"
	| "1024x1792"
	| "auto";

export type ImageQuality = "low" | "medium" | "high" | "auto";

export type ImageBackground = "transparent" | "opaque" | "auto";

export interface GenerateOptions {
	prompt: string;
	size?: ImageSize;
	quality?: ImageQuality;
	background?: ImageBackground;
	/** Number of images to produce. Defaults to 1. */
	n?: number;
	signal?: AbortSignal;
}

export interface EditOptions extends Omit<GenerateOptions, "background"> {
	/** 1-3 input image paths to edit. */
	images: string[];
	/**
	 * Optional mask image path. Transparent regions of the mask mark the
	 * areas the model is allowed to change. Omit for a whole-image edit.
	 */
	maskPath?: string;
}

export interface ImageOutput {
	/** Absolute path where the generated image was persisted. */
	path: string;
	mimeType: string;
	/** Provider-returned revised prompt, when available. */
	revisedPrompt?: string;
}

export interface ImageResult {
	images: ImageOutput[];
	/** Provider id (e.g. "openai"). */
	provider: string;
	model: string;
}

export interface ImageProvider {
	id: string;
	/** Capabilities this provider actually implements. Used to fail closed. */
	supports: {
		generate: boolean;
		edit: boolean;
		mask: boolean;
	};
	generate(options: GenerateOptions): Promise<ImageResult>;
	edit(options: EditOptions): Promise<ImageResult>;
}
