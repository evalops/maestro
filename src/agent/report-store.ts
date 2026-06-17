/**
 * Immutable report store
 *
 * Several primitives this codebase ships produce reports the rest of
 * the system needs to look up later:
 *
 *   - readiness reports (`readiness-criteria.ts`, #2661)
 *   - effectiveness reports (`effectiveness-criteria.ts`, #2662)
 *   - jury synthesis records (`jury-record.ts`, #2668)
 *
 * Each one wants the same shape: write-once, addressable by stable id,
 * listable by tag, queryable by window. Instead of every consumer
 * rewriting the persistence layer, this module owns the envelope and
 * the in-memory store implementation. Disk-backed variants land in
 * follow-up PRs that snap into the same interface.
 *
 * ## Design
 *
 *   - `ReportRecord<T>` wraps a typed payload with metadata: id, kind,
 *     tags, window, generatedAt.
 *   - `ReportStore<T>` exposes write / get / list / has — append-only.
 *     A `write` of an existing id is rejected; callers either pick a
 *     new id (e.g. with a content hash) or check `has` first.
 *   - `createInMemoryReportStore()` builds the canonical store the
 *     tests + dev runtime use. The disk-backed variant builds on top.
 *
 * No domain-specific knowledge: this module doesn't know what a
 * readiness or effectiveness criterion is. It just carries the envelope.
 */

/** Schema version for the record envelope. */
export const REPORT_RECORD_VERSION = 1;

/** Optional window the report covers (window-shaped reports only). */
export interface ReportWindow {
	/** ISO 8601 inclusive start. */
	start: string;
	/** ISO 8601 exclusive end. */
	end: string;
}

/** Stored record. `kind` discriminates which primitive owns the payload. */
export interface ReportRecord<T = unknown> {
	/** Schema version. */
	version: number;
	/** Stable record id (the caller picks; usually content-addressed). */
	id: string;
	/**
	 * Discriminator naming the payload shape — e.g. `"readiness"`,
	 * `"effectiveness"`, `"jury-finding"`. Stored on disk for
	 * forward-compat: a follow-up release can keep multi-kind stores
	 * coherent.
	 */
	kind: string;
	/** Optional tags for `list({ tag })` queries. */
	tags: string[];
	/** Optional window the report covers. */
	window?: ReportWindow;
	/** ISO 8601 timestamp the record was written. */
	generatedAt: string;
	/** Typed payload. */
	payload: T;
}

/** Filter options for `list`. */
export interface ListOptions {
	/** Only include records whose `kind` matches. */
	kind?: string;
	/** Only include records carrying every tag listed here. */
	tags?: string[];
	/**
	 * Only include records whose `generatedAt` is within the given
	 * window. Records with no `generatedAt` cannot match.
	 */
	generatedWithin?: ReportWindow;
}

/** Public interface every report store implementation conforms to. */
export interface ReportStore<T = unknown> {
	/** Append a record. Throws if its id is already in the store. */
	write(record: ReportRecord<T>): void;
	/** Look up by id. Returns `undefined` if absent. */
	get(id: string): ReportRecord<T> | undefined;
	/** True when a record with this id is in the store. */
	has(id: string): boolean;
	/**
	 * List records matching `options`. Sorted by `generatedAt`
	 * descending so the most recent record appears first.
	 */
	list(options?: ListOptions): ReportRecord<T>[];
	/** Number of stored records. */
	size(): number;
}

/** Construct a record envelope with the schema version pre-stamped. */
export function makeReportRecord<T>(input: {
	id: string;
	kind: string;
	payload: T;
	tags?: string[];
	window?: ReportWindow;
	generatedAt?: string;
}): ReportRecord<T> {
	const id = input.id.trim();
	const kind = input.kind.trim();
	if (!id) {
		throw new Error("ReportRecord: id is required");
	}
	if (!kind) {
		throw new Error("ReportRecord: kind is required");
	}
	// Store the trimmed values so `list({ kind })` queries match
	// records the caller created with stray whitespace, matching how
	// `sanitizeTags` already trims tags on write.
	const tags = sanitizeTags(input.tags ?? []);
	const record: ReportRecord<T> = {
		version: REPORT_RECORD_VERSION,
		id,
		kind,
		tags,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		payload: input.payload,
	};
	if (input.window) {
		assertWindowValid(input.window);
		record.window = input.window;
	}
	return record;
}

function sanitizeTags(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const tag of tags) {
		if (typeof tag !== "string") {
			throw new Error("ReportRecord: tag must be a string");
		}
		const trimmed = tag.trim();
		if (!trimmed) {
			throw new Error("ReportRecord: empty tag is not allowed");
		}
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function assertWindowValid(window: ReportWindow): void {
	if (!window.start.trim() || !window.end.trim()) {
		throw new Error("ReportWindow: start and end are required");
	}
	if (window.start > window.end) {
		throw new Error(
			`ReportWindow: start "${window.start}" must be <= end "${window.end}"`,
		);
	}
}

/**
 * In-memory store: the canonical implementation used by tests + the
 * dev runtime. The disk-backed variant in a later PR will compose
 * this with a flush-on-write pass while preserving the same
 * `ReportStore<T>` interface.
 */
export function createInMemoryReportStore<T = unknown>(): ReportStore<T> {
	const byId = new Map<string, ReportRecord<T>>();

	return {
		write(record: ReportRecord<T>): void {
			if (byId.has(record.id)) {
				throw new Error(
					`ReportStore: record id "${record.id}" already exists (append-only)`,
				);
			}
			// Defensive copy so callers can't mutate stored records after write.
			byId.set(record.id, deepClone(record));
		},
		get(id: string): ReportRecord<T> | undefined {
			const stored = byId.get(id);
			return stored ? deepClone(stored) : undefined;
		},
		has(id: string): boolean {
			return byId.has(id);
		},
		list(options: ListOptions = {}): ReportRecord<T>[] {
			const wantKind = options.kind;
			const wantTags = sanitizeTags(options.tags ?? []);
			const window = options.generatedWithin;
			const results: ReportRecord<T>[] = [];
			for (const record of byId.values()) {
				if (wantKind !== undefined && record.kind !== wantKind) continue;
				if (wantTags.length > 0) {
					let allMatch = true;
					for (const tag of wantTags) {
						if (!record.tags.includes(tag)) {
							allMatch = false;
							break;
						}
					}
					if (!allMatch) continue;
				}
				if (window) {
					// Records with a missing / non-string `generatedAt`
					// cannot meaningfully compare against the window, so
					// exclude them — matches the documented behavior in
					// `ListOptions.generatedWithin`. Without this guard,
					// `undefined < window.start` and `undefined >=
					// window.end` are both false and such records would
					// silently slip through window-filtered results.
					if (
						typeof record.generatedAt !== "string" ||
						record.generatedAt < window.start ||
						record.generatedAt >= window.end
					) {
						continue;
					}
				}
				results.push(deepClone(record));
			}
			results.sort((a, b) =>
				a.generatedAt === b.generatedAt
					? 0
					: a.generatedAt < b.generatedAt
						? 1
						: -1,
			);
			return results;
		},
		size(): number {
			return byId.size;
		},
	};
}

/**
 * Pure deep clone: the store API hands every value out by value so
 * callers can mutate the result without poking the underlying store.
 */
function deepClone<T>(value: T): T {
	if (typeof structuredClone === "function") {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
}
