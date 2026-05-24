import type {
	MaestroAppServerClientMethod,
	MaestroAppServerCommandExecResult,
	MaestroAppServerCommandProcessResult,
	MaestroAppServerEmptyResult,
	MaestroAppServerExternalAgentImportResult,
	MaestroAppServerFsMetadataResult,
	MaestroAppServerFsReadDirectoryResult,
	MaestroAppServerFsReadFileResult,
	MaestroAppServerFsWatchResult,
	MaestroAppServerInitializeResult,
	MaestroAppServerModelListResult,
	MaestroAppServerModelProviderCapabilitiesReadResult,
	MaestroAppServerNetworkAuditListResult,
	MaestroAppServerNetworkFetchResult,
	MaestroAppServerPluginBundleListResult,
	MaestroAppServerPluginBundleMutationResult,
	MaestroAppServerPolicyCheckResult,
	MaestroAppServerPolicyReadResult,
	MaestroAppServerRequirementsListResult,
	MaestroAppServerSandboxProbeResult,
	MaestroAppServerSandboxProofResult,
	MaestroAppServerThreadArchiveResult,
	MaestroAppServerThreadDeleteResult,
	MaestroAppServerThreadForkResult,
	MaestroAppServerThreadGoalResult,
	MaestroAppServerThreadListResult,
	MaestroAppServerThreadMetadataUpdateResult,
	MaestroAppServerThreadReadResult,
	MaestroAppServerThreadStartResult,
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
			: M extends "policy/read"
				? MaestroAppServerPolicyReadResult
				: M extends "policy/check"
					? MaestroAppServerPolicyCheckResult
					: M extends "requirements/list"
						? MaestroAppServerRequirementsListResult
						: M extends "network/fetch"
							? MaestroAppServerNetworkFetchResult
							: M extends "network/audit/list"
								? MaestroAppServerNetworkAuditListResult
								: M extends "sandbox/probe"
									? MaestroAppServerSandboxProbeResult
									: M extends "sandbox/proof/run"
										? MaestroAppServerSandboxProofResult
										: M extends "externalAgent/import"
											? MaestroAppServerExternalAgentImportResult
											: M extends "pluginBundle/list"
												? MaestroAppServerPluginBundleListResult
												: M extends
															| "pluginBundle/install"
															| "pluginBundle/remove"
													? MaestroAppServerPluginBundleMutationResult
													: M extends "command/exec"
														? MaestroAppServerCommandExecResult
														: M extends
																	| "command/exec/write"
																	| "command/exec/terminate"
															? MaestroAppServerCommandProcessResult
															: M extends "fs/readFile"
																? MaestroAppServerFsReadFileResult
																: M extends "fs/readDirectory"
																	? MaestroAppServerFsReadDirectoryResult
																	: M extends "fs/getMetadata"
																		? MaestroAppServerFsMetadataResult
																		: M extends "fs/watch"
																			? MaestroAppServerFsWatchResult
																			: M extends
																						| "fs/writeFile"
																						| "fs/createDirectory"
																						| "fs/remove"
																						| "fs/copy"
																						| "fs/unwatch"
																				? MaestroAppServerEmptyResult
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
																									: M extends "thread/start"
																										? MaestroAppServerThreadStartResult
																										: M extends "thread/fork"
																											? MaestroAppServerThreadForkResult
																											: M extends
																														| "thread/archive"
																														| "thread/unarchive"
																												? MaestroAppServerThreadArchiveResult
																												: M extends "thread/delete"
																													? MaestroAppServerThreadDeleteResult
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
