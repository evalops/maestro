export interface A2AOwnershipScope {
	scopeKey?: string;
	subject?: string;
	userId?: string;
	keyId?: string;
	workspaceId?: string;
	orgId?: string;
	teamId?: string;
}

export interface A2AOwnershipRecord {
	workspaceId?: string;
	organizationId?: string;
	orgId?: string;
	teamId?: string;
	actorId?: string;
	ownerId?: string;
	userId?: string;
	ownerSubject?: string;
	scopeKey?: string;
	sessionScope?: string;
	metadata?: Record<string, string | number | boolean>;
}

export function hasA2AOwnershipScope(
	scope: A2AOwnershipScope | undefined,
): scope is A2AOwnershipScope {
	return Boolean(
		scope &&
			Object.values(scope).some(
				(value) => typeof value === "string" && value.trim().length > 0,
			),
	);
}

export function matchesA2AOwnershipScope(
	record: A2AOwnershipRecord,
	scope: A2AOwnershipScope | undefined,
): boolean {
	if (!hasA2AOwnershipScope(scope)) {
		return true;
	}
	let sawMarker = false;
	let matched = false;
	let matchedIdentity = false;
	let sawIdentityMarker = false;

	const scopedIds = normalizedValues(scope.scopeKey);
	if (
		!matchRequiredDimension(
			metadataValues(record, ["scopeKey", "sessionScope"]),
			scopedIds,
			(next) => {
				sawMarker = true;
				matched ||= next;
			},
		)
	) {
		return false;
	}

	const workspaceIds = normalizedValues(scope.workspaceId);
	if (
		!matchRequiredDimension(
			metadataValues(record, ["workspaceId", "workspace_id"]),
			workspaceIds,
			(next) => {
				sawMarker = true;
				matched ||= next;
			},
		)
	) {
		return false;
	}

	const orgIds = normalizedValues(scope.orgId);
	if (
		!matchRequiredDimension(
			metadataValues(record, ["organizationId", "organization_id", "orgId"]),
			orgIds,
			(next) => {
				sawMarker = true;
				matched ||= next;
			},
		)
	) {
		return false;
	}

	const teamIds = normalizedValues(scope.teamId);
	if (
		!matchRequiredDimension(
			metadataValues(record, ["teamId", "team_id"]),
			teamIds,
			(next) => {
				sawMarker = true;
				matched ||= next;
			},
		)
	) {
		return false;
	}

	const identities = identityValues(scope);
	if (
		!matchRequiredDimension(
			metadataValues(record, [
				"ownerSubject",
				"owner_subject",
				"ownerId",
				"owner_id",
				"userId",
				"user_id",
				"actorId",
				"actor_id",
				"keyId",
				"key_id",
			]),
			identities,
			(next) => {
				sawMarker = true;
				sawIdentityMarker = true;
				matched ||= next;
				matchedIdentity ||= next;
			},
		)
	) {
		return false;
	}

	if (identities.size > 0 && sawIdentityMarker && !matchedIdentity) {
		return false;
	}
	return sawMarker && matched;
}

function matchRequiredDimension(
	values: readonly string[],
	expected: ReadonlySet<string>,
	observe: (matched: boolean) => void,
): boolean {
	if (values.length === 0) {
		return true;
	}
	if (expected.size === 0) {
		observe(false);
		return false;
	}
	const matched = values.some((value) => expected.has(normalize(value)));
	observe(matched);
	return matched;
}

function metadataValues(
	record: A2AOwnershipRecord,
	keys: readonly string[],
): string[] {
	const values = new Set<string>();
	for (const key of keys) {
		const direct = directString(record, key);
		if (direct) {
			values.add(direct);
		}
		const metadata = metadataString(record.metadata, key);
		if (metadata) {
			values.add(metadata);
		}
	}
	return [...values];
}

function directString(
	record: A2AOwnershipRecord,
	key: string,
): string | undefined {
	const value = (record as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataString(
	metadata: Record<string, string | number | boolean> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedValues(
	...values: Array<string | undefined>
): ReadonlySet<string> {
	return new Set(
		values
			.flatMap((value) => identityAliases(value))
			.map(normalize)
			.filter(Boolean),
	);
}

function identityValues(scope: A2AOwnershipScope): ReadonlySet<string> {
	return normalizedValues(scope.subject, scope.userId, scope.keyId);
}

function identityAliases(value: string | undefined): string[] {
	const trimmed = value?.trim();
	if (!trimmed) {
		return [];
	}
	const aliases = [trimmed];
	for (const prefix of ["user:", "key:"]) {
		if (trimmed.startsWith(prefix)) {
			aliases.push(trimmed.slice(prefix.length));
		}
	}
	return aliases;
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}
