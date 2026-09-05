# Dex Code visual baselines (macOS / `Menlo`)

Reviewed native terminal captures at 100×30 and 60×20, `Menlo` 18 pixels,
with the dark and light reference palettes. The forty-nine settled screens cover
conversation, approval, tool details, appearance, petting, quiet mode, suggested
input, every appearance catalog option, repeated pet greetings, the scrolled
appearance picker, theme filtering, and preview save/cancel behavior.
Startup and session headers say Dex Code.
Light-theme selectors and approvals use opaque backgrounds so titles remain readable on dark terminals. The gallery also covers explicit reduced motion.
Streaming is reviewed separately because its elapsed timer is live. No pixels are normalized, masked, or painted over.

From `products/maestro`, after building the native debug binary:

```sh
npm run screenshots:gallery -- --binary "$CARGO_TARGET_DIR/debug/maestro" \
  --output /tmp/dex-visual-check \
  --check-baseline test/fixtures/tui-capture/baselines/macos-menlo
```

Use `--record-baseline` with a new directory to propose an update, inspect
all images, then deliberately replace these reviewed PNG files. Never accept a
partial gallery or copy failed captures into the baseline.

The picker, approval and detail updates were captured on Linux using the same font and contain no
platform-specific shortcuts. The long Unicode query checks terminal cell layout
and cursor scrolling; `Menlo` lacks Japanese glyphs, so those characters appear
as missing-glyph boxes in these PNG files.

Font SHA-256: `f2d400484a6aace67980730ec0a9ef24ce9e535a2604f118e6fdc2510021b85f`.
