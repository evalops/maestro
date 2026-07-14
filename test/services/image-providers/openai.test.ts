import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIImageProvider } from "../../../src/services/image-providers/openai.js";

/**
 * Build a stub OpenAI client whose images.generate / images.edit return canned
 * payloads. The provider only depends on `client.images.{generate,edit}`, so
 * this is enough to exercise decode + write + mask handling without network.
 */
function makeStubClient(responses: {
	generate?: unknown;
	edit?: unknown;
}): OpenAI {
	const generate = vi
		.fn<OpenAI["images"]["generate"]>()
		.mockResolvedValue(responses.generate as never);
	const edit = vi
		.fn<OpenAI["images"]["edit"]>()
		.mockResolvedValue(responses.edit as never);
	return { images: { generate, edit } } as unknown as OpenAI;
}

const TINY_PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString(
	"base64",
);

describe("OpenAIImageProvider", () => {
	const tmpRoot = join(
		tmpdir(),
		`painter-provider-${process.pid}-${Date.now()}`,
	);

	beforeEach(async () => {
		process.env.MAESTRO_PAINTER_OUTPUT_DIR = tmpRoot;
	});

	afterEach(async () => {
		delete process.env.MAESTRO_PAINTER_OUTPUT_DIR;
		await rm(tmpRoot, { recursive: true, force: true });
	});

	describe("generate", () => {
		it("decodes b64_json and persists via writeImage", async () => {
			const writeImage = vi
				.fn<(b: Buffer, ext: string) => Promise<{ path: string }>>()
				.mockResolvedValue({ path: "/tmp/out.png" });
			const client = makeStubClient({
				generate: { data: [{ b64_json: TINY_PNG_BASE64 }] },
			});
			const provider = new OpenAIImageProvider({
				client,
				writeImage,
				model: "gpt-image-2",
			});

			const result = await provider.generate({ prompt: "an icon" });

			expect(writeImage).toHaveBeenCalledTimes(1);
			const [bytes, ext] = writeImage.mock.calls[0]!;
			expect(ext).toBe("png");
			expect(bytes.length).toBe(4);
			expect(result.images[0]?.path).toBe("/tmp/out.png");
			expect(result.provider).toBe("openai");
			expect(result.model).toBe("gpt-image-2");
			expect(client.images.generate).toHaveBeenCalledOnce();
		});

		it("carries the revised prompt through when present", async () => {
			const writeImage = vi.fn().mockResolvedValue({ path: "/tmp/out.png" });
			const client = makeStubClient({
				generate: {
					data: [
						{ b64_json: TINY_PNG_BASE64, revised_prompt: "a better icon" },
					],
				},
			});
			const provider = new OpenAIImageProvider({ client, writeImage });

			const result = await provider.generate({ prompt: "icon" });

			expect(result.images[0]?.revisedPrompt).toBe("a better icon");
		});

		it("throws when the API returns no image data", async () => {
			const writeImage = vi.fn();
			const client = makeStubClient({ generate: { data: [] } });
			const provider = new OpenAIImageProvider({ client, writeImage });

			await expect(provider.generate({ prompt: "x" })).rejects.toThrow(
				/no image data/i,
			);
			expect(writeImage).not.toHaveBeenCalled();
		});
	});

	describe("edit", () => {
		it("requires at least one input image path", async () => {
			const provider = new OpenAIImageProvider({
				client: makeStubClient({ edit: { data: [] } }),
				writeImage: vi.fn(),
			});
			await expect(provider.edit({ prompt: "x", images: [] })).rejects.toThrow(
				/at least one input image/,
			);
		});

		it("passes image files and omits mask when no maskPath", async () => {
			const writeImage = vi.fn().mockResolvedValue({ path: "/tmp/o.png" });
			const client = makeStubClient({
				edit: { data: [{ b64_json: TINY_PNG_BASE64 }] },
			});
			const provider = new OpenAIImageProvider({ client, writeImage });

			// Use a real temp file so readFile succeeds; contents are irrelevant.
			const inputPath = join(tmpRoot, "input.png");
			const { writeFile, mkdir } = await import("node:fs/promises");
			await mkdir(tmpRoot, { recursive: true });
			await writeFile(inputPath, Buffer.from([0x89, 0x50]));

			await provider.edit({ prompt: "redact", images: [inputPath] });

			const params = (client.images.edit as ReturnType<typeof vi.fn>).mock
				.calls[0]![0] as { image: unknown[]; mask?: unknown };
			expect(params.image).toHaveLength(1);
			expect(params.mask).toBeUndefined();
		});
	});

	describe("supports", () => {
		it("declares generate, edit, and mask", () => {
			const provider = new OpenAIImageProvider({
				client: makeStubClient({}),
				writeImage: vi.fn(),
			});
			expect(provider.supports).toEqual({
				generate: true,
				edit: true,
				mask: true,
			});
		});
	});
});
