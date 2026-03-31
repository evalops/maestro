import type { Container, TUI } from "@evalops/tui";
import { Markdown, Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import { getMarkdownTheme } from "../theme/theme.js";

interface HotkeysViewOptions {
	chatContainer: Container;
	ui: TUI;
}

const HOTKEYS_MARKDOWN = `
**Navigation**
| Key | Action |
|-----|--------|
| \`Arrow keys\` | Move cursor / browse history (Up when empty) |
| \`Option+Left/Right\` | Move by word |
| \`Ctrl+A\` / \`Home\` / \`Cmd+Left\` | Start of line |
| \`Ctrl+E\` / \`End\` / \`Cmd+Right\` | End of line |
| \`Page Up/Down\` | Scroll chat history |
| \`Ctrl+U\` | Scroll half page up |
| \`Ctrl+D\` | Exit (empty) / Scroll half page down |

**Editing**
| Key | Action |
|-----|--------|
| \`Enter\` | Send message (steer while running) |
| \`Shift+Enter\` | New line |
| \`Tab\` / \`Alt+Enter\` | Queue follow-up (while running) |
| \`Ctrl+W\` / \`Option+Backspace\` | Delete word backwards |
| \`Ctrl+U\` | Delete to start of line |
| \`Ctrl+K\` | Delete to end of line / Command palette |
| \`Ctrl+G\` | Edit message in external editor |
| \`Ctrl+V\` | Paste image from clipboard |

**Model & Thinking**
| Key | Action |
|-----|--------|
| \`Shift+Tab\` | Cycle thinking level |
| \`Ctrl+P\` | Cycle models |
| \`Ctrl+T\` | Toggle thinking block visibility |

**Tools & Output**
| Key | Action |
|-----|--------|
| \`Ctrl+O\` | Toggle tool output expansion |
| \`Tab\` | Path completion / accept autocomplete |

**Session**
| Key | Action |
|-----|--------|
| \`Escape\` | Cancel autocomplete / abort streaming |
| \`Ctrl+C\` | Clear editor (first) / exit (second) |
| \`Ctrl+Z\` | Suspend to background |
| \`/\` | Slash commands |
| \`@\` | File search / mention |
| \`!\` | Run bash command |
| \`Drop files\` | Attach files to message |
`;

export class HotkeysView {
	constructor(private readonly options: HotkeysViewOptions) {}

	handleHotkeysCommand(): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(
			new Text(chalk.bold.cyan("⌨️  Keyboard Shortcuts"), 1, 0),
		);
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(
			new Markdown(
				HOTKEYS_MARKDOWN.trim(),
				undefined,
				undefined,
				undefined,
				1,
				0,
				getMarkdownTheme(),
			),
		);
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.ui.requestRender();
	}
}
