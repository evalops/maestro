import { type SelectItem, Spacer } from "@evalops/tui";
import { BaseSelectorComponent } from "./base-selector.js";

export class QueueModeSelectorComponent extends BaseSelectorComponent<
	"all" | "one"
> {
	constructor(
		currentMode: "all" | "one",
		onSelect: (mode: "all" | "one") => void,
		onCancel: () => void,
	) {
		const queueModes: Array<SelectItem & { value: "one" | "all" }> = [
			{
				value: "one",
				label: "one-at-a-time",
				description: "Queue one message at a time while the agent runs",
			},
			{
				value: "all",
				label: "all",
				description: "Allow multiple messages to queue while running",
			},
		];

		super({
			items: queueModes,
			visibleRows: 2,
			onSelect,
			onCancel,
			topBorder: false,
			bottomBorder: false,
			prepend: [new Spacer(1)],
			append: [new Spacer(1)],
		});

		// Preselect current mode
		const currentIndex = queueModes.findIndex(
			(item) => item.value === currentMode,
		);
		if (currentIndex !== -1) {
			this.getSelectList().setSelectedIndex(currentIndex);
		}
	}
}
