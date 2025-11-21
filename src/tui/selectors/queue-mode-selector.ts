import { Container, type SelectItem, SelectList, Spacer } from "@evalops/tui";

export class QueueModeSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		currentMode: "all" | "one",
		onSelect: (mode: "all" | "one") => void,
		onCancel: () => void,
	) {
		super();

		const queueModes: SelectItem[] = [
			{
				value: "one",
				label: "one-at-a-time",
				description: "Process queued messages one by one (recommended)",
			},
			{
				value: "all",
				label: "all",
				description: "Process all queued messages at once",
			},
		];

		this.addChild(new Spacer(1));

		// Create selector
		this.selectList = new SelectList(queueModes, 2);

		// Preselect current mode
		const currentIndex = queueModes.findIndex(
			(item) => item.value === currentMode,
		);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as "all" | "one");
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
