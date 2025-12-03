import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getImageMetadata,
	isSharpAvailable,
	isSupportedImageFormat,
	processImage,
	processImageForClaude,
	processScreenshot,
} from "../../src/tools/image-processor.js";

describe("image-processor", () => {
	describe("isSupportedImageFormat", () => {
		it("returns true for jpeg", () => {
			expect(isSupportedImageFormat("image.jpeg")).toBe(true);
			expect(isSupportedImageFormat("image.jpg")).toBe(true);
		});

		it("returns true for png", () => {
			expect(isSupportedImageFormat("image.png")).toBe(true);
		});

		it("returns true for webp", () => {
			expect(isSupportedImageFormat("image.webp")).toBe(true);
		});

		it("returns true for gif", () => {
			expect(isSupportedImageFormat("image.gif")).toBe(true);
		});

		it("returns true for tiff", () => {
			expect(isSupportedImageFormat("image.tiff")).toBe(true);
		});

		it("returns true for avif", () => {
			expect(isSupportedImageFormat("image.avif")).toBe(true);
		});

		it("returns true for heif", () => {
			expect(isSupportedImageFormat("image.heif")).toBe(true);
		});

		it("returns false for unsupported formats", () => {
			expect(isSupportedImageFormat("document.pdf")).toBe(false);
			expect(isSupportedImageFormat("file.txt")).toBe(false);
			expect(isSupportedImageFormat("video.mp4")).toBe(false);
		});

		it("handles uppercase extensions", () => {
			expect(isSupportedImageFormat("IMAGE.JPEG")).toBe(true);
			expect(isSupportedImageFormat("IMAGE.PNG")).toBe(true);
		});

		it("handles paths with directories", () => {
			expect(isSupportedImageFormat("/path/to/image.png")).toBe(true);
			expect(isSupportedImageFormat("./images/photo.jpg")).toBe(true);
		});

		it("handles files with no extension", () => {
			expect(isSupportedImageFormat("noextension")).toBe(false);
		});

		it("handles files with multiple dots", () => {
			expect(isSupportedImageFormat("file.name.png")).toBe(true);
			expect(isSupportedImageFormat("file.name.txt")).toBe(false);
		});
	});

	describe("isSharpAvailable", () => {
		it("returns a boolean", async () => {
			const result = await isSharpAvailable();
			expect(typeof result).toBe("boolean");
		});
	});

	describe("processImage", () => {
		it("throws when sharp is not available", async () => {
			const sharpAvailable = await isSharpAvailable();
			if (!sharpAvailable) {
				await expect(processImage(Buffer.from("test"))).rejects.toThrow(
					"Image processing requires the 'sharp' package",
				);
			}
		});
	});

	describe("processImageForClaude", () => {
		it("throws when sharp is not available", async () => {
			const sharpAvailable = await isSharpAvailable();
			if (!sharpAvailable) {
				await expect(
					processImageForClaude(Buffer.from("test")),
				).rejects.toThrow("sharp");
			}
		});
	});

	describe("processScreenshot", () => {
		it("throws when sharp is not available", async () => {
			const sharpAvailable = await isSharpAvailable();
			if (!sharpAvailable) {
				await expect(processScreenshot(Buffer.from("test"))).rejects.toThrow(
					"sharp",
				);
			}
		});
	});

	describe("getImageMetadata", () => {
		it("returns null when sharp is not available", async () => {
			const sharpAvailable = await isSharpAvailable();
			if (!sharpAvailable) {
				const result = await getImageMetadata(Buffer.from("test"));
				expect(result).toBeNull();
			}
		});
	});
});

// Conditional tests that only run if sharp is available
describe("image-processor with sharp", async () => {
	const sharpAvailable = await isSharpAvailable();

	it.skipIf(!sharpAvailable)("processes a valid PNG buffer", async () => {
		// Create a minimal valid 1x1 PNG
		const pngBuffer = Buffer.from([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a, // PNG signature
			0x00,
			0x00,
			0x00,
			0x0d,
			0x49,
			0x48,
			0x44,
			0x52, // IHDR chunk
			0x00,
			0x00,
			0x00,
			0x01,
			0x00,
			0x00,
			0x00,
			0x01, // 1x1 dimensions
			0x08,
			0x02,
			0x00,
			0x00,
			0x00,
			0x90,
			0x77,
			0x53, // bit depth, color type, etc
			0xde,
			0x00,
			0x00,
			0x00,
			0x0c,
			0x49,
			0x44,
			0x41, // IDAT chunk
			0x54,
			0x08,
			0xd7,
			0x63,
			0xf8,
			0xff,
			0xff,
			0x3f,
			0x00,
			0x05,
			0xfe,
			0x02,
			0xfe,
			0xdc,
			0xcc,
			0x59,
			0xe7,
			0x00,
			0x00,
			0x00,
			0x00,
			0x49,
			0x45,
			0x4e, // IEND chunk
			0x44,
			0xae,
			0x42,
			0x60,
			0x82,
		]);

		const result = await processImage(pngBuffer);
		expect(result).toHaveProperty("base64");
		expect(result).toHaveProperty("mimeType");
		expect(result).toHaveProperty("processedSize");
	});

	it.skipIf(!sharpAvailable)("gets metadata for valid image", async () => {
		// Minimal PNG
		const pngBuffer = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
			0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
			0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
			0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
			0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
			0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);

		const metadata = await getImageMetadata(pngBuffer);
		expect(metadata).not.toBeNull();
		if (metadata) {
			expect(metadata.width).toBe(1);
			expect(metadata.height).toBe(1);
			expect(metadata.format).toBe("png");
		}
	});
});
