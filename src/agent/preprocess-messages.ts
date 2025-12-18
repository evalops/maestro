import {
	getImageMetadata,
	isSharpAvailable,
	processImage,
} from "../tools/image-processor.js";
import { transformMessages } from "./providers/transform-messages.js";
import type {
	AgentTool,
	Api,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "./types.js";

export type PreprocessMessagesFn = (
	messages: Message[],
	context: {
		systemPrompt: string;
		tools: AgentTool[];
		model: Model<Api>;
		userMessage?: Message;
	},
	signal?: AbortSignal,
) => Message[] | Promise<Message[]>;

export function chainPreprocessMessages(
	...fns: Array<PreprocessMessagesFn | undefined>
): PreprocessMessagesFn | undefined {
	const active = fns.filter(
		(fn): fn is PreprocessMessagesFn => typeof fn === "function",
	);
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];

	return async (messages, context, signal) => {
		let current = messages;
		for (const fn of active) {
			// Ensure abort is respected between preprocessors.
			if (signal?.aborted) return current;
			current = await fn(current, context, signal);
		}
		return current;
	};
}

function countImages(messages: Message[]): number {
	let count = 0;
	for (const msg of messages) {
		if (msg.role === "user") {
			if (Array.isArray(msg.content)) {
				for (const c of msg.content) if (c.type === "image") count++;
			}
		} else if (msg.role === "toolResult") {
			for (const c of msg.content) if (c.type === "image") count++;
		}
	}
	return count;
}

function stripImagesIfUnsupported(
	messages: Message[],
	model: Model<Api>,
): Message[] {
	if (model.input.includes("image")) return messages;

	const stripUser = (msg: UserMessage): UserMessage => {
		if (!Array.isArray(msg.content)) return msg;

		const removed = msg.content.filter((c) => c.type === "image").length;
		const kept = msg.content.filter((c): c is TextContent => c.type === "text");

		if (kept.length === 0) {
			const notice: TextContent = {
				type: "text",
				text:
					removed > 0
						? `[Image(s) omitted: current model (${model.id}) does not support image input.]`
						: `[Content omitted: current model (${model.id}) does not support non-text input.]`,
			};
			return { ...msg, content: [notice] };
		}

		return { ...msg, content: kept };
	};

	const stripToolResult = (msg: ToolResultMessage): ToolResultMessage => {
		const removed = msg.content.filter((c) => c.type === "image").length;
		const kept = msg.content.filter((c): c is TextContent => c.type === "text");
		if (kept.length === 0) {
			return {
				...msg,
				content: [
					{
						type: "text",
						text:
							removed > 0
								? `(tool returned ${removed} image(s) omitted: current model (${model.id}) does not support image input)`
								: "(tool returned no text output)",
					},
				],
			};
		}
		return { ...msg, content: kept };
	};

	let changed = false;
	const out = messages.map((msg) => {
		if (msg.role === "user") {
			if (
				Array.isArray(msg.content) &&
				msg.content.some((c) => c.type === "image")
			) {
				changed = true;
				return stripUser(msg);
			}
			return msg;
		}
		if (msg.role === "toolResult") {
			if (msg.content.some((c) => c.type === "image")) {
				changed = true;
				return stripToolResult(msg);
			}
			return msg;
		}
		return msg;
	});

	return changed ? out : messages;
}

function mimeTypeToFormat(
	mimeType: string | undefined,
): "jpeg" | "png" | "webp" | undefined {
	if (!mimeType) return undefined;
	if (mimeType.includes("png")) return "png";
	if (mimeType.includes("webp")) return "webp";
	if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpeg";
	return undefined;
}

async function sanitizeImagesForAnthropic(
	messages: Message[],
	model: Model<Api>,
	signal?: AbortSignal,
): Promise<Message[]> {
	if (model.api !== "anthropic-messages") return messages;
	if (!model.input.includes("image")) return messages;

	// Anthropic image dimension limits are dynamic; a conservative approximation:
	// - up to 8000x8000 generally
	// - when many images are present in a session, limits reduce (commonly ~2000x2000)
	const totalImages = countImages(messages);
	const maxDim = totalImages > 20 ? 2000 : 8000;

	const sharpAvailable = await isSharpAvailable();
	if (!sharpAvailable) {
		// Can't safely inspect/resize. Leave images as-is.
		return messages;
	}

	const maybeResize = async (
		img: ImageContent,
	): Promise<ImageContent | TextContent> => {
		if (signal?.aborted) return img;

		try {
			const input = Buffer.from(img.data, "base64");
			const metadata = await getImageMetadata(input);
			if (!metadata) return img;

			const { width, height } = metadata;
			if (width <= maxDim && height <= maxDim) return img;

			const processed = await processImage(input, {
				maxWidth: maxDim,
				maxHeight: maxDim,
				format: mimeTypeToFormat(img.mimeType),
				quality: 85,
				maxBytes: 5 * 1024 * 1024,
			});

			return {
				type: "image",
				data: processed.base64,
				mimeType: processed.mimeType,
			};
		} catch {
			return {
				type: "text",
				text: "[Image omitted: exceeded provider limits and could not be resized.]",
			};
		}
	};

	let changed = false;

	const out: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			if (!Array.isArray(msg.content)) {
				out.push(msg);
				continue;
			}

			let messageChanged = false;
			const nextContent: Array<TextContent | ImageContent> = [];
			for (const c of msg.content) {
				if (c.type !== "image") {
					nextContent.push(c);
					continue;
				}
				const replaced = await maybeResize(c);
				if (replaced !== c) {
					messageChanged = true;
				}
				nextContent.push(replaced);
			}
			if (messageChanged) {
				changed = true;
				out.push({ ...msg, content: nextContent } as UserMessage);
			} else {
				out.push(msg);
			}
			continue;
		}

		if (msg.role === "toolResult") {
			let messageChanged = false;
			const nextContent: Array<TextContent | ImageContent> = [];
			for (const c of msg.content) {
				if (c.type !== "image") {
					nextContent.push(c);
					continue;
				}
				const replaced = await maybeResize(c);
				if (replaced !== c) {
					messageChanged = true;
				}
				nextContent.push(replaced);
			}
			if (messageChanged) {
				changed = true;
				out.push({ ...msg, content: nextContent } as ToolResultMessage);
			} else {
				out.push(msg);
			}
			continue;
		}

		out.push(msg);
	}

	return changed ? out : messages;
}

/**
 * Default preprocessor applied right before provider invocation.
 *
 * Goals:
 * - Ensure cross-provider compatibility for *all* providers (including ones that
 *   don't run provider-level transforms, e.g. Bedrock).
 * - Avoid sending images to models that don't support them.
 * - Sanitize Anthropic image inputs to reduce rejection risk.
 */
export const defaultPreprocessMessages: PreprocessMessagesFn = async (
	messages,
	context,
	signal,
) => {
	// 1) Normalize thinking + filter orphaned tool calls (safe for all providers).
	let current = transformMessages(messages, context.model);

	// 2) Strip images if the target model doesn't support vision.
	current = stripImagesIfUnsupported(current, context.model);

	// 3) Provider-specific image sanitation (currently Anthropic).
	current = await sanitizeImagesForAnthropic(current, context.model, signal);

	return current;
};
