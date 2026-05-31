import { createRequire } from "node:module";

type RootPackageMetadata = {
	name?: string;
	version?: string;
	bin?: Record<string, string>;
	maestro?: {
		canonicalPackageName?: string;
		packageAliases?: string[];
	};
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
	const metadata = loadPackageMetadata();
	return (
		process.env.MAESTRO_PACKAGE_NAME ??
		metadata.name ??
		metadata.maestro?.canonicalPackageName ??
		"@evalops/maestro"
	);
}

export function getCanonicalPackageName(): string {
	const metadata = loadPackageMetadata();
	return metadata.maestro?.canonicalPackageName ?? getPackageName();
}

export function getPackageAliases(): string[] {
	const metadata = loadPackageMetadata();
	return Array.from(
		new Set([
			getPackageName(),
			getCanonicalPackageName(),
			...(Array.isArray(metadata.maestro?.packageAliases)
				? metadata.maestro.packageAliases.filter(
						(alias): alias is string =>
							typeof alias === "string" && alias.trim().length > 0,
					)
				: []),
		]),
	);
}

export function getCliCommand(): string {
	const bin = loadPackageMetadata().bin;
	const command = bin ? Object.keys(bin)[0] : undefined;
	return command ?? "maestro";
}

export function getGlobalInstallCommand(
	packageManager: "npm" | "bun" = "npm",
	packageName = getPackageName(),
): string {
	return `${packageManager} install -g ${packageName}`;
}
