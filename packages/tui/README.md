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

## Rendering Architecture

The TUI uses a **differential rendering** system to minimize terminal writes and prevent flicker. Understanding this system helps when debugging visual issues or building custom components.

### Rendering Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                      Render Pipeline                            │
├─────────────────────────────────────────────────────────────────┤
│  1. requestRender() called (component change, resize, input)    │
│  2. Throttle check (debounce rapid calls, especially over SSH)  │
│  3. doRender() executes:                                        │
│     a. All components render to string[] lines                  │
│     b. Lines wrapped to terminal width (cached for performance) │
│     c. Overflow check: if lines > viewport, clip to bottom N    │
│     d. Compare newLines vs previousLines                        │
│     e. Choose render strategy (full vs differential)            │
│     f. Write to terminal, update cursor tracking                │
└─────────────────────────────────────────────────────────────────┘
```

### Render Strategies

| Strategy | When Used | What Happens |
|----------|-----------|--------------|
| **First Render** | `previousLines.length === 0` | Write all lines from cursor, no clear |
| **Full Re-render** | Width changed, overflow state changed, or line count decreased | Clear screen (`\x1b[3J\x1b[2J\x1b[H`), write all lines |
| **Differential** | Only content changed (same dimensions) | Move cursor to first changed line, clear+write only changed lines |

### Key State Variables

```typescript
// What was rendered last frame (for diffing)
previousLines: string[]

// Cursor position tracking (0-indexed, relative to TUI's first line)
cursorRow: number

// Whether content exceeded viewport last frame
overflowedLastRender: boolean

// For throttling renders (especially over SSH)
lastRenderTs: number
lastFullRenderTs: number
```

### Overflow Handling (Viewport Clipping)

When content exceeds the terminal height, the TUI clips to show only the bottom N lines:

```
Full content (15 lines):          Clipped (10-line viewport):
┌──────────────────────┐          ┌──────────────────────┐
│ line0  (clipped)     │          │ line5                │ ← newLines[0]
│ line1  (clipped)     │          │ line6                │
│ line2  (clipped)     │          │ line7                │
│ line3  (clipped)     │          │ line8                │
│ line4  (clipped)     │          │ line9                │
├──────────────────────┤    →     │ line10               │
│ line5                │          │ line11               │
│ line6                │          │ line12               │
│ ...                  │          │ line13               │
│ line14               │          │ line14               │
└──────────────────────┘          └──────────────────────┘
```

**Important**: When overflow state changes, a full re-render is required because line indices no longer correspond to the same content positions between frames.

### Differential Rendering Algorithm

```typescript
// 1. Find the range of changed lines
for (i = 0; i < max(newLines, previousLines); i++) {
  if (newLines[i] !== previousLines[i]) {
    firstChanged = min(firstChanged, i)
    lastChanged = i
  }
}

// 2. Move cursor to first changed line
moveCursor(firstChanged - cursorRow)  // Up or down

// 3. Clear and write each changed line
for (i = firstChanged; i < newLines.length; i++) {
  clearLine()      // \x1b[2K
  write(newLines[i])
  if (i < newLines.length - 1) newline()
}

// 4. Clear any leftover lines if content shrunk
if (previousLines.length > newLines.length) {
  for each extra line: newline + clearLine
  moveCursorUp(extraLines)
}
```

### Synchronized Output (DECSET 2026)

The TUI wraps render output in synchronized output markers to prevent tearing:

```
\x1b[?2026h   ← Begin synchronized output (terminal buffers)
... render content ...
\x1b[?2026l   ← End synchronized output (terminal flushes atomically)
```

This is auto-disabled over SSH/tmux where it can cause "typing in waves" issues.

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
