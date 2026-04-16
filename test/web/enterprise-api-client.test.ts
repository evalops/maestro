import { afterEach, describe, expect, it, vi } from "vitest";

declare global {
	var window:
		| {
				location?: { origin?: string };
				sessionStorage?: {
					getItem(key: string): string | null;
					setItem(key: string, value: string): void;
					removeItem(key: string): void;
				};
		  }
		| undefined;
}

function makeSessionStorage() {
	const store = new Map<string, string>();
	return {
		getItem(key: string) {
			return store.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			store.set(key, value);
		},
		removeItem(key: string) {
			store.delete(key);
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("EnterpriseApiClient", () => {
	it("defaults to same-origin in hosted browser environments", async () => {
		vi.resetModules();
		vi.stubGlobal("window", {
			location: { origin: "https://maestro.evalops.dev" },
			sessionStorage: makeSessionStorage(),
		});
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: "user-1",
					email: "user@example.com",
					name: "User",
					isActive: true,
					organization: null,
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { EnterpriseApiClient } = await import(
			"../../packages/web/src/services/enterprise-api.js"
		);
		const client = new EnterpriseApiClient();

		await client.getMe();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://maestro.evalops.dev/api/auth/me",
			expect.objectContaining({
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
});
