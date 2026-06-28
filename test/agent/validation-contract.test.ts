import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ReaddirSync = typeof import("node:fs").readdirSync;
type ReaddirSyncArgs = Parameters<ReaddirSync>;
type ReaddirSyncResult = ReturnType<ReaddirSync>;

const fsMockState = vi.hoisted(() => ({
	originalReaddirSync: undefined as ReaddirSync | undefined,
	readdirSync: vi.fn<ReaddirSync>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMockState.originalReaddirSync = actual.readdirSync;
	return {
		...actual,
		readdirSync: (...args: ReaddirSyncArgs): ReaddirSyncResult =>
			fsMockState.readdirSync(...args),
	};
});

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Assertion,
	type ContractStorageConfig,
	type FeatureClaim,
	type ValidationContract,
	checkCoverage,
	createEmptyContract,
	getContractPaths,
	initializeContractState,
	listAssertionIds,
	listContractSlugs,
	loadContract,
	renderContractMarkdown,
	saveContract,
	setAssertionStatus,
} from "../../src/agent/validation-contract.js";

beforeEach(() => {
	fsMockState.readdirSync.mockImplementation((...args: ReaddirSyncArgs) =>
		fsMockState.originalReaddirSync!(...args),
	);
});

afterEach(() => {
	fsMockState.readdirSync.mockReset();
});

function makeAssertion(
	id: string,
	overrides: Partial<Assertion> = {},
): Assertion {
	return {
		id,
		description: `Assertion ${id}`,
		status: "pending",
		...overrides,
	};
}

function makeContract(): ValidationContract {
	return {
		version: 1,
		id: "checkout-flow",
		surface: "ui",
		title: "Checkout flow contract",
		areas: [
			{
				name: "cart",
				assertions: [makeAssertion("cart-1"), makeAssertion("cart-2")],
			},
			{
				name: "payment",
				assertions: [makeAssertion("payment-1")],
			},
		],
		crossAreaFlows: [
			{
				name: "happy path",
				assertions: [makeAssertion("flow-happy-1")],
			},
		],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("agent/validation-contract", () => {
	describe("listAssertionIds", () => {
		it("returns ids from areas and cross-area flows in document order", () => {
			expect(listAssertionIds(makeContract())).toEqual([
				"cart-1",
				"cart-2",
				"payment-1",
				"flow-happy-1",
			]);
		});

		it("returns an empty array on a fresh empty contract", () => {
			const empty = createEmptyContract({ id: "x", surface: "cli" });
			expect(listAssertionIds(empty)).toEqual([]);
		});
	});

	describe("checkCoverage", () => {
		it("returns ok when every assertion is claimed by exactly one feature", () => {
			const claims: FeatureClaim[] = [
				{ id: "feature-cart", fulfills: ["cart-1", "cart-2"] },
				{ id: "feature-payment", fulfills: ["payment-1"] },
				{ id: "feature-flow", fulfills: ["flow-happy-1"] },
			];
			const report = checkCoverage(makeContract(), claims);
			expect(report.ok).toBe(true);
			expect(report.orphans).toEqual([]);
			expect(report.duplicates).toEqual([]);
			expect(report.unknownAssertions).toEqual([]);
		});

		it("reports orphans (assertions with no claim)", () => {
			const claims: FeatureClaim[] = [
				{ id: "feature-cart", fulfills: ["cart-1"] },
			];
			const report = checkCoverage(makeContract(), claims);
			expect(report.ok).toBe(false);
			expect(report.orphans).toEqual(["cart-2", "flow-happy-1", "payment-1"]);
		});

		it("reports duplicates (assertions claimed by more than one feature)", () => {
			const claims: FeatureClaim[] = [
				{ id: "feature-a", fulfills: ["cart-1", "cart-2"] },
				{ id: "feature-b", fulfills: ["cart-1"] },
				{ id: "feature-c", fulfills: ["payment-1", "flow-happy-1"] },
			];
			const report = checkCoverage(makeContract(), claims);
			expect(report.ok).toBe(false);
			expect(report.duplicates).toEqual(["cart-1"]);
		});

		it("reports unknown assertion ids referenced by claims", () => {
			const claims: FeatureClaim[] = [
				{
					id: "feature-cart",
					fulfills: ["cart-1", "cart-2", "ghost-id"],
				},
				{ id: "feature-payment", fulfills: ["payment-1"] },
				{ id: "feature-flow", fulfills: ["flow-happy-1"] },
			];
			const report = checkCoverage(makeContract(), claims);
			expect(report.ok).toBe(false);
			expect(report.unknownAssertions).toEqual(["ghost-id"]);
		});

		it("treats claims with a missing fulfills list as empty instead of throwing", () => {
			const claims = [{ id: "feature-cart" }] as FeatureClaim[];
			const report = checkCoverage(makeContract(), claims);
			expect(report.ok).toBe(false);
			expect(report.orphans).toEqual([
				"cart-1",
				"cart-2",
				"flow-happy-1",
				"payment-1",
			]);
			expect(report.duplicates).toEqual([]);
			expect(report.unknownAssertions).toEqual([]);
		});

		it("reports all failure modes simultaneously when more than one applies", () => {
			const claims: FeatureClaim[] = [
				{ id: "f-a", fulfills: ["cart-1", "cart-1"] },
				{ id: "f-b", fulfills: ["ghost"] },
			];
			const report = checkCoverage(makeContract(), claims);
			expect(report.ok).toBe(false);
			expect(report.duplicates).toEqual(["cart-1"]);
			expect(report.orphans).toEqual(["cart-2", "flow-happy-1", "payment-1"]);
			expect(report.unknownAssertions).toEqual(["ghost"]);
		});

		it("rejects contracts that reuse an assertion id", () => {
			const contract: ValidationContract = {
				...makeContract(),
				areas: [
					{
						name: "cart",
						assertions: [
							makeAssertion("shared-id"),
							makeAssertion("shared-id"),
						],
					},
				],
				crossAreaFlows: [],
			};
			const claims: FeatureClaim[] = [
				{ id: "feature-cart", fulfills: ["shared-id"] },
			];

			const report = checkCoverage(contract, claims);
			expect(report.ok).toBe(false);
			expect(report.duplicates).toEqual(["shared-id"]);
			expect(report.orphans).toEqual([]);
			expect(report.unknownAssertions).toEqual([]);
		});
	});

	describe("setAssertionStatus", () => {
		it("updates the matching assertion and bumps updatedAt", () => {
			const before = makeContract();
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));

			try {
				const after = setAssertionStatus(before, "cart-1", "passed", {
					evidence: "test/cart.test.ts",
				});

				expect(after.updatedAt).toBe("2026-01-01T00:00:01.000Z");
				expect(after.updatedAt).not.toBe(before.updatedAt);
				const cart1 = after.areas[0].assertions.find((a) => a.id === "cart-1");
				expect(cart1?.status).toBe("passed");
				expect(cart1?.evidence).toBe("test/cart.test.ts");
				// Input is not mutated.
				expect(before.areas[0].assertions[0].status).toBe("pending");
			} finally {
				vi.useRealTimers();
			}
		});

		it("updates assertions inside cross-area flows", () => {
			const after = setAssertionStatus(
				makeContract(),
				"flow-happy-1",
				"failed",
				{ notes: "regression in 1.2.3" },
			);
			const flow1 = after.crossAreaFlows[0].assertions[0];
			expect(flow1.status).toBe("failed");
			expect(flow1.notes).toBe("regression in 1.2.3");
		});

		it("throws when the assertion id is not present", () => {
			expect(() =>
				setAssertionStatus(makeContract(), "missing", "passed"),
			).toThrow(/not found/);
		});
	});

	describe("initializeContractState", () => {
		it("resets every assertion to pending and clears evidence/notes", () => {
			const contract = setAssertionStatus(makeContract(), "cart-1", "passed", {
				evidence: "test/x.test.ts",
				notes: "ok",
			});
			const fresh = initializeContractState(contract);
			for (const id of listAssertionIds(fresh)) {
				const found =
					fresh.areas.flatMap((a) => a.assertions).find((a) => a.id === id) ??
					fresh.crossAreaFlows
						.flatMap((f) => f.assertions)
						.find((a) => a.id === id);
				expect(found?.status).toBe("pending");
				expect(found?.evidence).toBeUndefined();
				expect(found?.notes).toBeUndefined();
			}
		});
	});

	describe("renderContractMarkdown", () => {
		it("renders areas, cross-area flows, and a status summary", () => {
			const passed = setAssertionStatus(makeContract(), "cart-1", "passed");
			const md = renderContractMarkdown(passed);

			expect(md).toContain("# Checkout flow contract");
			expect(md).toContain("**Surface:** `ui`");
			expect(md).toContain("**Contract id:** `checkout-flow`");
			expect(md).toContain("## Coverage status");
			expect(md).toContain("passed: 1");
			expect(md).toContain("## Area: cart");
			expect(md).toContain("## Cross-area flows");
			expect(md).toContain("[x] `cart-1`");
		});

		it("falls back to the contract id when no title is present", () => {
			const stripped: ValidationContract = {
				...makeContract(),
				title: undefined,
			};
			const md = renderContractMarkdown(stripped);
			expect(md).toContain("# checkout-flow");
		});
	});

	describe("storage round-trip", () => {
		let testRoot: string;
		let config: ContractStorageConfig;

		beforeEach(() => {
			testRoot = join(
				tmpdir(),
				`validation-contract-test-${Date.now()}-${Math.random()}`,
			);
			mkdirSync(testRoot, { recursive: true });
			config = { contractsDir: join(testRoot, "contracts") };
		});

		afterEach(() => {
			if (existsSync(testRoot)) {
				rmSync(testRoot, { recursive: true, force: true });
			}
		});

		it("saves both JSON and markdown and round-trips through loadContract", () => {
			const contract = makeContract();
			const { jsonPath, markdownPath } = saveContract(
				"checkout",
				contract,
				config,
			);

			expect(existsSync(jsonPath)).toBe(true);
			expect(existsSync(markdownPath)).toBe(true);

			const loaded = loadContract("checkout", config);
			expect(loaded?.id).toBe(contract.id);
			expect(loaded?.areas[0].name).toBe("cart");
			expect(loaded?.areas[0].assertions).toHaveLength(2);

			const md = readFileSync(markdownPath, "utf-8");
			expect(md).toContain("# Checkout flow contract");
		});

		it("returns null when loading a slug with no contract written", () => {
			expect(loadContract("never-saved", config)).toBeNull();
		});

		it("rejects slugs that would escape the contracts directory", () => {
			expect(() => saveContract("../escape", makeContract(), config)).toThrow(
				/unsafe contract slug/,
			);
			expect(() => getContractPaths("../escape", config)).toThrow(
				/unsafe contract slug/,
			);
		});

		it("rejects symlinked slugs that resolve outside the contracts directory", () => {
			mkdirSync(config.contractsDir, { recursive: true });
			const outsideDir = join(testRoot, "outside-contract");
			const symlinkDir = join(config.contractsDir, "escape-link");
			mkdirSync(outsideDir, { recursive: true });
			symlinkSync(outsideDir, symlinkDir, "dir");
			writeFileSync(
				join(outsideDir, "contract.json"),
				`${JSON.stringify(makeContract(), null, 2)}\n`,
			);

			expect(() => saveContract("escape-link", makeContract(), config)).toThrow(
				/unsafe contract slug/,
			);
			expect(() => loadContract("escape-link", config)).toThrow(
				/unsafe contract slug/,
			);
			expect(() => getContractPaths("escape-link", config)).toThrow(
				/unsafe contract slug/,
			);
		});

		it("lists slugs that have a contract.json on disk", () => {
			saveContract("checkout", makeContract(), config);
			saveContract("returns", makeContract(), config);
			mkdirSync(join(config.contractsDir, "empty-dir"));

			expect(listContractSlugs(config)).toEqual(["checkout", "returns"]);
		});

		it("skips directory entries whose resolved slug escapes the contracts directory", () => {
			mkdirSync(config.contractsDir, { recursive: true });
			saveContract("checkout", makeContract(), config);
			const outsideDir = join(testRoot, "outside-contract");
			const symlinkDir = join(config.contractsDir, "escape-link");
			mkdirSync(outsideDir, { recursive: true });
			symlinkSync(outsideDir, symlinkDir, "dir");
			writeFileSync(
				join(outsideDir, "contract.json"),
				`${JSON.stringify(makeContract(), null, 2)}\n`,
			);
			fsMockState.readdirSync.mockReturnValue([
				{ name: "checkout", isDirectory: () => true },
				{ name: "escape-link", isDirectory: () => true },
			] as ReturnType<typeof fsMockState.originalReaddirSync>);

			expect(listContractSlugs(config)).toEqual(["checkout"]);
		});

		it("returns an empty list when the contracts directory does not exist", () => {
			expect(listContractSlugs(config)).toEqual([]);
		});
	});
});
