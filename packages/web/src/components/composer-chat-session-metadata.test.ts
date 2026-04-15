import { describe, expect, it, vi } from "vitest";
import { ComposerChat } from "./composer-chat.js";

type SessionMetadataInternals = {
	apiClient: {
		getSessions: ReturnType<typeof vi.fn>;
		updateSession: ReturnType<typeof vi.fn>;
	};
	sessions: Array<{
		id: string;
		title?: string;
		createdAt: string;
		updatedAt: string;
		messageCount: number;
		favorite?: boolean;
		tags?: string[];
	}>;
	showToast: ReturnType<typeof vi.fn>;
	updateSessionMetadata: (
		sessionId: string,
		updates: { favorite?: boolean; tags?: string[]; title?: string },
	) => Promise<void>;
};

describe("ComposerChat session metadata", () => {
	it("updates session metadata and refreshes the sidebar list", async () => {
		const updated = {
			id: "session-1",
			title: "Renamed session",
			createdAt: "2026-03-12T00:00:00.000Z",
			updatedAt: "2026-03-13T00:00:00.000Z",
			messageCount: 3,
			favorite: true,
			tags: ["release"],
		};
		const element = new ComposerChat() as unknown as SessionMetadataInternals;
		element.apiClient = {
			getSessions: vi.fn().mockResolvedValue([updated]),
			updateSession: vi.fn().mockResolvedValue(updated),
		};
		element.sessions = [
			{
				id: "session-1",
				title: "Old title",
				createdAt: "2026-03-12T00:00:00.000Z",
				updatedAt: "2026-03-12T12:00:00.000Z",
				messageCount: 3,
				favorite: false,
			},
		];
		element.showToast = vi.fn();

		await element.updateSessionMetadata("session-1", {
			title: "Renamed session",
			favorite: true,
			tags: ["release"],
		});

		expect(element.apiClient.updateSession).toHaveBeenCalledWith("session-1", {
			title: "Renamed session",
			favorite: true,
			tags: ["release"],
		});
		expect(element.apiClient.getSessions).toHaveBeenCalledOnce();
		expect(element.sessions).toEqual([updated]);
		expect(element.showToast).toHaveBeenCalledWith(
			"Session updated",
			"success",
			1500,
		);
	});
});
