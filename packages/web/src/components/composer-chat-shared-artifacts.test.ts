import { describe, expect, it, vi } from "vitest";
import { ComposerChat } from "./composer-chat.js";

type SharedArtifactInternals = {
	shareToken: string | null;
	currentSessionId: string | null;
	artifactsOpen: boolean;
	activeArtifact: string | null;
	messages: Array<Record<string, unknown>>;
	apiClient: {
		getSessionAttachmentContentBase64: ReturnType<typeof vi.fn>;
		getSharedSessionAttachmentContentBase64: ReturnType<typeof vi.fn>;
	};
	artifactsPanelAttachments: Array<Record<string, unknown>>;
	refreshArtifactsPanelAttachments: () => Promise<void>;
	toggleArtifactsPanel: () => void;
	setActiveArtifact: (filename: string) => void;
};

describe("ComposerChat shared artifacts", () => {
	it("allows shared sessions to open and select local artifacts", () => {
		const element = new ComposerChat() as unknown as SharedArtifactInternals;
		element.shareToken = "share-token";
		element.artifactsOpen = false;
		element.activeArtifact = null;

		element.toggleArtifactsPanel();
		element.setActiveArtifact("preview.html");

		expect(element.artifactsOpen).toBe(true);
		expect(element.activeArtifact).toBe("preview.html");
	});

	it("hydrates shared attachment content for artifact-backed previews", async () => {
		const element = new ComposerChat() as unknown as SharedArtifactInternals;
		element.shareToken = "share-token";
		element.currentSessionId = "session-1";
		element.apiClient = {
			getSessionAttachmentContentBase64: vi.fn(),
			getSharedSessionAttachmentContentBase64: vi
				.fn()
				.mockResolvedValue("PGgxPkhlbGxvPC9oMT4="),
		};
		element.messages = [
			{
				role: "user",
				attachments: [
					{
						id: "att-1",
						fileName: "snippet.html",
						mimeType: "text/html",
						size: 8,
						contentOmitted: true,
					},
				],
			},
		];

		await element.refreshArtifactsPanelAttachments();

		expect(
			element.apiClient.getSharedSessionAttachmentContentBase64,
		).toHaveBeenCalledWith("share-token", "att-1");
		expect(
			element.apiClient.getSessionAttachmentContentBase64,
		).not.toHaveBeenCalled();
		expect(element.artifactsPanelAttachments).toEqual([
			expect.objectContaining({
				id: "att-1",
				content: "PGgxPkhlbGxvPC9oMT4=",
				contentOmitted: undefined,
			}),
		]);
	});
});
