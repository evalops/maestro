import { describe, expect, it, vi } from "vitest";
import {
	FluxImageProvider,
	type FluxTransport,
	mapSizeToFlux,
} from "../../../src/services/image-providers/flux.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function makeTransport(responses: {
	post?: { images: { url?: string; content_type?: string }[] };
	get?: Buffer;
}): FluxTransport & {
	postSpy: ReturnType<typeof vi.fn>;
	getSpy: ReturnType<typeof vi.fn>;
} {
	const postSpy = vi
		.fn<FluxTransport["post"]>()
		.mockResolvedValue((responses.post ?? { images: [] }) as never);
	const getSpy = vi
		.fn<FluxTransport["get"]>()
		.mockResolvedValue((responses.get ?? PNG) as never);
	return { post: postSpy, get: getSpy, postSpy, getSpy };
}

describe("flux: mapSizeToFlux", () => {
	it("maps our sizes to fal's enum", () => {
		expect(mapSizeToFlux("1024x1024")).toBe("square");
		expect(mapSizeToFlux("1536x1024")).toBe("landscape_4_3");
		expect(mapSizeToFlux("1792x1024")).toBe("landscape_4_3");
		expect(mapSizeToFlux("1024x1536")).toBe("portrait_4_3");
		expect(mapSizeToFlux("1024x1792")).toBe("portrait_4_3");
		expect(mapSizeToFlux("auto")).toBe("square_hd");
		expect(mapSizeToFlux(undefined)).toBe("square_hd");
	});
});

describe("flux: generate", () => {
	it("posts to the model endpoint and persists fetched bytes via writeImage", async () => {
		const writeImage = vi
			.fn<(b: Buffer, ext: string) => Promise<{ path: string }>>()
			.mockResolvedValue({ path: "/tmp/out.png" });
		const transport = makeTransport({
			post: {
				images: [{ url: "https://cdn/x.png", content_type: "image/png" }],
			},
			get: PNG,
		});
		const provider = new FluxImageProvider({
			apiKey: "fal-key",
			writeImage,
			transport,
		});

		const result = await provider.generate({ prompt: "an icon", n: 2 });

		// Request shape: fal endpoint, image_size mapping, num_images, png output.
		expect(transport.postSpy).toHaveBeenCalledOnce();
		const [url, body] = transport.postSpy.mock.calls[0]!;
		expect(url).toBe("https://fal.run/fal-ai/flux/schnell");
		expect(body).toMatchObject({
			prompt: "an icon",
			image_size: "square_hd",
			num_images: 2,
			output_format: "png",
		});

		// Each returned URL is fetched once and persisted once.
		expect(transport.getSpy).toHaveBeenCalledTimes(1);
		expect(writeImage).toHaveBeenCalledTimes(1);
		expect(writeImage.mock.calls[0]![1]).toBe("png");

		expect(result.provider).toBe("flux");
		expect(result.model).toBe("fal-ai/flux/schnell");
		expect(result.images[0]?.path).toBe("/tmp/out.png");
		expect(result.images[0]?.mimeType).toBe("image/png");
	});

	it("throws when the API returns no images", async () => {
		const provider = new FluxImageProvider({
			apiKey: "fal-key",
			writeImage: vi.fn(),
			transport: makeTransport({ post: { images: [] } }),
		});
		await expect(provider.generate({ prompt: "x" })).rejects.toThrow(
			/no images/i,
		);
	});

	it("throws when images lack downloadable URLs", async () => {
		const provider = new FluxImageProvider({
			apiKey: "fal-key",
			writeImage: vi.fn(),
			transport: makeTransport({ post: { images: [{ url: undefined }] } }),
		});
		await expect(provider.generate({ prompt: "x" })).rejects.toThrow(
			/no downloadable/i,
		);
	});

	it("honors a custom model id", async () => {
		const transport = makeTransport({
			post: { images: [{ url: "https://cdn/y.png" }] },
		});
		const provider = new FluxImageProvider({
			apiKey: "fal-key",
			model: "fal-ai/flux/dev",
			writeImage: vi.fn().mockResolvedValue({ path: "/tmp/y.png" }),
			transport,
		});
		await provider.generate({ prompt: "x" });
		const [url] = transport.postSpy.mock.calls[0]!;
		expect(url).toBe("https://fal.run/fal-ai/flux/dev");
	});
});

describe("flux: edit + supports", () => {
	it("declares generate-only support", () => {
		const provider = new FluxImageProvider({
			apiKey: "fal-key",
			writeImage: vi.fn(),
			transport: makeTransport({}),
		});
		expect(provider.supports).toEqual({
			generate: true,
			edit: false,
			mask: false,
		});
	});

	it("rejects edit calls explicitly", async () => {
		const provider = new FluxImageProvider({
			apiKey: "fal-key",
			writeImage: vi.fn(),
			transport: makeTransport({}),
		});
		await expect(
			provider.edit({ prompt: "x", images: ["a.png"] }),
		).rejects.toThrow(/does not support editing/);
	});
});
