# Theming

The native TUI ships built-in themes and can load custom JSON themes.

---

## Built-in themes

| Name | Description |
|------|-------------|
| `dark` | Default dark background |
| `light` | Light background for bright environments |
| `high-contrast` | Maximum contrast for accessibility |

---

## Switching themes

In the TUI:

```text
/theme
/theme light
/theme dark
```

With no argument, `/theme` opens the theme selector.

To make the automatic theme follow terminal dark/light changes, enable:

```toml
[tui]
theme_follow = true
```

Maestro listens for terminal color-scheme notifications and periodically
queries the background color. It requires two consistent background readings
before switching, which avoids flicker near the light/dark threshold.

---

## Custom themes

Place JSON theme files under the theme directories the native loader scans. Documented paths include the legacy composer layout:

- Global: `~/.composer/themes/<name>.json`
- Project: `.composer/themes/<name>.json`

Prefer creating themes in a Maestro-home-aligned location if you standardize on `~/.maestro`; if a theme does not appear, place it where the loader currently scans (`~/.composer/themes`) or switch via `/theme` after copying the file.

Example theme JSON:

```json
{
  "name": "my-theme",
  "colors": {
    "accent": "#7dd3fc",
    "border": "#334155",
    "text": "#e2e8f0",
    "error": "#fca5a5",
    "success": "#86efac",
    "md_heading": "#60a5fa",
    "syntax_keyword": "#c084fc"
  }
}
```

Colors accept `#RRGGBB`, optional `#RRGGBBAA` (alpha ignored), or `transparent`.

Color categories include core UI (`accent`, `border`, `text`, …), messages, tools, markdown, syntax, and thinking-level colors.

---

## Terminal color adaptation

Themes adapt to terminal capability:

| Capability | Behavior |
|------------|----------|
| True color (16M) | Full RGB |
| 256 color | Nearest ANSI 256 |
| 16 color | Nearest basic ANSI |

---

## Related UI toggles

```text
/zen                 # minimal chrome
/footer rich|solo|history|clear
/compact-tools on|off
```

Accessibility env vars: `MAESTRO_REDUCED_MOTION`, `MAESTRO_DISABLE_ANIMATIONS` (see [Keyboard Shortcuts](03-keyboard-shortcuts.md)).
