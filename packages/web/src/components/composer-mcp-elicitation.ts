/**
 * MCP elicitation component - handles form and URL-mode elicitation requests.
 */

import type { ComposerPendingClientToolRequest } from "@evalops/contracts";
import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

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
					value.items.anyOf as Array<{
						const: string;
						title: string;
					}>
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
			message: "Malformed MCP elicitation request.",
			error: "Missing structured request arguments.",
		};
	}

	const serverName = getOptionalString(args, "serverName");
	const requestId = getOptionalString(args, "requestId");
	const message = getOptionalString(args, "message");
	const mode = args.mode === "url" ? "url" : "form";

	if (!serverName || !requestId || !message) {
		return {
			kind: "malformed",
			message: "Malformed MCP elicitation request.",
			serverName,
			requestId,
			error: "Missing server name, request id, or message.",
		};
	}

	if (mode === "url") {
		const url = getOptionalString(args, "url");
		if (!url) {
			return {
				kind: "malformed",
				message,
				serverName,
				requestId,
				error: "Missing URL for URL-mode elicitation.",
			};
		}
		return {
			kind: "url",
			serverName,
			requestId,
			message,
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
				"This elicitation form contains field types the web client does not support yet.",
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
): Record<string, PrimitiveValue> {
	const values: Record<string, PrimitiveValue> = {};
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

@customElement("composer-mcp-elicitation")
export class ComposerMcpElicitation extends LitElement {
	static override styles = css`
		:host {
			display: block;
			font-family: "SF Mono", "Menlo", "Monaco", "Courier New", monospace;
		}

		.overlay {
			position: fixed;
			inset: 0;
			background: rgba(9, 11, 14, 0.94);
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 1.25rem;
			z-index: 1000;
		}

		.panel {
			width: min(760px, 100%);
			max-height: 86vh;
			overflow-y: auto;
			background: #10141a;
			border: 1px solid #f59e0b;
			box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
		}

		.header {
			padding: 1rem 1.1rem;
			background: linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(251, 191, 36, 0.08));
			border-bottom: 1px solid rgba(245, 158, 11, 0.4);
			display: grid;
			gap: 0.5rem;
		}

		.eyebrow {
			display: flex;
			align-items: center;
			gap: 0.6rem;
			flex-wrap: wrap;
			font-size: 0.7rem;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: #fcd34d;
		}

		.badge {
			padding: 0.18rem 0.45rem;
			border: 1px solid rgba(245, 158, 11, 0.5);
			background: rgba(20, 24, 31, 0.75);
		}

		.title {
			font-size: 0.95rem;
			line-height: 1.6;
			color: #f8fafc;
		}

		.body {
			padding: 1rem 1.1rem;
			display: grid;
			gap: 0.95rem;
		}

		.info-box,
		.field,
		.validation,
		.error-box,
		.url-box {
			border: 1px solid #2a3340;
			background: #151b23;
			padding: 0.85rem;
		}

		.info-box {
			border-left: 3px solid #f59e0b;
		}

		.label {
			font-size: 0.72rem;
			font-weight: 700;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: #94a3b8;
			margin-bottom: 0.45rem;
		}

		.help,
		.queue,
		.error-box,
		.url-link {
			font-size: 0.75rem;
			line-height: 1.6;
			color: #cbd5e1;
		}

		.field-title {
			font-size: 0.78rem;
			font-weight: 700;
			color: #f8fafc;
		}

		.required {
			color: #fbbf24;
		}

		.description {
			margin-top: 0.3rem;
			font-size: 0.72rem;
			line-height: 1.55;
			color: #94a3b8;
		}

		.control,
		.select {
			width: 100%;
			box-sizing: border-box;
			margin-top: 0.65rem;
			padding: 0.68rem 0.72rem;
			border: 1px solid #334155;
			background: #0f141b;
			color: #f8fafc;
			font: inherit;
		}

		.toggle {
			display: flex;
			align-items: center;
			gap: 0.7rem;
			margin-top: 0.65rem;
			padding: 0.75rem;
			border: 1px solid #334155;
			background: #0f141b;
			cursor: pointer;
		}

		.toggle input {
			margin: 0;
		}

		.option-list {
			display: grid;
			gap: 0.55rem;
			margin-top: 0.65rem;
		}

		.option {
			display: flex;
			align-items: flex-start;
			gap: 0.65rem;
			padding: 0.7rem;
			border: 1px solid #334155;
			background: #0f141b;
			cursor: pointer;
		}

		.option input {
			margin: 0.1rem 0 0;
		}

		.option-copy {
			display: grid;
			gap: 0.2rem;
		}

		.validation,
		.error-box {
			border-color: #ef4444;
			background: rgba(127, 29, 29, 0.18);
			color: #fecaca;
		}

		.actions {
			padding: 1rem 1.1rem;
			border-top: 1px solid #2a3340;
			display: flex;
			justify-content: flex-end;
			gap: 0.75rem;
			flex-wrap: wrap;
		}

		.btn {
			padding: 0.68rem 1.15rem;
			border: 1px solid #334155;
			background: #0f141b;
			color: #f8fafc;
			font: inherit;
			cursor: pointer;
		}

		.btn-primary {
			border-color: #f59e0b;
			background: #f59e0b;
			color: #111827;
			font-weight: 700;
		}

		.btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
		}
	`;

	@property({ attribute: false })
	request: ComposerPendingClientToolRequest | null = null;

	@property({ type: Number })
	queueLength = 0;

	@property({ type: Boolean })
	submitting = false;

	@state()
	private formValues: Record<string, PrimitiveValue | undefined> = {};

	@state()
	private validationMessage: string | null = null;

	protected override willUpdate(changed: PropertyValues<this>): void {
		if (!changed.has("request")) {
			return;
		}
		const parsed = parseMcpElicitationRequest(this.request?.args);
		this.validationMessage = null;
		this.formValues =
			parsed.kind === "form" ? buildInitialValues(parsed.fields) : {};
	}

	private setValue(key: string, value: PrimitiveValue | undefined) {
		this.formValues = {
			...this.formValues,
			[key]: value,
		};
		if (this.validationMessage) {
			this.validationMessage = null;
		}
	}

	private collectFormContent(
		request: ParsedFormRequest,
	): Record<string, PrimitiveValue> | null {
		const content: Record<string, PrimitiveValue> = {};

		for (const field of request.fields) {
			const required = request.requiredKeys.has(field.key);
			const value = this.formValues[field.key];

			if (field.kind === "boolean") {
				if (typeof value !== "boolean") {
					if (required) {
						this.validationMessage = `Select a value for ${field.label}.`;
						return null;
					}
					continue;
				}
				content[field.key] = value;
				continue;
			}

			if (field.kind === "number") {
				if (typeof value !== "number" || Number.isNaN(value)) {
					if (required) {
						this.validationMessage = `Enter a value for ${field.label}.`;
						return null;
					}
					continue;
				}
				if (field.integer && !Number.isInteger(value)) {
					this.validationMessage = `${field.label} must be an integer.`;
					return null;
				}
				if (field.minimum !== undefined && value < field.minimum) {
					this.validationMessage = `${field.label} must be at least ${field.minimum}.`;
					return null;
				}
				if (field.maximum !== undefined && value > field.maximum) {
					this.validationMessage = `${field.label} must be at most ${field.maximum}.`;
					return null;
				}
				content[field.key] = value;
				continue;
			}

			if (field.kind === "multi-select") {
				const items = Array.isArray(value)
					? value.filter((entry): entry is string => typeof entry === "string")
					: [];
				if (required && items.length === 0) {
					this.validationMessage = `Select at least one option for ${field.label}.`;
					return null;
				}
				if (field.minItems !== undefined && items.length < field.minItems) {
					this.validationMessage = `${field.label} needs at least ${field.minItems} selections.`;
					return null;
				}
				if (field.maxItems !== undefined && items.length > field.maxItems) {
					this.validationMessage = `${field.label} allows at most ${field.maxItems} selections.`;
					return null;
				}
				if (items.length > 0) {
					content[field.key] = items;
				}
				continue;
			}

			const text = typeof value === "string" ? value.trim() : "";
			if (!text) {
				if (required) {
					this.validationMessage = `Enter a value for ${field.label}.`;
					return null;
				}
				continue;
			}
			if (field.kind === "string") {
				if (field.minLength !== undefined && text.length < field.minLength) {
					this.validationMessage = `${field.label} must be at least ${field.minLength} characters.`;
					return null;
				}
				if (field.maxLength !== undefined && text.length > field.maxLength) {
					this.validationMessage = `${field.label} must be at most ${field.maxLength} characters.`;
					return null;
				}
			}
			content[field.key] = text;
		}

		return content;
	}

	private submitAccept(request: ParsedRequest) {
		if (!this.request?.toolCallId) {
			return;
		}
		if (request.kind === "url") {
			if (typeof window !== "undefined" && typeof window.open === "function") {
				window.open(request.url, "_blank", "noopener,noreferrer");
			}
			this.dispatchEvent(
				new CustomEvent("submit-response", {
					detail: {
						toolCallId: this.request.toolCallId,
						action: "accept",
					},
					bubbles: true,
					composed: true,
				}),
			);
			return;
		}
		if (request.kind !== "form") {
			return;
		}

		const content = this.collectFormContent(request);
		if (!content) {
			return;
		}

		this.dispatchEvent(
			new CustomEvent("submit-response", {
				detail: {
					toolCallId: this.request.toolCallId,
					action: "accept",
					...(Object.keys(content).length > 0 ? { content } : {}),
				},
				bubbles: true,
				composed: true,
			}),
		);
	}

	private submitDecline() {
		if (!this.request?.toolCallId) {
			return;
		}
		this.dispatchEvent(
			new CustomEvent("submit-response", {
				detail: {
					toolCallId: this.request.toolCallId,
					action: "decline",
				},
				bubbles: true,
				composed: true,
			}),
		);
	}

	private cancelRequest() {
		if (!this.request?.toolCallId) {
			return;
		}
		this.dispatchEvent(
			new CustomEvent("cancel", {
				detail: { toolCallId: this.request.toolCallId },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private renderField(field: FieldDefinition, required: boolean) {
		if (field.kind === "boolean") {
			return html`
				<div class="field">
					<div class="field-title">
						${field.label}${required ? html` <span class="required">*</span>` : nothing}
					</div>
					${
						field.description
							? html`<div class="description">${field.description}</div>`
							: nothing
					}
					<label class="toggle">
						<input
							data-field-key=${field.key}
							type="checkbox"
							.checked=${this.formValues[field.key] === true}
							@change=${(event: Event) =>
								this.setValue(
									field.key,
									(event.currentTarget as HTMLInputElement).checked,
								)}
						/>
						<span>Enabled</span>
					</label>
				</div>
			`;
		}

		if (field.kind === "number") {
			return html`
				<div class="field">
					<div class="field-title">
						${field.label}${required ? html` <span class="required">*</span>` : nothing}
					</div>
					${
						field.description
							? html`<div class="description">${field.description}</div>`
							: nothing
					}
					<input
						class="control"
						data-field-key=${field.key}
						type="number"
						step=${field.integer ? "1" : "any"}
						.value=${
							typeof this.formValues[field.key] === "number"
								? String(this.formValues[field.key])
								: ""
						}
						@input=${(event: Event) => {
							const raw = (
								event.currentTarget as HTMLInputElement
							).value.trim();
							this.setValue(field.key, raw === "" ? undefined : Number(raw));
						}}
					/>
				</div>
			`;
		}

		if (field.kind === "select") {
			return html`
				<div class="field">
					<div class="field-title">
						${field.label}${required ? html` <span class="required">*</span>` : nothing}
					</div>
					${
						field.description
							? html`<div class="description">${field.description}</div>`
							: nothing
					}
					<select
						class="select"
						data-field-key=${field.key}
						.value=${
							typeof this.formValues[field.key] === "string"
								? (this.formValues[field.key] as string)
								: ""
						}
						@change=${(event: Event) =>
							this.setValue(
								field.key,
								(event.currentTarget as HTMLSelectElement).value || undefined,
							)}
					>
						<option value="">Select an option</option>
						${field.options.map(
							(option) => html`
								<option value=${option.value}>${option.label}</option>
							`,
						)}
					</select>
				</div>
			`;
		}

		if (field.kind === "multi-select") {
			const selected = Array.isArray(this.formValues[field.key])
				? (this.formValues[field.key] as string[])
				: [];
			return html`
				<div class="field">
					<div class="field-title">
						${field.label}${required ? html` <span class="required">*</span>` : nothing}
					</div>
					${
						field.description
							? html`<div class="description">${field.description}</div>`
							: nothing
					}
					<div class="option-list">
						${field.options.map(
							(option) => html`
								<label class="option">
									<input
										data-field-key=${field.key}
										data-option-value=${option.value}
										type="checkbox"
										.checked=${selected.includes(option.value)}
										@change=${(event: Event) => {
											const checked = (event.currentTarget as HTMLInputElement)
												.checked;
											const next = new Set(selected);
											if (checked) {
												next.add(option.value);
											} else {
												next.delete(option.value);
											}
											this.setValue(field.key, Array.from(next));
										}}
									/>
									<div class="option-copy">
										<div class="field-title">${option.label}</div>
									</div>
								</label>
							`,
						)}
					</div>
				</div>
			`;
		}

		return html`
			<div class="field">
				<div class="field-title">
					${field.label}${required ? html` <span class="required">*</span>` : nothing}
				</div>
				${
					field.description
						? html`<div class="description">${field.description}</div>`
						: nothing
				}
				<input
					class="control"
					data-field-key=${field.key}
					type=${
						field.format === "email"
							? "email"
							: field.format === "date"
								? "date"
								: field.format === "uri"
									? "url"
									: "text"
					}
					.value=${
						typeof this.formValues[field.key] === "string"
							? (this.formValues[field.key] as string)
							: ""
					}
					@input=${(event: Event) =>
						this.setValue(
							field.key,
							(event.currentTarget as HTMLInputElement).value,
						)}
				/>
			</div>
		`;
	}

	override render() {
		if (!this.request) {
			return nothing;
		}

		const parsed = parseMcpElicitationRequest(this.request.args);
		const waitingCount = Math.max(0, this.queueLength - 1);

		return html`
			<div class="overlay">
				<div class="panel">
					<div class="header">
						<div class="eyebrow">
							<span class="badge">MCP Elicitation</span>
							${
								parsed.serverName
									? html`<span>${parsed.serverName}</span>`
									: nothing
							}
							${
								parsed.requestId
									? html`<span>request ${parsed.requestId}</span>`
									: nothing
							}
						</div>
						<div class="title">${parsed.message}</div>
					</div>
					<div class="body">
						<div class="info-box">
							<div class="label">Queue</div>
							<div class="queue">
								Request 1 of ${Math.max(1, this.queueLength)}
								${
									waitingCount > 0
										? html`<br />${waitingCount} more MCP request${waitingCount === 1 ? "" : "s"} waiting.`
										: nothing
								}
							</div>
						</div>

						${
							parsed.kind === "malformed"
								? html`
									<div class="error-box">
										<div class="label">Unsupported Request</div>
										<div>${parsed.error}</div>
									</div>
								`
								: parsed.kind === "url"
									? html`
										<div class="url-box">
											<div class="label">External Step</div>
											<div class="help">
												Open the secure flow in a new tab, complete it, then continue here.
											</div>
											<div class="description url-link">${parsed.url}</div>
											${
												parsed.elicitationId
													? html`<div class="description">
														elicitation ${parsed.elicitationId}
													</div>`
													: nothing
											}
										</div>
									`
									: html`${parsed.fields.map((field) =>
											this.renderField(
												field,
												parsed.requiredKeys.has(field.key),
											),
										)}`
						}

						${
							this.validationMessage
								? html`<div class="validation">${this.validationMessage}</div>`
								: nothing
						}
					</div>
					<div class="actions">
						<button
							class="btn btn-cancel"
							@click=${this.cancelRequest}
							?disabled=${this.submitting}
						>
							Cancel
						</button>
						<button
							class="btn btn-decline"
							@click=${this.submitDecline}
							?disabled=${this.submitting || parsed.kind === "malformed"}
						>
							Decline
						</button>
						<button
							class="btn btn-primary btn-accept"
							@click=${() => this.submitAccept(parsed)}
							?disabled=${this.submitting || parsed.kind === "malformed"}
						>
							${parsed.kind === "url" ? "Open and continue" : "Submit"}
						</button>
					</div>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"composer-mcp-elicitation": ComposerMcpElicitation;
	}
}
