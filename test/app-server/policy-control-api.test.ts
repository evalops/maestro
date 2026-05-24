import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MaestroAppServerPolicyReadResult,
	MaestroAppServerRequirementsListResult,
} from "@evalops/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import {
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { loadPolicy } from "../../src/safety/policy.js";
import { SessionManager } from "../../src/session/manager.js";

describe("Maestro app-server managed policy API", () => {
	let testDir: string;
	let manager: SessionManager;
	const originalPolicyPath = process.env.MAESTRO_POLICY_PATH;
	const originalEnterprisePolicyPath =
		process.env.MAESTRO_ENTERPRISE_POLICY_PATH;

	beforeEach(() => {
		testDir = join(tmpdir(), `maestro-app-server-policy-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		manager = new SessionManager(false, undefined, { sessionDir: testDir });
		process.env.MAESTRO_POLICY_PATH = join(testDir, "policy.json");
		Reflect.deleteProperty(process.env, "MAESTRO_ENTERPRISE_POLICY_PATH");
		loadPolicy(true);
	});

	afterEach(() => {
		manager.disable();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		if (originalPolicyPath === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_POLICY_PATH");
		} else {
			process.env.MAESTRO_POLICY_PATH = originalPolicyPath;
		}
		if (originalEnterprisePolicyPath === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_ENTERPRISE_POLICY_PATH");
		} else {
			process.env.MAESTRO_ENTERPRISE_POLICY_PATH = originalEnterprisePolicyPath;
		}
		loadPolicy(true);
	});

	function writePolicy(policy: object): void {
		writeFileSync(
			process.env.MAESTRO_POLICY_PATH ?? join(testDir, "policy.json"),
			JSON.stringify(policy),
			"utf8",
		);
		loadPolicy(true);
	}

	it("advertises managed policy and requirements capabilities", () => {
		const api = createMaestroAppServerSessionApi(manager);

		expect(api.initialize()).toMatchObject({
			capabilities: {
				managedPolicy: true,
				requirements: true,
			},
		});
	});

	it("reads effective policy and lists policy-backed requirements", async () => {
		writePolicy({
			orgId: "org-1",
			skills: { required: ["security-review", "cua-proof"] },
			limits: { maxTokensPerSession: 10 },
		});
		const api = createMaestroAppServerSessionApi(manager);

		const policyResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "policy-read",
			method: "policy/read",
		});
		expect(policyResponse.result).toEqual({
			loaded: true,
			policy: {
				orgId: "org-1",
				skills: { required: ["security-review", "cua-proof"] },
				limits: { maxTokensPerSession: 10 },
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, policyResponse)).toBe(
			true,
		);

		const requirementsResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "requirements",
			method: "requirements/list",
		});
		expect(requirementsResponse.result).toEqual({
			requirements: [
				{ kind: "skill", id: "security-review", required: true },
				{ kind: "skill", id: "cua-proof", required: true },
			],
			requiredSkills: ["security-review", "cua-proof"],
		});
		expect(
			Value.Check(MaestroAppServerResponseSchema, requirementsResponse),
		).toBe(true);
		const requirementsResult =
			requirementsResponse.result as MaestroAppServerRequirementsListResult;
		expect(Object.isFrozen(requirementsResult.requiredSkills)).toBe(true);
		expect(() => {
			requirementsResult.requiredSkills.push("mutated-skill");
		}).toThrow(TypeError);

		const requirementsResponseAfterMutation =
			await handleMaestroAppServerRequest(api, {
				jsonrpc: "2.0",
				id: "requirements-after-mutation",
				method: "requirements/list",
			});
		expect(requirementsResponseAfterMutation.result).toMatchObject({
			requiredSkills: ["security-review", "cua-proof"],
		});
	});

	it("returns an immutable policy snapshot without mutating active enforcement", async () => {
		writePolicy({
			orgId: "org-1",
			tools: { blocked: ["bash"] },
		});
		const api = createMaestroAppServerSessionApi(manager);

		const policyResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "policy-read",
			method: "policy/read",
		});
		const readResult =
			policyResponse.result as MaestroAppServerPolicyReadResult;
		const snapshot = readResult.policy;
		if (!snapshot?.tools?.blocked) {
			throw new Error("expected policy snapshot with blocked tools");
		}
		const blockedTools = snapshot.tools.blocked;
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.tools)).toBe(true);
		expect(Object.isFrozen(blockedTools)).toBe(true);
		expect(() => {
			blockedTools.push("read");
		}).toThrow(TypeError);

		const checkResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "policy-check",
			method: "policy/check",
			params: {
				action: { toolName: "bash", args: {} },
			},
		});
		expect(checkResponse.result).toMatchObject({
			allowed: false,
			checks: [{ kind: "action", allowed: false }],
		});
	});

	it("evaluates action, model, and session policy checks together", async () => {
		writePolicy({
			orgId: "org-1",
			tools: { blocked: ["bash"] },
			models: { allowed: ["openai/*"] },
			limits: { maxSessionDurationMinutes: 5, maxTokensPerSession: 10 },
		});
		const api = createMaestroAppServerSessionApi(manager);
		const activeSession = {
			startedAt: new Date().toISOString(),
		};

		const blocked = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "blocked-policy",
			method: "policy/check",
			params: {
				action: {
					toolName: "bash",
					args: {},
					user: { id: "user-1", orgId: "org-1" },
				},
				modelId: "anthropic/claude-opus-4",
				session: activeSession,
				usage: { tokenCount: 4 },
			},
		});
		expect(blocked.result).toMatchObject({
			allowed: false,
			checks: [
				{ kind: "action", allowed: false },
				{ kind: "model", allowed: false },
				{ kind: "session", allowed: true },
			],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, blocked)).toBe(true);

		const allowed = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "allowed-policy",
			method: "policy/check",
			params: {
				action: {
					toolName: "read",
					args: {},
					user: { id: "user-1", orgId: "org-1" },
				},
				modelId: "openai/gpt-5.5",
				session: activeSession,
				usage: { tokenCount: 4 },
			},
		});
		expect(allowed.result).toEqual({
			allowed: true,
			checks: [
				{ kind: "action", allowed: true },
				{ kind: "model", allowed: true },
				{ kind: "session", allowed: true },
			],
		});
	});

	it("accepts native Date session timestamps from in-process clients", async () => {
		writePolicy({
			limits: { maxSessionDurationMinutes: 5 },
		});
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "date-session-policy",
			method: "policy/check",
			params: {
				action: { toolName: "read", args: {} },
				session: { startedAt: new Date() },
			},
		});

		expect(response.result).toEqual({
			allowed: true,
			checks: [
				{ kind: "action", allowed: true },
				{ kind: "session", allowed: true },
			],
		});
	});

	it("uses top-level session context when action session is null", async () => {
		writePolicy({
			limits: { maxSessionDurationMinutes: 5 },
		});
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "null-action-session-policy",
			method: "policy/check",
			params: {
				action: { toolName: "read", args: {}, session: null },
				session: { startedAt: new Date().toISOString() },
			},
		});

		expect(response.result).toEqual({
			allowed: true,
			checks: [
				{ kind: "action", allowed: true },
				{ kind: "session", allowed: true },
			],
		});
	});

	it("accepts id-less action-scoped session context", async () => {
		writePolicy({
			limits: { maxSessionDurationMinutes: 5 },
		});
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "action-session-policy",
			method: "policy/check",
			params: {
				action: {
					toolName: "read",
					args: {},
					session: { startedAt: new Date().toISOString() },
				},
			},
		});

		expect(response.result).toEqual({
			allowed: true,
			checks: [
				{ kind: "action", allowed: true },
				{ kind: "session", allowed: true },
			],
		});
	});

	it("applies session limits to action-scoped session context", async () => {
		writePolicy({
			limits: { maxTokensPerSession: 10 },
		});
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "action-session-token-limit-policy",
			method: "policy/check",
			params: {
				action: {
					toolName: "read",
					args: {},
					session: { startedAt: new Date().toISOString() },
				},
				usage: { tokenCount: 11 },
			},
		});

		expect(response.result).toEqual({
			allowed: false,
			reason:
				"Session token limit exceeded (11/10 tokens). Please start a new session.",
			checks: [
				{ kind: "action", allowed: true },
				{
					kind: "session",
					allowed: false,
					reason:
						"Session token limit exceeded (11/10 tokens). Please start a new session.",
				},
			],
		});
	});

	it("rejects negative usage counters", async () => {
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "negative-usage",
			method: "policy/check",
			params: {
				session: { startedAt: new Date().toISOString() },
				usage: { tokenCount: -1 },
			},
		});

		expect(response.error).toMatchObject({
			code: -32602,
			message: "Invalid usage.tokenCount",
		});
	});

	it("reports no active policy as loaded false without blocking checks", async () => {
		const api = createMaestroAppServerSessionApi(manager);

		const policyResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "policy-read",
			method: "policy/read",
		});
		expect(policyResponse.result).toEqual({
			loaded: false,
			policy: null,
		});

		const checkResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "policy-check",
			method: "policy/check",
			params: {
				action: { toolName: "read", args: {} },
			},
		});
		expect(checkResponse.result).toEqual({
			allowed: true,
			checks: [{ kind: "action", allowed: true }],
		});
	});
});
