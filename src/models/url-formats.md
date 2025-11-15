# Provider Base URL Formats

This document describes the expected base URL formats for different AI providers.

## Anthropic (Direct API)

**Format:**
```
https://api.anthropic.com/v1/messages
```

**Common Mistakes:**
- ❌ `https://api.anthropic.com` (missing `/v1/messages`)
- ❌ `https://anthropic.com/v1/messages` (missing `api.`)

**Config Example:**
```json
{
  "providers": [{
    "id": "anthropic",
    "name": "Anthropic",
    "api": "anthropic-messages",
    "baseUrl": "https://api.anthropic.com/v1/messages",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "models": [...]
  }]
}
```

## AWS Bedrock

**Format:**
```
https://bedrock-runtime.{region}.amazonaws.com
```

**Example:**
```
https://bedrock-runtime.us-east-1.amazonaws.com
```

**Common Mistakes:**
- ❌ `https://bedrock.us-east-1.amazonaws.com` (should be `bedrock-runtime`)

**Notes:**
- Bedrock uses AWS SDK signing
- Requires AWS credentials configured
- Model IDs like `anthropic.claude-3-sonnet-20240229-v1:0`

## Google Vertex AI

**Format:**
```
https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:rawPredict
```

**Example:**
```
https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict
```

**Notes:**
- Requires full path including project ID and location
- Model names use `@` suffix: `claude-sonnet-4-5@20250929`
- Requires Google Cloud credentials

## OpenAI

**Format:**
```
https://api.openai.com/v1/chat/completions
```

## Azure OpenAI

**Format:**
```
https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}
```

**Example:**
```
https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2024-02-15-preview
```

## Auto-Normalization

The model registry automatically normalizes incomplete URLs:

- Anthropic: Appends `/v1/messages` if missing
- Bedrock: Fixes `bedrock.` → `bedrock-runtime.`
- Vertex AI: Validates base domain (but cannot auto-complete project/location)

Warnings are logged when auto-normalization occurs.
