import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type PermissionProfile,
	buildNativeSandboxPolicy,
	intersectPermissionProfiles,
	mergePermissionProfiles,
	nativeSandboxPolicyFromPermissionProfile,
	normalizePermissionProfile,
	permissionProfileFromNativeSandboxPolicy,
} from "../../src/safety/permission-profile.js";

describe("permission profiles", () => {
	let cwd: string;
	let extraRoot: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `permission-profile-${Date.now()}`);
		extraRoot = join(cwd, "scratch");
		mkdirSync(extraRoot, { recursive: true });
		cwd = realpathSync(cwd);
		extraRoot = realpathSync(extraRoot);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("normalizes and deduplicates concrete paths", () => {
		const profile = normalizePermissionProfile(
			{
				fileSystem: {
					entries: [
						{ path: { kind: "path", path: "scratch" }, access: "read-write" },
						{
							path: { kind: "path", path: extraRoot },
							access: "read-write",
						},
					],
				},
				network: { enabled: true },
			},
			{ cwd },
		);

		expect(profile).toEqual({
			fileSystem: {
				entries: [
					{ path: { kind: "path", path: extraRoot }, access: "read-write" },
				],
			},
			network: { enabled: true },
		});
	});

	it("only allows glob entries as deny constraints", () => {
		expect(() =>
			normalizePermissionProfile({
				fileSystem: {
					entries: [
						{
							path: { kind: "glob", pattern: "**/*.env" },
							access: "read-write",
						},
					],
				},
			}),
		).toThrow("glob entries may only be deny rules");

		expect(
			normalizePermissionProfile({
				fileSystem: {
					entries: [
						{ path: { kind: "glob", pattern: "**/*.env" }, access: "none" },
					],
				},
			}).fileSystem?.entries,
		).toEqual([
			{ path: { kind: "glob", pattern: "**/*.env" }, access: "none" },
		]);
	});

	it("merges file-system entries and network grants", () => {
		const merged = mergePermissionProfiles(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "special", value: "workspace" },
							access: "read-write",
						},
					],
				},
				network: { enabled: false },
			},
			{
				fileSystem: {
					entries: [
						{ path: { kind: "path", path: extraRoot }, access: "read-write" },
					],
					globScanMaxDepth: 4,
				},
				network: { enabled: true },
			},
			{ cwd },
		);

		expect(merged.network).toEqual({ enabled: true });
		expect(merged.fileSystem?.globScanMaxDepth).toBe(4);
		expect(merged.fileSystem?.entries).toContainEqual({
			path: { kind: "special", value: "workspace" },
			access: "read-write",
		});
		expect(merged.fileSystem?.entries).toContainEqual({
			path: { kind: "path", path: extraRoot },
			access: "read-write",
		});
	});

	it("intersects requested and granted file-system and network access", () => {
		const requested: PermissionProfile = {
			fileSystem: {
				entries: [
					{
						path: { kind: "special", value: "workspace" },
						access: "read-write",
					},
					{ path: { kind: "glob", pattern: "**/.env" }, access: "none" },
				],
			},
			network: { enabled: false },
		};
		const granted: PermissionProfile = {
			fileSystem: {
				entries: [
					{ path: { kind: "path", path: extraRoot }, access: "read-write" },
					{ path: { kind: "path", path: "/var/log" }, access: "read-write" },
				],
			},
			network: { enabled: true },
		};

		const intersection = intersectPermissionProfiles(requested, granted, {
			cwd,
		});

		expect(intersection.network).toEqual({ enabled: false });
		expect(intersection.fileSystem?.entries).toContainEqual({
			path: { kind: "path", path: extraRoot },
			access: "read-write",
		});
		expect(intersection.fileSystem?.entries).toContainEqual({
			path: { kind: "glob", pattern: "**/.env" },
			access: "none",
		});
		expect(intersection.fileSystem?.entries).not.toContainEqual({
			path: { kind: "path", path: "/var/log" },
			access: "read-write",
		});
	});

	it("canonicalizes special tmp paths when intersecting concrete temp paths", () => {
		const tmpPath = realpathSync("/tmp");
		const tmpChild = join(tmpPath, "maestro-permission-profile-child");

		const intersection = intersectPermissionProfiles(
			{
				fileSystem: {
					entries: [
						{ path: { kind: "path", path: tmpChild }, access: "read-write" },
					],
				},
			},
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "special", value: "tmp" },
							access: "read-write",
						},
					],
				},
			},
			{ cwd },
		);

		expect(intersection.fileSystem?.entries).toContainEqual({
			path: { kind: "path", path: tmpChild },
			access: "read-write",
		});
	});

	it("intersects to the narrower path and least privileged access", () => {
		const nestedRoot = join(extraRoot, "nested");
		mkdirSync(nestedRoot, { recursive: true });
		const resolvedNestedRoot = realpathSync(nestedRoot);

		expect(
			intersectPermissionProfiles(
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "path", path: nestedRoot },
								access: "read-only",
							},
						],
					},
				},
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "special", value: "workspace" },
								access: "read-write",
							},
						],
					},
				},
				{ cwd },
			).fileSystem?.entries,
		).toContainEqual({
			path: { kind: "path", path: resolvedNestedRoot },
			access: "read-only",
		});

		expect(
			intersectPermissionProfiles(
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "special", value: "workspace" },
								access: "read-write",
							},
						],
					},
				},
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "path", path: nestedRoot },
								access: "read-only",
							},
						],
					},
				},
				{ cwd },
			).fileSystem?.entries,
		).toContainEqual({
			path: { kind: "path", path: resolvedNestedRoot },
			access: "read-only",
		});
	});

	it("keeps all narrower requested paths within a broader granted entry", () => {
		const nestedA = join(extraRoot, "nested-a");
		const nestedB = join(extraRoot, "nested-b");
		mkdirSync(nestedA, { recursive: true });
		mkdirSync(nestedB, { recursive: true });
		const resolvedNestedA = realpathSync(nestedA);
		const resolvedNestedB = realpathSync(nestedB);

		expect(
			intersectPermissionProfiles(
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "path", path: nestedA },
								access: "read-write",
							},
							{
								path: { kind: "path", path: nestedB },
								access: "read-write",
							},
						],
					},
				},
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "special", value: "workspace" },
								access: "read-write",
							},
						],
					},
				},
				{ cwd },
			).fileSystem?.entries,
		).toEqual([
			{ path: { kind: "path", path: resolvedNestedA }, access: "read-write" },
			{ path: { kind: "path", path: resolvedNestedB }, access: "read-write" },
		]);
	});

	it("coalesces overlapping intersections to the least privileged access", () => {
		const nestedRoot = join(extraRoot, "narrowed");
		mkdirSync(nestedRoot, { recursive: true });
		const resolvedNestedRoot = realpathSync(nestedRoot);

		const intersection = intersectPermissionProfiles(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "path", path: nestedRoot },
							access: "read-only",
						},
						{
							path: { kind: "path", path: nestedRoot },
							access: "read-write",
						},
					],
				},
			},
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "special", value: "workspace" },
							access: "read-write",
						},
					],
				},
			},
			{ cwd },
		);

		expect(intersection.fileSystem?.entries).toEqual([
			{
				path: { kind: "path", path: resolvedNestedRoot },
				access: "read-only",
			},
		]);
	});

	it("converts native sandbox policy to a profile", () => {
		const profile = permissionProfileFromNativeSandboxPolicy(
			{
				mode: "workspace-write",
				writableRoots: [extraRoot],
				networkAccess: true,
				excludeSlashTmp: true,
				excludeTmpdir: true,
			},
			cwd,
		);

		expect(profile.network).toEqual({ enabled: true });
		expect(profile.fileSystem?.entries).toContainEqual({
			path: { kind: "special", value: "workspace" },
			access: "read-write",
		});
		expect(profile.fileSystem?.entries).toContainEqual({
			path: { kind: "path", path: extraRoot },
			access: "read-write",
		});
		expect(profile.fileSystem?.entries).not.toContainEqual({
			path: { kind: "special", value: "tmp" },
			access: "read-write",
		});
	});

	it("preserves native read-only policy as full-disk read access", () => {
		const granted = permissionProfileFromNativeSandboxPolicy(
			{
				mode: "read-only",
				networkAccess: false,
			},
			cwd,
		);

		expect(granted.fileSystem?.entries).toContainEqual({
			path: { kind: "special", value: "full-disk" },
			access: "read-only",
		});

		const intersection = intersectPermissionProfiles(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "path", path: extraRoot },
							access: "read-only",
						},
					],
				},
			},
			granted,
			{ cwd },
		);

		expect(intersection.fileSystem?.entries).toEqual([
			{
				path: { kind: "path", path: extraRoot },
				access: "read-only",
			},
		]);
	});

	it("converts full-disk profile back to danger-full-access", () => {
		const policy = nativeSandboxPolicyFromPermissionProfile({
			fileSystem: {
				entries: [
					{
						path: { kind: "special", value: "full-disk" },
						access: "read-write",
					},
				],
			},
			network: { enabled: true },
		});

		expect(policy).toEqual({
			mode: "danger-full-access",
			networkAccess: true,
		});
	});

	it("converts concrete root write profiles back to danger-full-access", () => {
		const policy = nativeSandboxPolicyFromPermissionProfile(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "path", path: "/" },
							access: "read-write",
						},
					],
				},
				network: { enabled: false },
			},
			cwd,
		);

		expect(policy).toEqual({
			mode: "danger-full-access",
			networkAccess: false,
		});
	});

	it("accepts ancestor path grants as workspace coverage", () => {
		const parentRoot = realpathSync(tmpdir());
		const policy = nativeSandboxPolicyFromPermissionProfile(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "path", path: parentRoot },
							access: "read-write",
						},
					],
				},
			},
			cwd,
		);

		expect(policy).toEqual({
			mode: "workspace-write",
			writableRoots: [parentRoot],
			networkAccess: false,
			excludeSlashTmp: true,
			excludeTmpdir: true,
		});
	});

	it("refuses native conversion when it would silently widen workspace writes", () => {
		expect(() =>
			nativeSandboxPolicyFromPermissionProfile(
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "path", path: extraRoot },
								access: "read-write",
							},
						],
					},
				},
				cwd,
			),
		).toThrow("without granting workspace write");
	});

	it("refuses native conversion when deny rules would be dropped", () => {
		expect(() =>
			nativeSandboxPolicyFromPermissionProfile(
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "special", value: "workspace" },
								access: "read-write",
							},
							{
								path: { kind: "path", path: "secrets" },
								access: "none",
							},
						],
					},
				},
				cwd,
			),
		).toThrow("deny rules");
	});

	it("refuses native conversion when scoped read-only rules would widen reads", () => {
		expect(() =>
			nativeSandboxPolicyFromPermissionProfile(
				{
					fileSystem: {
						entries: [
							{
								path: { kind: "path", path: extraRoot },
								access: "read-only",
							},
						],
					},
				},
				cwd,
			),
		).toThrow("widening read permissions");
	});

	it("converts full-disk read-only profiles to native read-only", () => {
		const policy = nativeSandboxPolicyFromPermissionProfile(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "path", path: "/" },
							access: "read-only",
						},
					],
				},
				network: { enabled: true },
			},
			cwd,
		);

		expect(policy).toEqual({
			mode: "read-only",
			networkAccess: true,
		});
	});

	it("allows scoped read-only rules when full-disk read is granted", () => {
		const policy = nativeSandboxPolicyFromPermissionProfile(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "special", value: "full-disk" },
							access: "read-only",
						},
						{
							path: { kind: "path", path: extraRoot },
							access: "read-only",
						},
					],
				},
			},
			cwd,
		);

		expect(policy).toEqual({
			mode: "read-only",
			networkAccess: false,
		});
	});

	it("builds deterministic native sandbox policy from config-shaped input", () => {
		const policy = buildNativeSandboxPolicy(
			{
				mode: "workspace-write",
				writableRoots: [extraRoot],
				networkAccess: true,
				excludeSlashTmp: true,
				excludeTmpdir: true,
			},
			cwd,
		);

		expect(policy).toEqual({
			mode: "workspace-write",
			writableRoots: [extraRoot],
			networkAccess: true,
			excludeSlashTmp: true,
			excludeTmpdir: true,
		});
	});
});
