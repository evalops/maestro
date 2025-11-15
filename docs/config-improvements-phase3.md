# Config System Improvements - Phase 3+ Ideas

Based on current implementation and user experience analysis.

## 🎯 High-Impact Improvements

### 1. **Config Merging & Precedence** ⭐⭐⭐
**Problem:** Users can't layer configs (global + project + local)

**Solution:** Implement config hierarchy like opencode
```
~/.composer/config.json          (Global defaults)
  ↓
./.composer/config.json          (Project overrides)
  ↓
COMPOSER_CONFIG env var          (Runtime overrides)
```

**Benefits:**
- Global defaults for all projects
- Project-specific overrides
- Runtime flexibility

**Implementation:**
```typescript
function loadConfigHierarchy(): CustomModelConfig {
  const configs = [
    loadFile("~/.composer/config.json"),      // Global
    loadFile("./.composer/config.json"),       // Project
    loadFile(process.env.COMPOSER_CONFIG),     // Custom
  ];
  return mergeDeep(...configs);
}
```

**Priority:** HIGH (2-3 hours)

---

### 2. **JSON Schema for IDE Autocomplete** ⭐⭐⭐
**Problem:** Users don't know what fields are available

**Solution:** Generate and publish JSON schema
```jsonc
{
  "$schema": "https://composer-cli.dev/config.schema.json",
  "providers": [
    // Now you get autocomplete in VS Code!
  ]
}
```

**Benefits:**
- Autocomplete in VS Code/IDEs
- Inline documentation
- Validation before runtime
- Prevents typos

**Implementation:**
```typescript
import { zodToJsonSchema } from "zod-to-json-schema";

const schema = zodToJsonSchema(configSchema);
fs.writeFileSync("config.schema.json", JSON.stringify(schema));
```

**Priority:** HIGH (1 hour) - Massive DX win!

---

### 3. **Config Validation CLI Command** ⭐⭐⭐
**Problem:** Users find errors at runtime

**Solution:** Add `composer config validate` command
```bash
$ composer config validate
✓ Config syntax valid
✓ All file references resolved
✓ All environment variables set
✗ Warning: AWS_REGION not set (bedrock provider disabled)
✓ 3 providers, 12 models loaded
```

**Benefits:**
- Catch errors early
- CI/CD integration
- Helpful warnings

**Priority:** HIGH (2 hours)

---

### 4. **Config Templates/Init Wizard** ⭐⭐
**Problem:** Users don't know how to get started

**Solution:** Interactive config builder
```bash
$ composer config init

? Which provider would you like to use?
  ❯ Anthropic (claude-sonnet-4-5)
    OpenAI (gpt-4)
    AWS Bedrock
    Google Vertex AI
    
? How would you like to provide your API key?
  ❯ Environment variable
    Direct (not recommended)
    
? Would you like to use file references for prompts?
  ❯ Yes - create prompts/ folder
    No - inline in config

✓ Created .composer/config.json
✓ Created .composer/prompts/system.md
✓ Added ANTHROPIC_API_KEY to .env.example

Next steps:
  1. Set ANTHROPIC_API_KEY in your environment
  2. Edit .composer/prompts/system.md
  3. Run: composer models list
```

**Priority:** HIGH (3-4 hours) - Great onboarding!

---

## 🔧 Developer Experience

### 5. **Config Extends/Inheritance** ⭐⭐
**Problem:** Duplicate configs across projects

**Solution:** Config inheritance
```jsonc
{
  // Extend a base config
  "extends": "./base-config.json",
  
  // Override specific fields
  "providers": [{
    "id": "anthropic",
    "models": [...]
  }]
}
```

**Or from URL:**
```jsonc
{
  "extends": "https://gist.github.com/user/composer-base.json"
}
```

**Priority:** MEDIUM (2-3 hours)

---

### 6. **Model Aliases** ⭐⭐
**Problem:** Switching models requires config changes everywhere

**Solution:** Define aliases
```jsonc
{
  "aliases": {
    "fast": "anthropic/claude-haiku",
    "smart": "anthropic/claude-sonnet-4-5",
    "reasoning": "anthropic/claude-opus"
  }
}
```

Usage:
```bash
composer --model fast "quick task"
composer --model smart "complex analysis"
```

**Priority:** MEDIUM (2 hours)

---

### 7. **Secrets Management Integration** ⭐⭐
**Problem:** Managing API keys across teams is hard

**Solution:** Integrate with popular secret managers
```jsonc
{
  "providers": [{
    "apiKey": "{vault:secret/anthropic/api-key}",
    // or
    "apiKey": "{1password:vault/anthropic}",
    // or
    "apiKey": "{aws-secrets:composer/anthropic}"
  }]
}
```

**Supported:**
- HashiCorp Vault
- 1Password
- AWS Secrets Manager
- Azure Key Vault

**Priority:** MEDIUM (4-5 hours per integration)

---

### 8. **Config Inspector Tool** ⭐⭐
**Problem:** Hard to debug what config is actually being used

**Solution:** `composer config show` command
```bash
$ composer config show

📋 Loaded Configuration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Config Sources:
  • ~/.composer/config.json
  • ./.composer/config.json ✓
  • Environment variables

Providers (3):
  ✓ anthropic (3 models)
    • claude-sonnet-4-5
    • claude-opus
    • claude-haiku
    Base URL: https://api.anthropic.com/v1/messages (normalized)
    API Key: ••••••••key123 (from env:ANTHROPIC_API_KEY)
    
  ✓ bedrock (5 models)
    Base URL: https://bedrock-runtime.us-east-1.amazonaws.com (auto-generated)
    Region: us-east-1 (from env:AWS_REGION)
    Credentials: ✓ AWS_PROFILE=default
    
  ⚠ openai (disabled)
    Reason: OPENAI_API_KEY not set

File References (2):
  • ./prompts/system.md → 234 bytes
  • ./prompts/coding.txt → 156 bytes

Environment Variables (4):
  ✓ ANTHROPIC_API_KEY
  ✓ AWS_REGION
  ✓ AWS_PROFILE
  ✗ OPENAI_API_KEY (not set)
```

**Priority:** MEDIUM (2-3 hours)

---

## 🚀 Performance & Reliability

### 9. **Config Hot-Reloading** ⭐
**Problem:** Need to restart CLI after config changes

**Solution:** Watch for config file changes
```typescript
import { watch } from "fs";

watch(configPath(), () => {
  console.log("[Config] Reloading...");
  reloadModelConfig();
});
```

**Priority:** LOW (1 hour) - Nice for dev

---

### 10. **Request/Response Logging** ⭐⭐
**Problem:** Hard to debug API issues

**Solution:** Config-based logging
```jsonc
{
  "debug": {
    "logRequests": true,
    "logResponses": true,
    "logFile": "./composer-debug.log"
  }
}
```

Output:
```
[2025-01-15 10:30:45] → POST https://api.anthropic.com/v1/messages
Headers: {...}
Body: {...}

[2025-01-15 10:30:46] ← 200 OK
Response: {...}
Tokens: 1234 input, 567 output
Cost: $0.0234
```

**Priority:** MEDIUM (2-3 hours)

---

### 11. **Rate Limiting & Retry Policies** ⭐⭐
**Problem:** No control over retry behavior

**Solution:** Per-provider configs
```jsonc
{
  "providers": [{
    "id": "anthropic",
    "rateLimit": {
      "requestsPerMinute": 50,
      "tokensPerMinute": 100000
    },
    "retry": {
      "maxAttempts": 3,
      "backoff": "exponential",
      "initialDelayMs": 1000
    },
    "timeout": 30000
  }]
}
```

**Priority:** MEDIUM (3-4 hours)

---

### 12. **Cost Tracking & Budgets** ⭐⭐
**Problem:** No visibility into API costs

**Solution:** Track usage and set budgets
```jsonc
{
  "budget": {
    "daily": 10.00,
    "monthly": 200.00,
    "alertThreshold": 0.8,
    "action": "warn" // or "block"
  }
}
```

Commands:
```bash
$ composer cost today
Today: $2.34 / $10.00 (23%)

$ composer cost breakdown
Provider       | Requests | Tokens  | Cost
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
anthropic      | 45       | 123.4K  | $1.89
bedrock        | 12       | 34.2K   | $0.45

$ composer cost history --last 7d
[ASCII chart showing costs over time]
```

**Priority:** MEDIUM (4-5 hours) - Great for teams!

---

## 🛡️ Enterprise Features

### 13. **Config Profiles** ⭐⭐
**Problem:** Different configs for dev/staging/prod

**Solution:** Named profiles
```bash
$ composer --profile dev models list
$ composer --profile staging "task"
$ composer --profile prod "task"
```

Config:
```jsonc
{
  "profiles": {
    "dev": {
      "providers": [{ "id": "anthropic", "baseUrl": "..." }]
    },
    "prod": {
      "providers": [{ "id": "bedrock", "baseUrl": "..." }]
    }
  }
}
```

**Priority:** MEDIUM (2 hours)

---

### 14. **Team Config Sharing** ⭐
**Problem:** Keeping team configs in sync

**Solution:** Shared config repository
```jsonc
{
  "import": [
    "https://config-server.company.com/composer/base.json",
    "https://config-server.company.com/composer/team-backend.json"
  ]
}
```

**Priority:** LOW (3-4 hours)

---

### 15. **Audit Logging** ⭐
**Problem:** No visibility into who uses what

**Solution:** Audit trail
```jsonc
{
  "audit": {
    "enabled": true,
    "logFile": "./audit.log",
    "includePrompts": false,
    "includeResponses": false
  }
}
```

Logs:
```
2025-01-15 10:30:45 | user:john@company.com | model:anthropic/claude-sonnet-4-5 | tokens:1234 | cost:$0.02
```

**Priority:** LOW (2-3 hours) - Good for compliance

---

## 🎨 User Experience

### 16. **Interactive Config Editor (TUI)** ⭐⭐
**Problem:** Editing JSON is tedious

**Solution:** Terminal UI for config editing
```bash
$ composer config edit
```

```
┌─────────────────────────────────────────┐
│ Composer Configuration Editor           │
├─────────────────────────────────────────┤
│ Providers (3)                           │
│   ▶ anthropic (3 models)                │
│     • claude-sonnet-4-5                 │
│     • claude-opus                       │
│     • claude-haiku                      │
│   ▶ bedrock (5 models)                  │
│   ▶ openai (disabled)                   │
│                                         │
│ [a] Add Provider                        │
│ [e] Edit Provider                       │
│ [d] Delete Provider                     │
│ [s] Save & Exit                         │
└─────────────────────────────────────────┘
```

**Priority:** LOW (6-8 hours) - Cool but not essential

---

### 17. **Model Recommendations** ⭐
**Problem:** Users don't know which model to use

**Solution:** Smart recommendations
```bash
$ composer recommend --for "code generation"

Recommended models for code generation:
  1. anthropic/claude-sonnet-4-5 ⭐ (best quality)
  2. anthropic/claude-haiku (fastest)
  3. openai/gpt-4 (good alternative)

$ composer recommend --for "chat" --budget low

Recommended models for chat (low budget):
  1. anthropic/claude-haiku (fast & cheap)
  2. openai/gpt-3.5-turbo
```

**Priority:** LOW (3-4 hours)

---

### 18. **Config Migration Tool** ⭐⭐
**Problem:** Migrating from other tools is hard

**Solution:** Import from other formats
```bash
$ composer config import --from opencode ~/.opencode/config.json
✓ Converted 3 providers
✓ Migrated API keys to env vars
✓ Created .composer/config.json

$ composer config import --from cursor ~/.cursor/config.json
$ composer config import --from continue ~/.continue/config.json
```

**Priority:** MEDIUM (4-5 hours) - Good for adoption!

---

## 📊 Priority Matrix

### **Quick Wins (1-2 hours):**
1. JSON Schema generation (HIGHEST ROI!)
2. Config hot-reloading
3. Model aliases

### **High Impact (2-4 hours):**
1. Config validation CLI
2. Config hierarchy/merging
3. Config inspector tool
4. Init wizard/templates

### **Medium Impact (4-6 hours):**
1. Rate limiting & retries
2. Cost tracking
3. Config migration tool
4. Request/response logging

### **Nice to Have (6+ hours):**
1. Secrets management integrations
2. Interactive TUI editor
3. Team config sharing
4. Audit logging

---

## 🎯 Recommended Next Phase

### **Phase 3 (Quick Wins - 4 hours total):**
1. ✅ JSON Schema generation (1 hour)
2. ✅ Config validation CLI (2 hours)
3. ✅ Config hierarchy/merging (1 hour)

**Why?**
- Massive DX improvement
- Low effort, high impact
- Builds on existing work
- Users can immediately benefit

### **Phase 4 (User Onboarding - 4 hours):**
1. ✅ Init wizard (3 hours)
2. ✅ Model aliases (1 hour)

**Why?**
- Better first-run experience
- Reduces support burden
- Makes adoption easier

### **Phase 5 (Observability - 5 hours):**
1. ✅ Config inspector (2 hours)
2. ✅ Cost tracking (3 hours)

**Why?**
- Visibility into usage
- Budget management
- Team collaboration

---

## 💡 Long-Term Vision

### **Composer as a Platform:**
- Plugin system for custom providers
- Community model templates
- Shared prompt library
- Usage analytics dashboard
- Team collaboration features
- Model performance benchmarking

### **Enterprise Features:**
- SSO integration
- RBAC (role-based access)
- Centralized config management
- Compliance reporting
- Multi-region deployments

---

## 🚀 Implementation Strategy

1. **Quick wins first** - Build momentum with easy wins
2. **User feedback** - Let users guide priorities
3. **Incremental** - Ship small, ship often
4. **Backward compatible** - Never break existing configs
5. **Well documented** - Update docs with each feature

---

## 📝 Notes

- Focus on DX (developer experience)
- Keep it simple by default, powerful when needed
- Learn from existing tools (opencode, cursor, continue)
- Community feedback is gold
- Performance matters (don't slow down the CLI)

