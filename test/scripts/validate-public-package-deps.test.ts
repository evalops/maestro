import { describe, expect, it } from "vitest";
import {
	buildPublicPackageDependencyReport,
	collectPublicPackageDependencyReport,
} from "../../scripts/validate-public-package-deps.js";

const rootPackageName = ["@evalops", "maestro"].join("/");
const contractsPackageName = ["@evalops", "contracts"].join("/");
const tuiPackageName = ["@evalops", "tui"].join("/");

function workspacePackage(name: string, isPrivate: boolean) {
	return {
		name,
		data: {
			name,
			private: isPrivate,
		},
	};
}

describe("collectPublicPackageDependencyReport", () => {
	it("detects the broken published-package class with private workspace dependencies", () => {
		expect(
			collectPublicPackageDependencyReport({
				rootPackage: {
					name: rootPackageName,
					private: false,
					dependencies: {
						[contractsPackageName]: "^0.10.20",
					},
					optionalDependencies: {
						[tuiPackageName]: "^0.10.20",
					},
				},
				workspacePackages: [
					workspacePackage(contractsPackageName, true),
					workspacePackage(tuiPackageName, true),
				],
				runtimeWorkspaceNames: [contractsPackageName, tuiPackageName],
			}),
		).toMatchObject({
			rootName: rootPackageName,
			skipped: false,
			privateWorkspaceDependencies: [
				`dependencies.${contractsPackageName}`,
				`optionalDependencies.${tuiPackageName}`,
			],
			runtimeWorkspaceDependencies: [
				`dependencies.${contractsPackageName}`,
				`optionalDependencies.${tuiPackageName}`,
			],
		});
	});

	it("detects vendored runtime workspaces even when the workspace package is public", () => {
		expect(
			collectPublicPackageDependencyReport({
				rootPackage: {
					name: rootPackageName,
					private: false,
					peerDependencies: {
						[contractsPackageName]: "^0.10.48",
					},
				},
				workspacePackages: [workspacePackage(contractsPackageName, false)],
				runtimeWorkspaceNames: [contractsPackageName],
			}).runtimeWorkspaceDependencies,
		).toEqual([`peerDependencies.${contractsPackageName}`]);
	});

	it("skips private root packages", () => {
		expect(
			collectPublicPackageDependencyReport({
				rootPackage: {
					name: rootPackageName,
					private: true,
					dependencies: {
						[contractsPackageName]: "^0.10.48",
					},
				},
				workspacePackages: [workspacePackage(contractsPackageName, true)],
				runtimeWorkspaceNames: [contractsPackageName],
			}),
		).toMatchObject({
			rootName: rootPackageName,
			skipped: true,
			privateWorkspaceDependencies: [],
			runtimeWorkspaceDependencies: [],
		});
	});

	it("does not load workspace metadata before skipping private roots", async () => {
		await expect(
			buildPublicPackageDependencyReport({
				rootPackage: {
					name: rootPackageName,
					private: true,
				},
				loadWorkspacePackages: async () => {
					throw new Error("workspace metadata should not load");
				},
				resolveRuntimeWorkspaceNames: () => {
					throw new Error("runtime workspace metadata should not load");
				},
			}),
		).resolves.toMatchObject({
			rootName: rootPackageName,
			skipped: true,
			privateWorkspaceDependencies: [],
			runtimeWorkspaceDependencies: [],
		});
	});

	it("allows ordinary registry dependencies in public packages", () => {
		expect(
			collectPublicPackageDependencyReport({
				rootPackage: {
					name: rootPackageName,
					private: false,
					dependencies: {
						zod: "^4.3.6",
					},
				},
				workspacePackages: [workspacePackage(contractsPackageName, true)],
				runtimeWorkspaceNames: [contractsPackageName],
			}),
		).toMatchObject({
			rootName: rootPackageName,
			skipped: false,
			privateWorkspaceDependencies: [],
			runtimeWorkspaceDependencies: [],
		});
	});
});
