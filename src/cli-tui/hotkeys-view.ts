import type { Container, TUI } from "@evalops/tui";
import { Markdown, Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import { getMarkdownTheme } from "../theme/theme.js";
import {
	inspectKeybindingConfig,
	summarizeKeybindingConfigIssues,
} from "./keybindings-config.js";
import {
	getTuiKeybindingLabel,
	getTuiKeybindingShortcut,
} from "./keybindings.js";
import { getQueuedFollowUpEditBindingLabel } from "./queue/queued-follow-up-edit-binding.js";

interface HotkeysViewOptions {
	chatContainer: Container;
	ui: TUI;
}

export function buildHotkeysMarkdown(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const keybindingConfig = inspectKeybindingConfig(env);
	const queuedFollowUpEditBinding = getQueuedFollowUpEditBindingLabel(env);
	const commandPaletteBinding = getTuiKeybindingLabel("command-palette", env);
	const externalEditorBinding = getTuiKeybindingLabel("external-editor", env);
	const cycleModelBinding = getTuiKeybindingLabel("cycle-model", env);
	const toggleThinkingBinding = getTuiKeybindingLabel(
		"toggle-thinking-blocks",
		env,
	);
	const toggleToolOutputsBinding = getTuiKeybindingLabel(
		"toggle-tool-outputs",
		env,
	);
	const suspendBinding = getTuiKeybindingLabel("suspend", env);
	const ctrlKLine =
		getTuiKeybindingShortcut("command-palette", env) === "ctrl+k"
			? ""
			: "| `Ctrl+K` | Delete to end of line |\n";
	const validationLine = summarizeKeybindingConfigIssues(keybindingConfig)
		? `Validation: ${keybindingConfig.issues.length} issue(s) detected. Run \`/hotkeys validate\` for details.`
		: `Validation: ${keybindingConfig.exists ? "OK" : "config missing (run `/hotkeys init`)"}`;
	return `
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
| \`Tab\` | Send message / Queue follow-up (while running) |
| \`Alt+Enter\` | Queue follow-up (alternate while running) |
| \`${queuedFollowUpEditBinding}\` | Edit last queued follow-up |
| \`Ctrl+W\` / \`Option+Backspace\` | Delete word backwards |
| \`Ctrl+U\` | Delete to start of line |
${ctrlKLine}| \`${commandPaletteBinding}\` | Command palette |
| \`${externalEditorBinding}\` | Edit message in external editor |
| \`Ctrl+V\` | Paste image from clipboard |

**Model & Thinking**
| Key | Action |
|-----|--------|
| \`Shift+Tab\` | Cycle thinking level |
| \`${cycleModelBinding}\` | Cycle models |
| \`${toggleThinkingBinding}\` | Toggle thinking block visibility |

**Tools & Output**
| Key | Action |
|-----|--------|
| \`${toggleToolOutputsBinding}\` | Toggle tool output expansion |
| \`Tab\` | Path completion / accept autocomplete |

**Session**
| Key | Action |
|-----|--------|
| \`Escape\` | Cancel autocomplete / abort streaming |
| \`Ctrl+C\` | Clear editor (first) / exit (second) |
| \`${suspendBinding}\` | Suspend to background |
| \`/\` | Slash commands |
| \`@\` | File search / mention |
| \`!\` | Run bash command |
| \`Drop files\` | Attach files to message |

**Customization**
| Command | Purpose |
|---------|---------|
| \`/hotkeys path\` | Show the config file location |
| \`/hotkeys init\` | Create a starter \`keybindings.json\` |
| \`/hotkeys validate\` | Validate current overrides |

Current config: \`${keybindingConfig.path}\` (${keybindingConfig.exists ? "present" : "missing"})
${validationLine}
`;
}

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
				buildHotkeysMarkdown().trim(),
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
