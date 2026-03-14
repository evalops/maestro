import { fixture, html } from "@open-wc/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../services/api-client.js";
import type { Artifact } from "../services/artifacts.js";
import "./composer-artifacts-panel.js";
import type { ComposerArtifactsPanel } from "./composer-artifacts-panel.js";

describe("ComposerArtifactsPanel", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("prefetches auth-aware artifact urls through the shared api client", async () => {
		const resolveSessionArtifactViewUrl = vi
			.fn()
			.mockResolvedValue("blob:artifact-view");
		const resolveSessionArtifactDownloadUrl = vi
			.fn()
			.mockResolvedValue("blob:artifact-file");
		const resolveSessionArtifactsZipUrl = vi
			.fn()
			.mockResolvedValue("blob:artifact-zip");
		const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
		const apiClient = {
			baseUrl: "https://api.test",
			resolveSessionArtifactViewUrl,
			resolveSessionArtifactDownloadUrl,
			resolveSessionArtifactsZipUrl,
		} as unknown as ApiClient;
		const artifacts: Artifact[] = [
			{
				filename: "preview.html",
				content: "<p>Preview</p>",
				createdAt: 1,
				updatedAt: 1,
			},
		];

		const element = await fixture<ComposerArtifactsPanel>(
			html`<composer-artifacts-panel
				.artifacts=${artifacts}
				.activeFilename=${"preview.html"}
				.sessionId=${"session-1"}
				.apiClient=${apiClient}
			></composer-artifacts-panel>`,
		);

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		expect(resolveSessionArtifactViewUrl).toHaveBeenCalledWith(
			"session-1",
			"preview.html",
		);
		expect(resolveSessionArtifactDownloadUrl).toHaveBeenCalledWith(
			"session-1",
			"preview.html",
			{ standalone: true },
		);
		expect(resolveSessionArtifactsZipUrl).toHaveBeenCalledWith("session-1");

		const openButton = element.shadowRoot?.querySelector(
			'button[title="Open in new tab"]',
		) as HTMLButtonElement | null;
		expect(openButton).not.toBeNull();
		openButton?.click();

		expect(openSpy).toHaveBeenCalledWith(
			"blob:artifact-view",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("hides remote artifact actions when links cannot be resolved", async () => {
		const apiClient = {
			baseUrl: "https://api.test",
		} as unknown as ApiClient;
		const artifacts: Artifact[] = [
			{
				filename: "preview.html",
				content: "<p>Preview</p>",
				createdAt: 1,
				updatedAt: 1,
			},
		];

		const element = await fixture<ComposerArtifactsPanel>(
			html`<composer-artifacts-panel
				.artifacts=${artifacts}
				.activeFilename=${"preview.html"}
				.apiClient=${apiClient}
			></composer-artifacts-panel>`,
		);

		await element.updateComplete;

		expect(
			element.shadowRoot?.querySelector('button[title="Open in new tab"]'),
		).toBeNull();
		expect(
			element.shadowRoot?.querySelector('button[title="Download file"]'),
		).toBeNull();
		expect(
			element.shadowRoot?.querySelector(
				'button[title="Download standalone HTML"]',
			),
		).toBeNull();
		expect(
			element.shadowRoot?.querySelector(
				'button[title="Download artifacts zip"]',
			),
		).toBeNull();
	});
});
