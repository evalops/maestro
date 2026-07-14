/**
 * Bounding-box → mask synthesis.
 *
 * The OpenAI image edit endpoint accepts a mask PNG whose transparent pixels
 * mark the region the model is allowed to change. Requiring callers to author
 * that PNG by hand is poor UX, so Painter accepts a pixel bounding box and we
 * synthesize the mask here.
 *
 * This module is dependency-free (only `node:zlib`) so it is fully unit-
 * testable and works whether or not the optional `sharp` package is present.
 * Dimension detection of arbitrary input formats is handled by the caller
 * (see `readPngDimensions` for the common PNG case).
 *
 * Convention: transparent (alpha 0) = editable region; opaque (alpha 255) =
 * preserved. Matches the OpenAI Images API mask semantics.
 *
 * @module services/image-providers/masks
 */

import { deflateSync } from "node:zlib";

/** Pixel rectangle. Coordinates outside the canvas are clipped to bounds. */
export interface MaskRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ImageDimensions {
	width: number;
	height: number;
}

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// --- CRC32 (table-based, standard IEEE 802.3 polynomial) ---------------------

const CRC_TABLE: Uint32Array = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		const idx = (c ^ (buf[i] ?? 0)) & 0xff;
		c = (CRC_TABLE[idx] ?? 0) ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBuf = Buffer.from(type, "ascii");
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(data.length, 0);
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function ihdr(width: number, height: number): Buffer {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	// bit depth 8, color type 6 (RGBA), compression 0, filter 0, interlace 0
	data[8] = 8;
	data[9] = 6;
	data[10] = 0;
	data[11] = 0;
	data[12] = 0;
	return data;
}

/** Clip a region to the canvas, returning a normalized {x,y,width,height}. */
export function clipRegion(
	canvas: ImageDimensions,
	region: MaskRegion,
): { x: number; y: number; width: number; height: number } {
	const x = Math.max(0, Math.floor(region.x));
	const y = Math.max(0, Math.floor(region.y));
	const x2 = Math.min(canvas.width, Math.ceil(region.x + region.width));
	const y2 = Math.min(canvas.height, Math.ceil(region.y + region.height));
	return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}

/**
 * Encode an RGBA mask PNG of the given canvas size. Pixels inside `region`
 * are transparent (editable); everything else is opaque (preserved).
 *
 * @throws if canvas dimensions are non-positive or the region is degenerate
 *         after clipping.
 */
export function encodeMaskPng(
	canvas: ImageDimensions,
	region: MaskRegion,
): Buffer {
	if (canvas.width <= 0 || canvas.height <= 0) {
		throw new Error(
			`encodeMaskPng: canvas dimensions must be positive (got ${canvas.width}x${canvas.height})`,
		);
	}
	const clipped = clipRegion(canvas, region);
	if (clipped.width <= 0 || clipped.height <= 0) {
		throw new Error(
			"encodeMaskPng: region is empty after clipping to canvas bounds",
		);
	}

	const { width, height } = canvas;
	// Build raw scanlines: filter byte 0 (None) + width * 4 bytes RGBA.
	const rowLen = width * 4;
	const raw = Buffer.alloc((rowLen + 1) * height);
	for (let y = 0; y < height; y++) {
		const rowStart = y * (rowLen + 1);
		raw[rowStart] = 0; // filter: None
		const inY = y >= clipped.y && y < clipped.y + clipped.height;
		for (let x = 0; x < width; x++) {
			const px = rowStart + 1 + x * 4;
			const inX = x >= clipped.x && x < clipped.x + clipped.width;
			// RGB 0; alpha 0 inside region (editable), 255 outside (preserved).
			raw[px] = 0;
			raw[px + 1] = 0;
			raw[px + 2] = 0;
			raw[px + 3] = inX && inY ? 0 : 255;
		}
	}

	const idat = deflateSync(raw);
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr(width, height)),
		pngChunk("IDAT", idat),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * Read {width, height} from a PNG buffer by parsing the IHDR chunk.
 * Returns null if the buffer is not a PNG or the IHDR is malformed.
 */
export function readPngDimensions(buf: Buffer): ImageDimensions | null {
	if (buf.length < 24) return null;
	if (!PNG_SIGNATURE.equals(buf.subarray(0, 8))) return null;
	// Bytes 12..16 = "IHDR"; 16..20 = width; 20..24 = height.
	if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
	if (width <= 0 || height <= 0) return null;
	return { width, height };
}
