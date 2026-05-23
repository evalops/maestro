import { describe, expect, it } from "vitest";
import { assertInstallablePackageMetadata } from "../../scripts/install-smoke-utils.js";

describe("assertInstallablePackageMetadata", () => {
	it("allows ordinary registry dependencies", () => {
		expect(() =>
			assertInstallablePackageMetadata(
				{
					dependencies: {
						"@bufbuild/protobuf": "^2.11.0",
						zod: "^4.3.6",
					},
				},
				{
					label: "packed package",
					forbiddenWorkspaceNames: ["@evalops/contracts", "@evalops/tui"],
				},
			),
		).not.toThrow();
	});

	it("rejects private runtime workspaces in install-time dependencies", () => {
		expect(() =>
			assertInstallablePackageMetadata(
				{
					dependencies: {
						"@evalops/contracts": "^0.10.21",
					},
					optionalDependencies: {
						"@evalops/tui": "^0.10.21",
					},
				},
				{
					label: "published package",
					forbiddenWorkspaceNames: ["@evalops/contracts", "@evalops/tui"],
				},
			),
		).toThrow(
			"published package exposes non-registry workspace metadata: dependencies.@evalops/contracts, optionalDependencies.@evalops/tui",
		);
	});

	it("rejects workspace protocol specs and bundled private workspaces", () => {
		expect(() =>
			assertInstallablePackageMetadata(
				{
					dependencies: {
						"@evalops/maestro-helper": "workspace:*",
					},
					bundleDependencies: ["@evalops/contracts"],
				},
				{
					label: "packed package",
					forbiddenWorkspaceNames: ["@evalops/contracts"],
				},
			),
		).toThrow(
			"packed package exposes non-registry workspace metadata: bundleDependencies.@evalops/contracts, dependencies.@evalops/maestro-helper=workspace:",
		);
	});
});
