# Painter

Painter generates and edits images from inside an agent thread. It is the
visual counterpart to the Oracle: where the Oracle brings a second model's
reasoning, Painter brings an image model's output. Use it for UI mockups,
app icons, illustrations, and editing existing images (for example,
redacting a screenshot before pasting it into a PR).

Painter is a tool the main agent invokes. It is **not** always-on — tell the
agent to use it, the same way you would tell it to use the Oracle.

## Setup

Painter calls an image API and needs a credential in the environment where the
agent runs. The default provider is OpenAI (`gpt-image-2`):

```bash
export OPENAI_API_KEY=sk-...
```

To use FLUX via fal.ai instead:

```bash
export MAESTRO_PAINTER_PROVIDER=flux
export FAL_KEY=<your fal key>
```

## Providers

| Provider | `MAESTRO_PAINTER_PROVIDER` | Generate | Edit | Mask | Credential |
| --- | --- | --- | --- | --- | --- |
| OpenAI (default) | `openai` | yes | yes | yes | `OPENAI_API_KEY` |
| FLUX (fal.ai) | `flux` | yes | no | no | `FAL_KEY` |

Each provider declares a `supports` map; the painter checks it before calling
edit, so asking for an edit on FLUX fails fast with a clear error instead of a
buried API failure.

## What it does

- **Generate** — text prompt → new image.
- **Edit** — one to three input images + a prompt → edited image (OpenAI only).
  Restrict changes to a region with a mask (see Masking).
- Outputs are **persisted to disk** and returned as absolute paths. The agent
  references those paths in later turns. Transcripts stay small (image bytes
  are never inlined as base64 into the conversation).

## Masking

Two ways to restrict an edit to part of an image:

- **Bounding box** — pass `maskRegion: {x, y, width, height}` in pixels. Painter
  synthesizes the mask PNG automatically (transparent = editable region,
  matching OpenAI's mask semantics). Input dimensions come from the PNG header
  (no deps), fall back to the optional `sharp` package, then an explicit
  caller-supplied `maskSize`. Coordinates outside the image are clipped.
- **Mask file** — pass `mask` pointing at a PNG whose transparent pixels mark
  the editable region.

Omit both for a whole-image edit.

## Output location

Defaults to `~/.maestro/assets/painter/`. Override with
`MAESTRO_PAINTER_OUTPUT_DIR`. Files are named `painter-<timestamp>-<rand>.png`.

## Inline preview

View a generated image inline in a capable terminal:

```bash
maestro painter show ~/.maestro/assets/painter/painter-....png
```

Renders via iTerm2/WezTerm (OSC 1337) or kitty (graphics protocol). Run it from
a plain shell, not inside the full-screen TUI. This writes only to stdout — it
never routes through the agent loop, so it can't waste model tokens or corrupt
the conversation context.

## Spend ceiling (opt-in)

Painter checks a process-level budget before every API call. Enable by setting
both:

- `MAESTRO_PAINTER_MAX_COST_CENTS` — whole-dollar-cents ceiling.
- `MAESTRO_PAINTER_PRICE_TABLE` — JSON mapping
  `${model}|${size}|${quality}` → cents per image, with `*` wildcards, e.g.
  `{"gpt-image-2|*|high": 8}`.

When the next call would exceed the ceiling, Painter fails fast with a clear
reason and makes no API call. Prices are **not** fabricated: the default table
is empty, and when a ceiling is set but no price matches, the gate fails **open**
(allows the call) rather than blocking on missing data.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` / `FAL_KEY` | — | Required provider credential. |
| `MAESTRO_PAINTER_PROVIDER` | `openai` | `openai` or `flux`. |
| `MAESTRO_PAINTER_MODEL` | `gpt-image-2` (OpenAI) / `fal-ai/flux/schnell` (FLUX) | Model id. |
| `MAESTRO_PAINTER_BASE_URL` | — | OpenAI-compatible base URL (proxies). |
| `MAESTRO_PAINTER_OUTPUT_DIR` | `~/.maestro/assets/painter` | Where images are written. |
| `MAESTRO_PAINTER_TIMEOUT_MS` | `180000` | Per-call timeout. |
| `MAESTRO_PAINTER_MAX_COST_CENTS` | — | Opt-in spend ceiling (whole cents). |
| `MAESTRO_PAINTER_PRICE_TABLE` | — | JSON price table for the ceiling. |

## Examples

Ask the agent directly:

- "Use the painter to create a UI mockup for the settings page, dark theme."
- "Use the painter to generate an app icon: dark background, glowing cyan cursor."
- "Redact the API keys in `screenshots/bug.png` using the painter."

For edits, point the agent at one or more image paths (use `@`-mention).
Painter accepts up to three reference images.

## Model notes

`gpt-image-2` does **not** support transparency; requesting
`background: transparent` is rejected by the API. It supports arbitrary `WxH`
sizes where both dimensions are divisible by 16 and the aspect ratio is between
1:3 and 3:1, in addition to the standard sizes.

## Permissions

Painter writes files only inside the configured output directory. Inputs are
read-only — Painter never mutates a file you pass in. Painter is part of the
`advanced` tool category: available to `coder` and `custom` subagent types, and
explicitly denied from `explorer` (read-only), mirroring the Oracle.

## Composing with Conductor (browser automation)

The Maestro-native loop is Painter + Conductor together:

1. **Mockup → diff.** Painter generates a UI mockup; Conductor screenshots the
   live page; the agent compares and iterates.
2. **Bug → redact → PR.** Conductor captures a failing-state screenshot;
   Painter redacts secrets; the agent opens a PR with the clean image.

## Not yet implemented

- Sixel rasterization (sixel terminals are detected but not encoded; needs a
  real image library).
- FLUX editing / inpainting (fal exposes this on a separate endpoint).
- Inline rendering *inside* the full-screen TUI itself (the `maestro painter
  show` CLI command covers plain-shell preview; a TUI-integrated viewer is a
  separate piece of work in the TUI package).
