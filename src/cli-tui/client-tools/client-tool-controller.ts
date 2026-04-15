import { execFile } from "node:child_process";
import type { Container, TUI } from "@evalops/tui";
import type { Question } from "../../tools/ask-user.js";
import { extractQuestions, parseUserResponse } from "../../tools/ask-user.js";
import type { CustomEditor } from "../custom-editor.js";
import {
	HookInputModal,
	type HookInputModalOptions,
} from "../hooks/hook-input-modal.js";
import type { Modal } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import type {
	TuiClientToolLifecycleEvent,
	TuiClientToolService,
	TuiPendingClientToolRequest,
} from "./local-client-tool-service.js";

type PrimitiveValue = string | number | boolean | string[];

type EnumOption = {
	label: string;
	value: string;
};

type FieldDefinition =
	| {
			key: string;
			kind: "boolean";
			label: string;
			description?: string;
			defaultValue?: boolean;
	  }
	| {
			key: string;
			kind: "string";
			label: string;
			description?: string;
			defaultValue?: string;
			format?: "date" | "date-time" | "email" | "uri";
			maxLength?: number;
			minLength?: number;
	  }
	| {
			key: string;
			kind: "number";
			label: string;
			description?: string;
			defaultValue?: number;
			integer: boolean;
			maximum?: number;
			minimum?: number;
	  }
	| {
			key: string;
			kind: "select";
			label: string;
			description?: string;
			defaultValue?: string;
			options: EnumOption[];
	  }
	| {
			key: string;
			kind: "multi-select";
			label: string;
			description?: string;
			defaultValue?: string[];
			maxItems?: number;
			minItems?: number;
			options: EnumOption[];
	  };

type ParsedFormRequest = {
	fields: FieldDefinition[];
	kind: "form";
	message: string;
	requestId: string;
	requiredKeys: Set<string>;
	serverName: string;
};

type ParsedMalformedRequest = {
	error: string;
	kind: "malformed";
	message: string;
	requestId?: string;
	serverName?: string;
};

type ParsedUrlRequest = {
	elicitationId?: string;
	kind: "url";
	message: string;
	requestId: string;
	serverName: string;
	url: string;
};

type ParsedRequest =
	| ParsedFormRequest
	| ParsedMalformedRequest
	| ParsedUrlRequest;

interface ClientToolControllerOptions {
	clientToolService: TuiClientToolService;
	ui: TUI;
	editor: CustomEditor;
	editorContainer: Container;
	notificationView: NotificationView;
	createInputModal?: (options: HookInputModalOptions) => Modal;
	openUrl?: (url: string) => boolean | Promise<boolean>;
	onPendingStatusChange?: (toolCallId: string, status: string | null) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function getOptionalNumber(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function getOptionalString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function normalizeOptionEntries(
	values: string[],
	labels?: string[],
): EnumOption[] {
	return values.map((value, index) => ({
		value,
		label: labels?.[index] ?? value,
	}));
}

function parseFieldDefinition(
	key: string,
	value: unknown,
): FieldDefinition | null {
	if (!isRecord(value) || typeof value.type !== "string") {
		return null;
	}

	const label = getOptionalString(value, "title") ?? key;
	const description = getOptionalString(value, "description");

	if (value.type === "boolean") {
		return {
			key,
			kind: "boolean",
			label,
			description,
			defaultValue:
				typeof value.default === "boolean" ? value.default : undefined,
		};
	}

	if (value.type === "string") {
		if (
			Array.isArray(value.enum) &&
			value.enum.every((entry) => typeof entry === "string")
		) {
			const enumNames =
				Array.isArray(value.enumNames) &&
				value.enumNames.every((entry) => typeof entry === "string")
					? (value.enumNames as string[])
					: undefined;
			return {
				key,
				kind: "select",
				label,
				description,
				defaultValue:
					typeof value.default === "string" ? value.default : undefined,
				options: normalizeOptionEntries(value.enum as string[], enumNames),
			};
		}
		if (
			Array.isArray(value.oneOf) &&
			value.oneOf.every(
				(entry) =>
					isRecord(entry) &&
					typeof entry.const === "string" &&
					typeof entry.title === "string",
			)
		) {
			return {
				key,
				kind: "select",
				label,
				description,
				defaultValue:
					typeof value.default === "string" ? value.default : undefined,
				options: (value.oneOf as Array<{ const: string; title: string }>).map(
					(entry) => ({
						value: entry.const,
						label: entry.title,
					}),
				),
			};
		}
		return {
			key,
			kind: "string",
			label,
			description,
			defaultValue:
				typeof value.default === "string" ? value.default : undefined,
			format:
				value.format === "date" ||
				value.format === "date-time" ||
				value.format === "email" ||
				value.format === "uri"
					? value.format
					: undefined,
			maxLength: getOptionalNumber(value, "maxLength"),
			minLength: getOptionalNumber(value, "minLength"),
		};
	}

	if (value.type === "number" || value.type === "integer") {
		return {
			key,
			kind: "number",
			label,
			description,
			defaultValue:
				typeof value.default === "number" ? value.default : undefined,
			integer: value.type === "integer",
			maximum: getOptionalNumber(value, "maximum"),
			minimum: getOptionalNumber(value, "minimum"),
		};
	}

	if (value.type === "array" && isRecord(value.items)) {
		if (
			Array.isArray(value.items.enum) &&
			value.items.enum.every((entry) => typeof entry === "string")
		) {
			return {
				key,
				kind: "multi-select",
				label,
				description,
				defaultValue:
					Array.isArray(value.default) &&
					value.default.every((entry) => typeof entry === "string")
						? [...(value.default as string[])]
						: undefined,
				minItems: getOptionalNumber(value, "minItems"),
				maxItems: getOptionalNumber(value, "maxItems"),
				options: normalizeOptionEntries(value.items.enum as string[]),
			};
		}
		if (
			Array.isArray(value.items.anyOf) &&
			value.items.anyOf.every(
				(entry) =>
					isRecord(entry) &&
					typeof entry.const === "string" &&
					typeof entry.title === "string",
			)
		) {
			return {
				key,
				kind: "multi-select",
				label,
				description,
				defaultValue:
					Array.isArray(value.default) &&
					value.default.every((entry) => typeof entry === "string")
						? [...(value.default as string[])]
						: undefined,
				minItems: getOptionalNumber(value, "minItems"),
				maxItems: getOptionalNumber(value, "maxItems"),
				options: (
					value.items.anyOf as Array<{ const: string; title: string }>
				).map((entry) => ({
					value: entry.const,
					label: entry.title,
				})),
			};
		}
	}

	return null;
}

function parseMcpElicitationRequest(args: unknown): ParsedRequest {
	if (!isRecord(args)) {
		return {
			kind: "malformed",
			message: "MCP server requested additional input.",
			error: "Missing elicitation arguments.",
		};
	}

	const requestId = getOptionalString(args, "requestId");
	const serverName = getOptionalString(args, "serverName");
	const message =
		getOptionalString(args, "message") ??
		"MCP server requested additional input.";
	if (!requestId || !serverName) {
		return {
			kind: "malformed",
			message,
			error: "Missing elicitation request identity.",
		};
	}

	if (args.mode === "url") {
		const url = getOptionalString(args, "url");
		if (!url) {
			return {
				kind: "malformed",
				message,
				requestId,
				serverName,
				error: "Missing URL for URL-mode elicitation.",
			};
		}
		return {
			kind: "url",
			message,
			requestId,
			serverName,
			url,
			elicitationId: getOptionalString(args, "elicitationId"),
		};
	}

	const requestedSchema = args.requestedSchema;
	if (!isRecord(requestedSchema)) {
		return {
			kind: "malformed",
			message,
			serverName,
			requestId,
			error: "Missing requested schema for form elicitation.",
		};
	}
	if (
		requestedSchema.type !== "object" ||
		!isRecord(requestedSchema.properties)
	) {
		return {
			kind: "malformed",
			message,
			serverName,
			requestId,
			error: "Unsupported elicitation schema shape.",
		};
	}

	const fields = Object.entries(requestedSchema.properties).flatMap(
		([key, value]) => {
			const field = parseFieldDefinition(key, value);
			return field ? [field] : [];
		},
	);
	if (fields.length !== Object.keys(requestedSchema.properties).length) {
		return {
			kind: "malformed",
			message,
			serverName,
			requestId,
			error:
				"This elicitation form contains field types the TUI does not support yet.",
		};
	}

	const requiredKeys = new Set(
		Array.isArray(requestedSchema.required)
			? requestedSchema.required.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [],
	);

	return {
		kind: "form",
		serverName,
		requestId,
		message,
		fields,
		requiredKeys,
	};
}

function buildInitialValues(
	fields: FieldDefinition[],
): Record<string, PrimitiveValue | undefined> {
	const values: Record<string, PrimitiveValue | undefined> = {};
	for (const field of fields) {
		if (field.kind === "boolean" && field.defaultValue !== undefined) {
			values[field.key] = field.defaultValue;
			continue;
		}
		if (
			(field.kind === "string" || field.kind === "select") &&
			field.defaultValue !== undefined
		) {
			values[field.key] = field.defaultValue;
			continue;
		}
		if (field.kind === "number" && field.defaultValue !== undefined) {
			values[field.key] = field.defaultValue;
			continue;
		}
		if (field.kind === "multi-select" && field.defaultValue !== undefined) {
			values[field.key] = [...field.defaultValue];
		}
	}
	return values;
}

function validateCollectedForm(
	request: ParsedFormRequest,
	values: Record<string, PrimitiveValue | undefined>,
): { content?: Record<string, PrimitiveValue>; error?: string } {
	const content: Record<string, PrimitiveValue> = {};

	for (const field of request.fields) {
		const required = request.requiredKeys.has(field.key);
		const value = values[field.key];

		if (field.kind === "boolean") {
			if (typeof value !== "boolean") {
				if (required) {
					return { error: `Select a value for ${field.label}.` };
				}
				continue;
			}
			content[field.key] = value;
			continue;
		}

		if (field.kind === "number") {
			if (typeof value !== "number" || Number.isNaN(value)) {
				if (required) {
					return { error: `Enter a value for ${field.label}.` };
				}
				continue;
			}
			if (field.integer && !Number.isInteger(value)) {
				return { error: `${field.label} must be an integer.` };
			}
			if (field.minimum !== undefined && value < field.minimum) {
				return {
					error: `${field.label} must be at least ${field.minimum}.`,
				};
			}
			if (field.maximum !== undefined && value > field.maximum) {
				return {
					error: `${field.label} must be at most ${field.maximum}.`,
				};
			}
			content[field.key] = value;
			continue;
		}

		if (field.kind === "multi-select") {
			const items = Array.isArray(value)
				? value.filter((entry): entry is string => typeof entry === "string")
				: [];
			if (required && items.length === 0) {
				return {
					error: `Select at least one option for ${field.label}.`,
				};
			}
			if (field.minItems !== undefined && items.length < field.minItems) {
				return {
					error: `${field.label} needs at least ${field.minItems} selections.`,
				};
			}
			if (field.maxItems !== undefined && items.length > field.maxItems) {
				return {
					error: `${field.label} allows at most ${field.maxItems} selections.`,
				};
			}
			if (items.length > 0) {
				content[field.key] = items;
			}
			continue;
		}

		const text = typeof value === "string" ? value.trim() : "";
		if (!text) {
			if (required) {
				return { error: `Enter a value for ${field.label}.` };
			}
			continue;
		}
		if (field.kind === "string") {
			if (field.minLength !== undefined && text.length < field.minLength) {
				return {
					error: `${field.label} must be at least ${field.minLength} characters.`,
				};
			}
			if (field.maxLength !== undefined && text.length > field.maxLength) {
				return {
					error: `${field.label} must be at most ${field.maxLength} characters.`,
				};
			}
		}
		content[field.key] = text;
	}

	return { content };
}

function formatQueueSuffix(queueLength: number): string | null {
	if (queueLength <= 0) {
		return null;
	}
	return queueLength === 1
		? "1 more request is queued behind this one."
		: `${queueLength} more requests are queued behind this one.`;
}

function formatAskUserPrompt(
	question: Question,
	index: number,
	total: number,
	queueLength: number,
): string {
	const lines = [
		`Question ${index + 1} of ${total}`,
		`[${question.header}] ${question.question}`,
		"",
		...question.options.map(
			(option, optionIndex) =>
				`${optionIndex + 1}. ${option.label}: ${option.description}`,
		),
		`${question.options.length + 1}. Other: type your own answer directly`,
		"",
		question.multiSelect
			? "Choose one or more options separated by commas, or type your own answer."
			: "Choose one option by number or label, or type your own answer.",
		"Press Esc to cancel this input request.",
	];
	const queueSuffix = formatQueueSuffix(queueLength);
	if (queueSuffix) {
		lines.push("", queueSuffix);
	}
	return lines.join("\n");
}

function normalizeAskUserAnswer(answer: string | string[]): {
	error?: string;
	value?: string;
} {
	const entries = (Array.isArray(answer) ? answer : [answer])
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (entries.length === 0) {
		return {
			error: "Select an option or enter a custom answer.",
		};
	}
	if (entries.some((entry) => entry.toLowerCase() === "other")) {
		return {
			error: "Type the custom answer directly instead of selecting Other.",
		};
	}
	return {
		value: entries.join(", "),
	};
}

function parseBooleanInput(rawValue: string): boolean | undefined {
	switch (rawValue.trim().toLowerCase()) {
		case "y":
		case "yes":
		case "true":
		case "1":
		case "on":
			return true;
		case "n":
		case "no":
		case "false":
		case "0":
		case "off":
			return false;
		default:
			return undefined;
	}
}

function resolveSelectOption(
	rawValue: string,
	options: EnumOption[],
): EnumOption | undefined {
	const trimmed = rawValue.trim();
	if (!trimmed) {
		return undefined;
	}
	const index = Number.parseInt(trimmed, 10);
	if (!Number.isNaN(index) && index >= 1 && index <= options.length) {
		return options[index - 1];
	}
	const normalized = trimmed.toLowerCase();
	return options.find(
		(option) =>
			option.value.toLowerCase() === normalized ||
			option.label.toLowerCase() === normalized,
	);
}

function formatFieldValue(
	value: PrimitiveValue | undefined,
): string | undefined {
	if (typeof value === "boolean") {
		return value ? "yes" : "no";
	}
	if (typeof value === "number") {
		return String(value);
	}
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.join(", ");
	}
	return undefined;
}

function formatOption(option: EnumOption, index: number): string {
	const valueSuffix = option.label === option.value ? "" : ` (${option.value})`;
	return `${index + 1}. ${option.label}${valueSuffix}`;
}

function formatFieldPrompt(
	request: ParsedFormRequest,
	field: FieldDefinition,
	index: number,
	queueLength: number,
): string {
	const required = request.requiredKeys.has(field.key);
	const lines = [
		`Server: ${request.serverName}`,
		`Field ${index + 1} of ${request.fields.length}`,
		request.message,
		"",
		`${field.label}${required ? " (required)" : ""}`,
	];
	if (field.description) {
		lines.push(field.description);
	}

	switch (field.kind) {
		case "boolean":
			lines.push("", "Type yes or no.");
			break;
		case "string":
			lines.push("", "Type a value and press Enter.");
			if (field.format) {
				lines.push(`Expected format: ${field.format}.`);
			}
			if (field.minLength !== undefined) {
				lines.push(`Minimum length: ${field.minLength}.`);
			}
			if (field.maxLength !== undefined) {
				lines.push(`Maximum length: ${field.maxLength}.`);
			}
			break;
		case "number":
			lines.push(
				"",
				field.integer
					? "Type an integer and press Enter."
					: "Type a number and press Enter.",
			);
			if (field.minimum !== undefined) {
				lines.push(`Minimum value: ${field.minimum}.`);
			}
			if (field.maximum !== undefined) {
				lines.push(`Maximum value: ${field.maximum}.`);
			}
			break;
		case "select":
			lines.push(
				"",
				...field.options.map((option, optionIndex) =>
					formatOption(option, optionIndex),
				),
				"",
				"Choose an option by number, label, or value.",
			);
			break;
		case "multi-select":
			lines.push(
				"",
				...field.options.map((option, optionIndex) =>
					formatOption(option, optionIndex),
				),
				"",
				"Choose one or more options separated by commas.",
			);
			if (field.minItems !== undefined) {
				lines.push(`Minimum selections: ${field.minItems}.`);
			}
			if (field.maxItems !== undefined) {
				lines.push(`Maximum selections: ${field.maxItems}.`);
			}
			break;
	}

	const queueSuffix = formatQueueSuffix(queueLength);
	if (queueSuffix) {
		lines.push("", queueSuffix);
	}
	lines.push(
		"",
		"Submit a blank value to keep the default or skip an optional field.",
	);
	return lines.join("\n");
}

async function openExternalUrl(url: string): Promise<boolean> {
	const openCmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "cmd"
				: "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	return new Promise((resolve) => {
		execFile(openCmd, args, (error) => resolve(!error));
	});
}

export class ClientToolController {
	private readonly queue: TuiPendingClientToolRequest[] = [];
	private active: TuiPendingClientToolRequest | null = null;
	private modal: Modal | null = null;
	private processingNext = false;
	private readonly unsubscribe: () => void;

	constructor(private readonly options: ClientToolControllerOptions) {
		this.unsubscribe = this.options.clientToolService.subscribe((event) =>
			this.handleLifecycleEvent(event),
		);
	}

	dispose(): void {
		this.unsubscribe();
	}

	private handleLifecycleEvent(event: TuiClientToolLifecycleEvent): void {
		if (event.type === "registered") {
			this.enqueue(event.request);
			return;
		}
		this.options.onPendingStatusChange?.(event.request.id, null);
		if (this.active?.id === event.request.id) {
			this.active = null;
		} else {
			const queueIndex = this.queue.findIndex(
				(entry) => entry.id === event.request.id,
			);
			if (queueIndex >= 0) {
				this.queue.splice(queueIndex, 1);
			}
		}
		this.scheduleNext();
	}

	private enqueue(request: TuiPendingClientToolRequest): void {
		if (this.active?.id === request.id) {
			return;
		}
		if (this.queue.some((entry) => entry.id === request.id)) {
			return;
		}
		this.queue.push(request);
		this.options.onPendingStatusChange?.(
			request.id,
			this.getPendingStatus(request.toolName),
		);
		if (!this.active) {
			this.scheduleNext();
		}
	}

	private scheduleNext(): void {
		if (this.processingNext) {
			return;
		}
		this.processingNext = true;
		queueMicrotask(() => {
			this.processingNext = false;
			this.showNext();
		});
	}

	private showNext(): void {
		if (this.active || this.queue.length === 0) {
			if (!this.active && this.queue.length === 0) {
				this.restoreEditor();
			}
			return;
		}

		const next = this.queue.shift();
		if (!next) {
			this.restoreEditor();
			return;
		}
		this.active = next;
		this.showRequest(next);
	}

	private showRequest(request: TuiPendingClientToolRequest): void {
		if (request.toolName === "ask_user") {
			this.showAskUserRequest(request);
			return;
		}
		if (request.toolName === "mcp_elicitation") {
			this.showMcpElicitationRequest(request);
			return;
		}
		this.options.notificationView.showError(
			`Unsupported local client tool: ${request.toolName}`,
		);
		this.options.clientToolService.cancel(
			request.id,
			`Unsupported local client tool: ${request.toolName}`,
		);
	}

	private showAskUserRequest(request: TuiPendingClientToolRequest): void {
		const questions = extractQuestions(request.args);
		if (questions.length === 0) {
			this.options.notificationView.showError(
				"Malformed ask_user request. Cancelling the pending input.",
			);
			this.options.clientToolService.resolve(
				request.id,
				[{ type: "text", text: "User cancelled structured input request." }],
				true,
			);
			return;
		}

		const answers: string[] = [];
		const showQuestion = (index: number) => {
			const question = questions[index];
			if (!question) {
				const content =
					questions.length === 1 ? (answers[0] ?? "") : answers.join("\n");
				this.options.clientToolService.resolve(
					request.id,
					[{ type: "text", text: content }],
					false,
				);
				return;
			}
			const modal = this.createInputModal({
				ui: this.options.ui,
				title: "Structured Input",
				description: formatAskUserPrompt(
					question,
					index,
					questions.length,
					this.queue.length,
				),
				placeholder: "Type an option number, label, or your own answer",
				onSubmit: (value) => {
					const trimmed = value.trim();
					if (!trimmed) {
						this.options.notificationView.showError(
							"Select an option or enter a custom answer.",
						);
						return;
					}
					const parsed = parseUserResponse(trimmed, question);
					const normalized = normalizeAskUserAnswer(parsed);
					if (!normalized.value) {
						this.options.notificationView.showError(
							normalized.error ?? "Select an option or enter a custom answer.",
						);
						return;
					}
					answers[index] =
						questions.length === 1
							? normalized.value
							: `${question.header}: ${normalized.value}`;
					showQuestion(index + 1);
				},
				onCancel: () => {
					this.options.clientToolService.resolve(
						request.id,
						[
							{
								type: "text",
								text: "User cancelled structured input request.",
							},
						],
						true,
					);
				},
			});
			this.showModal(modal);
		};

		showQuestion(0);
	}

	private showMcpElicitationRequest(
		request: TuiPendingClientToolRequest,
	): void {
		const parsed = parseMcpElicitationRequest(request.args);
		if (parsed.kind === "malformed") {
			this.options.notificationView.showError(
				parsed.error || "Malformed MCP elicitation request.",
			);
			this.resolveMcpAction(request.id, "cancel");
			return;
		}

		if (parsed.kind === "url") {
			void Promise.resolve(
				(this.options.openUrl ?? openExternalUrl)(parsed.url),
			).then((opened) => {
				if (!opened) {
					this.options.notificationView.showInfo(
						"Could not auto-open the URL. Please open it manually.",
					);
				}
			});
			const modal = this.createInputModal({
				ui: this.options.ui,
				title: "MCP URL Request",
				description: [
					`Server: ${parsed.serverName}`,
					parsed.message,
					"",
					parsed.url,
					"",
					"Type accept, decline, or cancel.",
					formatQueueSuffix(this.queue.length),
				]
					.filter((line): line is string => Boolean(line))
					.join("\n"),
				placeholder: "accept | decline | cancel",
				onSubmit: (value) => {
					const action = value.trim().toLowerCase();
					if (
						action !== "accept" &&
						action !== "decline" &&
						action !== "cancel"
					) {
						this.options.notificationView.showError(
							"Type accept, decline, or cancel.",
						);
						return;
					}
					this.resolveMcpAction(
						request.id,
						action as "accept" | "decline" | "cancel",
					);
				},
				onCancel: () => this.resolveMcpAction(request.id, "cancel"),
			});
			this.showModal(modal);
			return;
		}

		if (parsed.fields.length === 0) {
			this.resolveMcpAction(request.id, "accept", {});
			return;
		}

		const values = buildInitialValues(parsed.fields);
		const showField = (index: number) => {
			const field = parsed.fields[index];
			if (!field) {
				const validation = validateCollectedForm(parsed, values);
				if (!validation.content) {
					this.options.notificationView.showError(
						validation.error ?? "Unable to submit MCP input.",
					);
					this.resolveMcpAction(request.id, "cancel");
					return;
				}
				this.resolveMcpAction(request.id, "accept", validation.content);
				return;
			}
			const required = parsed.requiredKeys.has(field.key);
			const currentValue = values[field.key];
			const modal = this.createInputModal({
				ui: this.options.ui,
				title: "MCP Input",
				description: formatFieldPrompt(parsed, field, index, this.queue.length),
				placeholder: "Submit the field value",
				prefill: formatFieldValue(currentValue),
				onSubmit: (value) => {
					const normalized = this.normalizeFieldValue(
						field,
						value,
						currentValue,
						required,
					);
					if (normalized.error) {
						this.options.notificationView.showError(normalized.error);
						return;
					}
					values[field.key] = normalized.value;
					showField(index + 1);
				},
				onCancel: () => this.resolveMcpAction(request.id, "cancel"),
			});
			this.showModal(modal);
		};

		showField(0);
	}

	private normalizeFieldValue(
		field: FieldDefinition,
		rawValue: string,
		currentValue: PrimitiveValue | undefined,
		required: boolean,
	): { error?: string; value?: PrimitiveValue } {
		const trimmed = rawValue.trim();
		if (!trimmed) {
			if (currentValue !== undefined) {
				return { value: currentValue };
			}
			if (required) {
				return { error: `Enter a value for ${field.label}.` };
			}
			return { value: undefined };
		}

		if (field.kind === "boolean") {
			const value = parseBooleanInput(trimmed);
			if (value === undefined) {
				return { error: `${field.label} must be yes or no.` };
			}
			return { value };
		}

		if (field.kind === "number") {
			const value = Number(trimmed);
			if (!Number.isFinite(value)) {
				return { error: `${field.label} must be a valid number.` };
			}
			if (field.integer && !Number.isInteger(value)) {
				return { error: `${field.label} must be an integer.` };
			}
			if (field.minimum !== undefined && value < field.minimum) {
				return {
					error: `${field.label} must be at least ${field.minimum}.`,
				};
			}
			if (field.maximum !== undefined && value > field.maximum) {
				return {
					error: `${field.label} must be at most ${field.maximum}.`,
				};
			}
			return { value };
		}

		if (field.kind === "select") {
			const option = resolveSelectOption(trimmed, field.options);
			if (!option) {
				return {
					error: `${field.label} must match one of the listed options.`,
				};
			}
			return { value: option.value };
		}

		if (field.kind === "multi-select") {
			const tokens = trimmed
				.split(",")
				.map((token) => token.trim())
				.filter((token) => token.length > 0);
			if (tokens.length === 0) {
				if (required) {
					return {
						error: `Select at least one option for ${field.label}.`,
					};
				}
				return { value: undefined };
			}
			const selections = new Set<string>();
			for (const token of tokens) {
				const option = resolveSelectOption(token, field.options);
				if (!option) {
					return {
						error: `${field.label} must use the listed options.`,
					};
				}
				selections.add(option.value);
			}
			const items = [...selections];
			if (field.minItems !== undefined && items.length < field.minItems) {
				return {
					error: `${field.label} needs at least ${field.minItems} selections.`,
				};
			}
			if (field.maxItems !== undefined && items.length > field.maxItems) {
				return {
					error: `${field.label} allows at most ${field.maxItems} selections.`,
				};
			}
			return { value: items };
		}

		if (field.minLength !== undefined && trimmed.length < field.minLength) {
			return {
				error: `${field.label} must be at least ${field.minLength} characters.`,
			};
		}
		if (field.maxLength !== undefined && trimmed.length > field.maxLength) {
			return {
				error: `${field.label} must be at most ${field.maxLength} characters.`,
			};
		}
		return { value: trimmed };
	}

	private resolveMcpAction(
		requestId: string,
		action: "accept" | "decline" | "cancel",
		content?: Record<string, PrimitiveValue>,
	): void {
		this.options.clientToolService.resolve(
			requestId,
			[
				{
					type: "text",
					text: JSON.stringify({
						action,
						...(action === "accept" && content ? { content } : {}),
					}),
				},
			],
			false,
		);
	}

	private createInputModal(options: HookInputModalOptions): Modal {
		return (
			this.options.createInputModal ??
			((modalOptions: HookInputModalOptions) =>
				new HookInputModal(modalOptions))
		)(options);
	}

	private showModal(modal: Modal): void {
		this.modal = modal;
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(modal);
		this.options.ui.setFocus(modal);
		this.options.ui.requestRender();
	}

	private restoreEditor(): void {
		if (!this.modal) {
			return;
		}
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.options.editor);
		this.options.ui.setFocus(this.options.editor);
		this.modal = null;
		this.options.ui.requestRender();
	}

	private getPendingStatus(toolName: string): string {
		switch (toolName) {
			case "ask_user":
				return "Waiting for structured input";
			case "mcp_elicitation":
				return "Waiting for MCP input";
			default:
				return "Waiting for local client tool";
		}
	}
}
