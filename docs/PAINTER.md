# Painter

Painter generates and edits images from inside an agent thread. It is the
visual counterpart to the Oracle: where the Oracle brings a second model's
reasoning, Painter brings an image model's output. Use it for UI mockups,
app icons, illustrations, and editing existing images (for example,
redacting a screenshot before pasting it into a PR).

Painter is a tool the main agent invokes. It is **not** always-on — tell the
agent to use it, the same way you would tell it to use the Oracle.

## Setup

Painter calls an OpenAI-compatible image API and needs an API key in the
environment where the agent runs:

```bash
export OPENAI_API_KEY=sk-...
```

That is the only required configuration. The default model is `gpt-image-2`.

## What it does

- **Generate** — text prompt → new image.
- **Edit** — one to three input images + a prompt describing the change →
  edited image. Pass a `mask` to restrict changes to a region.
- Outputs are **persisted to disk** and returned as absolute paths. The
  agent references those paths in later turns. Transcripts stay small
  (image bytes are never inlined as base64).

## Output location

Defaults to `~/.maestro/assets/painter/`. Override with
`MAESTRO_PAINTER_OUTPUT_DIR`. Files are named
`painter-<timestamp>-<rand>.png`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required. Provider credential. |
| `MAESTRO_PAINTER_MODEL` | `gpt-image-2` | Image model id. |
| `MAESTRO_PAINTER_BASE_URL` | — | OpenAI-compatible base URL (proxies, Azure-style endpoints). |
| `MAESTRO_PAINTER_OUTPUT_DIR` | `~/.maestro/assets/painter` | Where generated images are written. |
| `MAESTRO_PAINTER_TIMEOUT_MS` | `180000` | Per-call timeout. Image generation is slow; tune up for high quality. |

## Examples

Ask the agent directly:

- "Use the painter to create a UI mockup for the settings page, dark theme,
  two-column layout."
- "Use the painter to generate an app icon: dark background, glowing cyan
  terminal cursor."
- "Redact the API keys visible in `screenshots/bug.png` using the painter,
  then attach the result to the PR description."

For edits, point the agent at one or more image paths (use `@`-mention).
Painter accepts up to three reference images.

## Masking

Pass a `mask` path to restrict an edit to part of an image. The mask must be
a PNG whose transparent pixels mark the editable region (the OpenAI image
edit convention). Omit `mask` for a whole-image edit.

Bounding-box-to-mask synthesis (so you can say "edit the region
`x,y,w,h`" instead of supplying a mask file) is planned but not yet
shipped.

## Model notes

`gpt-image-2` does **not** support transparency; requesting
`background: transparent` is rejected by the API. It does support arbitrary
`WxH` sizes where both dimensions are divisible by 16 and the aspect ratio
is between 1:3 and 3:1, in addition to the standard sizes.

## Permissions

Painter writes files only inside the configured output directory. Inputs are
read-only — Painter never mutates a file you pass in. Painter is part of the
`advanced` tool category: available to `coder` and `custom` subagent types,
and explicitly denied from `explorer` (read-only), mirroring the Oracle.

## Composing with Conductor (browser automation)

The interesting Maestro-native loop is Painter + Conductor together, which
Amp's isolated Painter cannot do:

1. **Mockup → diff.** Painter generates a UI mockup; Conductor screenshots
   the live page; the agent compares and iterates.
2. **Bug → redact → PR.** Conductor captures a failing-state screenshot;
   Painter redacts secrets; the agent opens a PR with the clean image.

## What is not in v1

- TUI inline image rendering (iTerm2/sixel/kitty). v1 writes the file and
  returns the path; open it with your viewer of choice.
- Bounding-box mask synthesis (see Masking).
- A per-mode cost ceiling. Cost surfaces in the result metadata; a hard
  `MAESTRO_PAINTER_MAX_COST_CENTS` cap is follow-up work.
- Additional providers (FLUX, Imagen). The `ImageProvider` interface and its
  `supports` map are in place so these can be added without touching the
  Painter tool.
