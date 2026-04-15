import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAppearanceViewModel } from "../../../packages/desktop/src/renderer/components/Settings/AppearanceSection";
import { buildBackgroundTasksViewModel } from "../../../packages/desktop/src/renderer/components/Settings/BackgroundTasksSection";
import { buildFrameworkViewModel } from "../../../packages/desktop/src/renderer/components/Settings/FrameworkSection";
import {
	buildModelReasoningViewModel,
	normalizeModeOptions,
} from "../../../packages/desktop/src/renderer/components/Settings/ModelReasoningSection";
import { buildPlanningViewModel } from "../../../packages/desktop/src/renderer/components/Settings/PlanningSection";
import { buildSafetyApprovalsViewModel } from "../../../packages/desktop/src/renderer/components/Settings/SafetyApprovalsSection";
import { buildSessionBehaviorViewModel } from "../../../packages/desktop/src/renderer/components/Settings/SessionBehaviorSection";
import { buildTelemetryViewModel, buildTrainingViewModel } from "../../../packages/desktop/src/renderer/components/Settings/TelemetryTrainingSection";
import { buildTerminalUiViewModel } from "../../../packages/desktop/src/renderer/components/Settings/TerminalUiSection";
import {
	buildComposerProfilesViewModel,
	buildLspViewModel,
	buildMcpServerViewModel,
	resolveComposerSelection,
} from "../../../packages/desktop/src/renderer/components/Settings/ToolsRuntimeSection";
import {
	createEvalResult,
	type EvalSuiteResult,
	type EvalSuiteSummary,
	summarizeEvalResults,
} from "../shared";

export type SettingsViewModelEvalKind =
	| "appearance"
	| "backgroundTasks"
	| "framework"
	| "modelReasoning"
	| "modeOptions"
	| "planning"
	| "safetyApprovals"
	| "sessionBehavior"
	| "telemetry"
	| "terminalUi"
	| "toolsRuntimeComposerProfiles"
	| "toolsRuntimeComposerSelection"
	| "toolsRuntimeLsp"
	| "toolsRuntimeMcpServer"
	| "training";

export interface SettingsViewModelEvalCase {
	name: string;
	kind: SettingsViewModelEvalKind;
	input: Record<string, unknown>;
	expected: unknown;
}

export type SettingsViewModelEvalResult = EvalSuiteResult<
	SettingsViewModelEvalCase,
	unknown
>;

const DEFAULT_CASES_PATH = "evals/settings/view-model-cases.json";

export function getSettingsViewModelEvalCasesPath(): string {
	return process.env.SETTINGS_VIEW_MODEL_EVAL_CASES?.trim() || DEFAULT_CASES_PATH;
}

export function loadSettingsViewModelEvalCases(
	casesPath = getSettingsViewModelEvalCasesPath(),
): SettingsViewModelEvalCase[] {
	const fixturePath = resolve(process.cwd(), casesPath);
	const parsed = JSON.parse(
		readFileSync(fixturePath, "utf8"),
	) as SettingsViewModelEvalCase[];
	return Array.isArray(parsed) ? parsed : [];
}

export function runSettingsViewModelEvalCase(
	testCase: SettingsViewModelEvalCase,
): SettingsViewModelEvalResult {
	const actual = evaluateSettingsViewModelCase(testCase);
	return createEvalResult(testCase, actual, testCase.expected);
}

export function runSettingsViewModelEvalSuite(
	cases: SettingsViewModelEvalCase[],
): SettingsViewModelEvalResult[] {
	return cases.map((testCase) => runSettingsViewModelEvalCase(testCase));
}

export function summarizeSettingsViewModelEvalResults(
	results: SettingsViewModelEvalResult[],
): EvalSuiteSummary {
	return summarizeEvalResults(results);
}

function evaluateSettingsViewModelCase(testCase: SettingsViewModelEvalCase): unknown {
	const input = testCase.input;

	switch (testCase.kind) {
		case "appearance":
			return buildAppearanceViewModel(
				input.themeMode as "system" | "dark" | "light",
				Boolean(input.showTimestamps),
				input.density as "comfortable" | "compact",
			);

		case "backgroundTasks":
			return buildBackgroundTasksViewModel(
				(input.status as Parameters<typeof buildBackgroundTasksViewModel>[0]) ?? null,
			);

		case "framework":
			return buildFrameworkViewModel(
				(input.frameworks as Parameters<typeof buildFrameworkViewModel>[0]) ?? [],
				(input.frameworkId as string) ?? "none",
				(input.frameworkScope as "user" | "workspace") ?? "user",
				Boolean(input.frameworkLocked),
			);

		case "modelReasoning":
			return buildModelReasoningViewModel(
				(input.availableModels as Parameters<typeof buildModelReasoningViewModel>[0]) ??
					[],
				(input.fallbackModels as Parameters<typeof buildModelReasoningViewModel>[1]) ??
					[],
				(input.selectedModelId as string) ?? "",
				(input.modeStatus as Parameters<typeof buildModelReasoningViewModel>[3]) ?? null,
				(input.modeOptions as string[]) ?? [],
				(input.thinkingLevel as Parameters<typeof buildModelReasoningViewModel>[5]) ??
					"off",
			);

		case "modeOptions":
			return normalizeModeOptions(
				(input.modes as Parameters<typeof normalizeModeOptions>[0]) ?? [],
			);

		case "planning":
			return buildPlanningViewModel(
				(input.status as Parameters<typeof buildPlanningViewModel>[0]) ?? null,
				Boolean(input.planDirty),
			);

		case "safetyApprovals":
			return buildSafetyApprovalsViewModel(
				(input.approvalMode as Parameters<typeof buildSafetyApprovalsViewModel>[0]) ??
					"prompt",
				(input.guardianStatus as Parameters<typeof buildSafetyApprovalsViewModel>[1]) ??
					null,
				Boolean(input.guardianRunning),
			);

		case "sessionBehavior":
			return buildSessionBehaviorViewModel(
				Boolean(input.hasSession),
				(input.queueMode as "one" | "all") ?? "all",
			);

		case "telemetry":
			return buildTelemetryViewModel(
				(input.status as Parameters<typeof buildTelemetryViewModel>[0]) ?? null,
			);

		case "terminalUi":
			return buildTerminalUiViewModel(
				input.uiStatus as Parameters<typeof buildTerminalUiViewModel>[0],
				Boolean(input.hasSession),
			);

		case "toolsRuntimeComposerProfiles":
			return buildComposerProfilesViewModel(
				(input.status as Parameters<typeof buildComposerProfilesViewModel>[0]) ?? null,
				(input.selectedComposer as string) ?? "",
			);

		case "toolsRuntimeComposerSelection":
			return resolveComposerSelection(
				(input.status as Parameters<typeof resolveComposerSelection>[0]) ?? null,
				(input.currentSelection as string) ?? "",
			);

		case "toolsRuntimeLsp":
			return buildLspViewModel(
				(input.status as Parameters<typeof buildLspViewModel>[0]) ?? null,
				(input.detections as Parameters<typeof buildLspViewModel>[1]) ?? [],
			);

		case "toolsRuntimeMcpServer":
			return buildMcpServerViewModel(
				input.server as Parameters<typeof buildMcpServerViewModel>[0],
				(input.expandedServer as string | null) ?? null,
			);

		case "training":
			return buildTrainingViewModel(
				(input.status as Parameters<typeof buildTrainingViewModel>[0]) ?? null,
			);

		default: {
			const neverKind: never = testCase.kind;
			throw new Error(`Unsupported settings eval kind: ${neverKind}`);
		}
	}
}
