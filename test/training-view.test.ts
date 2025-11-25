import { Text } from "@evalops/tui";
import { Container, type TUI } from "@evalops/tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrainingView } from "../src/tui/status/training-view.js";

type TrainingCommandContext = Parameters<
	TrainingView["handleTrainingCommand"]
>[0];

vi.mock("../src/training.js", () => ({
	getTrainingStatus: vi.fn(),
	setTrainingRuntimeOverride: vi.fn(),
}));

import {
	getTrainingStatus,
	setTrainingRuntimeOverride,
} from "../src/training.js";

const mockGetStatus = vi.mocked(getTrainingStatus);
const mockSetOverride = vi.mocked(setTrainingRuntimeOverride);

const createStatus = (
	preference: "opted-in" | "opted-out" | "provider-default",
) => ({
	preference,
	optOut: preference === "provider-default" ? null : preference === "opted-out",
	reason: preference === "opted-out" ? "env" : "provider default",
	flagValue: undefined,
	runtimeOverride: undefined,
	overrideReason: undefined,
});

const createContext = (
	argumentText = "",
	parsedArgs?: TrainingCommandContext["parsedArgs"],
): TrainingCommandContext => ({
	command: { name: "training" },
	rawInput: `/training${argumentText ? ` ${argumentText}` : ""}`,
	argumentText,
	parsedArgs,
	showInfo: vi.fn(),
	showError: vi.fn(),
	renderHelp: vi.fn(),
});

describe("TrainingView", () => {
	let container: Container;
	let requestRender: ReturnType<typeof vi.fn>;
	let onStatusChanged: ReturnType<typeof vi.fn>;
	let view: TrainingView;

	beforeEach(() => {
		vi.clearAllMocks();
		container = new Container();
		requestRender = vi.fn();
		onStatusChanged = vi.fn();
		mockGetStatus.mockReturnValue(createStatus("provider-default"));
		view = new TrainingView({
			chatContainer: container,
			ui: { requestRender } as unknown as TUI,
			showInfo: vi.fn(),
			showError: vi.fn(),
			onStatusChanged,
		});
	});

	it("renders training status when no args provided", () => {
		view.handleTrainingCommand(createContext("", {}));

		expect(requestRender).toHaveBeenCalled();
		const textComponent = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		expect(textComponent).toBeDefined();
		const rendered = textComponent?.render(80).join("\n") ?? "";
		expect(rendered).toContain("Training data");
		expect(mockGetStatus).toHaveBeenCalled();
	});

	it("opts into training when /training on is used", () => {
		const status = createStatus("opted-in");
		mockGetStatus.mockReturnValue(status);
		const showInfo = vi.fn();
		view = new TrainingView({
			chatContainer: container,
			ui: { requestRender } as unknown as TUI,
			showInfo,
			showError: vi.fn(),
			onStatusChanged,
		});

		view.handleTrainingCommand(createContext("on", { action: "on" }));

		expect(mockSetOverride).toHaveBeenCalledWith(false, expect.any(String));
		expect(onStatusChanged).toHaveBeenCalledWith(status);
		expect(showInfo).toHaveBeenCalled();
	});

	it("resets training preference when /training reset is used", () => {
		view.handleTrainingCommand(createContext("reset", { action: "reset" }));
		expect(mockSetOverride).toHaveBeenCalledWith(null, undefined);
	});
});
