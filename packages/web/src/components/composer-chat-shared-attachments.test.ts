import { describe, expect, it, vi } from "vitest";
import { ComposerChat } from "./composer-chat.js";

type SharedAttachmentHydrationInternals = {
	apiClient: {
		getSessionAttachmentContentBase64: ReturnType<typeof vi.fn>;
		getSharedSessionAttachmentContentBase64: ReturnType<typeof vi.fn>;
	};
	hydrateAttachmentsForRequest: (
		attachments: Array<Record<string, unknown>>,
		options: { sessionId?: string | null; shareToken?: string | null },
	) => Promise<Array<Record<string, unknown>>>;
	attachmentContentCache: Map<string, string>;
	currentSessionId: string | null;
	shareToken: string | null;
};

describe("ComposerChat shared attachment hydration", () => {
	it("uses the shared attachment endpoint when a share token is present", async () => {
		const element =
			new ComposerChat() as unknown as SharedAttachmentHydrationInternals;
		element.apiClient = {
			getSessionAttachmentContentBase64: vi.fn(),
			getSharedSessionAttachmentContentBase64: vi
				.fn()
				.mockResolvedValue("AQID"),
		};
		element.attachmentContentCache = new Map();
		element.currentSessionId = "session-1";
		element.shareToken = "share-1";

		const [hydrated] = await element.hydrateAttachmentsForRequest(
			[
				{
					id: "att-1",
					fileName: "report.txt",
					mimeType: "text/plain",
					size: 3,
					contentOmitted: true,
				},
			],
			{ sessionId: "session-1", shareToken: "share-1" },
		);

		expect(
			element.apiClient.getSharedSessionAttachmentContentBase64,
		).toHaveBeenCalledWith("share-1", "att-1");
		expect(
			element.apiClient.getSessionAttachmentContentBase64,
		).not.toHaveBeenCalled();
		expect(hydrated).toMatchObject({
			id: "att-1",
			content: "AQID",
			contentOmitted: undefined,
		});
	});
});
