import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QuickSettingsController } from "../../../src/cli-tui/tui-renderer/quick-settings-controller.js";
import type { RegisteredModel } from "../../../src/models/registry.js";
import {
	createEvalResult,
	type EvalSuiteResult,
	type EvalSuiteSummary,
	summarizeEvalResults,
} from "../shared";

export type QuickSettingsEvalAction =
	| "toggleThinkingBlocks"
	| "toggleToolOutputs"
	| "cycleThinkingLevel"
	| "cycleModel";

export interface QuickSettingsEvalCase {
	name: string;
	action: QuickSettingsEvalAction;
	initialState: {
		toolOutputCompact?: boolean;
		hideThinkingBlocks?: boolean;
		thinkingLevel?: string;
		currentModel?: Partial<RegisteredModel> | null;
		modelScope?: Array<Partial<RegisteredModel>>;
		setModelError?: string;
	};
	expected: unknown;
}

export type QuickSettingsEvalResult = EvalSuiteResult<QuickSettingsEvalCase>;

const DEFAULT_CASES_PATH = "evals/tui/quick-settings-cases.json";

export function getQuickSettingsEvalCasesPath(): string {
	return process.env.QUICK_SETTINGS_EVAL_CASES?.trim() || DEFAULT_CASES_PATH;
}

export function loadQuickSettingsEvalCases(
	casesPath = getQuickSettingsEvalCasesPath(),
): QuickSettingsEvalCase[] {
	const fixturePath = resolve(process.cwd(), casesPath);
	const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as QuickSettingsEvalCase[];
	return Array.isArray(parsed) ? parsed : [];
}

export function runQuickSettingsEvalCase(
	testCase: QuickSettingsEvalCase,
): QuickSettingsEvalResult {
	const actual = evaluateQuickSettingsCase(testCase);
	return createEvalResult(testCase, actual, testCase.expected);
}

export function runQuickSettingsEvalSuite(
	cases: QuickSettingsEvalCase[],
): QuickSettingsEvalResult[] {
	return cases.map((testCase) => runQuickSettingsEvalCase(testCase));
}

export function summarizeQuickSettingsEvalResults(
	results: QuickSettingsEvalResult[],
): EvalSuiteSummary {
	return summarizeEvalResults(results);
}

function evaluateQuickSettingsCase(testCase: QuickSettingsEvalCase): unknown {
	const state = {
		toolOutputCompact: Boolean(testCase.initialState.toolOutputCompact),
		hideThinkingBlocks: Boolean(testCase.initialState.hideThinkingBlocks),
		notifications: [] as Array<{
			method: "showToast" | "showInfo" | "showError";
			message: string;
			kind?: string;
		}>,
		savedThinkingLevels: [] as string[],
		savedModelKeys: [] as string[],
		refreshFooterHintCalls: 0,
		persistUiStateCalls: 0,
		renderConversationViewCalls: 0,
		requestRenderCalls: 0,
	};

	const currentModel = testCase.initialState.currentModel
		? createRegisteredModel(testCase.initialState.currentModel)
		: undefined;
	const modelScope = (testCase.initialState.modelScope ?? []).map((model) =>
		createRegisteredModel(model),
	);

	const agent = {
		state: {
			model: currentModel,
			thinkingLevel: testCase.initialState.thinkingLevel ?? "off",
		},
		setThinkingLevel(level: string) {
			this.state.thinkingLevel = level;
		},
		setModel(model: RegisteredModel) {
			if (testCase.initialState.setModelError) {
				throw new Error(testCase.initialState.setModelError);
			}
			this.state.model = model;
		},
	};

	const sessionManager = {
		saveThinkingLevelChange(level: string) {
			state.savedThinkingLevels.push(level);
		},
		saveModelChange(modelKey: string) {
			state.savedModelKeys.push(modelKey);
		},
	};

	const notificationView = {
		showToast(message: string, kind?: string) {
			state.notifications.push({ method: "showToast", message, kind });
		},
		showInfo(message: string) {
			state.notifications.push({ method: "showInfo", message });
		},
		showError(message: string) {
			state.notifications.push({ method: "showError", message });
		},
	};

	const callbacks = {
		refreshFooterHint() {
			state.refreshFooterHintCalls += 1;
		},
		persistUiState() {
			state.persistUiStateCalls += 1;
		},
		renderConversationView() {
			state.renderConversationViewCalls += 1;
		},
		requestRender() {
			state.requestRenderCalls += 1;
		},
		getToolOutputCompact() {
			return state.toolOutputCompact;
		},
		toggleToolOutputCompact() {
			state.toolOutputCompact = !state.toolOutputCompact;
			return state.toolOutputCompact;
		},
		getHideThinkingBlocks() {
			return state.hideThinkingBlocks;
		},
		setHideThinkingBlocks(hidden: boolean) {
			state.hideThinkingBlocks = hidden;
		},
	};

	const controller = new QuickSettingsController({
		agent: agent as never,
		sessionManager: sessionManager as never,
		notificationView: notificationView as never,
		modelScope,
		callbacks,
	});

	switch (testCase.action) {
		case "toggleThinkingBlocks":
			controller.toggleThinkingBlocks();
			break;

		case "toggleToolOutputs":
			controller.toggleToolOutputs();
			break;

		case "cycleThinkingLevel":
			controller.cycleThinkingLevel();
			break;

		case "cycleModel":
			void controller.cycleModel();
			break;

		default: {
			const neverAction: never = testCase.action;
			throw new Error(`Unsupported quick settings eval action: ${neverAction}`);
		}
	}

	return buildQuickSettingsOutcome(state, agent);
}

function buildQuickSettingsOutcome(
	state: {
		toolOutputCompact: boolean;
		hideThinkingBlocks: boolean;
		notifications: Array<{
			method: "showToast" | "showInfo" | "showError";
			message: string;
			kind?: string;
		}>;
		savedThinkingLevels: string[];
		savedModelKeys: string[];
		refreshFooterHintCalls: number;
		persistUiStateCalls: number;
		renderConversationViewCalls: number;
		requestRenderCalls: number;
	},
	agent: {
		state: {
			model?: RegisteredModel;
			thinkingLevel?: string;
		};
	},
) {
	const notification = state.notifications[0] ?? null;

	return {
		toolOutputCompact: state.toolOutputCompact,
		hideThinkingBlocks: state.hideThinkingBlocks,
		thinkingLevel: agent.state.thinkingLevel ?? null,
		selectedModelId: agent.state.model?.id ?? null,
		selectedModelProvider: agent.state.model?.provider ?? null,
		notificationMethod: notification?.method ?? null,
		notificationMessage: notification?.message ?? null,
		notificationKind: notification?.kind ?? null,
		savedThinkingLevels: state.savedThinkingLevels,
		savedModelKeys: state.savedModelKeys,
		refreshFooterHintCalls: state.refreshFooterHintCalls,
		persistUiStateCalls: state.persistUiStateCalls,
		renderConversationViewCalls: state.renderConversationViewCalls,
		requestRenderCalls: state.requestRenderCalls,
	};
}

function createRegisteredModel(
	model: Partial<RegisteredModel>,
): RegisteredModel {
	const id = model.id ?? "model";
	const provider = model.provider ?? "openrouter";

	return {
		id,
		name: model.name ?? id,
		api: model.api ?? "openai-responses",
		provider,
		baseUrl: model.baseUrl ?? "https://openrouter.ai/api/v1/responses",
		reasoning: model.reasoning ?? false,
		input: model.input ?? ["text"],
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow ?? 200000,
		maxTokens: model.maxTokens ?? 8192,
		providerName: model.providerName ?? provider,
		source: model.source ?? "builtin",
		isLocal: model.isLocal ?? false,
	};
}
