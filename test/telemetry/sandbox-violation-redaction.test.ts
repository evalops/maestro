import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const joinParts = (...parts: string[]) => parts.join("");

const AWS_SECRET_ACCESS_KEY = joinParts(
	"wJalrXUtnFEMI",
	"/K7MDENG+bPxRfiCY",
	"EXAMPLEKEY",
);
const SLACK_BOT_TOKEN = joinParts(
	"xoxb-",
	"123456789012-",
	"123456789012-",
	"abcdefghijklmnopqrstuvwx",
);
const GOOGLE_API_KEY = joinParts("AIza", "Sy", "A".repeat(33));
const GCP_ACCESS_TOKEN = joinParts("ya29.", "b".repeat(24));
const RAW_SECRET_VALUES = [
	AWS_SECRET_ACCESS_KEY,
	SLACK_BOT_TOKEN,
	GOOGLE_API_KEY,
	GCP_ACCESS_TOKEN,
];

describe("sandbox violation telemetry redaction", () => {
	let tempDir: string;

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), "maestro-sandbox-telemetry-"));
		vi.stubEnv("MAESTRO_TELEMETRY", "1");
		vi.stubEnv("MAESTRO_OTEL", "0");
	});

	afterEach(async () => {
		vi.resetModules();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(tempDir, { recursive: true, force: true });
	});

	it("redacts sandbox violation secrets in telemetry files", async () => {
		const telemetryFile = join(tempDir, "telemetry.jsonl");
		vi.stubEnv("MAESTRO_TELEMETRY_FILE", telemetryFile);
		const { recordSandboxViolation } = await import("../../src/telemetry.js");

		recordSandboxViolation(
			"blocked",
			"bash",
			`aws --secret-access-key ${AWS_SECRET_ACCESS_KEY}`,
			`blocked slack token ${SLACK_BOT_TOKEN}`,
			{
				path: `/tmp/${GOOGLE_API_KEY}`,
				command: `gcloud auth print-access-token ${GCP_ACCESS_TOKEN}`,
				sessionId: "session-redaction",
				metadata: {
					detail: `metadata gcp token ${GCP_ACCESS_TOKEN}`,
					rawPath: `/tmp/${GOOGLE_API_KEY}`,
					apiKey: GOOGLE_API_KEY,
				},
			},
		);

		await vi.waitFor(async () => {
			const content = await readFile(telemetryFile, "utf8");
			expect(content).toContain("sandbox-violation");
		});

		const payloadText = (await readFile(telemetryFile, "utf8")).trim();
		for (const secret of RAW_SECRET_VALUES) {
			expect(payloadText).not.toContain(secret);
		}

		const payload = JSON.parse(payloadText) as {
			action: string;
			reason: string;
			path: string;
			command: string;
			metadata?: Record<string, unknown>;
			sensitiveMetadata?: Record<string, unknown>;
		};
		expect(payload.action).toBe("aws --secret-access-key [secret]");
		expect(payload.reason).toBe("blocked slack token [secret]");
		expect(payload.path).toBe("/tmp/[secret]");
		expect(payload.command).toBe("gcloud auth print-access-token [secret]");
		expect(payload.metadata).toEqual({
			detail: "metadata gcp token [secret]",
			rawPath: "/tmp/[secret]",
			sessionId: "session-redaction",
		});
		expect(payload.sensitiveMetadata).toEqual({
			apiKey: "[sensitive]",
		});
	});

	it("redacts sandbox violation secrets in telemetry endpoint payloads", async () => {
		vi.stubEnv("MAESTRO_TELEMETRY_ENDPOINT", "https://telemetry.example.test");
		const fetchMock = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 204 })),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { recordSandboxViolation } = await import("../../src/telemetry.js");

		recordSandboxViolation(
			"warned",
			"write",
			`write ${SLACK_BOT_TOKEN}`,
			`path includes ${GOOGLE_API_KEY}`,
			{
				path: `/tmp/${GOOGLE_API_KEY}`,
				command: `aws --secret-access-key ${AWS_SECRET_ACCESS_KEY}`,
				metadata: {
					output: `token ${GCP_ACCESS_TOKEN}`,
				},
			},
		);

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		const payloadText = String(init?.body);
		for (const secret of RAW_SECRET_VALUES) {
			expect(payloadText).not.toContain(secret);
		}

		const payload = JSON.parse(payloadText) as {
			action: string;
			reason: string;
			path: string;
			command: string;
			metadata?: Record<string, unknown>;
		};
		expect(payload.action).toBe("write [secret]");
		expect(payload.reason).toBe("path includes [secret]");
		expect(payload.path).toBe("/tmp/[secret]");
		expect(payload.command).toBe("aws --secret-access-key [secret]");
		expect(payload.metadata).toEqual({
			output: "token [secret]",
		});
	});
});
