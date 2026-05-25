import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleA2ACommand } from "../../../src/cli/commands/a2a.js";

const ANSI_ESCAPE_PATTERN = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*m`,
	"gu",
);

interface RequestRecord {
	method: string | undefined;
	url: string | undefined;
	body: unknown;
}

describe("A2A fleet delegation CLI", () => {
	let server: Server;
	let baseUrl: string;
	let requests: RequestRecord[];
	let taskFetches: number;
	let taskResponses: unknown[];
	let logs: string[];
	let errors: string[];

	beforeEach(async () => {
		requests = [];
		taskFetches = 0;
		taskResponses = [];
		logs = [];
		errors = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.join(" "));
		});
		server = createServer(async (request, response) => {
			if (request.method === "GET" && request.url === "/healthz") {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ ok: true }));
				return;
			}
			if (
				request.method === "GET" &&
				request.url === "/.well-known/agent-card.json"
			) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						name: "Mac mini Maestro",
						description: "Always-on local build and smoke peer",
						version: "0.10.18",
						provider: {
							organization: "EvalOps",
							url: "https://evalops.dev",
						},
						capabilities: { streaming: true },
						defaultInputModes: ["text/plain"],
						defaultOutputModes: ["text/plain"],
						supportedInterfaces: [
							{
								url: `${baseUrl}/message:send`,
								protocolBinding: "HTTP+JSON",
								protocolVersion: "1.0",
							},
						],
						skills: [
							{
								id: "repo-smoke",
								name: "Repo smoke",
								description: "Run focused repository smoke tests",
								tags: ["repo", "smoke"],
							},
						],
					}),
				);
				return;
			}
			if (request.method === "POST" && request.url === "/message:send") {
				const body = await readJson(request);
				const taskId = recordValue(body, "message.taskId") ?? "task-mac-mini-1";
				requests.push({ method: request.method, url: request.url, body });
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						task: {
							id: taskId,
							contextId:
								recordValue(body, "message.contextId") ??
								"maestro-a2a-context-test",
							status: {
								state: "TASK_STATE_SUBMITTED",
							},
							history: [recordValue(body, "message")].filter(Boolean),
							metadata: {
								worker: "mac-mini",
							},
						},
					}),
				);
				return;
			}
			if (request.method === "GET" && request.url?.startsWith("/tasks/")) {
				const taskId = decodeURIComponent(request.url.slice("/tasks/".length));
				taskFetches += 1;
				const taskResponse = taskResponses.shift();
				if (taskResponse) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(JSON.stringify(taskResponse));
					return;
				}
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						id: taskId,
						contextId: "maestro-a2a-context-test",
						status: {
							state: "TASK_STATE_COMPLETED",
							message: {
								messageId: "agent-message-1",
								role: "ROLE_AGENT",
								parts: [
									{
										text: "mac mini finished the smoke plan",
										mediaType: "text/plain",
									},
								],
							},
						},
						artifacts: [
							{
								artifactId: "result",
								parts: [
									{
										text: "mac mini finished the smoke plan",
										mediaType: "text/plain",
									},
								],
							},
						],
						metadata: {
							workGraph: workGraphMetadata(),
						},
					}),
				);
				return;
			}
			response.writeHead(404, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "not found" }));
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("imports Platform-discovered A2A peers into the local registry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-discover-"));
		const registryPath = join(dir, "peers.json");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_URL", "https://registry.test/");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
		vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
		vi.stubEnv("AGENT_REGISTRY_WORKSPACE_ID", "ws_from_env");
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://registry.test/agents.v1.AgentService/List",
				);
				expect(init?.method).toBe("POST");
				expect(
					Object.fromEntries(new Headers(init?.headers).entries()),
				).toEqual(
					expect.objectContaining({
						"x-workspace-id": "ws_1",
					}),
				);
				expect(JSON.parse(String(init?.body))).toMatchObject({
					workspaceId: "ws_1",
					capability: "code:review",
					status: "AGENT_STATUS_ONLINE",
					limit: 10,
					offset: 0,
				});
				return new Response(
					JSON.stringify({
						agents: [
							{
								id: "maestro-reviewer",
								workspaceId: "ws_1",
								name: "Remote Maestro Reviewer",
								agentType: "maestro",
								status: "AGENT_STATUS_ONLINE",
								a2a: {
									publicEndpointUrl: "https://reviewer.test/a2a",
									internalEndpointUrl: "http://reviewer.mesh/a2a",
									agentCardUrl:
										"https://reviewer.test/.well-known/agent-card.json",
									protocolBinding: "HTTP+JSON",
									protocolVersion: "1.0",
									pushNotifications: true,
									skills: [
										{
											id: "maestro.subagent.code-review",
											name: "Maestro code review subagent",
											description: "Review a delegated patch safely",
											tags: ["maestro", "subagent", "review"],
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
								},
							},
							{
								id: "maestro-reviewer-secondary",
								workspaceId: "ws_1",
								name: "Secondary Maestro Reviewer",
								agentType: "maestro",
								status: "AGENT_STATUS_ONLINE",
								a2a: {
									publicEndpointUrl: "https://secondary-reviewer.test/a2a",
									agentCardUrl:
										"https://secondary-reviewer.test/.well-known/agent-card.json",
									protocolBinding: "HTTP+JSON",
									protocolVersion: "1.0",
									pushNotifications: true,
									skills: [
										{
											id: "maestro.subagent.code-review",
											name: "Maestro code review subagent",
											tags: ["maestro", "subagent", "review"],
										},
									],
								},
							},
							{
								workspaceId: "ws_1",
								name: "Twin Reviewer",
								agentType: "maestro",
								status: "AGENT_STATUS_ONLINE",
								a2a: {
									publicEndpointUrl: "https://twin-one.test/a2a",
									agentCardUrl:
										"https://twin-one.test/.well-known/agent-card.json",
									protocolBinding: "HTTP+JSON",
									protocolVersion: "1.0",
									skills: [
										{
											id: "maestro.subagent.code-review",
											name: "Maestro code review subagent",
											tags: ["maestro", "subagent", "review"],
										},
									],
								},
							},
							{
								workspaceId: "ws_1",
								name: "Twin/Reviewer",
								agentType: "maestro",
								status: "AGENT_STATUS_ONLINE",
								a2a: {
									publicEndpointUrl: "https://twin-two.test/a2a",
									agentCardUrl:
										"https://twin-two.test/.well-known/agent-card.json",
									protocolBinding: "HTTP+JSON",
									protocolVersion: "1.0",
									skills: [
										{
											id: "maestro.subagent.code-review",
											name: "Maestro code review subagent",
											tags: ["maestro", "subagent", "review"],
										},
									],
								},
							},
						],
						discoveryEvidence: {
							schema: "agents.v1.discovery-evidence",
							decision: "matched",
							reason: "eligible_a2a_peers",
							workspaceId: "ws_1",
							capability: "code:review",
							a2aSkillId: "maestro.subagent.code-review",
							status: "AGENT_STATUS_ONLINE",
							requireA2ADispatch: true,
							candidateCount: 4,
							matchedCount: 4,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await handleA2ACommand([
			"discover",
			"--capability",
			"code:review",
			"--skill",
			"maestro.subagent.code-review",
			"--status",
			"AGENT_STATUS_ONLINE",
			"--workspace-id",
			"ws_1",
			"--limit",
			"10",
			"--offset",
			"0",
			"--prefer-internal",
			"--import",
			"--default",
			"--json",
			"--registry",
			registryPath,
		]);

		const output = JSON.parse(logs.join("\n")) as {
			peers: Array<{ endpointUrl: string; agentId?: string; name?: string }>;
			imported: Array<{ name: string; url: string; path: string }>;
			discoveryEvidence?: {
				decision?: string;
				candidateCount?: number;
				matchedCount?: number;
			};
		};
		expect(output.discoveryEvidence).toMatchObject({
			decision: "matched",
			candidateCount: 4,
			matchedCount: 4,
		});
		expect(output.peers).toEqual([
			expect.objectContaining({
				agentId: "maestro-reviewer",
				endpointUrl: "http://reviewer.mesh/a2a",
				endpointKind: "internal",
			}),
			expect.objectContaining({
				agentId: "maestro-reviewer-secondary",
				endpointUrl: "https://secondary-reviewer.test/a2a",
				endpointKind: "public",
			}),
			expect.objectContaining({
				name: "Twin Reviewer",
				endpointUrl: "https://twin-one.test/a2a",
			}),
			expect.objectContaining({
				name: "Twin/Reviewer",
				endpointUrl: "https://twin-two.test/a2a",
			}),
		]);
		expect(output.imported).toEqual([
			expect.objectContaining({
				name: "maestro-reviewer",
				path: registryPath,
				url: "http://reviewer.mesh/a2a",
			}),
			expect.objectContaining({
				name: "maestro-reviewer-secondary",
				path: registryPath,
				url: "https://secondary-reviewer.test/a2a",
			}),
			expect.objectContaining({
				name: "Twin-Reviewer",
				path: registryPath,
				url: "https://twin-one.test/a2a",
			}),
			expect.objectContaining({
				name: "Twin-Reviewer-2",
				path: registryPath,
				url: "https://twin-two.test/a2a",
			}),
		]);
		const registryRaw = await readFile(registryPath, "utf8");
		expect(registryRaw).not.toContain("registry-token");
		const registry = JSON.parse(registryRaw) as {
			defaultPeer?: string;
			peers: Record<
				string,
				{
					url: string;
					displayName?: string;
					agentCardUrl?: string;
					protocolBinding?: string;
					protocolVersion?: string;
					workspaceId?: string;
					agentId?: string;
					capabilities?: { pushNotifications?: boolean };
					skills?: Array<{
						id: string;
						name: string;
						description?: string;
						tags?: string[];
						requiredContextGrants?: string[];
						approvalPolicyRef?: string;
						maxAutonomy?: string;
						requiredArtifactKinds?: string[];
						allowedTaskClasses?: string[];
						deniedTaskClasses?: string[];
						attributes?: Record<string, string>;
						metadata?: Record<string, string | number | boolean>;
					}>;
					metadata?: Record<string, string | number | boolean>;
				}
			>;
		};
		expect(registry.defaultPeer).toBe("maestro-reviewer");
		expect(registry.peers["maestro-reviewer"]).toMatchObject({
			url: "http://reviewer.mesh/a2a",
			displayName: "Remote Maestro Reviewer",
			agentCardUrl: "https://reviewer.test/.well-known/agent-card.json",
			protocolBinding: "HTTP+JSON",
			protocolVersion: "1.0",
			workspaceId: "ws_1",
			agentId: "maestro-reviewer",
			capabilities: { pushNotifications: true },
			skills: [
				{
					id: "maestro.subagent.code-review",
					name: "Maestro code review subagent",
					description: "Review a delegated patch safely",
					tags: ["maestro", "subagent", "review"],
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
			metadata: {
				source: "platform-agent-registry",
				platformAgentId: "maestro-reviewer",
				platformAgentType: "maestro",
				platformAgentStatus: "AGENT_STATUS_ONLINE",
				selectedEndpoint: "internal",
				a2aPushNotifications: true,
				platformDiscoveryDecision: "matched",
				platformDiscoveryCandidateCount: 4,
				platformDiscoveryMatchedCount: 4,
			},
		});
		expect(registry.peers["maestro-reviewer-secondary"]).toMatchObject({
			url: "https://secondary-reviewer.test/a2a",
			displayName: "Secondary Maestro Reviewer",
			agentId: "maestro-reviewer-secondary",
			metadata: {
				source: "platform-agent-registry",
				platformAgentId: "maestro-reviewer-secondary",
				selectedEndpoint: "public",
			},
		});
		expect(registry.peers["Twin-Reviewer"]).toMatchObject({
			url: "https://twin-one.test/a2a",
			displayName: "Twin Reviewer",
		});
		expect(registry.peers["Twin-Reviewer-2"]).toMatchObject({
			url: "https://twin-two.test/a2a",
			displayName: "Twin/Reviewer",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("suffixes imported peer names when existing no-id peers point at different endpoints", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-discover-"));
		const registryPath = join(dir, "peers.json");
		await writeFile(
			registryPath,
			`${JSON.stringify(
				{
					defaultPeer: "Twin-Reviewer",
					peers: {
						"Twin-Reviewer": {
							url: "https://existing-twin.test/a2a",
							displayName: "Twin Reviewer",
							createdAt: "2026-05-01T00:00:00.000Z",
							updatedAt: "2026-05-01T00:00:00.000Z",
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		vi.stubEnv("AGENT_REGISTRY_SERVICE_URL", "https://registry.test/");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
		vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
		vi.stubEnv("AGENT_REGISTRY_WORKSPACE_ID", "ws_1");
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					agents: [
						{
							workspaceId: "ws_1",
							name: "Twin Reviewer",
							agentType: "maestro",
							status: "AGENT_STATUS_ONLINE",
							a2a: {
								publicEndpointUrl: "https://new-twin.test/a2a",
								agentCardUrl:
									"https://new-twin.test/.well-known/agent-card.json",
								protocolBinding: "HTTP+JSON",
								protocolVersion: "1.0",
								skills: [
									{
										id: "maestro.subagent.code-review",
										name: "Maestro code review subagent",
									},
								],
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await handleA2ACommand([
			"discover",
			"--workspace-id",
			"ws_1",
			"--skill",
			"maestro.subagent.code-review",
			"--import",
			"--json",
			"--registry",
			registryPath,
		]);

		const output = JSON.parse(logs.join("\n")) as {
			imported: Array<{ name: string; url: string; path: string }>;
		};
		expect(output.imported).toEqual([
			expect.objectContaining({
				name: "Twin-Reviewer-2",
				path: registryPath,
				url: "https://new-twin.test/a2a",
			}),
		]);
		const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
			defaultPeer?: string;
			peers: Record<string, { url: string; displayName?: string }>;
		};
		expect(registry.defaultPeer).toBe("Twin-Reviewer");
		expect(registry.peers["Twin-Reviewer"]).toMatchObject({
			url: "https://existing-twin.test/a2a",
			displayName: "Twin Reviewer",
		});
		expect(registry.peers["Twin-Reviewer-2"]).toMatchObject({
			url: "https://new-twin.test/a2a",
			displayName: "Twin Reviewer",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("delegates directly to a Platform-discovered subagent skill", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-discover-delegate-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_URL", "https://registry.test/");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
		vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
		vi.stubEnv("AGENT_REGISTRY_WORKSPACE_ID", "ws_from_env");
		const realFetch = globalThis.fetch;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).startsWith("https://registry.test/")) {
					expect(String(input)).toBe(
						"https://registry.test/agents.v1.AgentService/List",
					);
					expect(JSON.parse(String(init?.body))).toMatchObject({
						workspaceId: "ws_1",
						capability: "code:review",
						surface: "a2a",
						status: "AGENT_STATUS_IDLE",
						limit: 10,
					});
					return new Response(
						JSON.stringify({
							agents: [
								{
									id: "maestro-reviewer",
									workspaceId: "ws_1",
									name: "Remote Maestro Reviewer",
									agentType: "maestro",
									status: "AGENT_STATUS_IDLE",
									a2a: {
										publicEndpointUrl: baseUrl,
										agentCardUrl: `${baseUrl}/.well-known/agent-card.json`,
										protocolBinding: "HTTP+JSON",
										protocolVersion: "1.0",
										pushNotifications: true,
										skills: [
											{
												id: "maestro.subagent.code-review",
												name: "Maestro code review subagent",
												description: "Review a delegated patch safely",
												tags: ["maestro", "subagent", "review"],
												requiredContextGrants: ["repo:read"],
												approvalPolicyRef: "target-maestro-policy",
												maxAutonomy: "bounded",
												requiredArtifactKinds: ["review.summary"],
												optionalArtifactKinds: ["risk.finding"],
												allowedTaskClasses: ["code.review"],
												deniedTaskClasses: ["secret.exfiltration"],
												attributes: {
													subagentLaneId: "code-review",
													requestMetadataPath:
														"evalops.attributeSubagentRequest",
												},
												metadata: {
													requestMetadataPath: "evalops.customSubagentRequest",
													resultPolicy: "summary-and-artifacts",
												},
											},
										],
									},
								},
							],
							discovery_evidence: {
								schema: "agents.v1.discovery-evidence",
								decision: "matched",
								reason: "best_capability_score",
								workspace_id: "ws_1",
								capability: "code:review",
								a2a_skill_id: "maestro.subagent.code-review",
								status: "AGENT_STATUS_IDLE",
								candidate_count: 3,
								matched_count: 1,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return realFetch(input, init);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await handleA2ACommand([
			"delegate",
			"--discover",
			"--skill",
			"maestro.subagent.code-review",
			"--capability",
			"code:review",
			"--workspace-id",
			"ws_1",
			"review",
			"the",
			"patch",
			"--role",
			"reviewer",
			"--cwd",
			"/repo",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		expect(requests).toHaveLength(1);
		const metadata = recordValue(requests[0]!.body, "message.metadata") as
			| Record<string, unknown>
			| undefined;
		expect(metadata).toMatchObject({
			requestKind: "maestro-peer-delegation",
			relayPeer: "maestro-reviewer",
			delegationRole: "reviewer",
			delegationCwd: "/repo",
			discoverySource: "platform-agent-registry",
			a2aSkillId: "maestro.subagent.code-review",
		});
		expect(metadata?.["evalops.a2aDiscovery"]).toMatchObject({
			source: "platform-agent-registry",
			platformDiscoveryDecision: "matched",
			platformDiscoveryReason: "best_capability_score",
			platformDiscoveryCandidateCount: 3,
			platformDiscoveryMatchedCount: 1,
			selectedAgentId: "maestro-reviewer",
			selectedEndpointUrl: baseUrl,
			selectedEndpointKind: "public",
			score: expect.any(Number),
			reasons: expect.arrayContaining(["skill:maestro.subagent.code-review"]),
		});
		expect(metadata?.["evalops.subagentRequest"]).toBeUndefined();
		expect(metadata?.["evalops.attributeSubagentRequest"]).toBeUndefined();
		expect(metadata?.["evalops.customSubagentRequest"]).toMatchObject({
			skillId: "maestro.subagent.code-review",
			skillName: "Maestro code review subagent",
			role: "reviewer",
			cwd: "/repo",
			requiredContextGrants: ["repo:read"],
			approvalPolicyRef: "target-maestro-policy",
			maxAutonomy: "bounded",
			requiredArtifactKinds: ["review.summary"],
			optionalArtifactKinds: ["risk.finding"],
			allowedTaskClasses: ["code.review"],
			deniedTaskClasses: ["secret.exfiltration"],
			attributes: {
				subagentLaneId: "code-review",
				requestMetadataPath: "evalops.attributeSubagentRequest",
			},
			metadata: {
				requestMetadataPath: "evalops.customSubagentRequest",
				resultPolicy: "summary-and-artifacts",
			},
		});
		expect(plainLogs(logs)).toContain(
			"Selected Platform A2A peer maestro-reviewer",
		);
		expect(plainLogs(logs)).toContain("Delegated to maestro-reviewer");
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");

		const registryRaw = await readFile(registryPath, "utf8");
		expect(registryRaw).toContain("target-maestro-policy");
		expect(registryRaw).toContain("summary-and-artifacts");
		expect(registryRaw).not.toContain("registry-token");
		expect(errors.join("\n")).toBe("");
	});

	it("delegates work, records a transcript, and reports fleet health", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-fleet-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await handleA2ACommand([
			"delegate",
			"mac-mini",
			"run",
			"the",
			"tmux",
			"smoke",
			"--role",
			"background-worker",
			"--cwd",
			"/Users/jonathanhaas/Documents/Projects/maestro-internal",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		expect(requests).toHaveLength(1);
		expect(recordValue(requests[0]!.body, "message.metadata")).toMatchObject({
			requestKind: "maestro-peer-delegation",
			delegationRole: "background-worker",
			delegationCwd: "/Users/jonathanhaas/Documents/Projects/maestro-internal",
			relayPeer: "mac-mini",
		});
		expect(plainLogs(logs)).toContain("Delegated to mac-mini");
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");
		expect(plainLogs(logs)).toContain("Work graph: waiting");
		expect(plainLogs(logs)).not.toContain("Codex subagents:");
		expect(plainLogs(logs)).not.toContain("Correlation:");

		const ledgerRaw = await readFile(tasksPath, "utf8");
		expect(ledgerRaw).toContain("task-mac-mini-1");
		expect(ledgerRaw).toContain("run the tmux smoke");
		expect(ledgerRaw).toContain("mac mini finished the smoke plan");
		expect(ledgerRaw).not.toContain("super-secret-token");

		logs = [];
		await handleA2ACommand([
			"fleet",
			"--json",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--timeout-ms",
			"1000",
		]);
		const fleet = JSON.parse(logs.join("\n")) as {
			peers: Array<{
				name: string;
				status: string;
				displayName?: string;
				capabilities?: { streaming?: boolean };
				lastTask?: { id: string; state: string };
			}>;
		};
		expect(fleet.peers).toEqual([
			expect.objectContaining({
				name: "mac-mini",
				status: "online",
				displayName: "Mac mini Maestro",
				capabilities: expect.objectContaining({ streaming: true }),
				lastTask: expect.objectContaining({
					id: "task-mac-mini-1",
					state: "TASK_STATE_COMPLETED",
					workGraph: expect.objectContaining({
						state: "waiting",
						childRunIds: ["agent_run_child_1"],
						codexSubagents: expect.objectContaining({
							threadIds: ["thread_child_1"],
							edges: [
								expect.objectContaining({
									childRunId: "agent_run_child_1",
									operation: "spawn_agent",
									status: "running",
								}),
							],
						}),
					}),
				}),
			}),
		]);
		expect(JSON.stringify(fleet)).not.toContain("super-secret-token");

		logs = [];
		await handleA2ACommand(["tasks", "--json", "--tasks", tasksPath]);
		const taskView = JSON.parse(logs.join("\n")) as {
			tasks: Array<{
				peer: string;
				taskId: string;
				state: string;
				workGraph?: {
					state?: string;
					codexSubagents?: { threadIds?: string[] };
				};
			}>;
		};
		expect(taskView.tasks).toEqual([
			expect.objectContaining({
				peer: "mac-mini",
				taskId: "task-mac-mini-1",
				state: "TASK_STATE_COMPLETED",
				workGraph: expect.objectContaining({
					state: "waiting",
					codexSubagents: expect.objectContaining({
						threadIds: ["thread_child_1"],
						edges: [
							expect.objectContaining({
								childRunId: "agent_run_child_1",
								operation: "spawn_agent",
								status: "running",
							}),
						],
					}),
				}),
			}),
		]);
		logs = [];
		await handleA2ACommand(["tasks", "--work-graph", "--tasks", tasksPath]);
		expect(plainLogs(logs)).toContain("Work graph: waiting");
		expect(plainLogs(logs)).toContain("Codex subagents: edges 1");
		expect(plainLogs(logs)).toContain(
			"lifecycle spawn_agent:running(agent_run_child_1)",
		);
		expect(plainLogs(logs)).toContain(
			"Correlation: platform_agent_run_id=run_1 active_work_items=3 blocked_work_items=0 child_runs=1",
		);

		logs = [];
		await handleA2ACommand([
			"wait",
			"mac-mini",
			"task-mac-mini-1",
			"--work-graph",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);
		expect(plainLogs(logs)).toContain("Codex subagents: edges 1");
		expect(plainLogs(logs)).toContain(
			"Correlation: platform_agent_run_id=run_1",
		);
		const fetchesAfterCompletion = taskFetches;

		logs = [];
		await handleA2ACommand([
			"tasks",
			"--refresh",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--timeout-ms",
			"1000",
		]);
		expect(taskFetches).toBe(fetchesAfterCompletion);
		expect(errors.join("\n")).toBe("");
	});

	it("records plain sends in the durable A2A task ledger", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-send-ledger-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await handleA2ACommand([
			"send",
			"mac-mini",
			"check",
			"runtime",
			"health",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		expect(requests).toHaveLength(1);
		expect(recordValue(requests[0]!.body, "message.metadata")).toMatchObject({
			requestKind: "maestro-peer-message",
			relayPeer: "mac-mini",
		});
		expect(plainLogs(logs)).toContain("Task task-mac-mini-1");
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");

		const ledger = JSON.parse(await readFile(tasksPath, "utf8")) as {
			tasks: Array<{
				kind: string;
				peer: string;
				taskId: string;
				text: string;
				responseText?: string;
				metadata?: Record<string, unknown>;
				transcript: Array<{ role: string; text: string; messageId?: string }>;
			}>;
		};
		expect(ledger.tasks).toEqual([
			expect.objectContaining({
				kind: "message",
				peer: "mac-mini",
				taskId: "task-mac-mini-1",
				text: "check runtime health",
				responseText: "mac mini finished the smoke plan",
				metadata: expect.objectContaining({
					requestKind: "maestro-peer-message",
					relayPeer: "mac-mini",
					worker: "mac-mini",
				}),
			}),
		]);
		expect(ledger.tasks[0]!.transcript).toEqual([
			expect.objectContaining({
				role: "user",
				text: "check runtime health",
			}),
			expect.objectContaining({
				role: "agent",
				text: "mac mini finished the smoke plan",
				messageId: "agent-message-1",
			}),
		]);
		expect(JSON.stringify(ledger)).not.toContain("super-secret-token");
	});

	it("preserves an input-required delegated task and completes it after an operator reply", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-input-required-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");
		taskResponses = [
			{
				id: "task-mac-mini-1",
				contextId: "maestro-a2a-context-test",
				status: {
					state: "TASK_STATE_INPUT_REQUIRED",
					message: {
						messageId: "agent-input-required-1",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "Which smoke profile should I run?",
								mediaType: "text/plain",
							},
						],
					},
				},
			},
			{
				id: "task-mac-mini-1",
				contextId: "maestro-a2a-context-test",
				status: {
					state: "TASK_STATE_COMPLETED",
					message: {
						messageId: "agent-message-2",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "short smoke passed after operator reply",
								mediaType: "text/plain",
							},
						],
					},
				},
				artifacts: [
					{
						artifactId: "result",
						parts: [
							{
								text: "short smoke passed after operator reply",
								mediaType: "text/plain",
							},
						],
					},
				],
			},
		];

		await handleA2ACommand([
			"delegate",
			"mac-mini",
			"review",
			"the",
			"release",
			"branch",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		const inputRequiredLedger = JSON.parse(
			await readFile(tasksPath, "utf8"),
		) as {
			tasks: Array<{
				completedAt?: string;
				contextId?: string;
				responseText?: string;
				state: string;
				taskId: string;
			}>;
		};
		expect(inputRequiredLedger.tasks).toHaveLength(1);
		expect(inputRequiredLedger.tasks[0]).toMatchObject({
			taskId: "task-mac-mini-1",
			contextId: "maestro-a2a-context-test",
			state: "TASK_STATE_INPUT_REQUIRED",
			responseText: "Which smoke profile should I run?",
		});
		expect(inputRequiredLedger.tasks[0]!.completedAt).toBeUndefined();

		logs = [];
		await handleA2ACommand([
			"reply",
			"mac-mini",
			"task-mac-mini-1",
			"use",
			"the",
			"short",
			"smoke",
			"profile",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		expect(requests).toHaveLength(2);
		expect(recordValue(requests[1]!.body, "message.taskId")).toBe(
			"task-mac-mini-1",
		);
		expect(recordValue(requests[1]!.body, "message.contextId")).toBe(
			"maestro-a2a-context-test",
		);
		expect(plainLogs(logs)).toContain(
			"short smoke passed after operator reply",
		);
		const completedLedger = JSON.parse(await readFile(tasksPath, "utf8")) as {
			tasks: Array<{
				completedAt?: string;
				contextId?: string;
				responseText?: string;
				state: string;
				taskId: string;
				transcript: Array<{
					messageId?: string;
					role: string;
					state?: string;
					text: string;
				}>;
			}>;
		};
		expect(completedLedger.tasks).toHaveLength(1);
		expect(completedLedger.tasks[0]).toMatchObject({
			taskId: "task-mac-mini-1",
			contextId: "maestro-a2a-context-test",
			state: "TASK_STATE_COMPLETED",
			responseText: "short smoke passed after operator reply",
		});
		expect(completedLedger.tasks[0]!.completedAt).toEqual(expect.any(String));
		expect(completedLedger.tasks[0]!.transcript).toEqual([
			expect.objectContaining({
				role: "user",
				text: "review the release branch",
			}),
			expect.objectContaining({
				messageId: "agent-input-required-1",
				role: "agent",
				state: "TASK_STATE_INPUT_REQUIRED",
				text: "Which smoke profile should I run?",
			}),
			expect.objectContaining({
				role: "user",
				text: "use the short smoke profile",
			}),
			expect.objectContaining({
				messageId: "agent-message-2",
				role: "agent",
				state: "TASK_STATE_COMPLETED",
				text: "short smoke passed after operator reply",
			}),
		]);
		expect(JSON.stringify(completedLedger)).not.toContain("super-secret-token");
		expect(errors.join("\n")).toBe("");
	});

	it("coordinates pending tasks by refreshing input-required work without replying", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-coordinate-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		await writeFile(
			tasksPath,
			JSON.stringify({
				tasks: [
					{
						id: "maestro-a2a-ledger-1",
						kind: "delegation",
						peer: "mac-mini",
						taskId: "task-mac-mini-1",
						contextId: "maestro-a2a-context-test",
						messageId: "message-1",
						text: "review the release branch",
						state: "TASK_STATE_SUBMITTED",
						transcript: [
							{
								at: "2026-05-16T00:00:00.000Z",
								role: "user",
								text: "review the release branch",
								messageId: "message-1",
							},
						],
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:00:00.000Z",
					},
				],
			}),
		);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");
		taskResponses = [
			{
				id: "task-mac-mini-1",
				contextId: "maestro-a2a-context-test",
				status: {
					state: "TASK_STATE_INPUT_REQUIRED",
					message: {
						messageId: "agent-input-required-1",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "Which smoke profile should I run?",
								mediaType: "text/plain",
							},
						],
					},
				},
				metadata: {
					workGraph: workGraphMetadata({
						state: "blocked",
						blockedItemCount: 1,
					}),
				},
			},
		];

		await handleA2ACommand([
			"coordinate",
			"mac-mini",
			"--work-graph",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--timeout-ms",
			"1000",
		]);

		expect(requests).toHaveLength(0);
		expect(taskFetches).toBe(1);
		expect(plainLogs(logs)).toContain("A2A coordinate");
		expect(plainLogs(logs)).toContain("TASK_STATE_INPUT_REQUIRED");
		expect(plainLogs(logs)).toContain("Which smoke profile should I run?");
		expect(plainLogs(logs)).toContain("Work graph: blocked");
		expect(plainLogs(logs)).toContain("Codex subagents: edges 1");
		const ledger = JSON.parse(await readFile(tasksPath, "utf8")) as {
			tasks: Array<{
				contextId?: string;
				responseText?: string;
				state: string;
				taskId: string;
				transcript: Array<{ role: string; text: string }>;
				workGraph?: { state?: string; blockedItemCount?: number };
			}>;
		};
		expect(ledger.tasks).toHaveLength(1);
		expect(ledger.tasks[0]).toMatchObject({
			taskId: "task-mac-mini-1",
			contextId: "maestro-a2a-context-test",
			state: "TASK_STATE_INPUT_REQUIRED",
			responseText: "Which smoke profile should I run?",
			workGraph: expect.objectContaining({
				state: "blocked",
				blockedItemCount: 1,
			}),
		});
		expect(ledger.tasks[0]!.transcript).toEqual([
			expect.objectContaining({
				role: "user",
				text: "review the release branch",
			}),
			expect.objectContaining({
				role: "agent",
				text: "Which smoke profile should I run?",
			}),
		]);
		expect(JSON.stringify(ledger)).not.toContain("super-secret-token");
		expect(errors.join("\n")).toBe("");
	});

	it("continues coordinate refresh when one non-final peer task cannot be refreshed", async () => {
		const dir = await mkdtemp(
			join(tmpdir(), "maestro-a2a-coordinate-partial-refresh-"),
		);
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		await writeFile(
			tasksPath,
			JSON.stringify({
				tasks: [
					{
						id: "maestro-a2a-ledger-missing",
						kind: "delegation",
						peer: "offline-peer",
						taskId: "task-offline-1",
						contextId: "maestro-a2a-context-offline",
						text: "check the offline peer",
						state: "TASK_STATE_SUBMITTED",
						transcript: [
							{
								at: "2026-05-16T00:00:00.000Z",
								role: "user",
								text: "check the offline peer",
							},
						],
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:02:00.000Z",
					},
					{
						id: "maestro-a2a-ledger-1",
						kind: "delegation",
						peer: "mac-mini",
						taskId: "task-mac-mini-1",
						contextId: "maestro-a2a-context-test",
						messageId: "message-1",
						text: "review the release branch",
						state: "TASK_STATE_SUBMITTED",
						transcript: [
							{
								at: "2026-05-16T00:00:00.000Z",
								role: "user",
								text: "review the release branch",
								messageId: "message-1",
							},
						],
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:01:00.000Z",
					},
				],
			}),
		);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");
		taskResponses = [
			{
				id: "task-mac-mini-1",
				contextId: "maestro-a2a-context-test",
				status: {
					state: "TASK_STATE_INPUT_REQUIRED",
					message: {
						messageId: "agent-input-required-1",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "Which smoke profile should I run?",
								mediaType: "text/plain",
							},
						],
					},
				},
			},
		];

		await handleA2ACommand([
			"coordinate",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--timeout-ms",
			"1000",
		]);

		expect(taskFetches).toBe(1);
		expect(requests).toHaveLength(0);
		expect(plainLogs(logs)).toContain("task-mac-mini-1");
		expect(plainLogs(logs)).toContain("TASK_STATE_INPUT_REQUIRED");
		expect(errors.join("\n")).toContain(
			"could not refresh offline-peer task task-offline-1",
		);
		expect(errors.join("\n")).not.toContain("super-secret-token");
	});

	it("rejects coordinate reply flags without reply text", async () => {
		await expect(
			handleA2ACommand(["coordinate", "mac-mini", "--reply", "--wait"]),
		).rejects.toThrow("--reply requires text");

		expect(requests).toHaveLength(0);
		expect(taskFetches).toBe(0);
	});

	it("coordinates an input-required task by replying and waiting on the same ledger entry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-coordinate-reply-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		await writeFile(
			tasksPath,
			JSON.stringify({
				tasks: [
					{
						id: "maestro-a2a-ledger-1",
						kind: "delegation",
						peer: "mac-mini",
						taskId: "task-mac-mini-1",
						contextId: "maestro-a2a-context-test",
						messageId: "message-1",
						text: "review the release branch",
						state: "TASK_STATE_INPUT_REQUIRED",
						responseText: "Which smoke profile should I run?",
						transcript: [
							{
								at: "2026-05-16T00:00:00.000Z",
								role: "user",
								text: "review the release branch",
								messageId: "message-1",
							},
							{
								at: "2026-05-16T00:01:00.000Z",
								role: "agent",
								text: "Which smoke profile should I run?",
								state: "TASK_STATE_INPUT_REQUIRED",
								messageId: "agent-input-required-1",
							},
						],
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:01:00.000Z",
					},
				],
			}),
		);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");
		taskResponses = [
			{
				id: "task-mac-mini-1",
				contextId: "maestro-a2a-context-test",
				status: {
					state: "TASK_STATE_INPUT_REQUIRED",
					message: {
						messageId: "agent-input-required-1",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "Which smoke profile should I run?",
								mediaType: "text/plain",
							},
						],
					},
				},
			},
			{
				id: "task-mac-mini-1",
				contextId: "maestro-a2a-context-test",
				status: {
					state: "TASK_STATE_COMPLETED",
					message: {
						messageId: "agent-message-2",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "short smoke passed after operator reply",
								mediaType: "text/plain",
							},
						],
					},
				},
				artifacts: [
					{
						artifactId: "result",
						parts: [
							{
								text: "short smoke passed after operator reply",
								mediaType: "text/plain",
							},
						],
					},
				],
			},
		];

		await handleA2ACommand([
			"coordinate",
			"mac-mini",
			"--reply",
			"use the short smoke profile",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		expect(requests).toHaveLength(1);
		expect(recordValue(requests[0]!.body, "message.taskId")).toBe(
			"task-mac-mini-1",
		);
		expect(recordValue(requests[0]!.body, "message.contextId")).toBe(
			"maestro-a2a-context-test",
		);
		expect(plainLogs(logs)).toContain(
			"Coordinated mac-mini task task-mac-mini-1",
		);
		expect(plainLogs(logs)).toContain(
			"short smoke passed after operator reply",
		);
		const ledger = JSON.parse(await readFile(tasksPath, "utf8")) as {
			tasks: Array<{
				completedAt?: string;
				contextId?: string;
				id: string;
				responseText?: string;
				state: string;
				taskId: string;
				transcript: Array<{
					messageId?: string;
					role: string;
					state?: string;
					text: string;
				}>;
			}>;
		};
		expect(ledger.tasks).toHaveLength(1);
		expect(ledger.tasks[0]).toMatchObject({
			id: "maestro-a2a-ledger-1",
			taskId: "task-mac-mini-1",
			contextId: "maestro-a2a-context-test",
			state: "TASK_STATE_COMPLETED",
			responseText: "short smoke passed after operator reply",
		});
		expect(ledger.tasks[0]!.completedAt).toEqual(expect.any(String));
		expect(ledger.tasks[0]!.transcript).toEqual([
			expect.objectContaining({
				role: "user",
				text: "review the release branch",
			}),
			expect.objectContaining({
				messageId: "agent-input-required-1",
				role: "agent",
				state: "TASK_STATE_INPUT_REQUIRED",
				text: "Which smoke profile should I run?",
			}),
			expect.objectContaining({
				role: "user",
				text: "use the short smoke profile",
			}),
			expect.objectContaining({
				messageId: "agent-message-2",
				role: "agent",
				state: "TASK_STATE_COMPLETED",
				text: "short smoke passed after operator reply",
			}),
		]);
		expect(JSON.stringify(ledger)).not.toContain("super-secret-token");
		expect(errors.join("\n")).toBe("");
	});

	it("refreshes stale actionable tasks before choosing a coordinate reply target", async () => {
		const dir = await mkdtemp(
			join(tmpdir(), "maestro-a2a-coordinate-stale-ambiguous-"),
		);
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		await writeFile(
			tasksPath,
			JSON.stringify({
				tasks: [
					{
						id: "maestro-a2a-ledger-1",
						kind: "delegation",
						peer: "mac-mini",
						taskId: "task-mac-mini-1",
						contextId: "maestro-a2a-context-1",
						text: "review the release branch",
						state: "TASK_STATE_INPUT_REQUIRED",
						responseText: "Which smoke profile should I run?",
						transcript: [
							{
								at: "2026-05-16T00:00:00.000Z",
								role: "user",
								text: "review the release branch",
							},
							{
								at: "2026-05-16T00:01:00.000Z",
								role: "agent",
								text: "Which smoke profile should I run?",
								state: "TASK_STATE_INPUT_REQUIRED",
							},
						],
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:03:00.000Z",
					},
					{
						id: "maestro-a2a-ledger-2",
						kind: "delegation",
						peer: "mac-mini",
						taskId: "task-mac-mini-2",
						contextId: "maestro-a2a-context-2",
						text: "review the docs branch",
						state: "TASK_STATE_INPUT_REQUIRED",
						responseText: "Which docs scope should I run?",
						transcript: [
							{
								at: "2026-05-16T00:02:00.000Z",
								role: "user",
								text: "review the docs branch",
							},
							{
								at: "2026-05-16T00:03:00.000Z",
								role: "agent",
								text: "Which docs scope should I run?",
								state: "TASK_STATE_INPUT_REQUIRED",
							},
						],
						createdAt: "2026-05-16T00:02:00.000Z",
						updatedAt: "2026-05-16T00:01:00.000Z",
					},
				],
			}),
		);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");
		taskResponses = [
			{
				id: "task-mac-mini-1",
				contextId: "maestro-a2a-context-1",
				status: {
					state: "TASK_STATE_COMPLETED",
					message: {
						messageId: "agent-completed-1",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "release branch smoke already passed",
								mediaType: "text/plain",
							},
						],
					},
				},
			},
			{
				id: "task-mac-mini-2",
				contextId: "maestro-a2a-context-2",
				status: {
					state: "TASK_STATE_INPUT_REQUIRED",
					message: {
						messageId: "agent-input-required-2",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "Which docs scope should I run?",
								mediaType: "text/plain",
							},
						],
					},
				},
			},
			{
				id: "task-mac-mini-2",
				contextId: "maestro-a2a-context-2",
				status: {
					state: "TASK_STATE_COMPLETED",
					message: {
						messageId: "agent-completed-2",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "docs smoke passed",
								mediaType: "text/plain",
							},
						],
					},
				},
				artifacts: [
					{
						artifactId: "result",
						parts: [
							{
								text: "docs smoke passed",
								mediaType: "text/plain",
							},
						],
					},
				],
			},
		];

		await handleA2ACommand([
			"coordinate",
			"mac-mini",
			"--reply",
			"use the docs smoke scope",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		expect(taskFetches).toBe(3);
		expect(requests).toHaveLength(1);
		expect(recordValue(requests[0]!.body, "message.taskId")).toBe(
			"task-mac-mini-2",
		);
		expect(recordValue(requests[0]!.body, "message.contextId")).toBe(
			"maestro-a2a-context-2",
		);
		expect(plainLogs(logs)).toContain(
			"Coordinated mac-mini task task-mac-mini-2",
		);
		expect(plainLogs(logs)).toContain("docs smoke passed");
		const ledger = JSON.parse(await readFile(tasksPath, "utf8")) as {
			tasks: Array<{
				completedAt?: string;
				responseText?: string;
				state: string;
				taskId: string;
			}>;
		};
		expect(ledger.tasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					taskId: "task-mac-mini-1",
					state: "TASK_STATE_COMPLETED",
					responseText: "release branch smoke already passed",
					completedAt: expect.any(String),
				}),
				expect.objectContaining({
					taskId: "task-mac-mini-2",
					state: "TASK_STATE_COMPLETED",
					responseText: "docs smoke passed",
					completedAt: expect.any(String),
				}),
			]),
		);
		expect(errors.join("\n")).toBe("");
	});

	it("refuses coordinate replies when more than one actionable task matches", async () => {
		const dir = await mkdtemp(
			join(tmpdir(), "maestro-a2a-coordinate-ambiguous-"),
		);
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		await writeFile(
			tasksPath,
			JSON.stringify({
				tasks: [
					{
						id: "maestro-a2a-ledger-1",
						kind: "delegation",
						peer: "mac-mini",
						taskId: "task-mac-mini-1",
						contextId: "maestro-a2a-context-1",
						text: "review the release branch",
						state: "TASK_STATE_INPUT_REQUIRED",
						responseText: "Which smoke profile should I run?",
						transcript: [
							{
								at: "2026-05-16T00:00:00.000Z",
								role: "user",
								text: "review the release branch",
							},
							{
								at: "2026-05-16T00:01:00.000Z",
								role: "agent",
								text: "Which smoke profile should I run?",
								state: "TASK_STATE_INPUT_REQUIRED",
							},
						],
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:01:00.000Z",
					},
					{
						id: "maestro-a2a-ledger-2",
						kind: "delegation",
						peer: "mac-mini",
						taskId: "task-mac-mini-2",
						contextId: "maestro-a2a-context-2",
						text: "review the docs branch",
						state: "TASK_STATE_INPUT_REQUIRED",
						responseText: "Which docs scope should I run?",
						transcript: [
							{
								at: "2026-05-16T00:02:00.000Z",
								role: "user",
								text: "review the docs branch",
							},
							{
								at: "2026-05-16T00:03:00.000Z",
								role: "agent",
								text: "Which docs scope should I run?",
								state: "TASK_STATE_INPUT_REQUIRED",
							},
						],
						createdAt: "2026-05-16T00:02:00.000Z",
						updatedAt: "2026-05-16T00:03:00.000Z",
					},
				],
			}),
		);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");
		taskResponses = [
			{
				id: "task-mac-mini-2",
				contextId: "maestro-a2a-context-2",
				status: {
					state: "TASK_STATE_INPUT_REQUIRED",
					message: {
						messageId: "agent-input-required-2",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "Which docs scope should I run?",
								mediaType: "text/plain",
							},
						],
					},
				},
			},
			{
				id: "task-mac-mini-1",
				contextId: "maestro-a2a-context-1",
				status: {
					state: "TASK_STATE_INPUT_REQUIRED",
					message: {
						messageId: "agent-input-required-1",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "Which smoke profile should I run?",
								mediaType: "text/plain",
							},
						],
					},
				},
			},
		];

		await expect(
			handleA2ACommand([
				"coordinate",
				"mac-mini",
				"--reply",
				"use the short smoke profile",
				"--registry",
				registryPath,
				"--tasks",
				tasksPath,
				"--timeout-ms",
				"1000",
			]),
		).rejects.toThrow("Multiple actionable A2A tasks found");

		expect(requests).toHaveLength(0);
		expect(taskFetches).toBe(2);
		expect(errors.join("\n")).not.toContain("super-secret-token");
	});

	it("reports delegation success when local ledger persistence fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-fail-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks-as-dir");
		await writeRegistry(registryPath, baseUrl);
		await mkdir(tasksPath);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await expect(
			handleA2ACommand([
				"delegate",
				"mac-mini",
				"run",
				"the",
				"tmux",
				"smoke",
				"--wait",
				"--registry",
				registryPath,
				"--tasks",
				tasksPath,
				"--max-wait-ms",
				"1000",
				"--interval-ms",
				"10",
				"--timeout-ms",
				"1000",
			]),
		).resolves.toBeUndefined();

		expect(requests).toHaveLength(1);
		expect(plainLogs(logs)).toContain("Delegated to mac-mini");
		expect(plainLogs(logs)).toContain(
			"Task task-mac-mini-1: TASK_STATE_COMPLETED",
		);
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");
		expect(plainLogs(errors)).toContain("A2A task ledger warning");
		expect(plainLogs(errors)).not.toContain("super-secret-token");
	});

	it("replies to an existing task using the durable context", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-reply-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		await writeFile(
			tasksPath,
			JSON.stringify({
				tasks: [
					{
						id: "maestro-a2a-ledger-1",
						kind: "delegation",
						peer: "mac-mini",
						taskId: "task-mac-mini-1",
						contextId: "maestro-a2a-context-test",
						messageId: "message-1",
						text: "review the branch",
						state: "TASK_STATE_INPUT_REQUIRED",
						transcript: [
							{
								at: "2026-05-16T00:00:00.000Z",
								role: "user",
								text: "review the branch",
								messageId: "message-1",
							},
						],
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:00:00.000Z",
					},
				],
			}),
		);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await handleA2ACommand([
			"reply",
			"mac-mini",
			"task-mac-mini-1",
			"use",
			"the",
			"short",
			"smoke",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		expect(requests).toHaveLength(1);
		expect(recordValue(requests[0]!.body, "message.taskId")).toBe(
			"task-mac-mini-1",
		);
		expect(recordValue(requests[0]!.body, "message.contextId")).toBe(
			"maestro-a2a-context-test",
		);
		expect(recordValue(requests[0]!.body, "message.metadata")).toMatchObject({
			requestKind: "maestro-peer-task-reply",
			referencedTaskId: "task-mac-mini-1",
			relayPeer: "mac-mini",
		});
		expect(plainLogs(logs)).toContain(
			"Replied to mac-mini task task-mac-mini-1",
		);
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");

		const ledgerRaw = await readFile(tasksPath, "utf8");
		expect(ledgerRaw).toContain("review the branch");
		expect(ledgerRaw).toContain("use the short smoke");
		expect(ledgerRaw).toContain("mac mini finished the smoke plan");
		expect(ledgerRaw).not.toContain("super-secret-token");
		expect(errors.join("\n")).toBe("");
	});

	it("replies by task id when the local ledger context cannot be loaded", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-reply-no-ledger-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks-as-dir");
		await writeRegistry(registryPath, baseUrl);
		await mkdir(tasksPath);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await expect(
			handleA2ACommand([
				"reply",
				"mac-mini",
				"task-mac-mini-1",
				"use",
				"the",
				"short",
				"smoke",
				"--registry",
				registryPath,
				"--tasks",
				tasksPath,
				"--timeout-ms",
				"1000",
			]),
		).resolves.toBeUndefined();

		expect(requests).toHaveLength(1);
		expect(recordValue(requests[0]!.body, "message.taskId")).toBe(
			"task-mac-mini-1",
		);
		expect(recordValue(requests[0]!.body, "message.contextId")).toBeUndefined();
		expect(plainLogs(logs)).toContain(
			"Replied to mac-mini task task-mac-mini-1",
		);
		expect(plainLogs(errors)).toContain("could not load task reply context");
		expect(plainLogs(errors)).toContain("A2A task ledger warning");
		expect(plainLogs(errors)).not.toContain("super-secret-token");
	});

	it("reports wait completion when local ledger update fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-wait-ledger-fail-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks-as-dir");
		await writeRegistry(registryPath, baseUrl);
		await mkdir(tasksPath);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await expect(
			handleA2ACommand([
				"wait",
				"mac-mini",
				"task-mac-mini-1",
				"--registry",
				registryPath,
				"--tasks",
				tasksPath,
				"--max-wait-ms",
				"1000",
				"--interval-ms",
				"10",
				"--timeout-ms",
				"1000",
			]),
		).resolves.toBeUndefined();

		expect(plainLogs(logs)).toContain(
			"Task task-mac-mini-1: TASK_STATE_COMPLETED",
		);
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");
		expect(plainLogs(errors)).toContain("A2A task ledger warning");
		expect(plainLogs(errors)).not.toContain("super-secret-token");
	});
});

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function recordValue(input: unknown, path: string): unknown {
	let current = input;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function plainLogs(entries: string[]): string {
	return entries.join("\n").replace(ANSI_ESCAPE_PATTERN, "");
}

function workGraphMetadata(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		state: "waiting",
		itemCount: 3,
		activeItemCount: 3,
		blockedItemCount: 0,
		waitingItemCount: 1,
		childRunCount: 1,
		childRunIds: ["agent_run_child_1"],
		toolCallCount: 2,
		pendingToolCallCount: 1,
		toolExecutionIds: ["tool_exec_1"],
		waitItemCount: 1,
		waitIds: ["thread_child_1"],
		stateCounts: {
			AGENT_WORK_ITEM_STATE_WAITING: 1,
			AGENT_WORK_ITEM_STATE_RUNNING: 2,
		},
		correlationPath:
			"platform_agent_run_id=run_1 active_work_items=3 blocked_work_items=0 child_runs=1",
		codexSubagents: {
			edgeCount: 1,
			edges: [
				{
					spawnToolCallId: "toolu_spawn_child",
					waitToolCallId: "toolu_wait_child",
					childRunId: "agent_run_child_1",
					threadId: "thread_child_1",
					operation: "spawn_agent",
					status: "running",
				},
			],
			childRunIds: ["agent_run_child_1"],
			toolCallIds: ["toolu_spawn_child", "toolu_wait_child"],
			threadIds: ["thread_child_1"],
		},
		...overrides,
	};
}

async function writeRegistry(path: string, baseUrl: string): Promise<void> {
	await writeFile(
		path,
		JSON.stringify({
			defaultPeer: "mac-mini",
			peers: {
				"mac-mini": {
					url: baseUrl,
					displayName: "Mac mini Maestro",
					agentCardUrl: `${baseUrl}/.well-known/agent-card.json`,
					tokenEnv: "MAC_MINI_A2A_TOKEN",
					metadata: {
						model: "opus",
						cwd: "/Users/jonathanhaas/Documents/Projects/maestro-internal",
					},
				},
			},
		}),
	);
}
