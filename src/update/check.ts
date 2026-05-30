import { getPackageName } from "../package-metadata.js";
import { withTimeout } from "../utils/async.js";

const DEFAULT_GCS_UPDATE_URL =
	"https://storage.googleapis.com/evalops-prod-maestro-releases/maestro/version.json";
const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 5_000;

interface VersionMetadata {
	version: string;
	notes?: string;
}

export interface UpdateCheckResult {
	currentVersion: string;
	latestVersion?: string;
	notes?: string;
	isUpdateAvailable: boolean;
	sourceUrl: string;
	error?: string;
}

interface CheckForUpdateOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
	url?: string;
	urls?: string[];
}

const splitUrlList = (value: string | undefined): string[] => {
	if (!value) {
		return [];
	}
	return value
		.split(/[\n,]/u)
		.map((url) => url.trim())
		.filter(Boolean);
};

const npmLatestUrl = (packageName = getPackageName()): string => {
	return `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}/latest`;
};

export const resolveUpdateUrls = (
	options: Pick<CheckForUpdateOptions, "url" | "urls"> = {},
	env: NodeJS.ProcessEnv = process.env,
): string[] => {
	const explicitUrls = options.urls?.map((url) => url.trim()).filter(Boolean);
	if (explicitUrls && explicitUrls.length > 0) {
		return explicitUrls;
	}
	if (options.url?.trim()) {
		return [options.url.trim()];
	}
	const envUrls = splitUrlList(env.MAESTRO_UPDATE_URLS);
	if (envUrls.length > 0) {
		return envUrls;
	}
	if (env.MAESTRO_UPDATE_URL?.trim()) {
		return [env.MAESTRO_UPDATE_URL.trim()];
	}
	return [DEFAULT_GCS_UPDATE_URL, npmLatestUrl()];
};

const toErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "Unknown error";
};

const normalizeNotes = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length ? trimmed : undefined;
};

const parseNumericSegment = (segment: string): number => {
	const value = Number.parseInt(segment, 10);
	return Number.isNaN(value) ? 0 : value;
};

const parseMainSegments = (version: string): number[] => {
	return version.split(".").map((segment) => parseNumericSegment(segment));
};

const parsePreReleaseSegments = (version: string): string[] => {
	return version ? version.split(".") : [];
};

const isNumericIdentifier = (segment: string): boolean => {
	return /^[0-9]+$/.test(segment);
};

const comparePreRelease = (
	aSegments: string[],
	bSegments: string[],
): number => {
	if (aSegments.length === 0 && bSegments.length === 0) {
		return 0;
	}
	if (aSegments.length === 0) {
		return 1;
	}
	if (bSegments.length === 0) {
		return -1;
	}
	const length = Math.max(aSegments.length, bSegments.length);
	for (let i = 0; i < length; i++) {
		const a = aSegments[i];
		const b = bSegments[i];
		if (a === undefined) {
			return -1;
		}
		if (b === undefined) {
			return 1;
		}
		if (a === b) {
			continue;
		}
		const aIsNum = isNumericIdentifier(a);
		const bIsNum = isNumericIdentifier(b);
		if (aIsNum && bIsNum) {
			const aNum = Number.parseInt(a, 10);
			const bNum = Number.parseInt(b, 10);
			if (aNum < bNum) {
				return -1;
			}
			if (aNum > bNum) {
				return 1;
			}
			continue;
		}
		if (aIsNum && !bIsNum) {
			return -1;
		}
		if (!aIsNum && bIsNum) {
			return 1;
		}
		if (a < b) {
			return -1;
		}
		if (a > b) {
			return 1;
		}
	}
	return 0;
};

export function compareVersions(current: string, latest: string): number {
	const [currentMainPart, currentPreReleasePart = ""] = current.split("-", 2);
	const [latestMainPart, latestPreReleasePart = ""] = latest.split("-", 2);
	const currentMain = parseMainSegments(currentMainPart!);
	const latestMain = parseMainSegments(latestMainPart!);
	const length = Math.max(currentMain.length, latestMain.length);
	for (let i = 0; i < length; i++) {
		const currentValue = currentMain[i] ?? 0;
		const latestValue = latestMain[i] ?? 0;
		if (currentValue < latestValue) {
			return -1;
		}
		if (currentValue > latestValue) {
			return 1;
		}
	}
	const currentPre = parsePreReleaseSegments(currentPreReleasePart);
	const latestPre = parsePreReleaseSegments(latestPreReleasePart);
	return comparePreRelease(currentPre, latestPre);
}

export async function checkForUpdate(
	currentVersion: string,
	options: CheckForUpdateOptions = {},
): Promise<UpdateCheckResult> {
	const urls = resolveUpdateUrls(options);
	const fetchImpl = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let lastResult: UpdateCheckResult | null = null;
	let bestCurrentResult: UpdateCheckResult | null = null;

	for (const url of urls) {
		try {
			const response = await withTimeout(
				fetchImpl(url, {
					headers: { Accept: "application/json" },
				}),
				timeoutMs,
				`Update check timed out after ${timeoutMs}ms`,
			);

			if (!response.ok) {
				lastResult = {
					currentVersion,
					isUpdateAvailable: false,
					sourceUrl: url,
					error:
						`Update check failed (${response.status} ${response.statusText || ""})`.trim(),
				};
				continue;
			}
			let payload: VersionMetadata;
			try {
				payload = (await response.json()) as VersionMetadata;
			} catch (error) {
				lastResult = {
					currentVersion,
					isUpdateAvailable: false,
					sourceUrl: url,
					error: `Invalid update metadata: ${toErrorMessage(error)}`,
				};
				continue;
			}
			if (!payload || typeof payload.version !== "string") {
				lastResult = {
					currentVersion,
					isUpdateAvailable: false,
					sourceUrl: url,
					error: "Update metadata missing version field",
				};
				continue;
			}
			const latestVersion = payload.version.trim();
			const comparison = compareVersions(currentVersion.trim(), latestVersion);
			const result = {
				currentVersion,
				latestVersion,
				notes: normalizeNotes(payload.notes),
				isUpdateAvailable: comparison < 0,
				sourceUrl: url,
			};
			lastResult = result;
			if (result.isUpdateAvailable) {
				return result;
			}
			if (
				!bestCurrentResult ||
				compareVersions(
					bestCurrentResult.latestVersion ?? currentVersion,
					latestVersion,
				) < 0
			) {
				bestCurrentResult = result;
			}
		} catch (error) {
			lastResult = {
				currentVersion,
				isUpdateAvailable: false,
				sourceUrl: url,
				error: toErrorMessage(error),
			};
		}
	}

	return (
		bestCurrentResult ??
		lastResult ?? {
			currentVersion,
			isUpdateAvailable: false,
			sourceUrl: urls[0] ?? "",
			error: "No update metadata sources configured",
		}
	);
}
