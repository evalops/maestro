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

	it("keeps matching paths when granted access is broader than requested", () => {
		const intersection = intersectPermissionProfiles(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "special", value: "workspace" },
							access: "read-only",
						},
					],
				},
			},
			{
				fileSystem: {
					entries: [
						{ path: { kind: "path", path: extraRoot }, access: "read-write" },
					],
				},
			},
			{ cwd },
		);

		expect(intersection.fileSystem?.entries).toEqual([
			{ path: { kind: "path", path: extraRoot }, access: "read-only" },
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
