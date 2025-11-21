export interface WorkspacePackage {
	name: string;
	path: string;
	data: Record<string, unknown>;
}

export function loadRootPackage(): Record<string, unknown>;
export function getWorkspacePackagePaths(
	rootPackage: Record<string, unknown>,
): string[];
export function readPackageJson(path: string): Record<string, unknown>;
export function writePackageJson(
	path: string,
	pkg: Record<string, unknown>,
): void;
export function getWorkspacePackages(
	rootPackage: Record<string, unknown>,
): WorkspacePackage[];
export function syncInternalDependencies(
	pkg: Record<string, unknown>,
	version: string,
	internalNames: Set<string>,
): void;
export function verifyAlignedVersions(
	packages: Array<{ name: string; data: Record<string, unknown> }>,
	expectedVersion: string,
): void;
export function getRootPackagePath(): string;
