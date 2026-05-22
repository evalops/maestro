import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	sign as signBytes,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPlatformA2ALiveEvidenceFile } from "../../scripts/verify-platform-a2a-live-evidence.js";
import { getPackageName } from "../../src/package-metadata.js";

const joinParts = (...parts: string[]) => parts.join("");
const packageName = getPackageName();

function evidence(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		protocolVersion: "evalops.maestro.platform-a2a-live-smoke.v1",
		eventType: "platform_a2a_delegation_live_smoke",
		live: true,
		workspaceId: "ws_1",
		organizationId: "org_1",
		platformEndpoint: "https://platform.test",
		maestro: {
			gitSha: "1234567890abcdef1234567890abcdef12345678",
			cliPackage: packageName,
		},
		github: {
			repository: "evalops/maestro-internal",
			runId: "26252628231",
			runUrl:
				"https://github.com/evalops/maestro-internal/actions/runs/26252628231",
			sha: "1234567890abcdef1234567890abcdef12345678",
			pullRequestNumber: 2070,
			pullRequestUrl: "https://github.com/evalops/maestro-internal/pull/2070",
		},
		inputs: {
			fromAgentId: "maestro-origin",
			toAgentId: "maestro-target",
			promptHash: "a".repeat(64),
		},
		peers: {
			origin: {
				agentId: "maestro-origin",
				endpointUrl: "https://origin.test/a2a",
			},
			target: {
				agentId: "maestro-target",
				endpointUrl: "https://target.test/a2a",
			},
		},
		delegation: {
			id: "delegation_1",
			a2aTaskId: "task_1",
		},
		graph: {
			nodes: [{ delegationId: "delegation_1", a2aTaskId: "task_1" }],
			edges: [],
		},
		control: {
			mode: "A2A_DELEGATION_TASK_CONTROL_MODE_COLLECT",
			taskId: "task_1",
		},
		task: {
			id: "task_1",
			state: "TASK_STATE_COMPLETED",
			terminal: true,
		},
		redaction: {
			rawTokensWithheld: true,
			rawPayloadsWithheld: true,
		},
		...overrides,
	};
}

async function writeEvidenceBundle(
	dir: string,
	payload: Record<string, unknown>,
	sidecarOverride?: string,
	signature?: Record<string, unknown>,
): Promise<string> {
	const path = join(dir, "evidence.json");
	const bytes = `${JSON.stringify(payload, null, 2)}\n`;
	const digest = createHash("sha256").update(bytes).digest("hex");
	await writeFile(path, bytes);
	await writeFile(
		`${path}.sha256`,
		sidecarOverride ?? `${digest}  evidence.json\n`,
	);
	if (signature) {
		await writeFile(
			`${path}.sig.json`,
			`${JSON.stringify(signature, null, 2)}\n`,
		);
	}
	return path;
}

function signedEvidenceSidecar(
	bytes: string,
	privateKeyPem: string,
	publicKeyPem: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const publicDer = createPublicKey(publicKeyPem).export({
		format: "der",
		type: "spki",
	});
	return {
		protocolVersion: "evalops.maestro.platform-a2a-live-evidence-signature.v1",
		algorithm: "ed25519",
		evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
		signature: signBytes(null, Buffer.from(bytes), privateKeyPem).toString(
			"base64",
		),
		keyId: "platform-live-smoke-ci",
		publicKeyFingerprintSha256: createHash("sha256")
			.update(publicDer)
			.digest("hex"),
		signedAt: "2026-05-21T20:00:00.000Z",
		...overrides,
	};
}

describe("Platform A2A live evidence verifier", () => {
	it("accepts a hash-linked live evidence bundle", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path),
			).resolves.toMatchObject({
				path,
				protocolVersion: "evalops.maestro.platform-a2a-live-smoke.v1",
				gitSha: "1234567890abcdef1234567890abcdef12345678",
				delegationId: "delegation_1",
				a2aTaskId: "task_1",
				githubRunId: "26252628231",
				githubPullRequestNumber: 2070,
				evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects digest mismatches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence(),
				`${"0".repeat(64)}  evidence.json\n`,
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/digest mismatch/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects delegation and task id mismatches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					task: {
						id: "task_2",
						state: "TASK_STATE_COMPLETED",
						terminal: true,
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/delegation\.a2aTaskId task_1 does not match task\.id task_2/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects graph nodes that do not include the declared delegation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					graph: {
						nodes: [{ delegationId: "delegation_other", a2aTaskId: "task_1" }],
						edges: [],
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/graph does not include delegation\.id delegation_1/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects control task ids that do not match the verified task", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					control: {
						mode: "A2A_DELEGATION_TASK_CONTROL_MODE_COLLECT",
						taskId: "task_other",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/control\.taskId task_other does not match task\.id task_1/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects delegation inputs that do not match declared peers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					inputs: {
						fromAgentId: "maestro-other-origin",
						toAgentId: "maestro-target",
						promptHash: "a".repeat(64),
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/inputs\.fromAgentId maestro-other-origin does not match peers\.origin\.agentId maestro-origin/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("dereferences GitHub run and PR evidence when required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const paths: string[] = [];
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDereferenceableGithub: true,
					githubApiClient: async (apiPath) => {
						paths.push(apiPath);
						if (
							apiPath ===
							"/repos/evalops/maestro-internal/actions/runs/26252628231"
						) {
							return { id: 26252628231 };
						}
						if (apiPath === "/repos/evalops/maestro-internal/pulls/2070") {
							return { number: 2070 };
						}
						throw new Error(`unexpected GitHub API path ${apiPath}`);
					},
				}),
			).resolves.toMatchObject({
				githubDereferenced: true,
				githubPullRequestNumber: 2070,
				githubRunId: "26252628231",
			});
			expect(paths).toEqual([
				"/repos/evalops/maestro-internal/actions/runs/26252628231",
				"/repos/evalops/maestro-internal/pulls/2070",
			]);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("dereferences GHES evidence through the evidence server API host", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		const originalFetch = globalThis.fetch;
		const urls: string[] = [];
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					github: {
						repository: "evalops/maestro-internal",
						serverUrl: "https://github.example.com",
						runId: "26252628231",
						runUrl:
							"https://github.example.com/evalops/maestro-internal/actions/runs/26252628231",
						sha: "1234567890abcdef1234567890abcdef12345678",
						pullRequestNumber: 2070,
						pullRequestUrl:
							"https://github.example.com/evalops/maestro-internal/pull/2070",
					},
				}),
			);
			globalThis.fetch = (async (input) => {
				const url = String(input);
				urls.push(url);
				if (url.endsWith("/actions/runs/26252628231")) {
					return new Response(JSON.stringify({ id: 26252628231 }), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}
				if (url.endsWith("/pulls/2070")) {
					return new Response(JSON.stringify({ number: 2070 }), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}
				return new Response(JSON.stringify({ message: "not found" }), {
					status: 404,
				});
			}) as typeof fetch;

			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDereferenceableGithub: true,
				}),
			).resolves.toMatchObject({
				githubDereferenced: true,
				githubPullRequestNumber: 2070,
				githubRunId: "26252628231",
			});
			expect(urls).toEqual([
				"https://github.example.com/api/v3/repos/evalops/maestro-internal/actions/runs/26252628231",
				"https://github.example.com/api/v3/repos/evalops/maestro-internal/pulls/2070",
			]);
		} finally {
			globalThis.fetch = originalFetch;
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects non-HTTPS GitHub server URLs before dereferencing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		const paths: string[] = [];
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					github: {
						repository: "evalops/maestro-internal",
						serverUrl: "http://github.example.com",
						runId: "26252628231",
						runUrl:
							"http://github.example.com/evalops/maestro-internal/actions/runs/26252628231",
						sha: "1234567890abcdef1234567890abcdef12345678",
						pullRequestNumber: 2070,
						pullRequestUrl:
							"http://github.example.com/evalops/maestro-internal/pull/2070",
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDereferenceableGithub: true,
					githubApiClient: async (apiPath) => {
						paths.push(apiPath);
						throw new Error("GitHub API client should not be called");
					},
				}),
			).rejects.toThrow(/server URL must use HTTPS/);
			expect(paths).toEqual([]);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects GitHub run URLs that do not match the run id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					github: {
						repository: "evalops/maestro-internal",
						runId: "26252628231",
						runUrl:
							"https://github.com/evalops/maestro-internal/actions/runs/26252628232",
						sha: "1234567890abcdef1234567890abcdef12345678",
						pullRequestNumber: 2070,
						pullRequestUrl:
							"https://github.com/evalops/maestro-internal/pull/2070",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/run URL id 26252628232 does not match runId 26252628231/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts invalid-token rejection evidence when required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					negativeAuthProbe: {
						surface: "platform-agent-registry-peer-discovery",
						rejected: true,
						errorClass: "forbidden",
						observedAt: "2026-05-21T20:00:00.000Z",
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireNegativeAuthProbe: true,
				}),
			).resolves.toMatchObject({
				negativeAuthProbe: {
					surface: "platform-agent-registry-peer-discovery",
					rejected: true,
					errorClass: "forbidden",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects missing invalid-token evidence when required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireNegativeAuthProbe: true,
				}),
			).rejects.toThrow(/requires invalid-token rejection evidence/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects invalid-token evidence that is not rejected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					negativeAuthProbe: {
						surface: "platform-agent-registry-peer-discovery",
						rejected: false,
						errorClass: "forbidden",
						observedAt: "2026-05-21T20:00:00.000Z",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/not marked rejected/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects GitHub metadata that does not resolve when dereference is required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDereferenceableGithub: true,
					githubApiClient: async () => {
						throw new Error("HTTP 404 not found");
					},
				}),
			).rejects.toThrow(/HTTP 404 not found/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts a signed live evidence bundle when signature verification is required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const { privateKey, publicKey } = generateKeyPairSync("ed25519");
			const privateKeyPem = privateKey.export({
				format: "pem",
				type: "pkcs8",
			}) as string;
			const publicKeyPem = publicKey.export({
				format: "pem",
				type: "spki",
			}) as string;
			const payload = evidence();
			const bytes = `${JSON.stringify(payload, null, 2)}\n`;
			const path = await writeEvidenceBundle(
				dir,
				payload,
				undefined,
				signedEvidenceSidecar(bytes, privateKeyPem, publicKeyPem),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					publicKeyPem,
					requireSignature: true,
				}),
			).resolves.toMatchObject({
				signature: {
					algorithm: "ed25519",
					keyId: "platform-live-smoke-ci",
					verified: true,
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects missing signatures when signature verification is required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, { requireSignature: true }),
			).rejects.toThrow(/requires a detached signature sidecar/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects tampered detached signatures", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const { privateKey, publicKey } = generateKeyPairSync("ed25519");
			const privateKeyPem = privateKey.export({
				format: "pem",
				type: "pkcs8",
			}) as string;
			const publicKeyPem = publicKey.export({
				format: "pem",
				type: "spki",
			}) as string;
			const payload = evidence();
			const bytes = `${JSON.stringify(payload, null, 2)}\n`;
			const path = await writeEvidenceBundle(
				dir,
				payload,
				undefined,
				signedEvidenceSidecar(bytes, privateKeyPem, publicKeyPem, {
					signature: Buffer.from("not the signed evidence").toString("base64"),
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					publicKeyPem,
					requireSignature: true,
				}),
			).rejects.toThrow(/detached signature is invalid/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects production-looking evidence with synthetic git SHAs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					maestro: {
						gitSha: joinParts(
							"9f3a",
							"20260520222033",
							"c0de",
							"5afe",
							"00000000000001",
						),
						cliPackage: packageName,
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/synthetic/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects production-looking evidence with synthetic GitHub identifiers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					github: {
						repository: "evalops/maestro-internal",
						runId: joinParts("gha-run-", "20260520T222033Z", "-local"),
						pullRequest: joinParts(
							"evalops/platform#",
							"prod-pr-lane-",
							"20260520T222033Z",
							"-local",
						),
						sha: "1234567890abcdef1234567890abcdef12345678",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/positive integer id|integer PR number/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects local proof ids in live evidence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					proof: {
						id: "platform-a2a-proof-local",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/local synthetic proof id/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});
