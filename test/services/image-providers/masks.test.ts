import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	type ImageDimensions,
	type MaskRegion,
	clipRegion,
	crc32,
	encodeMaskPng,
	readPngDimensions,
} from "../../../src/services/image-providers/masks.js";

function findChunk(png: Buffer, type: string): Buffer | null {
	let offset = 8; // skip signature
	while (offset + 8 <= png.length) {
		const len = png.readUInt32BE(offset);
		const chunkType = png.toString("ascii", offset + 4, offset + 8);
		const dataStart = offset + 8;
		if (chunkType === type) return png.subarray(dataStart, dataStart + len);
		offset = dataStart + len + 4; // skip data + crc
	}
	return null;
}

/** Inflate the (single) IDAT and return raw RGBA scanlines, filter byte stripped. */
function rawPixels(png: Buffer): {
	width: number;
	height: number;
	data: Buffer;
} {
	const ihdr = findChunk(png, "IHDR")!;
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const idat = findChunk(png, "IDAT")!;
	const inflated = Buffer.from(inflateSync(idat));
	// strip per-row filter byte
	const rowLen = width * 4;
	const data = Buffer.alloc(rowLen * height);
	for (let y = 0; y < height; y++) {
		inflated
			.subarray(y * (rowLen + 1) + 1, y * (rowLen + 1) + 1 + rowLen)
			.copy(data, y * rowLen);
	}
	return { width, height, data };
}

describe("masks: crc32", () => {
	it("matches the canonical CRC32 check value", () => {
		// RFC 1952 / PKZIP reference: crc32("123456789") == 0xCBF43926
		expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);
	});

	it("is stable for empty input", () => {
		expect(crc32(Buffer.alloc(0))).toBe(0x00000000);
	});
});

describe("masks: clipRegion", () => {
	const canvas: ImageDimensions = { width: 100, height: 100 };

	it("clips a region that overflows the right/bottom edges", () => {
		const r = clipRegion(canvas, { x: 90, y: 90, width: 50, height: 50 });
		expect(r).toEqual({ x: 90, y: 90, width: 10, height: 10 });
	});

	it("clamps negative origin to zero", () => {
		const r = clipRegion(canvas, { x: -10, y: -10, width: 20, height: 20 });
		expect(r).toEqual({ x: 0, y: 0, width: 10, height: 10 });
	});

	it("returns empty width when the region is fully outside", () => {
		const r = clipRegion(canvas, { x: 200, y: 0, width: 10, height: 10 });
		expect(r.width).toBe(0);
	});
});

describe("masks: encodeMaskPng", () => {
	const canvas: ImageDimensions = { width: 10, height: 6 };
	const region: MaskRegion = { x: 2, y: 1, width: 4, height: 2 };

	it("emits a valid PNG signature and IHDR matching the canvas", () => {
		const png = encodeMaskPng(canvas, region);
		expect(png.subarray(0, 8).equals(png.subarray(0, 8))).toBe(true);
		expect(readPngDimensions(png)).toEqual(canvas);
	});

	it("marks pixels inside the region as transparent (alpha 0) and outside as opaque (255)", () => {
		const png = encodeMaskPng(canvas, region);
		const { width, data } = rawPixels(png);
		const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3];

		// inside the region
		expect(alpha(2, 1)).toBe(0);
		expect(alpha(5, 2)).toBe(0);
		// outside the region (corners + adjacent)
		expect(alpha(0, 0)).toBe(255);
		expect(alpha(9, 5)).toBe(255);
		expect(alpha(6, 1)).toBe(255); // just right of region
		expect(alpha(2, 3)).toBe(255); // just below region
	});

	it("clips a region that exceeds the canvas instead of failing", () => {
		const png = encodeMaskPng(canvas, { x: 8, y: 5, width: 10, height: 10 });
		const { width, data } = rawPixels(png);
		// clipped region is x in [8,10), y in [5,6): pixel (8,5) transparent
		expect(data[(5 * width + 8) * 4 + 3]).toBe(0);
		expect(data[(5 * width + 7) * 4 + 3]).toBe(255);
	});

	it("throws on non-positive canvas dimensions", () => {
		expect(() => encodeMaskPng({ width: 0, height: 10 }, region)).toThrow(
			/positive/,
		);
	});

	it("throws when the region is empty after clipping", () => {
		expect(() =>
			encodeMaskPng(canvas, { x: 200, y: 200, width: 5, height: 5 }),
		).toThrow(/empty after clipping/);
	});
});

describe("masks: readPngDimensions", () => {
	it("round-trips through encodeMaskPng", () => {
		const png = encodeMaskPng(
			{ width: 64, height: 32 },
			{ x: 0, y: 0, width: 8, height: 8 },
		);
		expect(readPngDimensions(png)).toEqual({ width: 64, height: 32 });
	});

	it("returns null for non-PNG input", () => {
		expect(readPngDimensions(Buffer.from("not a png"))).toBeNull();
	});

	it("returns null for a truncated buffer", () => {
		expect(readPngDimensions(Buffer.alloc(10))).toBeNull();
	});
});
