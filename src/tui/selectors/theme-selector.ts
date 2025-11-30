import { Container, type SelectItem, SelectList } from "@evalops/tui";
import {
	getAvailableThemes,
	getSelectListTheme,
	setTheme,
} from "../../theme/theme.js";
import { DynamicBorder } from "../utils/borders.js";

/**
 * Component that renders a theme selector with live preview.
 * Uses onSelectionChange for live preview as the user navigates.
 */
export class ThemeSelectorComponent extends Container {
	private selectList: SelectList;
	private originalTheme: string;

	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview?: (themeName: string) => void,
	) {
		super();
		this.originalTheme = currentTheme;

		// Get available themes and create select items
		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector with theme styling
		this.selectList = new SelectList(themeItems, 10);

		// Preselect current theme
		const currentIndex = themes.indexOf(currentTheme);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			// Apply theme permanently
			setTheme(item.value);
			onSelect(item.value);
		};

		this.selectList.onCancel = () => {
			// Restore original theme on cancel
			setTheme(this.originalTheme);
			onCancel();
		};

		// Live preview as user navigates
		if (onPreview) {
			this.selectList.onSelectionChange = (item) => {
				setTheme(item.value);
				onPreview(item.value);
			};
		}

		this.addChild(this.selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}

	/**
	 * Get the original theme name (before any preview changes)
	 */
	getOriginalTheme(): string {
		return this.originalTheme;
	}

	/**
	 * Forward input to the SelectList for keyboard navigation
	 */
	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}
