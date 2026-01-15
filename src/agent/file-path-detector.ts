/**
 * File Path Detector
 *
 * Automatically detects file paths in user input and provides functionality
 * to auto-attach referenced files (especially images like screenshots).
 *
 * ## Problem Solved
 *
 * When users paste screenshot paths or reference files in their messages,
 * they expect the agent to be able to see those files. This module:
 * - Detects absolute file paths in text
 * - Identifies image files (png, jpg, gif, webp, etc.)
 * - Provides attachment metadata for auto-inclusion
 *
 * ## Usage
 *
 * ```typescript
 * import { detectFilePaths, extractImageAttachments } from "./file-path-detector.js";
 *
 * // Detect all file paths
 * const paths = detectFilePaths(userMessage);
 * // ["/var/folders/.../Screenshot 2026-01-12.png", "/Users/foo/code/app.ts"]
 *
 * // Extract image attachments for the agent
 * const images = await extractImageAttachments(userMessage);
 * // [{ path: "...", mimeType: "image/png", base64: "..." }]
 * ```
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent:file-path-detector");

/**
 * Image MIME type mappings
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".heic": "image/heic",
	".heif": "image/heif",
	".avif": "image/avif",
};

/**
 * Maximum file size to auto-attach (5MB)
 */
const MAX_AUTO_ATTACH_SIZE = 5 * 1024 * 1024;

/**
 * File path patterns to detect
 * Matches:
 * - Unix absolute paths: /foo/bar/baz.png
 * - macOS temp paths: /var/folders/...
 * - Home directory: ~/Documents/file.png
 * - Windows paths: C:\Users\...
 */
const FILE_PATH_PATTERNS = [
	// Unix absolute paths (including paths with spaces)
	/(?:^|\s)(\/(?:[^\s/]+\/)*[^\s/]+\.[a-zA-Z0-9]+)/g,
	// Paths with escaped spaces or quoted
	/"(\/[^"]+)"/g,
	/'(\/[^']+)'/g,
	// Home directory expansion
	/(?:^|\s)(~\/[^\s]+\.[a-zA-Z0-9]+)/g,
	// Windows paths
	/(?:^|\s)([A-Za-z]:\\[^\s]+\.[a-zA-Z0-9]+)/g,
];

/**
 * Common macOS screenshot path patterns
 */
const SCREENSHOT_PATH_PATTERNS = [
	/\/var\/folders\/[^/]+\/[^/]+\/T\/TemporaryItems\/NSIRD_screencaptureui_[^/]+\/[^/]+\.png/,
	/\/Users\/[^/]+\/Desktop\/Screenshot[^/]*\.png/i,
	/\/Users\/[^/]+\/Pictures\/Screenshots?\/[^/]+\.png/i,
];

/**
 * Detected file path with metadata
 */
export interface DetectedFilePath {
	/** Original path as found in text */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** File extension (lowercase) */
	extension: string;
	/** Whether this appears to be an image */
	isImage: boolean;
	/** Whether this appears to be a screenshot */
	isScreenshot: boolean;
	/** MIME type if known */
	mimeType?: string;
	/** File size in bytes (if file exists) */
	size?: number;
	/** Whether the file exists and is readable */
	exists: boolean;
}

/**
 * Image attachment ready for inclusion in messages
 */
export interface ImageAttachment {
	/** File path */
	path: string;
	/** MIME type */
	mimeType: string;
	/** Base64-encoded image data */
	base64: string;
	/** Original file size */
	size: number;
	/** Whether this was auto-detected as a screenshot */
	isScreenshot: boolean;
}

/**
 * Expand home directory in path
 */
function expandHomePath(path: string): string {
	if (path.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		return path.replace("~", home);
	}
	return path;
}

/**
 * Check if a path looks like a screenshot
 */
function isScreenshotPath(path: string): boolean {
	return SCREENSHOT_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Detect all file paths in text
 */
export function detectFilePaths(text: string): DetectedFilePath[] {
	const detectedPaths = new Set<string>();
	const results: DetectedFilePath[] = [];

	for (const pattern of FILE_PATH_PATTERNS) {
		// Reset lastIndex for global patterns
		pattern.lastIndex = 0;
		let match = pattern.exec(text);
		while (match !== null) {
			const path = match[1];
			if (path && !detectedPaths.has(path)) {
				detectedPaths.add(path);

				const resolvedPath = expandHomePath(path);
				const extension = extname(resolvedPath).toLowerCase();
				const isImage = extension in IMAGE_EXTENSIONS;
				const isScreenshot = isScreenshotPath(resolvedPath);
				const mimeType = IMAGE_EXTENSIONS[extension];

				let exists = false;
				let size: number | undefined;

				try {
					if (existsSync(resolvedPath)) {
						const stats = statSync(resolvedPath);
						if (stats.isFile()) {
							exists = true;
							size = stats.size;
						}
					}
				} catch {
					// File doesn't exist or isn't accessible
				}

				results.push({
					path,
					resolvedPath,
					extension,
					isImage,
					isScreenshot,
					mimeType,
					size,
					exists,
				});
			}

			match = pattern.exec(text);
		}
	}

	return results;
}

/**
 * Detect only image file paths in text
 */
export function detectImagePaths(text: string): DetectedFilePath[] {
	return detectFilePaths(text).filter((f) => f.isImage && f.exists);
}

/**
 * Extract image attachments from text, ready for inclusion in messages
 *
 * @param text - Text to search for image paths
 * @param maxSize - Maximum file size to include (default 5MB)
 * @returns Array of image attachments with base64-encoded data
 */
export async function extractImageAttachments(
	text: string,
	maxSize: number = MAX_AUTO_ATTACH_SIZE,
): Promise<ImageAttachment[]> {
	const imagePaths = detectImagePaths(text);
	const attachments: ImageAttachment[] = [];

	for (const detected of imagePaths) {
		if (!detected.exists || !detected.mimeType) continue;
		if (detected.size && detected.size > maxSize) {
			logger.info("Skipping large image file", {
				path: detected.path,
				size: detected.size,
				maxSize,
			});
			continue;
		}

		try {
			const data = readFileSync(detected.resolvedPath);
			const base64 = data.toString("base64");

			attachments.push({
				path: detected.path,
				mimeType: detected.mimeType,
				base64,
				size: data.length,
				isScreenshot: detected.isScreenshot,
			});

			logger.info("Auto-attached image from path", {
				path: detected.path,
				mimeType: detected.mimeType,
				size: data.length,
				isScreenshot: detected.isScreenshot,
			});
		} catch (error) {
			logger.warn("Failed to read image file", {
				path: detected.path,
				errorType: error instanceof Error ? error.name : "unknown",
			});
		}
	}

	return attachments;
}

/**
 * Check if text contains any detectable file paths
 */
export function containsFilePaths(text: string): boolean {
	return FILE_PATH_PATTERNS.some((pattern) => {
		pattern.lastIndex = 0;
		return pattern.test(text);
	});
}

/**
 * Check if text contains any image paths
 */
export function containsImagePaths(text: string): boolean {
	return detectImagePaths(text).length > 0;
}

/**
 * Format detected paths for display to user
 */
export function formatDetectedPaths(paths: DetectedFilePath[]): string {
	if (paths.length === 0) return "";

	const lines = ["Detected file paths:"];
	for (const p of paths) {
		const status = p.exists ? "✓" : "✗";
		const type = p.isScreenshot ? "screenshot" : p.isImage ? "image" : "file";
		lines.push(
			`  ${status} ${p.path} (${type}${p.size ? `, ${Math.round(p.size / 1024)}KB` : ""})`,
		);
	}
	return lines.join("\n");
}
