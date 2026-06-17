import { describe, expect, it } from "vitest";
import {
	IPC_ENVELOPE_VERSION,
	IPC_PROTOCOL_VERSION,
	type IpcMessage,
	decodeFrames,
	encodeFrame,
	isIpcMessage,
	makeErrorResponse,
	makeEvent,
	makeRequest,
	makeResponse,
	negotiateProtocolVersion,
} from "../../src/agent/ipc-envelope.js";

describe("agent/ipc-envelope", () => {
	describe("factories", () => {
		it("makeRequest stamps the envelope version + id + method", () => {
			const r = makeRequest("req-1", "mission.list", { limit: 10 });
			expect(r.kind).toBe("request");
			expect(r.v).toBe(IPC_ENVELOPE_VERSION);
			expect(r.id).toBe("req-1");
			expect(r.method).toBe("mission.list");
			expect(r.params).toEqual({ limit: 10 });
		});

		it("makeRequest omits params when undefined (no `params` key)", () => {
			const r = makeRequest("req-2", "daemon.status");
			expect("params" in r).toBe(false);
		});

		it("makeResponse builds a success response echoing the id", () => {
			const r = makeResponse("req-1", { missions: [] });
			expect(r.kind).toBe("response");
			expect(r.ok).toBe(true);
			expect(r.id).toBe("req-1");
			expect(r.result).toEqual({ missions: [] });
		});

		it("makeErrorResponse carries a structured IpcError", () => {
			const r = makeErrorResponse("req-3", {
				code: "unknown-method",
				message: "no such method: mission.qux",
				details: { method: "mission.qux" },
			});
			expect(r.ok).toBe(false);
			expect(r.error.code).toBe("unknown-method");
			expect(r.error.details).toEqual({ method: "mission.qux" });
		});

		it("makeEvent builds a channel push", () => {
			const e = makeEvent("mission.updated", { id: "M-1", status: "running" });
			expect(e.kind).toBe("event");
			expect(e.channel).toBe("mission.updated");
			expect(e.payload).toEqual({ id: "M-1", status: "running" });
		});
	});

	describe("negotiateProtocolVersion", () => {
		it("accepts matching versions", () => {
			const result = negotiateProtocolVersion(IPC_PROTOCOL_VERSION);
			expect(result).toEqual({ ok: true, agreed: IPC_PROTOCOL_VERSION });
		});

		it("rejects clients newer than the daemon", () => {
			const result = negotiateProtocolVersion(99, 1);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toMatch(/exceeds daemon max/);
			}
		});

		it("rejects non-integer / zero / negative versions", () => {
			expect(negotiateProtocolVersion(0).ok).toBe(false);
			expect(negotiateProtocolVersion(-1).ok).toBe(false);
			expect(negotiateProtocolVersion(1.5).ok).toBe(false);
		});

		it("agrees on the client version when it's older than the daemon's max", () => {
			const result = negotiateProtocolVersion(1, 5);
			expect(result).toEqual({ ok: true, agreed: 1 });
		});
	});

	describe("isIpcMessage", () => {
		it("accepts valid request/response/event shapes", () => {
			expect(isIpcMessage(makeRequest("a", "m"))).toBe(true);
			expect(isIpcMessage(makeResponse("a", null))).toBe(true);
			expect(
				isIpcMessage(makeErrorResponse("a", { code: "x", message: "y" })),
			).toBe(true);
			expect(isIpcMessage(makeEvent("c", {}))).toBe(true);
		});

		it("rejects non-objects, null, missing v / kind, garbage shapes", () => {
			expect(isIpcMessage(null)).toBe(false);
			expect(isIpcMessage(undefined)).toBe(false);
			expect(isIpcMessage("hi")).toBe(false);
			expect(isIpcMessage(42)).toBe(false);
			expect(isIpcMessage({})).toBe(false);
			expect(isIpcMessage({ kind: "request", id: "a", method: "m" })).toBe(
				false,
			); // no v
			expect(isIpcMessage({ v: 1, kind: "unknown" })).toBe(false);
		});

		it("accepts a success response with no `result` key (JSON drops `undefined`)", () => {
			// `JSON.stringify({ result: undefined })` produces `{}`, so the
			// validator must accept absent `result` as equivalent to undefined.
			expect(isIpcMessage({ kind: "response", v: 1, id: "a", ok: true })).toBe(
				true,
			);
		});

		it("accepts an event with no `payload` key (JSON drops `undefined`)", () => {
			expect(isIpcMessage({ kind: "event", v: 1, channel: "log" })).toBe(true);
		});

		it("rejects error responses missing or malformed `error`", () => {
			expect(isIpcMessage({ kind: "response", v: 1, id: "a", ok: false })).toBe(
				false,
			);
			expect(
				isIpcMessage({
					kind: "response",
					v: 1,
					id: "a",
					ok: false,
					error: { code: "x" }, // missing message
				}),
			).toBe(false);
		});
	});

	describe("encodeFrame / decodeFrames", () => {
		it("round-trips a single message", () => {
			const msg = makeRequest("a", "x.y", { z: 1 });
			const frame = encodeFrame(msg);
			const { messages, remainder } = decodeFrames(frame);
			expect(messages).toEqual([msg]);
			expect(remainder.byteLength).toBe(0);
		});

		it("decodes multiple concatenated frames", () => {
			const a = makeRequest("a", "x");
			const b = makeResponse("a", { ok: true });
			const c = makeEvent("log", { line: "hello" });
			const buffer = concat([encodeFrame(a), encodeFrame(b), encodeFrame(c)]);
			const { messages, remainder } = decodeFrames(buffer);
			expect(messages).toEqual([a, b, c]);
			expect(remainder.byteLength).toBe(0);
		});

		it("returns an incomplete trailing frame as the remainder", () => {
			const a = makeRequest("a", "x");
			const b = makeRequest("b", "y");
			const full = concat([encodeFrame(a), encodeFrame(b)]);
			// Truncate b's body by one byte.
			const truncated = full.subarray(0, full.byteLength - 1);
			const { messages, remainder } = decodeFrames(truncated);
			expect(messages).toEqual([a]);
			expect(remainder.byteLength).toBe(encodeFrame(b).byteLength - 1);
		});

		it("returns the whole buffer as remainder when the first length prefix is incomplete", () => {
			const buffer = new Uint8Array([0, 0]); // only 2 of the 4 prefix bytes
			const { messages, remainder } = decodeFrames(buffer);
			expect(messages).toEqual([]);
			expect(remainder.byteLength).toBe(2);
		});

		it("encodes the length prefix as a 4-byte big-endian uint32", () => {
			const frame = encodeFrame(makeEvent("c", "hello")); // body: {"kind":"event","v":1,"channel":"c","payload":"hello"}
			const view = new DataView(frame.buffer, frame.byteOffset, 4);
			const length = view.getUint32(0, false);
			expect(length).toBe(frame.byteLength - 4);
		});

		it("throws when a frame body is not a valid IPC message", () => {
			const garbage = JSON.stringify({ kind: "request", v: 1 }); // missing id+method
			const body = new TextEncoder().encode(garbage);
			const frame = new Uint8Array(4 + body.byteLength);
			new DataView(frame.buffer).setUint32(0, body.byteLength, false);
			frame.set(body, 4);
			expect(() => decodeFrames(frame)).toThrow(/not a valid IPC message/);
		});

		it("round-trips a success response whose `result` is undefined", () => {
			// `makeResponse(id, undefined)` serializes via JSON.stringify which
			// drops the `result` key; the decoded payload must still validate.
			const msg = makeResponse("a", undefined);
			const { messages } = decodeFrames(encodeFrame(msg));
			expect(messages).toHaveLength(1);
			expect(messages[0]?.kind).toBe("response");
		});

		it("round-trips an event whose `payload` is undefined", () => {
			const msg = makeEvent("log", undefined);
			const { messages } = decodeFrames(encodeFrame(msg));
			expect(messages).toHaveLength(1);
			expect(messages[0]?.kind).toBe("event");
		});

		it("rejects frames whose declared length exceeds 2^31-1", () => {
			// Forge a frame whose length prefix advertises 4 GB even though
			// the encoder caps at 2 GB - 1.
			const frame = new Uint8Array(4);
			new DataView(frame.buffer).setUint32(0, 0xffffffff, false);
			expect(() => decodeFrames(frame)).toThrow(/2\^31-1/);
		});

		it("handles UTF-8 multi-byte characters in payloads", () => {
			const msg = makeEvent("log", { line: "héllo 世界 🚀" });
			const { messages, remainder } = decodeFrames(encodeFrame(msg));
			expect(messages).toEqual([msg]);
			expect(remainder.byteLength).toBe(0);
		});
	});

	describe("type narrowing", () => {
		it("kind discriminates the IpcMessage union", () => {
			const messages: IpcMessage[] = [
				makeRequest("a", "x"),
				makeResponse("a", 1),
				makeEvent("c", 2),
			];
			const kinds = messages.map((m) => m.kind);
			expect(kinds).toEqual(["request", "response", "event"]);
		});
	});
});

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.byteLength;
	}
	return out;
}
