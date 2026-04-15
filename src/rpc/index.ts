/**
 * RPC Module for Composer Agent
 *
 * Provides typed RPC communication for programmatic control of Composer.
 *
 * @module rpc
 */

export { RpcClient, type RpcClientOptions } from "./rpc-client.js";
export {
	type RpcCommand,
	type RpcPromptCommand,
	type RpcAbortCommand,
	type RpcGetMessagesCommand,
	type RpcGetStateCommand,
	type RpcContinueCommand,
	type RpcCompactCommand,
	type RpcResponse,
	type RpcMessagesResponse,
	type RpcStateResponse,
	type RpcErrorResponse,
	type RpcCompactionResponse,
	type RpcAgentEventType,
	isAgentEvent,
	isErrorResponse,
} from "./rpc-types.js";
