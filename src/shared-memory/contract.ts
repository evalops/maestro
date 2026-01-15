/**
 * Shared Memory Contract v1
 *
 * This file defines the contract between Composer and Conductor for
 * shared memory synchronization. Both projects should implement
 * compatible types to ensure interoperability.
 *
 * Schema Version: 1
 * Last Updated: 2026-01-15
 */

// =============================================================================
// Schema Version
// =============================================================================

export const SHARED_MEMORY_SCHEMA_VERSION = 1;

// =============================================================================
// Error Codes
// =============================================================================

/**
 * Unified error codes for shared memory operations.
 * Both Composer and Conductor should use these codes for consistent error handling.
 */
export enum SharedMemoryErrorCode {
	// Network errors (1xxx)
	NETWORK_TIMEOUT = "SM1001",
	NETWORK_UNREACHABLE = "SM1002",
	NETWORK_ABORTED = "SM1003",

	// Authentication errors (2xxx)
	AUTH_MISSING = "SM2001",
	AUTH_INVALID = "SM2002",
	AUTH_EXPIRED = "SM2003",
	AUTH_FORBIDDEN = "SM2004",

	// Request errors (3xxx)
	REQUEST_TOO_LARGE = "SM3001",
	REQUEST_INVALID_FORMAT = "SM3002",
	REQUEST_RATE_LIMITED = "SM3003",
	REQUEST_UNSUPPORTED_ENCODING = "SM3004",
	REQUEST_METHOD_NOT_ALLOWED = "SM3005",

	// Server errors (4xxx)
	SERVER_ERROR = "SM4001",
	SERVER_UNAVAILABLE = "SM4002",
	SERVER_ENDPOINT_NOT_FOUND = "SM4003",

	// Data errors (5xxx)
	DATA_SERIALIZATION_FAILED = "SM5001",
	DATA_DESERIALIZATION_FAILED = "SM5002",
	DATA_VALIDATION_FAILED = "SM5003",
	DATA_TRUNCATED = "SM5004",

	// Session errors (6xxx)
	SESSION_NOT_FOUND = "SM6001",
	SESSION_CONFLICT = "SM6002",
	SESSION_INVALID = "SM6003",
}

/**
 * Map HTTP status codes to SharedMemoryErrorCode
 */
export function httpStatusToErrorCode(status: number): SharedMemoryErrorCode {
	switch (status) {
		case 401:
			return SharedMemoryErrorCode.AUTH_INVALID;
		case 403:
			return SharedMemoryErrorCode.AUTH_FORBIDDEN;
		case 404:
			return SharedMemoryErrorCode.SERVER_ENDPOINT_NOT_FOUND;
		case 405:
			return SharedMemoryErrorCode.REQUEST_METHOD_NOT_ALLOWED;
		case 413:
			return SharedMemoryErrorCode.REQUEST_TOO_LARGE;
		case 415:
			return SharedMemoryErrorCode.REQUEST_UNSUPPORTED_ENCODING;
		case 429:
			return SharedMemoryErrorCode.REQUEST_RATE_LIMITED;
		case 500:
		case 502:
		case 503:
		case 504:
			return SharedMemoryErrorCode.SERVER_ERROR;
		default:
			return SharedMemoryErrorCode.SERVER_ERROR;
	}
}

// =============================================================================
// Source Identifiers
// =============================================================================

export type SharedMemorySource = "composer" | "conductor";

// =============================================================================
// Capabilities Contract
// =============================================================================

export interface SharedMemoryCapabilities {
	/** Whether the /sync endpoint is supported */
	supportsSync: boolean;
	/** Whether gzip Content-Encoding is supported */
	supportsGzip: boolean;
	/** Maximum request body size in bytes */
	maxBodyBytes: number;
	/** Maximum events per batch request */
	maxEventsBatch: number;
	/** Maximum payload size per event in bytes */
	maxEventPayloadBytes: number;
	/** Maximum length of event type string */
	maxEventTypeLength: number;
	/** Maximum length of event ID string */
	maxEventIdLength: number;
}

export const DEFAULT_CAPABILITIES: SharedMemoryCapabilities = {
	supportsSync: true,
	supportsGzip: true,
	maxBodyBytes: 256 * 1024,
	maxEventsBatch: 25,
	maxEventPayloadBytes: 32 * 1024,
	maxEventTypeLength: 128,
	maxEventIdLength: 128,
};

// =============================================================================
// Event Contract
// =============================================================================

export interface SharedMemoryEvent {
	/** Event type identifier (e.g., "composer.session.started") */
	type: string;
	/** Event payload data */
	payload?: Record<string, unknown>;
	/** Optional tags for filtering/categorization */
	tags?: string[];
	/** Unique event identifier */
	id?: string;
	/** Actor that generated the event */
	actor?: SharedMemorySource;
}

// =============================================================================
// State Contract
// =============================================================================

/**
 * Base state fields that both Composer and Conductor share.
 */
export interface SharedMemoryStateBase {
	/** Session identifier */
	sessionId: string;
	/** Source that last updated the state */
	source: SharedMemorySource;
	/** Instance identifier (unique per process/tab) */
	instanceId: string;
	/** ISO timestamp of last update */
	updatedAt?: string;
}

/**
 * Composer-specific state fields.
 */
export interface ComposerState extends SharedMemoryStateBase {
	source: "composer";
	/** Current working directory */
	cwd?: string;
	/** Active model identifier */
	model?: string;
	/** Last message ID */
	lastMessageId?: string;
	/** Last message role */
	lastMessageRole?: string;
	/** Session summary */
	summary?: string;
}

/**
 * Conductor-specific state fields.
 */
export interface ConductorState extends SharedMemoryStateBase {
	source: "conductor";
	/** Session title */
	title?: string;
	/** Active model */
	model?: string | null;
	/** Message count */
	messageCount?: number;
	/** Preview text */
	preview?: string;
	/** Last modified timestamp */
	lastModified?: string;
}

// =============================================================================
// Sync Request Contract
// =============================================================================

export interface SharedMemorySyncRequest {
	/** State updates keyed by source */
	state?: {
		composer?: ComposerState;
		conductor?: ConductorState;
	};
	/** Events to append */
	events?: SharedMemoryEvent[];
	/** Queue statistics for monitoring */
	stats?: SharedMemoryQueueStats;
}

// =============================================================================
// Queue Statistics Contract
// =============================================================================

export interface SharedMemoryQueueStats {
	/** Number of states that were trimmed to fit size limits */
	trimmed_states: number;
	/** Number of events that were trimmed to fit size limits */
	trimmed_events: number;
	/** Number of states that were dropped (couldn't be sent) */
	dropped_states: number;
	/** Number of events that were dropped (couldn't be sent) */
	dropped_events: number;
	/** Number of batch splits due to size limits */
	batch_splits: number;
	/** Number of gzip-compressed requests */
	gzip_requests: number;
	/** ISO timestamp of last successful send */
	last_sent_at: string;
	/** Source that generated these stats */
	source: SharedMemorySource;
	/** Instance identifier */
	instance_id: string;
}

// =============================================================================
// Persisted Queue Contract
// =============================================================================

export interface PersistedQueueEntry<TState> {
	state: TState | null;
	events: SharedMemoryEvent[];
	updatedAt: number;
}

export interface PersistedQueue<TState> {
	/** Schema version for migration */
	version: typeof SHARED_MEMORY_SCHEMA_VERSION;
	/** When the queue was last persisted */
	updatedAt: number;
	/** Pending sessions by key */
	sessions: Record<string, PersistedQueueEntry<TState>>;
	/** Queue statistics */
	stats: {
		trimmedStates: number;
		trimmedEvents: number;
		droppedStates: number;
		droppedEvents: number;
		batchSplits: number;
		gzipRequests: number;
		lastSentAt: string | null;
	};
}

// =============================================================================
// Configuration Constants
// =============================================================================

export const SHARED_MEMORY_CONFIG = {
	/** Delay before flushing pending updates (ms) */
	FLUSH_DELAY_MS: 150,
	/** Request timeout (ms) */
	REQUEST_TIMEOUT_MS: 5000,
	/** Maximum pending events per session */
	MAX_PENDING_EVENTS: 50,
	/** Maximum backoff delay for retries (ms) */
	MAX_BACKOFF_MS: 5000,
	/** Default events per batch */
	DEFAULT_EVENTS_PER_BATCH: 25,
	/** Target max body size (with safety margin) */
	TARGET_MAX_BODY_BYTES: 220 * 1024,
	/** Maximum string length before truncation */
	MAX_STRING_LENGTH: 4000,
	/** Maximum array length before truncation */
	MAX_ARRAY_LENGTH: 50,
	/** Debounce delay for persisting queue (ms) */
	PERSIST_DEBOUNCE_MS: 300,
	/** TTL for persisted queue entries (ms) */
	PERSIST_TTL_MS: 24 * 60 * 60 * 1000,
	/** TTL for capabilities cache (ms) */
	CAPABILITIES_TTL_MS: 5 * 60 * 1000,
} as const;

// =============================================================================
// Event Type Conventions
// =============================================================================

/**
 * Standard event type prefixes for each source.
 * Events should follow the pattern: {source}.{category}.{action}
 *
 * Examples:
 * - composer.session.started
 * - composer.message.saved
 * - conductor.tool.executed
 * - conductor.session.updated
 */
export const EVENT_TYPE_PREFIXES = {
	COMPOSER: "composer.",
	CONDUCTOR: "conductor.",
} as const;

// =============================================================================
// Type Guards
// =============================================================================

export function isComposerState(
	state: SharedMemoryStateBase,
): state is ComposerState {
	return state.source === "composer";
}

export function isConductorState(
	state: SharedMemoryStateBase,
): state is ConductorState {
	return state.source === "conductor";
}

export function isValidEventType(type: string): boolean {
	const trimmed = type.trim();
	if (!trimmed) return false;
	if (trimmed.length > DEFAULT_CAPABILITIES.maxEventTypeLength) return false;
	return true;
}
