import { describe, expect, it } from "vitest";
import type {
	DaemonCapabilities,
	NegotiateCapabilitiesResult,
} from "../../src/agent/ipc-capability-negotiate.js";
import {
	negotiateCapabilities,
	rejectedChannels,
} from "../../src/agent/ipc-capability-negotiate.js";
import type { IpcHelloParams } from "../../src/agent/ipc-envelope.js";

const daemon: DaemonCapabilities = {
	minProtocolVersion: 1,
	maxProtocolVersion: 2,
	daemonBuild: "1.2.3+abc",
	methods: ["mission.list", "mission.create"],
	channels: ["mission.updated", "log"],
};

function hello(overrides: Partial<IpcHelloParams> = {}): IpcHelloParams {
	return {
		protocolVersion: 2,
		client: "tui",
		channels: ["mission.updated"],
		...overrides,
	};
}

function expectOk(
	result: NegotiateCapabilitiesResult,
): Extract<NegotiateCapabilitiesResult, { ok: true }> {
	if (!result.ok) {
		throw new Error(
			`expected negotiation success, got ${result.code}: ${result.message}`,
		);
	}
	return result;
}

function expectErr(
	result: NegotiateCapabilitiesResult,
): Extract<NegotiateCapabilitiesResult, { ok: false }> {
	if (result.ok) {
		throw new Error("expected negotiation failure, got success");
	}
	return result;
}

describe("agent/ipc-capability-negotiate", () => {
	describe("negotiateCapabilities", () => {
		it("agrees on the lower of client and daemon protocol versions", () => {
			const result = expectOk(
				negotiateCapabilities(hello({ protocolVersion: 1 }), daemon),
			);
			expect(result.welcome.protocolVersion).toBe(1);
		});

		it("caps the agreed protocol at the daemon's max even if the client speaks newer", () => {
			const result = expectOk(
				negotiateCapabilities(hello({ protocolVersion: 5 }), daemon),
			);
			expect(result.welcome.protocolVersion).toBe(2);
		});

		it("intersects requested channels with the daemon's advertised set", () => {
			const result = expectOk(
				negotiateCapabilities(
					hello({ channels: ["mission.updated", "ghost-channel"] }),
					daemon,
				),
			);
			expect(result.welcome.channels).toEqual(["mission.updated"]);
		});

		it("returns an empty channel list when the client subscribes to nothing", () => {
			const result = expectOk(
				negotiateCapabilities(hello({ channels: [] }), daemon),
			);
			expect(result.welcome.channels).toEqual([]);
		});

		it("treats a missing channels field the same as an empty list", () => {
			const result = expectOk(
				negotiateCapabilities(hello({ channels: undefined }), daemon),
			);
			expect(result.welcome.channels).toEqual([]);
		});

		it("dedupes the channel grant in first-seen order", () => {
			const result = expectOk(
				negotiateCapabilities(
					hello({
						channels: ["log", "mission.updated", "log", "mission.updated"],
					}),
					daemon,
				),
			);
			expect(result.welcome.channels).toEqual(["log", "mission.updated"]);
		});

		it("surfaces the daemon build identifier in the welcome", () => {
			const result = expectOk(negotiateCapabilities(hello(), daemon));
			expect(result.welcome.daemonBuild).toBe("1.2.3+abc");
		});

		it("exposes the full method list (deduped, order preserved)", () => {
			const result = expectOk(
				negotiateCapabilities(hello(), {
					...daemon,
					methods: ["mission.list", "mission.create", "mission.list"],
				}),
			);
			expect(result.welcome.methods).toEqual([
				"mission.list",
				"mission.create",
			]);
		});

		it("fails 'protocol-too-old' when the client is below daemon min", () => {
			const result = expectErr(
				negotiateCapabilities(hello({ protocolVersion: 0 }), {
					...daemon,
					minProtocolVersion: 2,
				}),
			);
			expect(result.code).toBe("bad-hello");
		});

		it("returns 'protocol-too-old' when the client speaks below daemon min but valid otherwise", () => {
			const result = expectErr(
				negotiateCapabilities(hello({ protocolVersion: 1 }), {
					...daemon,
					minProtocolVersion: 2,
				}),
			);
			expect(result.code).toBe("protocol-too-old");
			expect(result.message).toContain("v1");
		});

		it("returns 'bad-hello' on missing client", () => {
			const result = expectErr(
				negotiateCapabilities(hello({ client: "" }), daemon),
			);
			expect(result.code).toBe("bad-hello");
		});

		it("returns 'bad-hello' on non-integer protocol version", () => {
			const result = expectErr(
				negotiateCapabilities(hello({ protocolVersion: 1.5 }), daemon),
			);
			expect(result.code).toBe("bad-hello");
		});

		it("returns 'bad-hello' on non-string channel entries", () => {
			const result = expectErr(
				negotiateCapabilities(
					hello({ channels: [42 as unknown as string] }),
					daemon,
				),
			);
			expect(result.code).toBe("bad-hello");
		});

		it("returns 'bad-hello' when daemon min > max", () => {
			const result = expectErr(
				negotiateCapabilities(hello(), {
					...daemon,
					minProtocolVersion: 3,
					maxProtocolVersion: 2,
				}),
			);
			expect(result.code).toBe("bad-hello");
		});

		it("returns 'bad-hello' when daemon build is blank", () => {
			const result = expectErr(
				negotiateCapabilities(hello(), { ...daemon, daemonBuild: "  " }),
			);
			expect(result.code).toBe("bad-hello");
		});

		it("returns 'bad-hello' when daemon methods is missing", () => {
			const result = expectErr(
				negotiateCapabilities(hello(), {
					...daemon,
					methods: undefined as unknown as string[],
				}),
			);
			expect(result.code).toBe("bad-hello");
		});

		it("returns 'bad-hello' when daemon channels contains non-string entries", () => {
			const result = expectErr(
				negotiateCapabilities(hello(), {
					...daemon,
					channels: [42 as unknown as string],
				}),
			);
			expect(result.code).toBe("bad-hello");
		});
	});

	describe("rejectedChannels", () => {
		it("lists requested channels the daemon does not advertise", () => {
			expect(
				rejectedChannels(
					hello({ channels: ["mission.updated", "ghost", "log"] }),
					daemon,
				),
			).toEqual(["ghost"]);
		});

		it("returns an empty list when every channel is known", () => {
			expect(
				rejectedChannels(hello({ channels: ["mission.updated"] }), daemon),
			).toEqual([]);
		});

		it("returns an empty list when the client requested no channels", () => {
			expect(rejectedChannels(hello({ channels: undefined }), daemon)).toEqual(
				[],
			);
		});

		it("dedupes rejected channels in first-seen order", () => {
			expect(
				rejectedChannels(
					hello({ channels: ["ghost", "phantom", "ghost"] }),
					daemon,
				),
			).toEqual(["ghost", "phantom"]);
		});
	});
});
