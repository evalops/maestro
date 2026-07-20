import type { SelectItem } from "@evalops/tui";
import type { ThinkingLevel } from "../../agent/types.js";
import { BaseSelectorComponent } from "./base-selector.js";

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends BaseSelectorComponent<ThinkingLevel> {
	constructor(
		currentLevel: ThinkingLevel,
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		const thinkingLevels: Array<SelectItem & { value: ThinkingLevel }> = [
			{ value: "off", label: "off", description: "No reasoning" },
			{
				value: "minimal",
				label: "minimal",
				description: "Very brief reasoning (~1k tokens)",
			},
			{
				value: "low",
				label: "low",
				description: 'Light reasoning (~4k tokens) — "think"',
			},
			{
				value: "medium",
				label: "medium",
				description: 'Moderate reasoning (~8k tokens) — "think hard"',
			},
			{
				value: "high",
				label: "high",
				description: 'Deep reasoning (~16k tokens) — "think harder"',
			},
			{
				value: "ultra",
				label: "ultra",
				description: 'Maximum reasoning (~32k+ tokens) — "ultrathink"',
			},
		];

		super({
			items: thinkingLevels,
			visibleRows: 6,
			onSelect,
			onCancel,
		});

		const currentIndex = thinkingLevels.findIndex(
			(item) => item.value === currentLevel,
		);
		if (currentIndex !== -1) {
			this.getSelectList().setSelectedIndex(currentIndex);
		}
	}
}
