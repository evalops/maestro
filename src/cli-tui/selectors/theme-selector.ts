import type { SelectItem } from "@evalops/tui";
import {
	getAvailableThemes,
	getSelectListTheme,
	setTheme,
} from "../../theme/theme.js";
import { BaseSelectorComponent } from "./base-selector.js";

/**
 * Component that renders a theme selector with live preview.
 * Uses onSelectionChange for live preview as the user navigates.
 */
export class ThemeSelectorComponent extends BaseSelectorComponent<string> {
	private originalTheme: string;

	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview?: (themeName: string) => void,
	) {
		// Get available themes and create select items
		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		super({
			items: themeItems,
			visibleRows: 10,
			onSelect: (theme) => {
				setTheme(theme);
				onSelect(theme);
			},
			onCancel: () => {
				setTheme(currentTheme);
				onCancel();
			},
			onSelectionChange: (theme) => {
				setTheme(theme);
				onPreview?.(theme);
			},
		});

		this.originalTheme = currentTheme;

		// Preselect current theme
		const currentIndex = themes.indexOf(currentTheme);
		if (currentIndex !== -1) {
			this.getSelectList().setSelectedIndex(currentIndex);
		}
	}

	/**
	 * Get the original theme name (before any preview changes)
	 */
	getOriginalTheme(): string {
		return this.originalTheme;
	}
}
