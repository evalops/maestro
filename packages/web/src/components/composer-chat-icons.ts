import { html } from "lit";

export type ComposerChatIconName =
	| "chevron-left"
	| "chevron-right"
	| "info"
	| "refresh"
	| "globe"
	| "share"
	| "settings"
	| "sun"
	| "moon"
	| "grid"
	| "file"
	| "timeline"
	| "network"
	| "flask"
	| "reduce"
	| "close";

const ICON_PATHS: Record<ComposerChatIconName, string> = {
	"chevron-left": "M15 18l-6-6 6-6",
	"chevron-right": "M9 6l6 6-6 6",
	info: "M12 12v4m0-8h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z",
	refresh:
		"M4.93 4.93A10 10 0 0 1 19.07 5M20 9v-4h-4M19.07 19.07A10 10 0 0 1 4.93 19M4 15v4h4",
	globe:
		"M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c3 0 5-4 5-9s-2-9-5-9-5 4-5 9 2 9 5 9Zm0 0c2.5 0 4.5-4 4.5-9S14.5 3 12 3 7.5 7 7.5 12 9.5 21 12 21Zm0-9h9M3 12h9",
	share:
		"M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 0 6Zm-12 4a3 3 0 1 0 2.83 4H9a3 3 0 0 0 0-6Zm12 0a3 3 0 1 0 2.83 4H21a3 3 0 0 0 0-6Zm-4.59-1.51L8.59 15.5M15.41 8.5 8.59 11.5",
	settings:
		"M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.63a1 1 0 0 0 0-1.74l-1.17-.68a1 1 0 0 1-.46-.86l.05-1.35a1 1 0 0 0-1.17-1.01l-1.35.23a1 1 0 0 1-.9-.26L13.2 6a1 1 0 0 0-1.4 0l-.9.9a1 1 0 0 1-.9.26l-1.35-.23a1 1 0 0 0-1.17 1.01l.05 1.35a1 1 0 0 1-.46.86l-1.17.68a1 1 0 0 0 0 1.74l1.17.68a1 1 0 0 1 .46.86l-.05 1.35a1 1 0 0 0 1.17 1.01l1.35-.23a1 1 0 0 1 .9.26l.9.9a1 1 0 0 0 1.4 0l.9-.9a1 1 0 0 1 .9-.26l1.35.23a1 1 0 0 0 1.17-1.01l-.05-1.35a1 1 0 0 1 .46-.86Z",
	sun: "M12 4.5V3M12 21v-1.5M4.5 12H3m18 0h-1.5M6.75 6.75 5.7 5.7m12.6 12.6-1.05-1.05M6.75 17.25 5.7 18.3m12.6-12.6-1.05 1.05M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
	moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
	grid: "M4 4h7v7H4Zm9 0h7v7h-7ZM4 13h7v7H4Zm9 7v-7h7v7Z",
	file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
	timeline:
		"M4 5h4m-4 7h8m-8 7h12M10 5h10M14 12h6M18 19h2M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm4 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm4 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
	network:
		"M12 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-7 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm14 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM10.4 5.1 6.6 16.9m7-11.8 3.8 11.8M7.8 19h8.4",
	flask:
		"M9 3h6M10 3v5.5L5.5 17a3 3 0 0 0 2.65 4.4h7.7A3 3 0 0 0 18.5 17L14 8.5V3M8 14h8",
	reduce: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Zm-5-9h10",
	close: "M18 6 6 18M6 6l12 12",
};

export function renderComposerChatIcon(name: ComposerChatIconName) {
	return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
		<path d=${ICON_PATHS[name]}></path>
	</svg>`;
}
