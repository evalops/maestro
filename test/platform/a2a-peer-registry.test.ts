import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createA2APeerPairingPayload } from "../../src/platform/a2a-peer-pairing.js";
import {
	listA2APeers,
	loadA2APeerRegistry,
	resolveA2APeer,
	resolvePeerToken,
	upsertA2APeerFromPairingPayload,
} from "../../src/platform/a2a-peer-registry.js";

const NOW = new Date("2026-05-16T00:00:00.000Z");

async function registryPath(): Promise<string> {
	return join(
		await mkdtemp(join(tmpdir(), "maestro-a2a-registry-")),
		"peers.json",
	);
}

describe("A2A peer registry", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("accepts a pairing payload into the native registry", async () => {
		const path = await registryPath();
		const payload = createA2APeerPairingPayload({
			displayName: "Mac mini Maestro",
			agentCardUrl: "http://mac-mini.ts.net:18787/.well-known/agent-card.json",
			transportUrl: "http://mac-mini.ts.net:18787",
			peerId: "mac-mini",
			skills: [
				{
					id: "maestro.subagent.code-review",
					name: "Maestro code review subagent",
					description: "Review a delegated patch safely",
					tags: ["maestro", "review"],
					requiredContextGrants: ["repo:read"],
					approvalPolicyRef: "target-maestro-policy",
					maxAutonomy: "bounded",
					requiredArtifactKinds: ["review.summary"],
					allowedTaskClasses: ["code.review"],
					deniedTaskClasses: ["secret.exfiltration"],
					attributes: {
						subagentLaneId: "code-review",
					},
					metadata: {
						requestMetadataPath: "evalops.subagentRequest",
					},
				},
			],
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, {
			path,
			makeDefault: true,
			tokenEnv: "MAC_MINI_A2A_TOKEN",
			now: NOW,
		});

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			defaultPeer: "mac-mini",
			peers: {
				"mac-mini": {
					url: "http://mac-mini.ts.net:18787",
					displayName: "Mac mini Maestro",
					agentCardUrl:
						"http://mac-mini.ts.net:18787/.well-known/agent-card.json",
					tokenEnv: "MAC_MINI_A2A_TOKEN",
					skills: [
						{
							id: "maestro.subagent.code-review",
							name: "Maestro code review subagent",
							description: "Review a delegated patch safely",
							tags: ["maestro", "review"],
							requiredContextGrants: ["repo:read"],
							approvalPolicyRef: "target-maestro-policy",
							maxAutonomy: "bounded",
							requiredArtifactKinds: ["review.summary"],
							allowedTaskClasses: ["code.review"],
							deniedTaskClasses: ["secret.exfiltration"],
							attributes: {
								subagentLaneId: "code-review",
							},
							metadata: {
								requestMetadataPath: "evalops.subagentRequest",
							},
						},
					],
					createdAt: NOW.toISOString(),
					updatedAt: NOW.toISOString(),
				},
			},
		});
	});

	it("resolves peer configs without printing or storing token values", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "dev-desktop",
				peers: {
					"dev-desktop": {
						url: "http://100.90.1.2:18787",
						tokenEnv: "DEV_DESKTOP_A2A_TOKEN",
						workspaceId: "ws_peer",
					},
				},
			}),
		);
		vi.stubEnv("DEV_DESKTOP_A2A_TOKEN", "secret-token");

		await expect(resolveA2APeer(undefined, { path })).resolves.toMatchObject({
			name: "dev-desktop",
			config: {
				baseUrl: "http://100.90.1.2:18787",
				token: "secret-token",
				workspaceId: "ws_peer",
			},
		});
		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain("secret-token");
	});

	it("normalizes legacy send endpoint URLs when resolving peer configs", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "legacy-relay",
				peers: {
					"legacy-relay": {
						url: "http://100.90.1.2:18787/a2a/message:send",
						workspaceId: "ws_peer",
					},
				},
			}),
		);

		await expect(resolveA2APeer(undefined, { path })).resolves.toMatchObject({
			config: {
				baseUrl: "http://100.90.1.2:18787/a2a",
				workspaceId: "ws_peer",
			},
		});
	});

	it("resolves token files when explicitly configured", async () => {
		const path = await registryPath();
		const tokenFile = join(
			await mkdtemp(join(tmpdir(), "maestro-token-")),
			"token",
		);
		await writeFile(tokenFile, "file-token\n");

		await expect(resolvePeerToken({ tokenFile })).resolves.toBe("file-token");
		await expect(
			listA2APeers({
				path,
			}),
		).resolves.toMatchObject({
			registry: { peers: {} },
		});
	});

	it("falls back to token files when a configured token env var is empty", async () => {
		const tokenFile = join(
			await mkdtemp(join(tmpdir(), "maestro-token-fallback-")),
			"token",
		);
		await writeFile(tokenFile, "file-token\n");
		vi.stubEnv("EMPTY_A2A_TOKEN", "");

		await expect(
			resolvePeerToken({ tokenEnv: "EMPTY_A2A_TOKEN", tokenFile }),
		).resolves.toBe("file-token");
	});

	it("clears stale alternate auth fields when re-accepting an existing peer", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "mac-mini",
				peers: {
					"mac-mini": {
						url: "http://mac-mini.ts.net:18787",
						tokenEnv: "OLD_A2A_TOKEN",
					},
				},
			}),
		);
		const tokenFile = join(
			await mkdtemp(join(tmpdir(), "maestro-token-reaccept-")),
			"token",
		);
		const payload = createA2APeerPairingPayload({
			displayName: "Mac mini Maestro",
			agentCardUrl: "http://mac-mini.ts.net:18787/.well-known/agent-card.json",
			transportUrl: "http://mac-mini.ts.net:18787",
			peerId: "mac-mini",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path, tokenFile });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"mac-mini": {
					tokenFile,
				},
			},
		});
		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain("OLD_A2A_TOKEN");
	});
});
