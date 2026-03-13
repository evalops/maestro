import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
	getArtifactAccessGrantFromRequest,
	issueArtifactAccessGrant,
	redactArtifactAccessTokenInUrl,
} from "../../src/server/artifact-access.js";

function makeReq(
	url: string,
	headers?: Record<string, string>,
): IncomingMessage {
	return { url, headers } as IncomingMessage;
}

describe("artifact access grants", () => {
	it("accepts matching artifact viewer requests from headers", () => {
		const access = issueArtifactAccessGrant({
			sessionId: "session-1",
			scope: "scope-1",
			filename: "preview.html",
			actions: ["view", "file", "events", "zip"],
			now: 1_000,
			expiresInMs: 30_000,
		});

		expect(
			getArtifactAccessGrantFromRequest(
				makeReq("/api/sessions/session-1/artifacts/preview.html/view", {
					"x-composer-artifact-access": access.token,
				}),
				2_000,
			),
		).toMatchObject({
			sessionId: "session-1",
			scope: "scope-1",
			filename: "preview.html",
		});
	});

	it("rejects filename-scoped event requests without a matching filename filter", () => {
		const access = issueArtifactAccessGrant({
			sessionId: "session-1",
			filename: "preview.html",
			actions: ["events"],
			now: 1_000,
			expiresInMs: 30_000,
		});

		expect(
			getArtifactAccessGrantFromRequest(
				makeReq("/api/sessions/session-1/artifacts/events", {
					"x-composer-artifact-access": access.token,
				}),
				2_000,
			),
		).toBeNull();
		expect(
			getArtifactAccessGrantFromRequest(
				makeReq(
					"/api/sessions/session-1/artifacts/events?filename=other.html",
					{
						"x-composer-artifact-access": access.token,
					},
				),
				2_000,
			),
		).toBeNull();
		expect(
			getArtifactAccessGrantFromRequest(
				makeReq(
					"/api/sessions/session-1/artifacts/events?filename=preview.html",
					{
						"x-composer-artifact-access": access.token,
					},
				),
				2_000,
			),
		).not.toBeNull();
	});

	it("rejects artifact access tokens passed via query strings", () => {
		const access = issueArtifactAccessGrant({
			sessionId: "session-1",
			filename: "preview.html",
			actions: ["view"],
			now: 1_000,
			expiresInMs: 30_000,
		});

		expect(
			getArtifactAccessGrantFromRequest(
				makeReq(
					`/api/sessions/session-1/artifacts/preview.html/view?composerArtifactToken=${access.token}`,
				),
				2_000,
			),
		).toBeNull();
	});

	it("accepts artifact access grants from headers", () => {
		const access = issueArtifactAccessGrant({
			sessionId: "session-1",
			scope: "scope-1",
			filename: "preview.html",
			actions: ["view"],
			now: 1_000,
			expiresInMs: 30_000,
		});

		expect(
			getArtifactAccessGrantFromRequest(
				makeReq("/api/sessions/session-1/artifacts/preview.html/view", {
					"x-composer-artifact-access": access.token,
				}),
				2_000,
			),
		).toMatchObject({
			sessionId: "session-1",
			scope: "scope-1",
			filename: "preview.html",
		});
	});

	it("redacts artifact access tokens from logged urls", () => {
		expect(
			redactArtifactAccessTokenInUrl(
				"/api/sessions/session-1/artifacts.zip?download=1&composerArtifactToken=token-123",
			),
		).toBe(
			"/api/sessions/session-1/artifacts.zip?download=1&composerArtifactToken=[REDACTED]",
		);
	});
});
