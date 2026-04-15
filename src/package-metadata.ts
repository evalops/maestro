import { createRequire } from "node:module";

type RootPackageMetadata = {
	name?: string;
	version?: string;
	bin?: Record<string, string>;
};

let cachedPackageMetadata: RootPackageMetadata | null = null;

function loadPackageMetadata(): RootPackageMetadata {
	if (cachedPackageMetadata) {
		return cachedPackageMetadata;
	}

	try {
		const packageJson = createRequire(import.meta.url)(
			"../package.json",
		) as RootPackageMetadata;
		cachedPackageMetadata = packageJson;
		return packageJson;
	} catch {
		cachedPackageMetadata = {};
		return cachedPackageMetadata;
	}
}

export function getPackageVersion(): string {
	return (
		process.env.MAESTRO_VERSION ?? loadPackageMetadata().version ?? "unknown"
	);
}

export function getPackageName(): string {
	return loadPackageMetadata().name ?? "@evalops/maestro";
}

export function getCliCommand(): string {
	const bin = loadPackageMetadata().bin;
	const command = bin ? Object.keys(bin)[0] : undefined;
	return command ?? "maestro";
}

export function getGlobalInstallCommand(
	packageManager: "npm" | "bun" = "npm",
): string {
	return `${packageManager} install -g ${getPackageName()}`;
}
