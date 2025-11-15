import type { Response } from "undici";
import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareVersions } from "../src/update/check.js";

type ResponseFields = Pick<Response, "ok" | "status" | "statusText" | "json">;

const createResponse = (
	data: unknown,
	overrides: Partial<Pick<Response, "ok" | "status" | "statusText">> = {},
): ResponseFields => ({
	ok: overrides.ok ?? true,
	status: overrides.status ?? 200,
	statusText: overrides.statusText ?? "OK",
	json: async () => data,
});

describe("compareVersions", () => {
	it("orders numeric segments", () => {
		expect(compareVersions("0.8.0", "0.9.0")).toBe(-1);
		expect(compareVersions("0.9.0", "0.8.0")).toBe(1);
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
	});

	it("handles pre-release precedence", () => {
		expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
		expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
		expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
	});

	it("treats mixed identifiers as non-numeric", () => {
		expect(compareVersions("1.0.0-123", "1.0.0-123abc")).toBe(-1);
		expect(compareVersions("1.0.0-123abc", "1.0.0-123")).toBe(1);
	});
});

describe("checkForUpdate", () => {
	const url = "https://example.com/composer/version.json";
	const options = { url, timeoutMs: 0 } as const;

	it("detects when a newer version is available", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				createResponse({ version: "0.9.0", notes: "New release" }) as Response,
			);
		const result = await checkForUpdate("0.8.0", {
			...options,
			fetch: fetchMock,
		});
		expect(fetchMock).toHaveBeenCalledWith(url, expect.any(Object));
		expect(result.isUpdateAvailable).toBe(true);
		expect(result.latestVersion).toBe("0.9.0");
		expect(result.notes).toBe("New release");
		expect(result.error).toBeUndefined();
	});

	it("returns false when already on the latest version", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(createResponse({ version: "0.8.0" }) as Response);
		const result = await checkForUpdate("0.8.0", {
			...options,
			fetch: fetchMock,
		});
		expect(result.isUpdateAvailable).toBe(false);
		expect(result.error).toBeUndefined();
	});

	it("captures fetch errors", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
		const result = await checkForUpdate("0.8.0", {
			...options,
			fetch: fetchMock,
		});
		expect(result.isUpdateAvailable).toBe(false);
		expect(result.error).toContain("network down");
	});

	it("flags invalid payloads", async () => {
		const fetchMock = vi.fn().mockResolvedValue(createResponse({}) as Response);
		const result = await checkForUpdate("0.8.0", {
			...options,
			fetch: fetchMock,
		});
		expect(result.isUpdateAvailable).toBe(false);
		expect(result.error).toContain("missing version");
	});
});
