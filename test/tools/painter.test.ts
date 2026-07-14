import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getPainterBudget,
	resetPainterBudgetSingleton,
} from "../../src/services/image-providers/cost.js";
import {
	encodeMaskPng,
	readPngDimensions,
} from "../../src/services/image-providers/masks.js";
import {
	type PainterToolDetails,
	buildMaskPath,
	isTransientImageError,
	painterOutputDir,
	painterTimeoutMs,
	painterTool,
	persistImage,
	resolvePainterModel,
} from "../../src/tools/painter.js";

const PAINTER_ENV_KEYS = [
	"OPENAI_API_KEY",
	"MAESTRO_PAINTER_MODEL",
	"MAESTRO_PAINTER_BASE_URL",
	"MAESTRO_PAINTER_OUTPUT_DIR",
	"MAESTRO_PAINTER_TIMEOUT_MS",
] as const;

describe("painter: configuration helpers", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of PAINTER_ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PAINTER_ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	describe("resolvePainterModel", () => {
		it("defaults to gpt-image-2", () => {
			expect(resolvePainterModel()).toBe("gpt-image-2");
		});

		it("honors MAESTRO_PAINTER_MODEL", () => {
			process.env.MAESTRO_PAINTER_MODEL = "gpt-image-1";
			expect(resolvePainterModel()).toBe("gpt-image-1");
		});

		it("ignores whitespace-only overrides", () => {
			process.env.MAESTRO_PAINTER_MODEL = "   ";
			expect(resolvePainterModel()).toBe("gpt-image-2");
		});
	});

	describe("painterTimeoutMs", () => {
		it("defaults to 180s", () => {
			expect(painterTimeoutMs()).toBe(180_000);
		});

		it("parses an explicit override", () => {
			process.env.MAESTRO_PAINTER_TIMEOUT_MS = "30000";
			expect(painterTimeoutMs()).toBe(30_000);
		});

		it("falls back to default on garbage", () => {
			process.env.MAESTRO_PAINTER_TIMEOUT_MS = "not-a-number";
			expect(painterTimeoutMs()).toBe(180_000);
		});

		it("falls back to default on non-positive values", () => {
			process.env.MAESTRO_PAINTER_TIMEOUT_MS = "0";
			expect(painterTimeoutMs()).toBe(180_000);
		});
	});

	describe("painterOutputDir", () => {
		it("defaults into the maestro home assets dir", () => {
			const dir = painterOutputDir();
			expect(dir.endsWith(join(".maestro", "assets", "painter"))).toBe(true);
		});

		it("honors MAESTRO_PAINTER_OUTPUT_DIR", () => {
			process.env.MAESTRO_PAINTER_OUTPUT_DIR = "/tmp/painter-override";
			expect(painterOutputDir()).toBe("/tmp/painter-override");
		});
	});

	describe("isTransientImageError", () => {
		it("flags rate-limit and network class failures", () => {
			expect(isTransientImageError(new Error("rate limit exceeded"))).toBe(
				true,
			);
			expect(isTransientImageError(new Error("429 Too Many Requests"))).toBe(
				true,
			);
			expect(
				isTransientImageError(new Error("Service Unavailable (503)")),
			).toBe(true);
			expect(isTransientImageError(new Error("ETIMEDOUT"))).toBe(true);
			const errnoErr = new Error("connect ECONNREFUSED");
			errnoErr.code = "ECONNREFUSED";
			expect(isTransientImageError(errnoErr)).toBe(true);
		});

		it("does not flag validation or content-policy failures", () => {
			expect(isTransientImageError(new Error("Invalid size"))).toBe(false);
			expect(
				isTransientImageError(
					new Error("Painter requires OPENAI_API_KEY to be set"),
				),
			).toBe(false);
			expect(isTransientImageError(new Error("content policy"))).toBe(false);
		});
	});
});

describe("painter: persistImage", () => {
	const tmpRoot = join(tmpdir(), `painter-test-${process.pid}-${Date.now()}`);

	beforeEach(async () => {
		process.env.MAESTRO_PAINTER_OUTPUT_DIR = tmpRoot;
		await mkdir(tmpRoot, { recursive: true });
	});

	afterEach(async () => {
		delete process.env.MAESTRO_PAINTER_OUTPUT_DIR;
		await rm(tmpRoot, { recursive: true, force: true });
	});

	it("writes the decoded bytes and returns the absolute path", async () => {
		const bytes = Buffer.from([1, 2, 3, 4]);
		const { path } = await persistImage(bytes, "png");
		expect(existsSync(path)).toBe(true);
		expect(path.endsWith(".png")).toBe(true);
	});

	it("creates the output directory if it does not exist", async () => {
		const nested = join(tmpRoot, "deeper");
		process.env.MAESTRO_PAINTER_OUTPUT_DIR = nested;
		const { path } = await persistImage(Buffer.from([0]), "png");
		expect(existsSync(path)).toBe(true);
	});
});

describe("painter: buildMaskPath", () => {
	const tmpRoot = join(tmpdir(), `painter-mask-${process.pid}-${Date.now()}`);

	beforeEach(async () => {
		process.env.MAESTRO_PAINTER_OUTPUT_DIR = tmpRoot;
		await mkdir(tmpRoot, { recursive: true });
	});

	afterEach(async () => {
		delete process.env.MAESTRO_PAINTER_OUTPUT_DIR;
		await rm(tmpRoot, { recursive: true, force: true });
	});

	it("synthesizes a mask sized to the input PNG and reports the png-header source", async () => {
		const inputPng = encodeMaskPng(
			{ width: 20, height: 10 },
			{ x: 0, y: 0, width: 1, height: 1 },
		);
		const inputPath = join(tmpRoot, "input.png");
		await writeFile(inputPath, inputPng);

		const { maskPath, dimensions, source } = await buildMaskPath([inputPath], {
			x: 5,
			y: 2,
			width: 4,
			height: 3,
		});

		expect(source).toBe("png-header");
		expect(dimensions).toEqual({ width: 20, height: 10 });
		expect(existsSync(maskPath)).toBe(true);
		expect(readPngDimensions(await readFile(maskPath))).toEqual({
			width: 20,
			height: 10,
		});
	});

	it("writes the mask into the configured output directory", async () => {
		const inputPng = encodeMaskPng(
			{ width: 8, height: 8 },
			{ x: 0, y: 0, width: 1, height: 1 },
		);
		const inputPath = join(tmpRoot, "input.png");
		await writeFile(inputPath, inputPng);

		const { maskPath } = await buildMaskPath([inputPath], {
			x: 1,
			y: 1,
			width: 2,
			height: 2,
		});

		expect(maskPath.startsWith(tmpRoot)).toBe(true);
		expect(maskPath.endsWith(".png")).toBe(true);
	});

	it("rejects when no input images are provided", async () => {
		await expect(
			buildMaskPath([], { x: 0, y: 0, width: 1, height: 1 }),
		).rejects.toThrow(/at least one input image/);
	});
});

describe("painter: provider selection", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of [
			"OPENAI_API_KEY",
			"FAL_KEY",
			"MAESTRO_PAINTER_PROVIDER",
			"MAESTRO_PAINTER_MAX_COST_CENTS",
		]) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		resetPainterBudgetSingleton();
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		resetPainterBudgetSingleton();
	});

	it("defaults to the OpenAI provider and requires OPENAI_API_KEY", async () => {
		await expect(
			painterTool.execute("c5", { mode: "generate", prompt: "x" }),
		).rejects.toThrow(/OPENAI_API_KEY/);
	});

	it("routes to FLUX when MAESTRO_PAINTER_PROVIDER=flux and requires FAL_KEY", async () => {
		process.env.MAESTRO_PAINTER_PROVIDER = "flux";
		await expect(
			painterTool.execute("c6", { mode: "generate", prompt: "x" }),
		).rejects.toThrow(/FAL_KEY/);
	});

	it("rejects edit when the selected provider does not support it", async () => {
		process.env.MAESTRO_PAINTER_PROVIDER = "flux";
		process.env.FAL_KEY = "fal-test";
		await expect(
			painterTool.execute("c7", {
				mode: "edit",
				prompt: "x",
				images: ["/tmp/a.png"],
			}),
		).rejects.toThrow(/does not support editing/);
	});

	it("refunds the reserved budget when the call fails after reservation", async () => {
		// flux + edit: budget reserves for the request, then the supports guard
		// throws — the refund path must release the reservation so failed calls
		// do not permanently consume the ceiling.
		process.env.MAESTRO_PAINTER_PROVIDER = "flux";
		process.env.FAL_KEY = "fal-test";
		process.env.MAESTRO_PAINTER_MAX_COST_CENTS = "100";
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"flux|*|*": 30,
		});
		resetPainterBudgetSingleton();
		await expect(
			painterTool.execute("c8", {
				mode: "edit",
				prompt: "x",
				images: ["/tmp/a.png"],
			}),
		).rejects.toThrow(/does not support editing/);
		expect(getPainterBudget().cumulativeCents).toBe(0);
	});
});

describe("painter: input guards", () => {
	const savedKey = process.env.OPENAI_API_KEY;

	beforeEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	afterEach(() => {
		if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = savedKey;
	});

	it("rejects when OPENAI_API_KEY is not set", async () => {
		await expect(
			painterTool.execute("call_1", { mode: "generate", prompt: "an icon" }),
		).rejects.toThrow(/OPENAI_API_KEY/);
	});

	it("rejects edit mode without any input images", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		await expect(
			painterTool.execute("call_2", { mode: "edit", prompt: "redact" }),
		).rejects.toThrow(/images/);
	});

	it("rejects an invalid mode at the schema layer", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		await expect(
			painterTool.execute("call_3", {
				mode: "upscale",
				prompt: "x",
			} as unknown as { mode: "generate"; prompt: string }),
		).rejects.toThrow(/Validation failed/);
	});

	it("enforces the cost ceiling before any API call", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		process.env.MAESTRO_PAINTER_MAX_COST_CENTS = "1";
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|auto": 8,
		});
		// The budget is a process singleton that reads ceiling env at construction;
		// reset so this test's env is honored.
		resetPainterBudgetSingleton();
		await expect(
			painterTool.execute("call_4", {
				mode: "generate",
				prompt: "icon",
				size: "1024x1024",
			}),
		).rejects.toThrow(/exceeded/);
		resetPainterBudgetSingleton();
	});

	it("declares a stable name, schema, and summary hooks", () => {
		expect(painterTool.name).toBe("painter");
		expect(painterTool.parameters).toBeDefined();
		expect(typeof painterTool.getToolUseSummary).toBe("function");
		expect(painterTool.getToolUseSummary?.({ mode: "generate" })).toBe(
			"painter generate",
		);
	});

	// Sentinel to keep the details type honest if the schema grows.
	it("uses PainterToolDetails with the persisted paths", () => {
		const details: PainterToolDetails = {
			provider: "openai",
			model: "gpt-image-2",
			mode: "generate",
			paths: ["/tmp/x.png"],
		};
		expect(details.paths).toHaveLength(1);
	});
});
