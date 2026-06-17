import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({
	lookupMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
	lookup: lookupMock,
}));

import { extractDocumentTool } from "../../src/tools/extract-document.js";
import * as pinnedFetch from "../../src/utils/fetch-with-pinned-address.js";

describe("extract_document tool", () => {
	beforeEach(() => {
		lookupMock.mockReset();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("blocks direct metadata and private network URLs before fetch", async () => {
		const fetchSpy = vi.spyOn(pinnedFetch, "fetchWithPinnedAddress");

		await expect(
			extractDocumentTool.execute("extract-1", {
				url: "http://169.254.169.254/latest/meta-data/",
			}),
		).rejects.toThrow(/private or local address/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("blocks IPv6 literals that embed private IPv4 addresses before fetch", async () => {
		const fetchSpy = vi.spyOn(pinnedFetch, "fetchWithPinnedAddress");

		await expect(
			extractDocumentTool.execute("extract-ipv6-compatible", {
				url: "http://[::127.0.0.1]/report.txt",
			}),
		).rejects.toThrow(/private or local address/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("blocks unspecified IPv6 literals before fetch", async () => {
		const fetchSpy = vi.spyOn(pinnedFetch, "fetchWithPinnedAddress");

		await expect(
			extractDocumentTool.execute("extract-ipv6-unspecified", {
				url: "http://[::0:0]/report.txt",
			}),
		).rejects.toThrow(/private or local address/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("blocks DNS answers with expanded IPv4-mapped IPv6 addresses", async () => {
		lookupMock.mockResolvedValueOnce([
			{ address: "0:0:0:0:0:ffff:169.254.169.254", family: 6 },
		]);
		const fetchSpy = vi.spyOn(pinnedFetch, "fetchWithPinnedAddress");

		await expect(
			extractDocumentTool.execute("extract-ipv6-mapped-dns", {
				url: "https://example.com/report.txt",
			}),
		).rejects.toThrow(/private or local address/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("blocks redirects to metadata and private network URLs", async () => {
		const fetchSpy = vi
			.spyOn(pinnedFetch, "fetchWithPinnedAddress")
			.mockResolvedValueOnce(
				new Response("redirecting", {
					status: 302,
					headers: { location: "http://169.254.169.254/latest/meta-data/" },
				}),
			);

		await expect(
			extractDocumentTool.execute("extract-2", {
				url: "http://93.184.216.34/report.txt",
			}),
		).rejects.toThrow(/private or local address/i);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("stops at the redirect limit before applying one more location", async () => {
		lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		const fetchSpy = vi.spyOn(pinnedFetch, "fetchWithPinnedAddress");
		for (let i = 0; i < 5; i += 1) {
			fetchSpy.mockResolvedValueOnce(
				new Response("redirecting", {
					status: 302,
					headers: { location: `https://example.com/redirect-${i + 1}` },
				}),
			);
		}
		fetchSpy.mockResolvedValueOnce(
			new Response("redirecting", {
				status: 302,
				headers: { location: "https://%" },
			}),
		);

		await expect(
			extractDocumentTool.execute("extract-redirect-limit", {
				url: "https://example.com/report.txt",
			}),
		).rejects.toThrow("Document URL redirected more than 5 times");
		expect(fetchSpy).toHaveBeenCalledTimes(6);
	});

	it("passes validated DNS answers to the pinned fetch transport", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
		const fetchSpy = vi
			.spyOn(pinnedFetch, "fetchWithPinnedAddress")
			.mockResolvedValueOnce(
				new Response("hello from document", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
			);

		await extractDocumentTool.execute("extract-dns", {
			url: "https://example.com/report.txt",
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://example.com/report.txt",
			expect.objectContaining({
				redirect: "manual",
			}),
			expect.objectContaining({
				originalHost: "example.com",
				resolvedAddress: "93.184.216.34",
				resolvedAddresses: ["93.184.216.34"],
			}),
		);
	});

	it("stops waiting for DNS lookup when the tool signal aborts", async () => {
		lookupMock.mockReturnValueOnce(new Promise(() => undefined));
		const fetchSpy = vi.spyOn(pinnedFetch, "fetchWithPinnedAddress");
		const controller = new AbortController();
		const promise = extractDocumentTool.execute(
			"extract-abort",
			{ url: "https://example.com/report.txt" },
			controller.signal,
		);

		controller.abort();

		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects when DNS lookup finishes after the signal aborts", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
		const fetchSpy = vi
			.spyOn(pinnedFetch, "fetchWithPinnedAddress")
			.mockResolvedValueOnce(
				new Response("hello from document", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
			);
		const signal = {
			aborted: false,
			addEventListener() {
				this.aborted = true;
			},
			removeEventListener() {},
		} as unknown as AbortSignal;

		await expect(
			extractDocumentTool.execute(
				"extract-abort-race",
				{ url: "https://example.com/report.txt" },
				signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("normalizes untrusted content types before extraction", async () => {
		vi.spyOn(pinnedFetch, "fetchWithPinnedAddress").mockResolvedValueOnce(
			new Response("hello from document", {
				status: 200,
				headers: {
					"content-disposition": 'attachment; filename="notes.txt"',
					"content-type": "application/x-attacker; --mime-type=text/html",
				},
			}),
		);

		const result = await extractDocumentTool.execute("extract-3", {
			url: "http://93.184.216.34/download",
		});

		expect(result.content?.[0]).toEqual({
			type: "text",
			text: "hello from document",
		});
		expect(result.details?.mimeType).toBeUndefined();
		expect(result.details?.fileName).toBe("notes.txt");
	});
});
