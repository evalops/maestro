import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isInsidePath(parent: string, candidate: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

export function getHostedWorkspaceRoot(env = process.env): string | undefined {
	if (env.MAESTRO_HOSTED_RUNNER_MODE !== "1") {
		return undefined;
	}
	const root = env.MAESTRO_WORKSPACE_ROOT?.trim();
	return root ? resolve(root) : undefined;
}

export function assertWithinHostedWorkspaceRoot(
	path: string,
	env = process.env,
): string {
	const workspaceRoot = getHostedWorkspaceRoot(env);
	if (!workspaceRoot) {
		return resolve(path);
	}

	const resolvedWorkspaceRoot = realpathSync(workspaceRoot);
	const resolvedPath = realpathSync(resolve(path));
	if (!isInsidePath(resolvedWorkspaceRoot, resolvedPath)) {
		throw new Error(
			`Path is outside hosted runner workspace root: ${resolvedPath}`,
		);
	}
	return resolvedPath;
}

export function resolveHostedWorkspacePath(
	path: string | undefined,
	env = process.env,
): string | undefined {
	const workspaceRoot = getHostedWorkspaceRoot(env);
	if (!workspaceRoot) {
		return path ? resolve(path) : undefined;
	}

	const candidate = path
		? isAbsolute(path)
			? resolve(path)
			: resolve(workspaceRoot, path)
		: workspaceRoot;
	return assertWithinHostedWorkspaceRoot(candidate, env);
}
