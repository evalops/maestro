# Providers & Factory Integration

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
