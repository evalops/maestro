/**
 * Response State - Manages message state for Slack responses
 *
 * Encapsulates the shared logic for responding to Slack messages,
 * including text accumulation, working indicators, and message updates.
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type {
	ChatPostMessageArguments,
	FilesUploadV2Arguments,
	WebClient,
} from "@slack/web-api";
import type { ChannelStore } from "../store.js";

export interface ResponseStateConfig {
	channelId: string;
	webClient: WebClient;
	store: ChannelStore;
	callSlack: <T>(fn: () => Promise<T>, context: string) => Promise<T>;
	obfuscateUsernames?: (text: string) => string;
	/** Thread timestamp if responding in a thread */
	threadTs?: string;
	/** Whether to broadcast replies to the channel */
	replyBroadcast?: boolean;
}

export interface ResponseHandlers {
	respond(text: string, log?: boolean): Promise<void>;
	replaceMessage(text: string, log?: boolean, logText?: string): Promise<void>;
	respondInThread(text: string, log?: boolean): Promise<void>;
	postMessage(channel: string, text: string, log?: boolean): Promise<void>;
	postThreadReply(
		channel: string,
		threadTs: string,
		text: string,
		log?: boolean,
	): Promise<void>;
	setTyping(isTyping: boolean): Promise<void>;
	uploadFile(filePath: string, title?: string): Promise<void>;
	setWorking(working: boolean): Promise<void>;
	updateStatus(status: string): Promise<void>;
}

const WORKING_INDICATOR = " ...";
const UPDATE_MIN_INTERVAL_MS = 1000;
const EXTERNAL_UPLOAD_THRESHOLD_BYTES = 10 * 1024 * 1024;

/**
 * Creates response handlers for a Slack context.
 * This factory encapsulates the message state management logic
 * that was previously duplicated across createContext, createSlashContext,
 * and createScheduledContext.
 */
export function createResponseHandlers(
	config: ResponseStateConfig,
): ResponseHandlers {
	const {
		channelId,
		webClient,
		store,
		callSlack,
		obfuscateUsernames = (t) => t,
		threadTs,
		replyBroadcast,
	} = config;

	// Mutable state for response tracking
	let messageTs: string | null = null;
	let accumulatedText = "";
	let isThinking = true;
	let isWorking = true;
	let updatePromise: Promise<void> = Promise.resolve();
	let lastUpdateAt = 0;

	const throttleUpdate = async (fn: () => Promise<void>): Promise<void> => {
		const now = Date.now();
		const waitMs = Math.max(0, lastUpdateAt + UPDATE_MIN_INTERVAL_MS - now);
		if (waitMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
		await fn();
		lastUpdateAt = Date.now();
	};

	const enqueueUpdate = (fn: () => Promise<void>): Promise<void> => {
		const operation = updatePromise.catch(() => undefined).then(fn);
		updatePromise = operation.catch(() => undefined);
		return operation;
	};

	const respond = async (responseText: string, log = true): Promise<void> => {
		const operation = enqueueUpdate(async () => {
			if (isThinking) {
				accumulatedText = responseText;
				isThinking = false;
			} else {
				accumulatedText += `\n${responseText}`;
			}

			const displayText = isWorking
				? accumulatedText + WORKING_INDICATOR
				: accumulatedText;

			await throttleUpdate(async () => {
				if (messageTs) {
					const currentMessageTs = messageTs;
					await callSlack(
						() =>
							webClient.chat.update({
								channel: channelId,
								ts: currentMessageTs,
								text: displayText,
							}),
						"chat.update",
					);
				} else {
					const postArgs = {
						channel: channelId,
						text: displayText,
						thread_ts: threadTs,
						reply_broadcast: replyBroadcast,
					} as ChatPostMessageArguments;
					const result = await callSlack(
						() => webClient.chat.postMessage(postArgs),
						"chat.postMessage",
					);
					messageTs = result.ts as string;
				}
			});

			if (log && messageTs) {
				await store.logBotResponse(channelId, responseText, messageTs);
			}
		});

		await operation;
	};

	const replaceMessage = async (
		newText: string,
		log = false,
		logText = newText,
	): Promise<void> => {
		const operation = enqueueUpdate(async () => {
			accumulatedText = newText;

			const displayText = isWorking
				? accumulatedText + WORKING_INDICATOR
				: accumulatedText;

			await throttleUpdate(async () => {
				if (messageTs) {
					const currentMessageTs = messageTs;
					await callSlack(
						() =>
							webClient.chat.update({
								channel: channelId,
								ts: currentMessageTs,
								text: displayText,
							}),
						"chat.update",
					);
				} else {
					const postArgs = {
						channel: channelId,
						text: displayText,
						thread_ts: threadTs,
						reply_broadcast: replyBroadcast,
					} as ChatPostMessageArguments;
					const result = await callSlack(
						() => webClient.chat.postMessage(postArgs),
						"chat.postMessage",
					);
					messageTs = result.ts as string;
				}
			});

			if (log && messageTs) {
				await store.logBotResponse(channelId, logText, messageTs);
			}
		});

		await operation;
	};

	const postMessage = async (
		targetChannel: string,
		text: string,
		log = true,
	): Promise<void> => {
		const operation = enqueueUpdate(async () => {
			const result = await callSlack(
				() =>
					webClient.chat.postMessage({
						channel: targetChannel,
						text,
					} as ChatPostMessageArguments),
				"chat.postMessage",
			);
			if (log && result.ts) {
				await store.logBotResponse(targetChannel, text, result.ts as string);
			}
		});

		await operation;
	};

	const postThreadReply = async (
		targetChannel: string,
		targetThreadTs: string,
		text: string,
		log = false,
	): Promise<void> => {
		const operation = enqueueUpdate(async () => {
			const result = await callSlack(
				() =>
					webClient.chat.postMessage({
						channel: targetChannel,
						thread_ts: targetThreadTs,
						text,
					} as ChatPostMessageArguments),
				"chat.postMessage",
			);
			if (log && result.ts) {
				await store.logMessage(targetChannel, {
					date: new Date().toISOString(),
					ts: result.ts as string,
					threadTs: targetThreadTs,
					user: "bot",
					text,
					attachments: [],
					isBot: true,
				});
			}
		});

		await operation;
	};

	const respondInThread = async (
		threadText: string,
		log = false,
	): Promise<void> => {
		const operation = enqueueUpdate(async () => {
			const targetThreadTs = messageTs ?? threadTs;
			const obfuscatedText = obfuscateUsernames(threadText);
			let replyTs: string | undefined;
			await throttleUpdate(async () => {
				const result = await callSlack(() => {
					const postArgs = {
						channel: channelId,
						text: obfuscatedText,
						...(targetThreadTs && { thread_ts: targetThreadTs }),
					} as ChatPostMessageArguments;
					return webClient.chat.postMessage(postArgs);
				}, "chat.postMessage");
				replyTs = result.ts as string | undefined;
			});
			if (log && replyTs) {
				await store.logMessage(channelId, {
					date: new Date().toISOString(),
					ts: replyTs,
					threadTs: targetThreadTs,
					user: "bot",
					text: obfuscatedText,
					attachments: [],
					isBot: true,
				});
			}
		});

		await operation;
	};

	const setTyping = async (typing: boolean): Promise<void> => {
		if (typing && !messageTs) {
			accumulatedText = "_Thinking_";
			const postArgs = {
				channel: channelId,
				text: accumulatedText,
				thread_ts: threadTs,
				reply_broadcast: replyBroadcast,
			} as ChatPostMessageArguments;
			const result = await callSlack(
				() => webClient.chat.postMessage(postArgs),
				"chat.postMessage",
			);
			messageTs = result.ts as string;
		}
	};

	const uploadFile = async (
		filePath: string,
		title?: string,
	): Promise<void> => {
		const fileName = title || basename(filePath);
		const { size } = await stat(filePath);

		if (size >= EXTERNAL_UPLOAD_THRESHOLD_BYTES) {
			const uploadUrlResult = await callSlack(
				() =>
					webClient.files.getUploadURLExternal({
						filename: fileName,
						length: size,
					}),
				"files.getUploadURLExternal",
			);

			const uploadUrl = uploadUrlResult.upload_url as string | undefined;
			const fileId = uploadUrlResult.file_id as string | undefined;
			if (!uploadUrl || !fileId) {
				throw new Error(
					"Slack external upload did not return upload_url or file_id",
				);
			}

			const requestOptions: RequestInit & { duplex?: "half" } = {
				method: "PUT",
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": size.toString(),
				},
				body: Readable.toWeb(
					createReadStream(filePath),
				) as ReadableStream<Uint8Array>,
				duplex: "half",
			};
			const response = await fetch(uploadUrl, requestOptions);
			if (!response.ok) {
				throw new Error(
					`Slack external upload failed: ${response.status} ${response.statusText}`,
				);
			}

			await callSlack(
				() =>
					webClient.files.completeUploadExternal({
						files: [{ id: fileId, title: fileName }],
						channel_id: channelId,
						...(threadTs && { thread_ts: threadTs }),
					}),
				"files.completeUploadExternal",
			);
			return;
		}

		const fileContent = await readFile(filePath);
		const uploadArgs = {
			channel_id: channelId,
			file: fileContent,
			filename: fileName,
			title: fileName,
			...(threadTs && { thread_ts: threadTs }),
		} as FilesUploadV2Arguments;
		await callSlack(
			() => webClient.files.uploadV2(uploadArgs),
			"files.uploadV2",
		);
	};

	const setWorking = async (working: boolean): Promise<void> => {
		const operation = enqueueUpdate(async () => {
			isWorking = working;

			if (messageTs) {
				const currentMessageTs = messageTs;
				const displayText = isWorking
					? accumulatedText + WORKING_INDICATOR
					: accumulatedText;
				await throttleUpdate(async () => {
					await callSlack(
						() =>
							webClient.chat.update({
								channel: channelId,
								ts: currentMessageTs,
								text: displayText,
							}),
						"chat.update",
					);
				});
			}
		});

		await operation;
	};

	const updateStatus = async (status: string): Promise<void> => {
		const operation = enqueueUpdate(async () => {
			if (messageTs && isWorking) {
				const currentMessageTs = messageTs;
				const displayText = `${accumulatedText}\n_${status}_${WORKING_INDICATOR}`;
				await throttleUpdate(async () => {
					await callSlack(
						() =>
							webClient.chat.update({
								channel: channelId,
								ts: currentMessageTs,
								text: displayText,
							}),
						"chat.update",
					);
				});
			}
		});

		await operation;
	};

	return {
		respond,
		replaceMessage,
		respondInThread,
		postMessage,
		postThreadReply,
		setTyping,
		uploadFile,
		setWorking,
		updateStatus,
	};
}
