import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FileDownloadRuntimeProvider,
	clearSandboxDownloadsSnapshot,
	getSandboxDownloadsSnapshot,
} from "./file-download-runtime-provider.js";

describe("FileDownloadRuntimeProvider", () => {
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;

	beforeEach(() => {
		vi.useFakeTimers();
		clearSandboxDownloadsSnapshot("sandbox");
		(
			URL as typeof URL & { createObjectURL: (blob: Blob) => string }
		).createObjectURL = vi.fn(() => "blob:test");
		(
			URL as typeof URL & { revokeObjectURL: (url: string) => void }
		).revokeObjectURL = vi.fn();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		(
			URL as typeof URL & { createObjectURL?: (blob: Blob) => string }
		).createObjectURL = originalCreate;
		(
			URL as typeof URL & { revokeObjectURL?: (url: string) => void }
		).revokeObjectURL = originalRevoke;
	});

	it("normalizes ArrayBuffer payloads", async () => {
		const provider = new FileDownloadRuntimeProvider();
		const buffer = new ArrayBuffer(3);
		new Uint8Array(buffer).set([1, 2, 3]);

		await provider.handleMessage(
			{
				type: "file-returned",
				sandboxId: "sandbox",
				fileName: "buffer.bin",
				mimeType: "application/octet-stream",
				content: buffer,
			},
			vi.fn(),
		);

		const snap = getSandboxDownloadsSnapshot("sandbox");
		expect(snap?.files.length).toBe(1);
		const file = snap?.files[0];
		expect(file?.content).toBeInstanceOf(Uint8Array);
		expect(Array.from(file?.content as Uint8Array)).toEqual([1, 2, 3]);
	});

	it("normalizes ArrayBufferView payloads", async () => {
		const provider = new FileDownloadRuntimeProvider();
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);
		view.setUint8(0, 9);
		view.setUint8(1, 8);
		view.setUint8(2, 7);
		view.setUint8(3, 6);

		await provider.handleMessage(
			{
				type: "file-returned",
				sandboxId: "sandbox",
				fileName: "view.bin",
				mimeType: "application/octet-stream",
				content: view,
			},
			vi.fn(),
		);

		const snap = getSandboxDownloadsSnapshot("sandbox");
		expect(snap?.files.length).toBe(1);
		const file = snap?.files[0];
		expect(file?.content).toBeInstanceOf(Uint8Array);
		expect(Array.from(file?.content as Uint8Array)).toEqual([9, 8, 7, 6]);
	});

	it("normalizes Blob payloads when available", async () => {
		if (typeof Blob === "undefined") return;
		const provider = new FileDownloadRuntimeProvider();
		const blob = new Blob([new Uint8Array([4, 5])], {
			type: "application/octet-stream",
		});

		await provider.handleMessage(
			{
				type: "file-returned",
				sandboxId: "sandbox",
				fileName: "blob.bin",
				mimeType: "application/octet-stream",
				content: blob,
			},
			vi.fn(),
		);

		const snap = getSandboxDownloadsSnapshot("sandbox");
		expect(snap?.files.length).toBe(1);
		const file = snap?.files[0];
		expect(file?.content).toBeInstanceOf(Uint8Array);
		expect(Array.from(file?.content as Uint8Array)).toEqual([4, 5]);
	});
});
