# Providers & Factory Integration

Audience: contributors/operator tweaking model registry and provider configs.  
Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Safety](SAFETY.md) · [AI SDK](../packages/ai/README.md)

Composer loads model/provider metadata from multiple locations so you can mix
built-in configs with Factory CLI settings. This page clarifies the resolution
order and how to customize providers.

## Config Sources

`src/models/registry.ts` builds the registry from:

1. **Built-in defaults** (shipped with Composer)
2. **Factory data**:
   - `~/.factory/config.json`
   - `~/.factory/settings.json`
3. **Composer config**:
   - `~/.composer/models.json` (legacy path)
   - `~/.composer/config.json` (via `COMPOSER_CONFIG`)
4. **Env overrides**:
   - `COMPOSER_MODELS_FILE=/path/to/custom.json`

Paths are read in that order, later entries overriding earlier ones.

## Format

Custom config files accept:

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "headers": { "Authorization": "Bearer ..." },
      "enabled": true
    }
  },
  "models": [
    {
      "provider": "my-provider",
      "id": "my-model",
      "name": "My Model",
      "reasoning": false,
      "contextWindow": 128000
    }
  ]
}
```

Factory files follow their own schema; Composer maps Factory model IDs to
providers internally (see `factoryDataCache.modelProviderMap`).

## Provider Loaders

Some providers need runtime detection (API keys, regions). The `PROVIDER_LOADERS`
map injects defaults:

| Provider   | Behavior                                                      |
| ---------- | ------------------------------------------------------------- |
| `anthropic`| Adds `anthropic-beta: prompt-caching-2024-07-31` header       |
| `bedrock`  | Uses `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` to toggle `enabled`  |
| `vertex-ai`| Reads `GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT` for base URL       |
| `groq`     | Auto-enables when `GROQ_API_KEY` is present                   |
| ...        | (See `src/models/registry.ts` for the full list)              |

## Built-in Overlays (Responses API)

Composer seeds a few Responses-capable models that aren’t yet emitted by the
generator, so you can use them out of the box:

- **OpenRouter (Responses API):** `openai/o4`, `openai/o4-mini`, and their
  `:online` variants, all routed to `https://openrouter.ai/api/v1/responses`.
- **Groq (Responses API):** `openai/gpt-oss-20b`, `openai/gpt-oss-120b`,
  routed via Groq’s OpenAI-compatible endpoint
  `https://api.groq.com/openai/v1/responses`.

To add more Responses-capable models (or override these), drop them into
`.composer/config.json` with `api: "openai-responses"`; Composer will normalize
the base URL to `/responses` automatically.

### Responses API Compatibility Notes (Tools)

When `api: "openai-responses"` is enabled for a model, Composer must filter tool
definitions to match Responses API schema constraints.

In particular, Composer filters out any tool whose `parameters` JSON Schema
contains these keywords at the **top level**:

- `oneOf`, `anyOf`, `allOf`
- `enum`
- `not`

This filtering is implemented in `filterResponsesApiTools()` (`src/agent/providers/openai.ts`).
When tools are filtered, Composer logs a warning listing the affected tool names
(`src/agent/providers/openai-responses-sdk.ts`).

Background:
- OpenAI’s Structured Outputs docs describe the supported JSON Schema subset and
  the requirement that the root schema not be `anyOf` and that some keywords
  (including `allOf` / `not`) are not supported. See:
  `https://platform.openai.com/docs/guides/structured-outputs/supported-schemas`
  and
  `https://platform.openai.com/docs/guides/structured-outputs/some-type-specific-keywords-are-not-yet-supported`

**Workaround:** wrap constrained values inside an object schema (nest under
`properties`) so the top-level schema remains an object:

```json
// ❌ filtered (top-level enum)
{ "enum": ["a", "b", "c"] }

// ✅ compatible (enum nested under properties)
{
  "type": "object",
  "properties": { "value": { "enum": ["a", "b", "c"] } }
}
```

> Note: Codex subscription models are intentionally excluded. The Codex endpoint
> requires the Codex CLI system prompt and tool set verbatim, which Composer
> does not forward for security and transparency reasons.

## Factory Commands

- `/import factory` or `npm run factory:import` – copies `~/.factory` config +
  provider metadata into Composer’s store. Handy after updating models in Factory CLI.
- `/export factory` or `npm run factory:export` – push Composer’s provider data
  back to Factory files.

These commands ensure both CLIs stay in sync while still allowing standalone
configs.

## Tips

- Use `composer models list` (or `/models`) to inspect the final registry, including
  custom entries and their providers.
- Keep secrets out of repo files; rely on `COMPOSER_MODELS_FILE` plus env vars for headers.
- When troubleshooting, `LOG_COMPOSER_MODELS=1` (future flag) could dump the path
  resolution order—until then, add debug logs around `getRegisteredModels()`.
