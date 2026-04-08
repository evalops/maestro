export interface PackageSearchEntry {
	name: string;
	version?: string;
	description?: string;
	keywords: string[];
	date?: string;
	links: {
		npm?: string;
		repository?: string;
		homepage?: string;
	};
	installSource: string;
}

export interface PackageSearchResponse {
	query: string;
	entries: PackageSearchEntry[];
}

interface NpmRegistrySearchPayload {
	objects?: Array<{
		package?: {
			name?: string;
			version?: string;
			description?: string;
			keywords?: string[];
			date?: string;
			links?: {
				npm?: string;
				repository?: string;
				homepage?: string;
			};
		};
	}>;
}

const PACKAGE_DISCOVERY_LIMIT = 8;
const MAESTRO_PACKAGE_KEYWORD = "maestro-package";

function buildPackageSearchText(query: string): string {
	const trimmed = query.trim();
	return trimmed.length > 0
		? `${MAESTRO_PACKAGE_KEYWORD} ${trimmed}`
		: MAESTRO_PACKAGE_KEYWORD;
}

function normalizePackageSearchEntry(
	packageInfo: NonNullable<
		NonNullable<NpmRegistrySearchPayload["objects"]>[number]["package"]
	>,
): PackageSearchEntry | null {
	if (!packageInfo.name || packageInfo.name.trim().length === 0) {
		return null;
	}

	return {
		name: packageInfo.name,
		version: packageInfo.version,
		description: packageInfo.description,
		keywords: packageInfo.keywords ?? [],
		date: packageInfo.date,
		links: {
			npm: packageInfo.links?.npm,
			repository: packageInfo.links?.repository,
			homepage: packageInfo.links?.homepage,
		},
		installSource: `npm:${packageInfo.name}`,
	};
}

export async function searchPackageRegistry(
	query = "",
): Promise<PackageSearchResponse> {
	const text = buildPackageSearchText(query);
	const url = new URL("https://registry.npmjs.org/-/v1/search");
	url.searchParams.set("text", text);
	url.searchParams.set("size", String(PACKAGE_DISCOVERY_LIMIT));

	const response = await fetch(url, {
		headers: {
			accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Package search failed: ${response.status} ${response.statusText}`.trim(),
		);
	}

	const payload = (await response.json()) as NpmRegistrySearchPayload;
	const entries = (payload.objects ?? [])
		.map((entry) =>
			entry.package ? normalizePackageSearchEntry(entry.package) : null,
		)
		.filter((entry): entry is PackageSearchEntry => entry !== null);

	return {
		query: query.trim(),
		entries,
	};
}
