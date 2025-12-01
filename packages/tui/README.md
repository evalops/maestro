# @evalops/tui

Terminal UI library with differential rendering for building flicker-free interactive CLI applications.

## Features

- **Differential Rendering**: Only updates what changed for optimal performance
- **Component-based**: Simple Component interface with render() method
- **Built-in Components**: Text, Input, Editor, Loader, SelectList, Spacer
- **ANSI Support**: Full color and formatting support
- **Keyboard Handling**: Arrow keys, home/end, ctrl shortcuts
- **Auto-wrapping**: Smart text wrapping with proper line breaks

## Installation

```bash
npm install @evalops/tui
```

## Quick Start

```typescript
import { TUI, Text, Input } from "@evalops/tui";

const tui = new TUI();

// Add static text
tui.addChild(new Text("Welcome to my app!"));

// Add interactive input
const input = new Input();
input.onSubmit = (text) => {
  console.log("You entered:", text);
};
tui.addChild(input);

// Start the UI
tui.start();
```

## Core API

### Component Interface

All components implement:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
}
```

### Built-in Components

#### Text
Display static or dynamic text with wrapping.

```typescript
const text = new Text("Hello World");
text.setText("Updated text");
```

#### Input
Single-line text input with keyboard support.

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
```

#### Editor
Multi-line text editor with full keyboard support.

```typescript
const editor = new Editor();
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
```

#### Loader
Animated loading indicator.

```typescript
const loader = new Loader("Processing...");
```

#### StatusBar
Lightweight status strip with spinner and interrupt hint. Handy over SSH where prompts can be missed.

```typescript
const status = new StatusBar({ message: "Working", interruptHint: "Ctrl+C" });
tui.addChild(status);
tui.setInterruptHandler(() => abortCurrentTask());
```

#### SelectList
Interactive list selector with keyboard navigation.

```typescript
const list = new SelectList(items);
list.onSelect = (item) => console.log("Selected:", item);
```

## Advanced Usage

### Over SSH / tmux / "typing in waves"

The TUI uses synchronized output (DECSET 2026) for flicker-free redraws. SSH and tmux/screen often buffer those frames, so keystrokes can arrive in bursts. Composer now auto-disables sync output when `SSH_CONNECTION`, `SSH_CLIENT`, `TMUX`, or `STY` is set. You can override with environment variables:

- `COMPOSER_NO_SYNC=1` or `COMPOSER_SYNC_OUTPUT=0|false` — disable sync output (recommended over SSH/tmux)
- `COMPOSER_SYNC_OUTPUT=1|true` — force enable even over SSH/tmux

### Custom Components

```typescript
class MyComponent implements Component {
  render(width: number): string[] {
    return ["Line 1", "Line 2"];
  }
  
  handleInput(data: string): void {
    // Handle keyboard input
  }
}
```

### Styling with Chalk

```typescript
import chalk from "chalk";

const text = new Text(chalk.blue.bold("Styled text"));
```

## License

MIT - see LICENSE file for details.
