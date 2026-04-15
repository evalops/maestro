import type { CleanMode } from "../../conversation/render-model.js";
import type { FooterMode } from "../utils/footer-utils.js";
import {
	type UiStateCallbacks,
	UiStateController,
} from "./ui-state-controller.js";

export type { UiStateController };

export interface UiStateSetupParams {
	initialCleanMode: CleanMode;
	initialFooterMode: FooterMode;
	initialZenMode: boolean;
	initialHideThinkingBlocks: boolean;
	callbacks: UiStateCallbacks;
}

export function createUiStateController(
	params: UiStateSetupParams,
): UiStateController {
	return new UiStateController({
		initialCleanMode: params.initialCleanMode,
		initialFooterMode: params.initialFooterMode,
		initialZenMode: params.initialZenMode,
		initialHideThinkingBlocks: params.initialHideThinkingBlocks,
		callbacks: params.callbacks,
	});
}
