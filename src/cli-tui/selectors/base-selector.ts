import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
} from "@evalops/tui";
import { DynamicBorder } from "../utils/borders.js";

type SelectorValue = string;

export interface BaseSelectorOptions<T extends SelectorValue = SelectorValue> {
	items: Array<SelectItem & { value: T }>;
	visibleRows?: number;
	onSelect: (value: T) => void;
	onCancel: () => void;
	onSelectionChange?: (value: T) => void;
	topBorder?: Component | false;
	bottomBorder?: Component | false;
	prepend?: Component[];
	append?: Component[];
}

/**
 * Shared wrapper for simple SelectList-based selectors.
 * Handles borders, wiring callbacks, and forwarding input/focus.
 */
export class BaseSelectorComponent<
	T extends SelectorValue = SelectorValue,
> extends Container {
	private readonly selectList: SelectList;

	constructor(options: BaseSelectorOptions<T>) {
		super();

		if (options.prepend) {
			for (const child of options.prepend) {
				this.addChild(child);
			}
		}

		if (options.topBorder !== false) {
			this.addChild(options.topBorder ?? new DynamicBorder());
		}

		this.selectList = new SelectList(
			options.items,
			options.visibleRows ?? options.items.length,
		);

		this.selectList.onSelect = (item) => {
			options.onSelect(item.value as T);
		};

		this.selectList.onCancel = () => {
			options.onCancel();
		};

		if (options.onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				options.onSelectionChange?.(item.value as T);
			};
		}

		this.addChild(this.selectList);

		if (options.bottomBorder !== false) {
			this.addChild(options.bottomBorder ?? new DynamicBorder());
		}

		if (options.append) {
			for (const child of options.append) {
				this.addChild(child);
			}
		}
	}

	getSelectList(): SelectList {
		return this.selectList;
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}
