# Maestro Desktop

Beautiful, native Electron desktop app for Maestro - your AI coding assistant.

## Features

### Native Experience
- **macOS Integration** - Native titlebar with traffic lights, vibrancy, and system menu
- **Windows/Linux** - Custom titlebar with proper window controls
- **Persistent Settings** - Window position, size, and preferences saved between sessions

### Beautiful Dark Theme
- **Obsidian noir background** - Deep blacks for reduced eye strain
- **Teal accent color** - Modern, distinctive visual identity
- **Thoughtful typography** - DM Sans for UI, JetBrains Mono for code
- **Subtle animations** - Smooth transitions and micro-interactions
- **Syntax highlighting** - Full highlight.js support for code blocks

### Full Maestro Integration
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
bun run package:mac           # macOS (.dmg, .zip)
bun run package:mac:universal # macOS Universal Binary (Intel + Apple Silicon)
bun run package:win           # Windows (.exe, NSIS installer)
bun run package:linux         # Linux (.AppImage, .deb, .rpm)
bun run package:all           # All platforms
```

## Packaging

### Icon Generation

Regenerate app icons from SVG source:

```bash
# Requires ImageMagick: brew install imagemagick
bun run icons
```

This generates:
- `icon.icns` - macOS app icon
- `icon.ico` - Windows icon
- `icon.png` - Linux icon (512x512)
- `dmg-background.png` - DMG installer background
- `dmg-background@2x.png` - Retina DMG background

### macOS DMG

The macOS DMG features:
- **Custom background** - Branded installer with drag-to-Applications guidance
- **Universal binary** - Runs natively on Intel and Apple Silicon Macs
- **ULFO compression** - Modern, efficient compression
- **Notarization ready** - Hardened runtime with proper entitlements

### Code Signing & Notarization (macOS)

For distribution outside the Mac App Store:

1. **Developer ID Certificate** - Obtain from Apple Developer portal

2. **Environment Variables**:
   ```bash
   # Option A: Apple ID credentials
   export APPLE_ID="your@email.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="XXXXXXXXXX"

   # Option B: App Store Connect API Key (recommended for CI/CD)
   export APPLE_API_KEY="XXXXXXXXXX"
   export APPLE_API_KEY_PATH="/path/to/AuthKey_XXXXXXXXXX.p8"
   export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   ```

3. **Build with notarization**:
   ```bash
   bun run publish:mac
   ```

To skip notarization during development:
```bash
SKIP_NOTARIZE=true bun run package:mac
```

### Windows

- NSIS installer with customizable installation directory
- Portable executable option
- Desktop and Start Menu shortcuts

### Linux

- AppImage for universal distribution
- `.deb` for Debian/Ubuntu
- `.rpm` for Fedora/RHEL

## Architecture

```
packages/desktop/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts    # App entry point
│   │   ├── window.ts   # Window management
│   │   ├── menu.ts     # Native menu bar
│   │   ├── server.ts   # Embedded backend server
│   │   └── ipc.ts      # IPC handlers
│   ├── preload/        # Context bridge
│   │   └── index.ts    # Exposed APIs
│   └── renderer/       # React UI
│       ├── components/ # UI components
│       ├── hooks/      # React hooks
│       └── lib/        # API client, types
├── assets/             # App icons & DMG background
├── scripts/            # Build scripts
│   ├── generate-icons.sh  # Icon generation
│   └── notarize.js        # macOS notarization
├── release/            # Built installers
└── dist-electron/      # Built Electron code
```

## Configuration

The app connects to a Maestro backend server at `http://localhost:8080` by default. To change this:

1. Start Maestro web server: `maestro web`
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
--bg-void: #020204;         /* Deepest black */
--bg-primary: #06060a;      /* Primary background */
--bg-secondary: #0c0c12;    /* Card backgrounds */
--bg-tertiary: #12121a;     /* Elevated surfaces */
--accent: #14b8a6;          /* Teal accent */
--accent-hover: #0d9488;    /* Teal hover */
--text-primary: #f8fafc;    /* Main text */
--text-secondary: #94a3b8;  /* Muted text */
```

### Typography

- **UI Text**: DM Sans (400, 500, 600, 700)
- **Code**: JetBrains Mono (400, 500, 600)
- **Sizes**: 11px (xs), 13px (sm), 15px (base), 18px (lg), 24px (xl)

## Development Notes

### Main Process

The main process (`src/main/`) handles:
- Window creation and lifecycle
- Native menu bar
- IPC communication
- Embedded backend server management
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

## Troubleshooting

### App won't connect

1. Ensure Maestro backend is running: `maestro web`
2. Check that port 8080 is available
3. Look for errors in DevTools (View → Toggle DevTools)

### Build fails

1. Clear the build cache: `bun run clean`
2. Reinstall dependencies: `rm -rf node_modules && bun install`
3. Check for TypeScript errors: `bun run check`

### DMG background not showing

1. Regenerate icons: `bun run icons`
2. Ensure ImageMagick is installed: `brew install imagemagick`
3. Check `assets/dmg-background.png` exists

### Notarization fails

1. Verify your Apple Developer credentials
2. Check entitlements in `assets/entitlements.mac.plist`
3. Set `SKIP_NOTARIZE=true` for local development

## License

MIT - Same as main Maestro project.
