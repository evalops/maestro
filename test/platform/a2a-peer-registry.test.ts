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

	it("clears existing auth sources when re-pairing changes peer identity", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "victim-peer",
				peers: {
					"victim-peer": {
						url: "https://trusted.example",
						tokenEnv: "OLD_A2A_TOKEN",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Attacker Relay",
			agentCardUrl: "https://attacker.example/.well-known/agent-card.json",
			transportUrl: "https://attacker.example",
			peerId: "victim-peer",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"victim-peer": {
					url: "https://attacker.example",
				},
			},
		});
		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain("OLD_A2A_TOKEN");
	});

	it("retains auth sources when re-pairing adds metadata for the same minimal peer", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "stable-peer",
				peers: {
					"stable-peer": {
						url: "https://stable.example",
						tokenEnv: "STABLE_A2A_TOKEN",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Stable Relay",
			agentCardUrl: "https://stable.example/.well-known/agent-card.json",
			transportUrl: "https://stable.example",
			peerId: "stable-peer",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"stable-peer": {
					url: "https://stable.example",
					tokenEnv: "STABLE_A2A_TOKEN",
					displayName: "Stable Relay",
				},
			},
		});
	});

	it("retains auth sources when re-pairing only renames a peer", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "renamed-peer",
				peers: {
					"renamed-peer": {
						url: "https://stable.example/a2a",
						displayName: "Old Relay",
						tokenEnv: "STABLE_A2A_TOKEN",
						keyFingerprint: "sha256:stable-key",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Renamed Relay",
			agentCardUrl: "https://stable.example/a2a/.well-known/agent-card.json",
			transportUrl: "https://stable.example/a2a",
			peerId: "renamed-peer",
			keyFingerprint: "sha256:stable-key",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"renamed-peer": {
					url: "https://stable.example/a2a",
					displayName: "Renamed Relay",
					tokenEnv: "STABLE_A2A_TOKEN",
					keyFingerprint: "sha256:stable-key",
				},
			},
		});
	});

	it("retains auth sources when re-pairing a peer stored with a trailing slash URL", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "slash-peer",
				peers: {
					"slash-peer": {
						url: "https://stable.example/",
						tokenEnv: "STABLE_A2A_TOKEN",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Stable Relay",
			agentCardUrl: "https://stable.example/.well-known/agent-card.json",
			transportUrl: "https://stable.example",
			peerId: "slash-peer",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"slash-peer": {
					url: "https://stable.example",
					tokenEnv: "STABLE_A2A_TOKEN",
					displayName: "Stable Relay",
				},
			},
		});
	});

	it("retains auth sources when re-pairing a peer stored with a message send URL", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "send-peer",
				peers: {
					"send-peer": {
						url: "https://stable.example/a2a/message:send",
						tokenFile: "~/stable-a2a-token",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Stable Relay",
			agentCardUrl: "https://stable.example/a2a/.well-known/agent-card.json",
			transportUrl: "https://stable.example/a2a",
			peerId: "send-peer",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"send-peer": {
					url: "https://stable.example/a2a",
					tokenFile: "~/stable-a2a-token",
					displayName: "Stable Relay",
				},
			},
		});
	});

	it("retains auth sources when re-pairing a canonical peer with a message send URL", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "send-peer",
				peers: {
					"send-peer": {
						url: "https://stable.example/a2a",
						tokenEnv: "STABLE_A2A_TOKEN",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Stable Relay",
			agentCardUrl: "https://stable.example/a2a/.well-known/agent-card.json",
			transportUrl: "https://stable.example/a2a/message:send",
			peerId: "send-peer",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"send-peer": {
					url: "https://stable.example/a2a/message:send",
					tokenEnv: "STABLE_A2A_TOKEN",
					displayName: "Stable Relay",
				},
			},
		});
	});

	it("clears existing auth sources when a peer key fingerprint changes", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "signed-peer",
				peers: {
					"signed-peer": {
						url: "https://signed.example",
						tokenEnv: "SIGNED_A2A_TOKEN",
						keyFingerprint: "sha256:old-key",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Signed Relay",
			agentCardUrl: "https://signed.example/.well-known/agent-card.json",
			transportUrl: "https://signed.example",
			peerId: "signed-peer",
			keyFingerprint: "sha256:new-key",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"signed-peer": {
					url: "https://signed.example",
					keyFingerprint: "sha256:new-key",
				},
			},
		});
		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain("SIGNED_A2A_TOKEN");
	});

	it("clears existing auth sources when a peer key fingerprint is removed", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "unsigned-peer",
				peers: {
					"unsigned-peer": {
						url: "https://unsigned.example",
						tokenEnv: "SIGNED_A2A_TOKEN",
						keyFingerprint: "sha256:old-key",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Unsigned Relay",
			agentCardUrl: "https://unsigned.example/.well-known/agent-card.json",
			transportUrl: "https://unsigned.example",
			peerId: "unsigned-peer",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"unsigned-peer": {
					url: "https://unsigned.example",
				},
			},
		});
		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain("SIGNED_A2A_TOKEN");
		expect(raw).not.toContain("sha256:old-key");
	});

	it("retains auth sources when a peer key fingerprint is unchanged", async () => {
		const path = await registryPath();
		await writeFile(
			path,
			JSON.stringify({
				defaultPeer: "stable-signed-peer",
				peers: {
					"stable-signed-peer": {
						url: "https://stable-signed.example",
						tokenEnv: "STABLE_SIGNED_A2A_TOKEN",
						keyFingerprint: "sha256:stable-key",
					},
				},
			}),
		);

		const payload = createA2APeerPairingPayload({
			displayName: "Stable Signed Relay",
			agentCardUrl: "https://stable-signed.example/.well-known/agent-card.json",
			transportUrl: "https://stable-signed.example",
			peerId: "stable-signed-peer",
			keyFingerprint: "sha256:stable-key",
			now: NOW,
		});

		await upsertA2APeerFromPairingPayload(payload, { path });

		await expect(loadA2APeerRegistry({ path })).resolves.toMatchObject({
			peers: {
				"stable-signed-peer": {
					url: "https://stable-signed.example",
					tokenEnv: "STABLE_SIGNED_A2A_TOKEN",
					keyFingerprint: "sha256:stable-key",
				},
			},
		});
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
