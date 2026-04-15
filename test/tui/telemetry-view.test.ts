import { Text } from "@evalops/tui";
import { Container, type TUI } from "@evalops/tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryView } from "../../src/cli-tui/status/telemetry-view.js";

type TelemetryCommandContext = Parameters<
	TelemetryView["handleTelemetryCommand"]
>[0];

vi.mock("../../src/telemetry.js", () => ({
	getTelemetryStatus: vi.fn(),
	setTelemetryRuntimeOverride: vi.fn(),
}));

import {
	getTelemetryStatus,
	setTelemetryRuntimeOverride,
} from "../../src/telemetry.js";

const mockGetStatus = vi.mocked(getTelemetryStatus);
const mockSetOverride = vi.mocked(setTelemetryRuntimeOverride);

const createStatus = (enabled = true) => ({
	enabled,
	reason: enabled ? "endpoint" : "disabled",
	endpoint: enabled ? "https://example.test" : undefined,
	filePath: "/tmp/telemetry.log",
	sampleRate: 1,
	flagValue: "1",
	runtimeOverride: undefined,
	overrideReason: undefined,
});

const createContext = (
	argumentText = "",
	parsedArgs?: TelemetryCommandContext["parsedArgs"],
): TelemetryCommandContext => ({
	command: { name: "telemetry" },
	rawInput: `/telemetry${argumentText ? ` ${argumentText}` : ""}`,
	argumentText,
	parsedArgs,
	showInfo: vi.fn(),
	showError: vi.fn(),
	renderHelp: vi.fn(),
});

describe("TelemetryView", () => {
	let container: Container;
	let requestRender: ReturnType<typeof vi.fn>;
	let onStatusChanged: ReturnType<typeof vi.fn>;
	let view: TelemetryView;

	beforeEach(() => {
		vi.clearAllMocks();
		container = new Container();
		requestRender = vi.fn();
		onStatusChanged = vi.fn();
		mockGetStatus.mockReturnValue(createStatus());
		view = new TelemetryView({
			chatContainer: container,
			ui: { requestRender } as unknown as TUI,
			showInfo: vi.fn(),
			showError: vi.fn(),
			onStatusChanged,
		});
	});

	it("renders telemetry status when no args provided", () => {
		view.handleTelemetryCommand(createContext("", {}));

		expect(requestRender).toHaveBeenCalled();
		const textComponent = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		expect(textComponent).toBeDefined();
		const rendered = textComponent?.render(80).join("\n") ?? "";
		expect(rendered).toContain("Telemetry status");
		expect(mockGetStatus).toHaveBeenCalled();
	});

	it("enables telemetry when /telemetry on is used", () => {
		const enabledStatus = createStatus(true);
		mockGetStatus.mockReturnValue(enabledStatus);
		const showInfo = vi.fn();
		view = new TelemetryView({
			chatContainer: container,
			ui: { requestRender } as unknown as TUI,
			showInfo,
			showError: vi.fn(),
			onStatusChanged,
		});

		view.handleTelemetryCommand(createContext("on", { action: "on" }));

		expect(mockSetOverride).toHaveBeenCalledWith(true, expect.any(String));
		expect(onStatusChanged).toHaveBeenCalledWith(enabledStatus);
		expect(showInfo).toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalled();
	});

	it("resets telemetry when /telemetry reset is used", () => {
		view.handleTelemetryCommand(createContext("reset", { action: "reset" }));
		expect(mockSetOverride).toHaveBeenCalledWith(null, undefined);
	});
});
