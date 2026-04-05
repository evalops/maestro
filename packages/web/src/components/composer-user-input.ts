/**
 * User input component - request structured input for ask_user tool calls.
 */

import type { ComposerPendingClientToolRequest } from "@evalops/contracts";
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface AskUserOption {
	label: string;
	description: string;
}

interface AskUserQuestion {
	header: string;
	question: string;
	options: AskUserOption[];
	multiSelect?: boolean;
}

interface QuestionSelectionState {
	selectedOptionIndexes: number[];
	otherSelected: boolean;
	otherText: string;
}

function parseAskUserQuestions(args: unknown): AskUserQuestion[] {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return [];
	}
	const questions = (args as { questions?: unknown }).questions;
	if (!Array.isArray(questions)) {
		return [];
	}
	return questions.flatMap((question) => {
		if (!question || typeof question !== "object" || Array.isArray(question)) {
			return [];
		}
		const {
			header,
			question: prompt,
			options,
			multiSelect,
		} = question as {
			header?: unknown;
			question?: unknown;
			options?: unknown;
			multiSelect?: unknown;
		};
		if (
			typeof header !== "string" ||
			typeof prompt !== "string" ||
			!Array.isArray(options)
		) {
			return [];
		}
		const parsedOptions = options.flatMap((option) => {
			if (!option || typeof option !== "object" || Array.isArray(option)) {
				return [];
			}
			const { label, description } = option as {
				label?: unknown;
				description?: unknown;
			};
			if (typeof label !== "string" || typeof description !== "string") {
				return [];
			}
			return [{ label, description }];
		});
		if (parsedOptions.length === 0) {
			return [];
		}
		return [
			{
				header,
				question: prompt,
				options: parsedOptions,
				multiSelect: multiSelect === true,
			},
		];
	});
}

@customElement("composer-user-input")
export class ComposerUserInput extends LitElement {
	static override styles = css`
		:host {
			display: block;
			font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
		}

		.user-input-overlay {
			position: fixed;
			inset: 0;
			background: rgba(10, 14, 20, 0.95);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 1000;
			animation: fadeIn 0.2s ease-out;
		}

		@keyframes fadeIn {
			from { opacity: 0; }
			to { opacity: 1; }
		}

		.user-input-modal {
			background: #0d1117;
			border: 2px solid #3fb950;
			border-radius: 4px;
			max-width: 760px;
			width: 92%;
			max-height: 84vh;
			overflow-y: auto;
			animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
		}

		@keyframes slideUp {
			from {
				opacity: 0;
				transform: translateY(20px);
			}
			to {
				opacity: 1;
				transform: translateY(0);
			}
		}

		.user-input-header {
			padding: 1rem;
			background: rgba(63, 185, 80, 0.12);
			border-bottom: 1px solid #3fb950;
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.user-input-icon {
			width: 1.9rem;
			height: 1.9rem;
			display: flex;
			align-items: center;
			justify-content: center;
			border: 1px solid #3fb950;
			border-radius: 999px;
			font-size: 0.85rem;
			font-weight: 700;
			color: #3fb950;
		}

		.header-text {
			flex: 1;
		}

		.header-title {
			font-size: 0.85rem;
			font-weight: 700;
			color: #3fb950;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-bottom: 0.25rem;
		}

		.header-subtitle {
			font-size: 0.75rem;
			color: #8b949e;
		}

		.user-input-body {
			padding: 1rem;
		}

		.section {
			margin-bottom: 1rem;
		}

		.section:last-child {
			margin-bottom: 0;
		}

		.section-label {
			font-size: 0.7rem;
			font-weight: 700;
			color: #6e7681;
			text-transform: uppercase;
			letter-spacing: 0.1em;
			margin-bottom: 0.5rem;
		}

		.queue-box,
		.question-box,
		.validation-box,
		.malformed-box {
			border-radius: 3px;
			padding: 0.75rem;
		}

		.queue-box,
		.question-box,
		.malformed-box {
			background: #161b22;
			border: 1px solid #30363d;
		}

		.queue-box {
			border-left: 3px solid #3fb950;
		}

		.queue-title,
		.question-title {
			font-size: 0.78rem;
			font-weight: 700;
			color: #e6edf3;
		}

		.queue-subtitle,
		.question-prompt,
		.option-description,
		.malformed-box {
			font-size: 0.72rem;
			line-height: 1.6;
			color: #8b949e;
		}

		.queue-subtitle,
		.question-prompt {
			margin-top: 0.35rem;
		}

		.question-header {
			display: inline-flex;
			align-items: center;
			padding: 0.18rem 0.5rem;
			border: 1px solid #30363d;
			border-radius: 999px;
			background: #0d1117;
			font-size: 0.66rem;
			font-weight: 700;
			color: #e6edf3;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			margin-bottom: 0.65rem;
		}

		.options {
			display: grid;
			gap: 0.5rem;
			margin-top: 0.85rem;
		}

		.option {
			display: block;
			cursor: pointer;
		}

		.option-input {
			position: absolute;
			opacity: 0;
			pointer-events: none;
		}

		.option-card {
			border: 1px solid #30363d;
			border-radius: 3px;
			padding: 0.75rem;
			background: #0d1117;
			transition: border-color 0.15s ease, background 0.15s ease;
		}

		.option input:checked + .option-card,
		.option-card.selected {
			border-color: #3fb950;
			background: rgba(63, 185, 80, 0.08);
		}

		.option-label {
			font-size: 0.75rem;
			font-weight: 700;
			color: #e6edf3;
		}

		.option-description {
			margin-top: 0.3rem;
		}

		.other-input {
			width: 100%;
			margin-top: 0.5rem;
			padding: 0.55rem 0.65rem;
			border-radius: 3px;
			border: 1px solid #30363d;
			background: #0b1016;
			color: #e6edf3;
			font: inherit;
			box-sizing: border-box;
		}

		.validation-box {
			background: rgba(248, 81, 73, 0.12);
			border: 1px solid #f85149;
			color: #f85149;
			font-size: 0.72rem;
			line-height: 1.5;
		}

		.user-input-actions {
			padding: 1rem;
			border-top: 1px solid #30363d;
			display: flex;
			gap: 0.75rem;
			justify-content: flex-end;
			flex-wrap: wrap;
		}

		.btn {
			padding: 0.625rem 1.25rem;
			border: 1px solid #30363d;
			border-radius: 2px;
			font-family: inherit;
			font-size: 0.75rem;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			cursor: pointer;
			transition: all 0.15s;
		}

		.btn-cancel {
			background: transparent;
			color: #8b949e;
		}

		.btn-cancel:hover {
			background: #21262d;
			border-color: #6e7681;
			color: #c9d1d9;
		}

		.btn-submit {
			background: #3fb950;
			color: #0d1117;
			border-color: #3fb950;
		}

		.btn-submit:hover {
			background: #56d364;
			border-color: #56d364;
		}

		.btn:disabled {
			cursor: not-allowed;
			opacity: 0.6;
		}
	`;

	@property({ attribute: false })
	request: ComposerPendingClientToolRequest | null = null;

	@property({ type: Boolean })
	submitting = false;

	@property({ type: Number })
	queueLength = 0;

	@state()
	private questionStates: QuestionSelectionState[] = [];

	@state()
	private validationMessage: string | null = null;

	private readonly handleKeyDownRef = (event: KeyboardEvent) =>
		this.handleKeyDown(event);

	override connectedCallback() {
		super.connectedCallback();
		window.addEventListener("keydown", this.handleKeyDownRef);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener("keydown", this.handleKeyDownRef);
	}

	override willUpdate(changed: Map<PropertyKey, unknown>) {
		if (changed.has("request")) {
			this.questionStates = this.getQuestions().map(() => ({
				selectedOptionIndexes: [],
				otherSelected: false,
				otherText: "",
			}));
			this.validationMessage = null;
		}
	}

	private getQuestions(): AskUserQuestion[] {
		return parseAskUserQuestions(this.request?.args);
	}

	private getQueueTitle(): string {
		if (this.queueLength <= 1) {
			return "Input 1 of 1";
		}
		return `Input 1 of ${this.queueLength}`;
	}

	private getQueueSubtitle(): string {
		if (this.queueLength <= 1) {
			return "This agent run is waiting for your structured response.";
		}
		return `${this.queueLength - 1} more input request${this.queueLength === 2 ? "" : "s"} waiting behind this one.`;
	}

	private toggleOption(
		questionIndex: number,
		optionIndex: number,
		checked: boolean,
	) {
		const question = this.getQuestions()[questionIndex];
		if (!question) return;
		const nextStates = [...this.questionStates];
		const current = nextStates[questionIndex] ?? {
			selectedOptionIndexes: [],
			otherSelected: false,
			otherText: "",
		};

		if (question.multiSelect) {
			const selected = new Set(current.selectedOptionIndexes);
			if (checked) {
				selected.add(optionIndex);
			} else {
				selected.delete(optionIndex);
			}
			nextStates[questionIndex] = {
				...current,
				selectedOptionIndexes: [...selected].sort((a, b) => a - b),
			};
		} else {
			nextStates[questionIndex] = {
				...current,
				selectedOptionIndexes: checked ? [optionIndex] : [],
				otherSelected: false,
				otherText: checked ? "" : current.otherText,
			};
		}

		this.questionStates = nextStates;
		this.validationMessage = null;
	}

	private toggleOther(questionIndex: number, checked: boolean) {
		const question = this.getQuestions()[questionIndex];
		if (!question) return;
		const nextStates = [...this.questionStates];
		const current = nextStates[questionIndex] ?? {
			selectedOptionIndexes: [],
			otherSelected: false,
			otherText: "",
		};
		nextStates[questionIndex] = question.multiSelect
			? { ...current, otherSelected: checked }
			: {
					...current,
					selectedOptionIndexes: [],
					otherSelected: checked,
					otherText: checked ? current.otherText : "",
				};
		this.questionStates = nextStates;
		this.validationMessage = null;
	}

	private updateOtherText(questionIndex: number, value: string) {
		const nextStates = [...this.questionStates];
		const current = nextStates[questionIndex] ?? {
			selectedOptionIndexes: [],
			otherSelected: false,
			otherText: "",
		};
		nextStates[questionIndex] = {
			...current,
			otherSelected: value.trim().length > 0 || current.otherSelected,
			otherText: value,
		};
		this.questionStates = nextStates;
		this.validationMessage = null;
	}

	private buildResponseText(): string | null {
		const questions = this.getQuestions();
		if (questions.length === 0) {
			return null;
		}

		const lines: string[] = [];
		for (const [questionIndex, question] of questions.entries()) {
			const state = this.questionStates[questionIndex];
			const selections =
				state?.selectedOptionIndexes
					.map((index) => question.options[index]?.label)
					.filter((label): label is string => Boolean(label)) ?? [];
			const otherText = state?.otherText.trim() ?? "";
			const includeOther = state?.otherSelected === true;
			if (includeOther && otherText.length > 0) {
				selections.push(otherText);
			} else if (includeOther) {
				selections.push("Other");
			}
			if (selections.length === 0) {
				return null;
			}
			const answer = question.multiSelect
				? selections.join(", ")
				: (selections[0] ?? null);
			if (!answer) {
				return null;
			}
			lines.push(
				questions.length === 1 ? answer : `${question.header}: ${answer}`,
			);
		}

		return lines.join("\n");
	}

	private handleSubmit() {
		if (this.submitting) {
			return;
		}
		const responseText = this.buildResponseText();
		if (!responseText) {
			this.validationMessage =
				"Select an option or enter a custom response for each question.";
			return;
		}
		this.dispatchEvent(
			new CustomEvent("submit-response", {
				detail: {
					toolCallId: this.request?.toolCallId,
					responseText,
				},
				bubbles: true,
				composed: true,
			}),
		);
	}

	private handleCancel() {
		if (this.submitting) {
			return;
		}
		this.dispatchEvent(
			new CustomEvent("cancel", {
				detail: { toolCallId: this.request?.toolCallId },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private handleKeyDown(event: KeyboardEvent) {
		if (!this.request) {
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			this.handleCancel();
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			this.handleSubmit();
		}
	}

	override render() {
		if (!this.request) return html``;

		const questions = this.getQuestions();

		return html`
			<div class="user-input-overlay">
				<div class="user-input-modal">
					<div class="user-input-header">
						<div class="user-input-icon">?</div>
						<div class="header-text">
							<div class="header-title">User Input Required</div>
							<div class="header-subtitle">Answer the structured questions to continue this run</div>
						</div>
					</div>

					<div class="user-input-body">
						<div class="section">
							<div class="section-label">Queue Status</div>
							<div class="queue-box">
								<div class="queue-title">${this.getQueueTitle()}</div>
								<div class="queue-subtitle">${this.getQueueSubtitle()}</div>
							</div>
						</div>

						${
							questions.length === 0
								? html`
									<div class="section">
										<div class="section-label">Input Request</div>
										<div class="malformed-box">
											This request is missing structured questions. Cancel it and retry the action if needed.
										</div>
									</div>
								`
								: questions.map((question, questionIndex) => {
										const state = this.questionStates[questionIndex] ?? {
											selectedOptionIndexes: [],
											otherSelected: false,
											otherText: "",
										};
										return html`
											<div class="section">
												<div class="question-box">
													<div class="question-header">${question.header}</div>
													<div class="question-title">Question ${questionIndex + 1}</div>
													<div class="question-prompt">${question.question}</div>
													<div class="options">
														${question.options.map((option, optionIndex) => {
															const selected =
																state.selectedOptionIndexes.includes(
																	optionIndex,
																);
															return html`
																	<label class="option">
																		<input
																			class="option-input"
																			data-question-index=${String(questionIndex)}
																			data-option-index=${String(optionIndex)}
																			type=${question.multiSelect ? "checkbox" : "radio"}
																			name="question-${questionIndex}"
																			.checked=${selected}
																			@change=${(event: Event) =>
																				this.toggleOption(
																					questionIndex,
																					optionIndex,
																					(event.target as HTMLInputElement)
																						.checked,
																				)}
																		/>
																		<div class="option-card ${selected ? "selected" : ""}">
																			<div class="option-label">${option.label}</div>
																			<div class="option-description">${option.description}</div>
																		</div>
																	</label>
																`;
														})}
														<label class="option">
															<input
																class="option-input"
																data-question-index=${String(questionIndex)}
																data-option-index="other"
																type=${question.multiSelect ? "checkbox" : "radio"}
																name="question-${questionIndex}"
																.checked=${state.otherSelected}
																@change=${(event: Event) =>
																	this.toggleOther(
																		questionIndex,
																		(event.target as HTMLInputElement).checked,
																	)}
															/>
															<div class="option-card ${state.otherSelected ? "selected" : ""}">
																<div class="option-label">Other</div>
																<div class="option-description">Provide a custom answer.</div>
																${
																	state.otherSelected
																		? html`
																			<input
																				class="other-input"
																				data-question-index=${String(questionIndex)}
																				type="text"
																				placeholder="Enter a custom response"
																				.value=${state.otherText}
																				@input=${(event: Event) =>
																					this.updateOtherText(
																						questionIndex,
																						(event.target as HTMLInputElement)
																							.value,
																					)}
																			/>
																		`
																		: ""
																}
															</div>
														</label>
													</div>
												</div>
											</div>
										`;
									})
						}

						${
							this.validationMessage
								? html`
									<div class="section">
										<div class="validation-box">${this.validationMessage}</div>
									</div>
								`
								: ""
						}
					</div>

					<div class="user-input-actions">
						<button
							class="btn btn-cancel"
							type="button"
							?disabled=${this.submitting}
							@click=${this.handleCancel}
						>
							Cancel
						</button>
						<button
							class="btn btn-submit"
							type="button"
							?disabled=${this.submitting || questions.length === 0}
							@click=${this.handleSubmit}
						>
							${this.submitting ? "Submitting..." : "Submit"}
						</button>
					</div>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"composer-user-input": ComposerUserInput;
	}
}
