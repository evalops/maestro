/**
 * Daemon IPC capability negotiator
 *
 * Builds on the IPC envelope (part 1 of #2658, merged as #2683). Pure
 * helper that resolves a `hello` handshake into a coherent
 * `IpcWelcomeResult`:
 *
 *   - `protocolVersion` collapses to the highest version both sides
 *     understand (i.e. `min(clientVersion, daemonVersion)` capped at
 *     the daemon's supported range).
 *   - `methods` / `channels` are the intersection of what the client
 *     asked for and what the daemon advertises. Channels the client
 *     didn't ask for are not subscribed even if the daemon supports
 *     them — saves bandwidth on push-heavy clients.
 *   - When the negotiation cannot succeed (no overlapping protocol),
 *     the helper returns a structured failure so the daemon can send
 *     a clean error response instead of a half-formed welcome.
 *
 * Pure function. No I/O.
 */

import type { IpcHelloParams, IpcWelcomeResult } from "./ipc-envelope.js";

/**
 * What the daemon advertises during negotiation.
 */
export interface DaemonCapabilities {
	/** Highest protocol version this daemon supports. */
	maxProtocolVersion: number;
	/** Lowest protocol version this daemon still accepts. */
	minProtocolVersion: number;
	/** Identifier reported back to the client (semver + commit). */
	daemonBuild: string;
	/** RPC method names this daemon will dispatch. */
	methods: readonly string[];
	/** Event channels the daemon can publish on. */
	channels: readonly string[];
}

export type NegotiateCapabilitiesResult =
	| { ok: true; welcome: IpcWelcomeResult }
	| { ok: false; code: NegotiationFailureCode; message: string };

export type NegotiationFailureCode =
	| "protocol-too-old"
	| "protocol-too-new"
	| "bad-hello";

/**
 * Resolve a client `hello` against the daemon's advertised
 * capabilities. Returns a discriminated result so the caller can map
 * failure straight onto an `IpcErrorResponse`.
 */
export function negotiateCapabilities(
	hello: IpcHelloParams,
	daemon: DaemonCapabilities,
): NegotiateCapabilitiesResult {
	if (!isValidHello(hello)) {
		return {
			ok: false,
			code: "bad-hello",
			message: "hello params missing required fields",
		};
	}
	if (!isValidDaemonCapabilities(daemon)) {
		return {
			ok: false,
			code: "bad-hello",
			message: "daemon capabilities are inconsistent",
		};
	}
	if (hello.protocolVersion < daemon.minProtocolVersion) {
		return {
			ok: false,
			code: "protocol-too-old",
			message: `client speaks v${hello.protocolVersion}; daemon requires v${daemon.minProtocolVersion}+`,
		};
	}
	const agreedVersion = Math.min(
		hello.protocolVersion,
		daemon.maxProtocolVersion,
	);
	if (agreedVersion < daemon.minProtocolVersion) {
		return {
			ok: false,
			code: "protocol-too-new",
			message: `daemon cannot fall back below v${daemon.minProtocolVersion}`,
		};
	}
	const channelsRequested = hello.channels ?? [];
	const daemonChannels = new Set(daemon.channels);
	const grantedChannels = uniqueInOrder(
		channelsRequested.filter((c) => daemonChannels.has(c)),
	);
	const methods = uniqueInOrder([...daemon.methods]);
	return {
		ok: true,
		welcome: {
			protocolVersion: agreedVersion,
			daemonBuild: daemon.daemonBuild,
			methods,
			channels: grantedChannels,
		},
	};
}

/**
 * Convenience: list channels the client asked for that the daemon
 * rejected. Useful so the daemon can log "client x asked for unknown
 * channel y" without re-deriving the diff.
 */
export function rejectedChannels(
	hello: IpcHelloParams,
	daemon: DaemonCapabilities,
): string[] {
	const requested = hello.channels ?? [];
	const known = new Set(daemon.channels);
	return uniqueInOrder(requested.filter((c) => !known.has(c)));
}

function isValidHello(hello: IpcHelloParams): boolean {
	if (typeof hello.protocolVersion !== "number") return false;
	if (!Number.isInteger(hello.protocolVersion)) return false;
	if (hello.protocolVersion < 1) return false;
	if (typeof hello.client !== "string" || hello.client.trim() === "") {
		return false;
	}
	if (hello.channels !== undefined) {
		if (!Array.isArray(hello.channels)) return false;
		for (const c of hello.channels) {
			if (typeof c !== "string") return false;
		}
	}
	return true;
}

function isValidDaemonCapabilities(d: DaemonCapabilities): boolean {
	if (!Number.isInteger(d.maxProtocolVersion)) return false;
	if (!Number.isInteger(d.minProtocolVersion)) return false;
	if (d.minProtocolVersion < 1) return false;
	if (d.maxProtocolVersion < d.minProtocolVersion) return false;
	if (typeof d.daemonBuild !== "string" || d.daemonBuild.trim() === "") {
		return false;
	}
	if (!Array.isArray(d.methods)) return false;
	for (const method of d.methods) {
		if (typeof method !== "string") return false;
	}
	if (!Array.isArray(d.channels)) return false;
	for (const channel of d.channels) {
		if (typeof channel !== "string") return false;
	}
	return true;
}

function uniqueInOrder(items: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}
