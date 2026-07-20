export type SkillArtifactSource = "project" | "user" | "system" | "service";

export interface SkillArtifactMetadata {
	name: string;
	hash: string;
	source: SkillArtifactSource;
	artifactId?: string;
	version?: string;
	sourcePath?: string;
	scope?: string;
	workspaceId?: string;
	ownerId?: string;
}

function normalizeSkillArtifactMetadata(
	value: unknown,
): SkillArtifactMetadata | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.name !== "string" ||
		candidate.name.trim().length === 0 ||
		typeof candidate.hash !== "string" ||
		candidate.hash.trim().length === 0 ||
		typeof candidate.source !== "string" ||
		candidate.source.trim().length === 0
	) {
		return undefined;
	}

	return {
		name: candidate.name.trim(),
		hash: candidate.hash.trim(),
		source: candidate.source.trim() as SkillArtifactSource,
		...(typeof candidate.artifactId === "string" &&
		candidate.artifactId.trim().length > 0
			? { artifactId: candidate.artifactId.trim() }
			: {}),
		...(typeof candidate.version === "string" &&
		candidate.version.trim().length > 0
			? { version: candidate.version.trim() }
			: {}),
		...(typeof candidate.sourcePath === "string" &&
		candidate.sourcePath.trim().length > 0
			? { sourcePath: candidate.sourcePath.trim() }
			: {}),
		...(typeof candidate.scope === "string" && candidate.scope.trim().length > 0
			? { scope: candidate.scope.trim() }
			: {}),
		...(typeof candidate.workspaceId === "string" &&
		candidate.workspaceId.trim().length > 0
			? { workspaceId: candidate.workspaceId.trim() }
			: {}),
		...(typeof candidate.ownerId === "string" &&
		candidate.ownerId.trim().length > 0
			? { ownerId: candidate.ownerId.trim() }
			: {}),
	};
}

export function getSkillArtifactMetadataFromDetails(
	details: unknown,
): SkillArtifactMetadata | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return undefined;
	}
	return normalizeSkillArtifactMetadata(
		(details as { skillMetadata?: unknown }).skillMetadata,
	);
}
