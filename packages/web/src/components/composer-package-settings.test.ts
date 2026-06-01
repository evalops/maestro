import { fixture, html } from "@open-wc/testing";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../services/api-client.js";
import "./composer-package-settings.js";
import type { ComposerPackageSettings } from "./composer-package-settings.js";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

describe("ComposerPackageSettings", () => {
	function createDeferred<T>(): Deferred<T> {
		let resolve: Deferred<T>["resolve"] | null = null;
		let reject: Deferred<T>["reject"] | null = null;
		const promise = new Promise<T>((promiseResolve, promiseReject) => {
			resolve = promiseResolve;
			reject = promiseReject;
		});

		if (!resolve || !reject) {
			throw new Error("Failed to create deferred promise");
		}

		return { promise, resolve, reject };
	}

	function createApiClient() {
		const getPackageStatus = vi.fn().mockResolvedValue({ packages: [] });
		const searchPackages = vi.fn().mockResolvedValue({
			query: "",
			entries: [],
		});
		const apiClient = {
			getPackageStatus,
			searchPackages,
		} as unknown as ApiClient;

		return { apiClient, getPackageStatus, searchPackages };
	}

	it("loads package data when apiClient is initially bound", async () => {
		const { apiClient, getPackageStatus, searchPackages } = createApiClient();

		const element = await fixture<ComposerPackageSettings>(
			html`<composer-package-settings
				.apiClient=${apiClient}
			></composer-package-settings>`,
		);

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		expect(getPackageStatus).toHaveBeenCalledOnce();
		expect(searchPackages).toHaveBeenCalledWith("");
	});

	it("loads package data when apiClient is assigned after connection", async () => {
		const { apiClient, getPackageStatus, searchPackages } = createApiClient();

		const element = await fixture<ComposerPackageSettings>(
			html`<composer-package-settings></composer-package-settings>`,
		);

		await element.updateComplete;
		expect(getPackageStatus).not.toHaveBeenCalled();
		expect(searchPackages).not.toHaveBeenCalled();

		element.apiClient = apiClient;

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		expect(getPackageStatus).toHaveBeenCalledOnce();
		expect(searchPackages).toHaveBeenCalledWith("");
	});

	it("keeps newer package search results when the initial load settles later", async () => {
		const initialSearch = createDeferred<{
			query: string;
			entries: Array<{
				name: string;
				version: string;
				keywords: string[];
				links: Record<string, string>;
				installSource: string;
			}>;
		}>();
		const getPackageStatus = vi.fn().mockResolvedValue({ packages: [] });
		const searchPackages = vi
			.fn()
			.mockReturnValueOnce(initialSearch.promise)
			.mockResolvedValueOnce({
				query: "memory",
				entries: [
					{
						name: "maestro-memory-package",
						version: "1.0.0",
						keywords: ["maestro-package"],
						links: {},
						installSource: "npm:maestro-memory-package",
					},
				],
			});
		const apiClient = {
			getPackageStatus,
			searchPackages,
		} as unknown as ApiClient;

		const element = await fixture<ComposerPackageSettings>(
			html`<composer-package-settings
				.apiClient=${apiClient}
			></composer-package-settings>`,
		);

		await element.updateComplete;
		expect(searchPackages).toHaveBeenCalledWith("");

		const input = element.querySelector<HTMLInputElement>(
			'input[aria-label="Package search"]',
		);
		const searchButton = element.querySelector<HTMLButtonElement>(
			".package-search-button",
		);
		expect(input).toBeTruthy();
		expect(searchButton).toBeTruthy();

		input!.value = "memory";
		input!.dispatchEvent(new Event("input", { bubbles: true }));
		searchButton!.click();

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		expect(searchPackages).toHaveBeenLastCalledWith("memory");
		expect(element.textContent).toContain("maestro-memory-package");

		initialSearch.resolve({
			query: "",
			entries: [
				{
					name: "initial-package",
					version: "0.1.0",
					keywords: ["maestro-package"],
					links: {},
					installSource: "npm:initial-package",
				},
			],
		});

		await Promise.resolve();
		await element.updateComplete;

		expect(element.textContent).toContain("maestro-memory-package");
		expect(element.textContent).not.toContain("initial-package");
	});

	it("clears manual search loading when a client change supersedes it", async () => {
		const manualSearch = createDeferred<{ query: string; entries: [] }>();
		const firstClient = {
			getPackageStatus: vi.fn().mockResolvedValue({ packages: [] }),
			searchPackages: vi
				.fn()
				.mockResolvedValueOnce({ query: "", entries: [] })
				.mockReturnValueOnce(manualSearch.promise),
		} as unknown as ApiClient;
		const secondClient = createApiClient().apiClient;

		const element = await fixture<ComposerPackageSettings>(
			html`<composer-package-settings
				.apiClient=${firstClient}
			></composer-package-settings>`,
		);

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		const input = element.querySelector<HTMLInputElement>(
			'input[aria-label="Package search"]',
		);
		const searchButton = element.querySelector<HTMLButtonElement>(
			".package-search-button",
		);
		expect(input).toBeTruthy();
		expect(searchButton).toBeTruthy();

		input!.value = "memory";
		input!.dispatchEvent(new Event("input", { bubbles: true }));
		searchButton!.click();

		await element.updateComplete;
		expect(searchButton!.disabled).toBe(true);

		element.apiClient = secondClient;

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		expect(searchButton!.disabled).toBe(false);
	});
});
