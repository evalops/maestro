# Composer Desktop

Beautiful, native Electron desktop app for Composer - your AI coding assistant.

## Features

### Native Experience
- **macOS Integration** - Native titlebar with traffic lights, vibrancy, and system menu
- **Windows/Linux** - Custom titlebar with proper window controls
- **Persistent Settings** - Window position, size, and preferences saved between sessions

### Beautiful Dark Theme
- **Deep black background** (#0a0a0b) for reduced eye strain
- **Thoughtful typography** - Inter for UI, JetBrains Mono for code
- **Subtle animations** - Smooth transitions and micro-interactions
- **Syntax highlighting** - Full highlight.js support for code blocks

### Full Composer Integration
- **Session Management** - Create, switch, delete, and search sessions
- **Model Selection** - Quick model switching from the header
- **Streaming Responses** - Real-time SSE streaming with typing indicators
- **Tool Execution** - Collapsible tool call cards with syntax-highlighted results

## Quick Start

### Development

```bash
# Install dependencies
cd packages/desktop
bun install

# Start in development mode (with hot reload)
bun run dev
```

### Production Build

```bash
# Build and package for current platform
bun run package

# Build for specific platform
bun run package:mac    # macOS (.dmg, .zip)
bun run package:win    # Windows (.exe, NSIS installer)
bun run package:linux  # Linux (.AppImage, .deb)
```

## Architecture

```
packages/desktop/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts    # App entry point
│   │   ├── window.ts   # Window management
│   │   ├── menu.ts     # Native menu bar
│   │   └── ipc.ts      # IPC handlers
│   ├── preload/        # Context bridge
│   │   └── index.ts    # Exposed APIs
│   └── renderer/       # React UI
│       ├── components/ # UI components
│       ├── hooks/      # React hooks
│       └── lib/        # API client, types
├── assets/             # App icons
└── dist-electron/      # Built Electron code
```

## Configuration

The app connects to a Composer backend server at `http://localhost:8080` by default. To change this:

1. Start Composer web server: `composer web`
2. The desktop app will automatically connect

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+N` | New session |
| `Cmd/Ctrl+K` | Clear context |
| `Cmd/Ctrl+\` | Toggle sidebar |
| `Cmd/Ctrl+M` | Select model |
| `Cmd/Ctrl+,` | Preferences (macOS) |
| `Enter` | Send message |
| `Shift+Enter` | New line |

## Design System

### Colors

```css
--bg-primary: #0a0a0b;      /* Deep black */
--bg-secondary: #141416;    /* Card backgrounds */
--bg-tertiary: #1c1c1f;     /* Hover states */
--border: #2a2a2d;          /* Subtle borders */
--text-primary: #fafafa;    /* Main text */
--text-secondary: #a1a1aa;  /* Muted text */
--accent: #3b82f6;          /* Blue accent */
```

### Typography

- **UI Text**: Inter (400, 500, 600, 700)
- **Code**: JetBrains Mono (400, 500, 600)
- **Sizes**: 12px (xs), 14px (sm), 16px (base), 20px (lg), 28px (xl)

## Development Notes

### Main Process

The main process (`src/main/`) handles:
- Window creation and lifecycle
- Native menu bar
- IPC communication
- File system access

### Preload Script

The preload script (`src/preload/`) exposes a limited API to the renderer:
- Window controls (minimize, maximize, close)
- File dialogs
- Clipboard access
- Native notifications
- Path utilities

### Renderer

The renderer (`src/renderer/`) is a React application with:
- **Tailwind CSS** for styling
- **highlight.js** for syntax highlighting
- **marked** for Markdown rendering
- Custom hooks for chat and session management

## Packaging

Built with `electron-builder`:
- macOS: DMG installer with drag-to-Applications
- Windows: NSIS installer with optional per-user install
- Linux: AppImage and .deb packages

### Code Signing (macOS)

For distribution, you'll need:
1. Apple Developer certificate
2. Notarization with `notarize.js` script
3. Hardened runtime entitlements

## Troubleshooting

### App won't connect

1. Ensure Composer backend is running: `composer web`
2. Check that port 8080 is available
3. Look for errors in DevTools (View → Toggle DevTools)

### Build fails

1. Clear the build cache: `bun run clean`
2. Reinstall dependencies: `rm -rf node_modules && bun install`
3. Check for TypeScript errors: `bun run check`

## License

MIT - Same as main Composer project.
