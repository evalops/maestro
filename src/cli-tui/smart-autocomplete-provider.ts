import {
	type AutocompleteItem,
	CombinedAutocompleteProvider,
} from "@evalops/tui";
import { getWorkspaceFiles } from "../utils/workspace-files.js";

export class SmartAutocompleteProvider extends CombinedAutocompleteProvider {
	protected override getFileSuggestions(prefix: string): AutocompleteItem[] {
		// Use fast workspace file search for @ mentions
		if (prefix.startsWith("@")) {
			const query = prefix.slice(1).toLowerCase();
			const files = getWorkspaceFiles(); // This returns cached list of all files

			// Handle empty query - return first files without ranking
			if (!query) {
				return files.slice(0, 20).map((f) => ({
					value: `@${f}`,
					label: f,
					description: "file",
				}));
			}

			// Rank matches: basename > prefix > substring
			const scored = files
				.map((f) => {
					const lower = f.toLowerCase();
					const basename = lower.split("/").pop() ?? lower;
					let score = 0;
					if (basename.startsWith(query)) score = 3;
					else if (lower.startsWith(query)) score = 2;
					else if (lower.includes(query)) score = 1;
					return { file: f, score };
				})
				.filter(({ score }) => score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 20);

			return scored.map(({ file: f }) => ({
				value: `@${f}`,
				label: f,
				description: "file",
			}));
		}

		// Fallback to default directory traversal for other paths (e.g. absolute or ./ or ~/)
		return super.getFileSuggestions(prefix);
	}
}
