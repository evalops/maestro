/**
 * Image processing utilities using Sharp.
 * Provides image optimization, format conversion, and resizing for LLM consumption.
 */

import { extname } from "node:path";

// Sharp types (we load dynamically to handle missing optional dependency)
interface SharpInstance {
	resize: (
		width?: number,
		height?: number,
		options?: { fit?: string; withoutEnlargement?: boolean },
	) => SharpInstance;
	jpeg: (options?: { quality?: number }) => SharpInstance;
	png: (options?: { compressionLevel?: number }) => SharpInstance;
	webp: (options?: { quality?: number }) => SharpInstance;
	toBuffer: () => Promise<Buffer>;
	metadata: () => Promise<{
		width?: number;
		height?: number;
		format?: string;
		size?: number;
	}>;
}

type SharpFunction = (input: Buffer | string) => SharpInstance;

// Lazy-load sharp to handle optional dependency
let sharpModule: SharpFunction | null | undefined = undefined;

async function getSharp(): Promise<SharpFunction | null> {
	if (sharpModule === undefined) {
		try {
			const module = await import("sharp");
			sharpModule = (module.default || module) as SharpFunction;
		} catch {
			sharpModule = null;
		}
	}
	return sharpModule;
}

export function isSharpAvailable(): Promise<boolean> {
	return getSharp().then((s) => s !== null);
}

export interface ImageProcessOptions {
	/** Maximum width in pixels (maintains aspect ratio) */
	maxWidth?: number;
	/** Maximum height in pixels (maintains aspect ratio) */
	maxHeight?: number;
	/** Output format (jpeg, png, webp). Defaults to original format or jpeg */
	format?: "jpeg" | "png" | "webp";
	/** Quality for lossy formats (1-100). Defaults to 85 */
	quality?: number;
	/** Maximum file size in bytes. Will reduce quality to meet this limit */
	maxBytes?: number;
}

export interface ProcessedImage {
	/** Base64 encoded image data */
	base64: string;
	/** MIME type of the processed image */
	mimeType: string;
	/** Original dimensions */
	originalWidth?: number;
	originalHeight?: number;
	/** Processed dimensions */
	width?: number;
	height?: number;
	/** Original size in bytes */
	originalSize: number;
	/** Processed size in bytes */
	processedSize: number;
	/** Whether the image was resized */
	wasResized: boolean;
	/** Whether the image was compressed */
	wasCompressed: boolean;
}

const FORMAT_MIME_TYPES: Record<string, string> = {
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
};

const SUPPORTED_FORMATS = new Set([
	"jpeg",
	"jpg",
	"png",
	"webp",
	"gif",
	"tiff",
	"avif",
	"heif",
]);

export function isSupportedImageFormat(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase().slice(1);
	return SUPPORTED_FORMATS.has(ext);
}

/**
 * Process an image for optimal LLM consumption.
 * Resizes and compresses images to reduce token usage while maintaining quality.
 */
export async function processImage(
	input: Buffer | string,
	options: ImageProcessOptions = {},
): Promise<ProcessedImage> {
	const sharp = await getSharp();
	if (!sharp) {
		throw new Error(
			"Image processing requires the 'sharp' package. Install with: npm install sharp",
		);
	}

	const {
		maxWidth = 2048,
		maxHeight = 2048,
		format,
		quality = 85,
		maxBytes,
	} = options;

	const image = sharp(input);
	const metadata = await image.metadata();

	const originalWidth = metadata.width || 0;
	const originalHeight = metadata.height || 0;
	const originalFormat = metadata.format || "jpeg";
	const originalSize = typeof input === "string" ? 0 : input.length;

	// Determine output format
	const outputFormat =
		format || (SUPPORTED_FORMATS.has(originalFormat) ? originalFormat : "jpeg");
	const mimeType = FORMAT_MIME_TYPES[outputFormat] || "image/jpeg";

	// Check if resizing is needed
	const needsResize = originalWidth > maxWidth || originalHeight > maxHeight;

	let processedImage = image;

	// Resize if needed (maintains aspect ratio)
	if (needsResize) {
		processedImage = processedImage.resize(maxWidth, maxHeight, {
			fit: "inside",
			withoutEnlargement: true,
		});
	}

	// Apply format-specific compression
	let currentQuality = quality;
	let buffer: Buffer;

	const compressWithQuality = async (q: number): Promise<Buffer> => {
		let img = sharp(input);
		if (needsResize) {
			img = img.resize(maxWidth, maxHeight, {
				fit: "inside",
				withoutEnlargement: true,
			});
		}

		switch (outputFormat) {
			case "jpeg":
			case "jpg":
				return img.jpeg({ quality: q }).toBuffer();
			case "png":
				// PNG uses compression level (0-9), not quality
				return img
					.png({ compressionLevel: Math.floor((100 - q) / 11) })
					.toBuffer();
			case "webp":
				return img.webp({ quality: q }).toBuffer();
			default:
				return img.jpeg({ quality: q }).toBuffer();
		}
	};

	buffer = await compressWithQuality(currentQuality);

	// If maxBytes is specified, progressively reduce quality
	if (maxBytes && buffer.length > maxBytes) {
		const minQuality = 20;
		while (buffer.length > maxBytes && currentQuality > minQuality) {
			currentQuality -= 10;
			buffer = await compressWithQuality(Math.max(currentQuality, minQuality));
		}
	}

	// Get final dimensions
	const finalMetadata = await sharp(buffer).metadata();

	return {
		base64: buffer.toString("base64"),
		mimeType,
		originalWidth,
		originalHeight,
		width: finalMetadata.width,
		height: finalMetadata.height,
		originalSize,
		processedSize: buffer.length,
		wasResized: needsResize,
		wasCompressed: currentQuality < quality || outputFormat !== originalFormat,
	};
}

/**
 * Process an image to fit within Claude's vision limits.
 * Claude has a 20MB limit per image, but smaller is better for tokens.
 */
export async function processImageForClaude(
	input: Buffer | string,
): Promise<ProcessedImage> {
	return processImage(input, {
		maxWidth: 2048,
		maxHeight: 2048,
		quality: 85,
		maxBytes: 5 * 1024 * 1024, // 5MB target for efficiency
	});
}

/**
 * Process a screenshot for optimal display.
 * Screenshots are often larger and benefit from aggressive compression.
 */
export async function processScreenshot(
	input: Buffer | string,
): Promise<ProcessedImage> {
	return processImage(input, {
		maxWidth: 1920,
		maxHeight: 1080,
		format: "jpeg",
		quality: 80,
		maxBytes: 2 * 1024 * 1024, // 2MB for screenshots
	});
}

/**
 * Get image metadata without processing.
 */
export async function getImageMetadata(input: Buffer | string): Promise<{
	width: number;
	height: number;
	format: string;
	size: number;
} | null> {
	const sharp = await getSharp();
	if (!sharp) {
		return null;
	}

	try {
		const metadata = await sharp(input).metadata();
		return {
			width: metadata.width || 0,
			height: metadata.height || 0,
			format: metadata.format || "unknown",
			size: typeof input === "string" ? 0 : input.length,
		};
	} catch {
		return null;
	}
}
