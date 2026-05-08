import type {
	MaestroAppServerClientMethod,
	MaestroAppServerInitializeResult,
	MaestroAppServerModelListResult,
	MaestroAppServerModelProviderCapabilitiesReadResult,
	MaestroAppServerThreadGoalResult,
	MaestroAppServerThreadListResult,
	MaestroAppServerThreadMetadataUpdateResult,
	MaestroAppServerThreadReadResult,
	MaestroAppServerTurnsListResult,
} from "@evalops/contracts";
import {
	type MaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "./session-api.js";

const DEFAULT_MAX_PENDING_REQUESTS = 64;
const OVERLOADED_ERROR_CODE = -32001;

export interface MaestroAppServerClientInfo {
	name: string;
	title?: string;
	version: string;
}

export interface InProcessMaestroAppServerClientOptions {
	clientInfo: MaestroAppServerClientInfo;
	maxPendingRequests?: number;
}

type AppServerRequestMethod = Exclude<
	MaestroAppServerClientMethod,
	"initialize"
>;

type AppServerMethodResult<M extends AppServerRequestMethod> =
	M extends "model/list"
		? MaestroAppServerModelListResult
		: M extends "modelProvider/capabilities/read"
			? MaestroAppServerModelProviderCapabilitiesReadResult
			: M extends "thread/list"
				? MaestroAppServerThreadListResult
				: M extends "thread/read"
					? MaestroAppServerThreadReadResult
					: M extends "thread/metadata/update"
						? MaestroAppServerThreadMetadataUpdateResult
						: M extends "thread/name/set"
							? MaestroAppServerThreadMetadataUpdateResult
							: M extends
										| "thread/goal/get"
										| "thread/goal/set"
										| "thread/goal/clear"
								? MaestroAppServerThreadGoalResult
								: M extends "thread/turns/list"
									? MaestroAppServerTurnsListResult
									: never;

export class InProcessMaestroAppServerClientError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "InProcessMaestroAppServerClientError";
	}
}

export class InProcessMaestroAppServerClient {
	private initialized = false;
	private initializing = false;
	private nextRequestId = 1;
	private pendingRequests = 0;
	private readonly maxPendingRequests: number;

	constructor(
		private readonly api: MaestroAppServerSessionApi,
		private readonly options: InProcessMaestroAppServerClientOptions,
	) {
		this.maxPendingRequests = Math.max(
			1,
			Math.trunc(options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS),
		);
	}

	async initialize(): Promise<MaestroAppServerInitializeResult> {
		if (this.initialized || this.initializing) {
			throw new InProcessMaestroAppServerClientError(
				-32000,
				"Already initialized",
			);
		}
		this.initializing = true;
		try {
			const response = await handleMaestroAppServerRequest(this.api, {
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {
					clientInfo: this.options.clientInfo,
				},
			});
			if (response.error) {
				throw new InProcessMaestroAppServerClientError(
					response.error.code,
					response.error.message,
				);
			}
			this.initialized = true;
			return response.result as MaestroAppServerInitializeResult;
		} finally {
			this.initializing = false;
		}
	}

	async request<M extends AppServerRequestMethod>(
		method: M,
		params?: Record<string, unknown>,
	): Promise<AppServerMethodResult<M>> {
		if (!this.initialized) {
			throw new InProcessMaestroAppServerClientError(-32000, "Not initialized");
		}
		if (this.pendingRequests >= this.maxPendingRequests) {
			throw new InProcessMaestroAppServerClientError(
				OVERLOADED_ERROR_CODE,
				"Server overloaded; retry later.",
			);
		}

		this.pendingRequests++;
		try {
			const response = await handleMaestroAppServerRequest(this.api, {
				jsonrpc: "2.0",
				id: this.nextRequestId++,
				method,
				params,
			});
			if (response.error) {
				throw new InProcessMaestroAppServerClientError(
					response.error.code,
					response.error.message,
				);
			}
			return response.result as AppServerMethodResult<M>;
		} finally {
			this.pendingRequests--;
		}
	}
}

export function createInProcessMaestroAppServerClient(
	api: MaestroAppServerSessionApi,
	options: InProcessMaestroAppServerClientOptions,
): InProcessMaestroAppServerClient {
	return new InProcessMaestroAppServerClient(api, options);
}
