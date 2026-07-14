import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PainterBudget,
	estimateImageCost,
	getPainterBudget,
	resetPainterBudgetSingleton,
} from "../../../src/services/image-providers/cost.js";

const COST_ENV = [
	"MAESTRO_PAINTER_MAX_COST_CENTS",
	"MAESTRO_PAINTER_PRICE_TABLE",
];

describe("cost: estimateImageCost", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of COST_ENV) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of COST_ENV) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("returns undefined when no price is configured", () => {
		expect(
			estimateImageCost({
				model: "gpt-image-2",
				size: "1024x1024",
				quality: "high",
			}),
		).toBeUndefined();
	});

	it("resolves an exact model/size/quality key", () => {
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|high": 8,
		});
		expect(
			estimateImageCost({
				model: "gpt-image-2",
				size: "1024x1024",
				quality: "high",
			}),
		).toBe(8);
	});

	it("multiplies by n", () => {
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|high": 8,
		});
		expect(
			estimateImageCost({
				model: "gpt-image-2",
				size: "1024x1024",
				quality: "high",
				n: 3,
			}),
		).toBe(24);
	});

	it("falls back to size wildcard, then quality wildcard, then model wildcard", () => {
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|*|high": 8,
			"gpt-image-2|*|*": 4,
		});
		expect(
			estimateImageCost({
				model: "gpt-image-2",
				size: "1792x1024",
				quality: "high",
			}),
		).toBe(8);
		expect(
			estimateImageCost({
				model: "gpt-image-2",
				size: "1792x1024",
				quality: "low",
			}),
		).toBe(4);
	});

	it("ignores non-numeric entries in the table", () => {
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|high": "free",
		});
		expect(
			estimateImageCost({
				model: "gpt-image-2",
				size: "1024x1024",
				quality: "high",
			}),
		).toBeUndefined();
	});

	it("ignores malformed JSON", () => {
		process.env.MAESTRO_PAINTER_PRICE_TABLE = "{not json";
		expect(
			estimateImageCost({
				model: "gpt-image-2",
				size: "1024x1024",
				quality: "high",
			}),
		).toBeUndefined();
	});
});

describe("cost: PainterBudget", () => {
	beforeEach(() => {
		for (const k of COST_ENV) delete process.env[k];
		resetPainterBudgetSingleton();
	});

	afterEach(() => {
		for (const k of COST_ENV) delete process.env[k];
		resetPainterBudgetSingleton();
	});

	it("does not enforce when no ceiling is configured", () => {
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|high": 8,
		});
		const budget = new PainterBudget();
		const d = budget.checkAndReserve({
			model: "gpt-image-2",
			size: "1024x1024",
			quality: "high",
		});
		expect(d.ok).toBe(true);
		expect(d.enforced).toBe(false);
	});

	it("fails open when a ceiling is set but prices are unknown", () => {
		process.env.MAESTRO_PAINTER_MAX_COST_CENTS = "100";
		const budget = new PainterBudget();
		const d = budget.checkAndReserve({
			model: "gpt-image-2",
			size: "1024x1024",
			quality: "high",
		});
		expect(d.ok).toBe(true);
		expect(d.enforced).toBe(false);
		expect(d.reason).toMatch(/no price configured/);
	});

	it("reserves and accumulates when under the ceiling", () => {
		process.env.MAESTRO_PAINTER_MAX_COST_CENTS = "100";
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|high": 30,
		});
		const budget = new PainterBudget();
		const first = budget.checkAndReserve({
			model: "gpt-image-2",
			size: "1024x1024",
			quality: "high",
			n: 2,
		});
		expect(first.ok).toBe(true);
		expect(first.enforced).toBe(true);
		expect(first.estimatedCents).toBe(60);
		expect(first.cumulativeCents).toBe(60);

		const second = budget.checkAndReserve({
			model: "gpt-image-2",
			size: "1024x1024",
			quality: "high",
		});
		expect(second.ok).toBe(true);
		expect(second.cumulativeCents).toBe(90);
	});

	it("rejects when the next call would exceed the ceiling", () => {
		process.env.MAESTRO_PAINTER_MAX_COST_CENTS = "50";
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|high": 30,
		});
		const budget = new PainterBudget();
		expect(
			budget.checkAndReserve({
				model: "gpt-image-2",
				size: "1024x1024",
				quality: "high",
			}).ok,
		).toBe(true); // 30 reserved
		const blocked = budget.checkAndReserve({
			model: "gpt-image-2",
			size: "1024x1024",
			quality: "high",
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.enforced).toBe(true);
		expect(blocked.reason).toMatch(/exceeded/);
		expect(blocked.cumulativeCents).toBe(30); // not reserved
	});

	it("reset() clears accumulated spend", () => {
		process.env.MAESTRO_PAINTER_MAX_COST_CENTS = "100";
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|high": 30,
		});
		const budget = new PainterBudget();
		budget.checkAndReserve({
			model: "gpt-image-2",
			size: "1024x1024",
			quality: "high",
		});
		expect(budget.cumulativeCents).toBe(30);
		budget.reset();
		expect(budget.cumulativeCents).toBe(0);
	});

	it("release() refunds reserved spend and clamps at zero", () => {
		process.env.MAESTRO_PAINTER_MAX_COST_CENTS = "100";
		process.env.MAESTRO_PAINTER_PRICE_TABLE = JSON.stringify({
			"gpt-image-2|1024x1024|high": 30,
		});
		const budget = new PainterBudget();
		budget.checkAndReserve({
			model: "gpt-image-2",
			size: "1024x1024",
			quality: "high",
		});
		expect(budget.cumulativeCents).toBe(30);
		budget.release(30); // refund a failed call
		expect(budget.cumulativeCents).toBe(0);
		budget.release(50); // cannot go negative / raise the ceiling
		expect(budget.cumulativeCents).toBe(0);
	});

	it("getPainterBudget returns a process singleton", () => {
		const a = getPainterBudget();
		const b = getPainterBudget();
		expect(a).toBe(b);
		resetPainterBudgetSingleton();
		const c = getPainterBudget();
		expect(c).not.toBe(a);
	});

	it("ignores a non-numeric ceiling value", () => {
		process.env.MAESTRO_PAINTER_MAX_COST_CENTS = "not-a-number";
		const budget = new PainterBudget();
		expect(budget.ceilingCents).toBeUndefined();
	});
});
