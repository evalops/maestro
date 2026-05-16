import { describe, expect, it } from "vitest";
import type { A2AAgentCard } from "../../src/platform/a2a-client.js";
import {
	a2aPeerConnectionFromPairingPayload,
	createA2APeerPairingPayload,
	createA2APeerPairingPayloadFromAgentCard,
	decodeA2APeerPairingCode,
	encodeA2APeerPairingCode,
	resolveA2AAgentCardUrl,
	selectA2AAgentInterface,
} from "../../src/platform/a2a-peer-pairing.js";

const NOW = new Date("2026-05-16T00:00:00.000Z");

function agentCard(): A2AAgentCard {
	return {
		name: "Mac mini Maestro",
		description: "Local Maestro A2A endpoint",
		supportedInterfaces: [
			{
				url: "http://mac-mini.tailnet.ts.net:18787",
				protocolBinding: "HTTP+JSON",
				protocolVersion: "1.0",
			},
		],
		version: "test",
		capabilities: {
			streaming: false,
			pushNotifications: false,
			extendedAgentCard: false,
		},
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [
			{
				id: "maestro-codex",
				name: "Maestro Codex",
				description: "Collaborate on code",
				tags: ["maestro", "codex", "a2a"],
			},
		],
	};
}

describe("A2A peer pairing codes", () => {
	it("round-trips a pairing payload without secrets", () => {
		const payload = createA2APeerPairingPayloadFromAgentCard({
			agentCard: agentCard(),
			agentCardUrl:
				"http://mac-mini.tailnet.ts.net:18787/.well-known/agent-card.json",
			peerId: "mac-mini",
			now: NOW,
		});

		const code = encodeA2APeerPairingCode(payload);
		expect(code).toMatch(/^maestro-pair-v1\.[^.]+\.[a-f0-9]{16}$/u);

		expect(decodeA2APeerPairingCode(code, { now: NOW })).toMatchObject({
			version: 1,
			displayName: "Mac mini Maestro",
			peerId: "mac-mini",
			agentCardUrl:
				"http://mac-mini.tailnet.ts.net:18787/.well-known/agent-card.json",
			transportUrl: "http://mac-mini.tailnet.ts.net:18787/",
			protocolBinding: "HTTP+JSON",
			protocolVersion: "1.0",
			skills: [
				{
					id: "maestro-codex",
					name: "Maestro Codex",
					tags: ["maestro", "codex", "a2a"],
				},
			],
		});
	});

	it("rejects tampered pairing codes", () => {
		const payload = createA2APeerPairingPayload({
			displayName: "Peer",
			agentCardUrl: "https://peer.test/.well-known/agent-card.json",
			transportUrl: "https://peer.test",
			now: NOW,
		});
		const code = encodeA2APeerPairingCode(payload);
		const tampered = `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;

		expect(() => decodeA2APeerPairingCode(tampered, { now: NOW })).toThrow(
			/checksum/u,
		);
	});

	it("rejects expired pairing codes unless explicitly allowed", () => {
		const payload = createA2APeerPairingPayload({
			displayName: "Peer",
			agentCardUrl: "https://peer.test/.well-known/agent-card.json",
			transportUrl: "https://peer.test",
			issuedAt: "2026-05-16T00:00:00.000Z",
			expiresAt: "2026-05-16T00:01:00.000Z",
			now: NOW,
		});
		const code = encodeA2APeerPairingCode(payload);

		expect(() =>
			decodeA2APeerPairingCode(code, {
				now: new Date("2026-05-16T00:02:00.000Z"),
			}),
		).toThrow(/expired/u);
		expect(
			decodeA2APeerPairingCode(code, {
				now: new Date("2026-05-16T00:02:00.000Z"),
				allowExpired: true,
			}).displayName,
		).toBe("Peer");
	});

	it("rejects secret-bearing payloads", () => {
		expect(() =>
			createA2APeerPairingPayload({
				displayName: "Peer",
				agentCardUrl: "https://peer.test/.well-known/agent-card.json",
				transportUrl: "https://peer.test",
				metadata: { apiToken: "do-not-share" },
				now: NOW,
			}),
		).toThrow(/secret field/u);
	});

	it("scrubs credential, query, and fragment parts from pairing URLs", () => {
		const payload = createA2APeerPairingPayload({
			displayName: "Peer",
			agentCardUrl:
				"https://user:pass@peer.test/.well-known/agent-card.json?token=secret#fragment",
			transportUrl: "https://user:pass@peer.test/a2a?api_key=secret#fragment",
			now: NOW,
		});

		expect(payload.agentCardUrl).toBe(
			"https://peer.test/.well-known/agent-card.json",
		);
		expect(payload.transportUrl).toBe("https://peer.test/a2a");
		const decodedJson = JSON.stringify(
			decodeA2APeerPairingCode(encodeA2APeerPairingCode(payload), {
				now: NOW,
			}),
		);
		expect(decodedJson).not.toMatch(/user|pass|secret|fragment/u);
	});

	it("allows local HTTP for LAN and Tailscale pairing", () => {
		expect(
			createA2APeerPairingPayload({
				displayName: "LAN Peer",
				agentCardUrl: "http://192.168.4.53:18787/.well-known/agent-card.json",
				transportUrl: "http://100.90.1.2:18787",
				now: NOW,
			}),
		).toMatchObject({
			displayName: "LAN Peer",
			transportUrl: "http://100.90.1.2:18787/",
		});
	});

	it("rejects public HTTP pairing URLs", () => {
		expect(() =>
			createA2APeerPairingPayload({
				displayName: "Public Peer",
				agentCardUrl: "http://example.com/.well-known/agent-card.json",
				transportUrl: "http://example.com",
				now: NOW,
			}),
		).toThrow(/must use https/u);
	});

	it("does not treat private-looking DNS names as local HTTP targets", () => {
		for (const host of ["10.evil.example", "192.168.attacker.example"]) {
			expect(() =>
				createA2APeerPairingPayload({
					displayName: "DNS Peer",
					agentCardUrl: `http://${host}/.well-known/agent-card.json`,
					transportUrl: `http://${host}`,
					now: NOW,
				}),
			).toThrow(/must use https/u);
		}
	});

	it("only treats private IPv6 literals as local HTTP targets", () => {
		expect(
			createA2APeerPairingPayload({
				displayName: "IPv6 Peer",
				agentCardUrl: "http://[fd00::1]:18787/.well-known/agent-card.json",
				transportUrl: "http://[fd00::1]:18787",
				now: NOW,
			}),
		).toMatchObject({
			transportUrl: "http://[fd00::1]:18787/",
		});

		expect(() =>
			createA2APeerPairingPayload({
				displayName: "DNS Peer",
				agentCardUrl: "http://fd.example.com/.well-known/agent-card.json",
				transportUrl: "http://fd.example.com",
				now: NOW,
			}),
		).toThrow(/must use https/u);
	});

	it("selects the HTTP+JSON A2A interface from an Agent Card", () => {
		const selected = selectA2AAgentInterface({
			...agentCard(),
			supportedInterfaces: [
				{
					url: "https://peer.test/jsonrpc",
					protocolBinding: "JSONRPC",
					protocolVersion: "1.0",
				},
				{
					url: "https://peer.test",
					protocolBinding: "HTTP+JSON",
					protocolVersion: "1.0",
				},
			],
		});

		expect(selected).toMatchObject({
			url: "https://peer.test/",
			protocolBinding: "HTTP+JSON",
		});
	});

	it("rejects Agent Cards without an HTTP+JSON interface", () => {
		expect(() =>
			selectA2AAgentInterface({
				...agentCard(),
				supportedInterfaces: [
					{
						url: "https://peer.test/jsonrpc",
						protocolBinding: "JSONRPC",
						protocolVersion: "1.0",
					},
				],
			}),
		).toThrow(/HTTP\+JSON/u);
	});

	it("derives a peer connection from an accepted payload", () => {
		const payload = createA2APeerPairingPayload({
			displayName: "Peer",
			agentCardUrl: "https://peer.test/.well-known/agent-card.json",
			transportUrl: "https://peer.test/",
			peerId: "peer",
			now: NOW,
		});

		expect(a2aPeerConnectionFromPairingPayload(payload)).toMatchObject({
			peerId: "peer",
			displayName: "Peer",
			baseUrl: "https://peer.test",
			agentCardUrl: "https://peer.test/.well-known/agent-card.json",
		});
	});

	it("resolves Agent Card URLs from a base URL", () => {
		expect(resolveA2AAgentCardUrl("https://peer.test/a2a")).toBe(
			"https://peer.test/a2a/.well-known/agent-card.json",
		);
		expect(resolveA2AAgentCardUrl("https://peer.test/a2a/message:send")).toBe(
			"https://peer.test/a2a/.well-known/agent-card.json",
		);
		expect(
			resolveA2AAgentCardUrl(
				"https://peer.test/.well-known/agent-card.json?ignored=1",
			),
		).toBe("https://peer.test/.well-known/agent-card.json");
	});
});
