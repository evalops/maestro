// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ComposerChat } from "../../packages/web/src/components/composer-chat.js";

type WorkspaceStatusLike = {
	database: {
		configured: boolean;
		connected: boolean;
	};
};

type AdminGatingInternals = {
	adminSettingsOpen: boolean;
	status: WorkspaceStatusLike | null;
	hasAdminSettingsAccess: () => boolean;
	toggleAdminSettings: () => void;
};

describe("composer-chat admin settings gating", () => {
	it("keeps admin settings closed when the database is unavailable", () => {
		const element = new ComposerChat() as unknown as AdminGatingInternals;
		element.status = {
			database: {
				configured: false,
				connected: false,
			},
		};

		element.toggleAdminSettings();

		expect(element.hasAdminSettingsAccess()).toBe(false);
		expect(element.adminSettingsOpen).toBe(false);
	});

	it("allows admin settings to open when the database is configured", () => {
		const element = new ComposerChat() as unknown as AdminGatingInternals;
		element.status = {
			database: {
				configured: true,
				connected: true,
			},
		};

		element.toggleAdminSettings();

		expect(element.hasAdminSettingsAccess()).toBe(true);
		expect(element.adminSettingsOpen).toBe(true);
	});
});
