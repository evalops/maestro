# Config System Improvements Research

Based on analysis of `sst/opencode` config system vs our current Composer implementation.

## 🎯 Key Findings from OpenCode

### 1. **JSONC Support (JSON with Comments)**
**What they do:**
```jsonc
{
  // This is a comment!
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-4-5": {} // Can comment inline too
      }
    }
  }
}
```

**Implementation:** Uses `jsonc-parser` package
```typescript
import { parse as parseJsonc } from "jsonc-parser"
const data = parseJsonc(text, errors, { allowTrailingComma: true })
```

**Benefits:**
- Users can document their configs inline
- Easier onboarding (explain what each field does)
- Can comment out options without deleting them

---

### 2. **Environment Variable Substitution**
**What they do:**
```json
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:MY_ANTHROPIC_KEY}"
      }
    }
  }
}
```

**Implementation:**
```typescript
text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
  return process.env[varName] || ""
})
```

**Benefits:**
- Keep secrets out of config files
- Different keys per environment (dev/prod)
- Easier team sharing (everyone uses their own keys)

---

### 3. **File References**
**What they do:**
```json
{
  "agent": {
    "system": {
      "prompt": "{file:./prompts/system.md}"
    }
  }
}
```

**Implementation:**
```typescript
for (const match of line.matchAll(/\{file:([^}]+)\}/g)) {
  const filePath = match[1]
  const resolvedPath = path.isAbsolute(filePath) 
    ? filePath 
    : path.resolve(configDir, filePath)
  const fileContent = await Bun.file(resolvedPath).text()
  text = text.replace(match[0], JSON.stringify(fileContent).slice(1, -1))
}
```

**Benefits:**
- Keep large prompts/configs in separate files
- Better organization (prompts/, configs/, etc.)
- Easier editing (proper syntax highlighting for .md files)
- Reusable components

---

### 4. **Sophisticated Config Merging**
**What they do:**
```typescript
// Load in order, each overrides previous
result = pipe(
  {},
  mergeDeep(await loadFile("~/.opencode/config.json")),      // Global
  mergeDeep(await loadFile(".opencode/opencode.jsonc")),     // Project
  mergeDeep(await loadFile(Flag.OPENCODE_CONFIG)),           // Custom
  mergeDeep(JSON.parse(Flag.OPENCODE_CONFIG_CONTENT))        // Runtime
)
```

**Benefits:**
- Clear precedence: Global → Project → Custom → Runtime
- Deep merging (not just Object.assign)
- Can override specific nested fields without replacing entire sections

---

### 5. **Custom Provider Loaders**
**What they do:**
```typescript
const CUSTOM_LOADERS: Record<string, CustomLoader> = {
  async anthropic() {
    return {
      autoload: false,
      options: {
        headers: {
          "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
        }
      }
    }
  },
  async "amazon-bedrock"() {
    const region = process.env["AWS_REGION"] ?? "us-east-1"
    return {
      autoload: Boolean(process.env["AWS_PROFILE"]),
      options: {
        region,
        credentialProvider: fromNodeProviderChain()
      },
      async getModel(sdk, modelID, options) {
        // Custom logic to add region prefixes
        if (modelRequiresPrefix) {
          modelID = `us.${modelID}`
        }
        return sdk.languageModel(modelID)
      }
    }
  }
}
```

**Benefits:**
- Provider-specific initialization logic
- Auto-detect credentials
- Custom model ID transformations
- Provider-specific headers/options

---

### 6. **Models.dev Integration**
**What they do:**
```typescript
export async function get() {
  refresh()  // Non-blocking refresh
  const cached = await Bun.file(filepath).json().catch(() => {})
  if (cached) return cached
  return await fetchFromModelsDev()
}

export async function refresh() {
  const result = await fetch("https://models.dev/api.json", {
    signal: AbortSignal.timeout(10 * 1000),
  })
  if (result.ok) await Bun.write(file, await result.text())
}

// Auto-refresh every hour
setInterval(() => ModelsDev.refresh(), 60 * 1000 * 60).unref()
```

**Benefits:**
- Always up-to-date model definitions
- No hardcoded model lists
- Community-maintained registry
- Fallback to cached data if network fails

---

### 7. **Plugin System for Auth**
**What they do:**
```typescript
for (const plugin of await Plugin.list()) {
  if (!plugin.auth) continue
  const options = await plugin.auth.loader(
    () => Auth.get(providerID),
    database[providerID]
  )
  mergeProvider(providerID, options ?? {}, "custom")
}
```

**Benefits:**
- Extensible authentication mechanisms
- Third-party providers can add their own auth
- OAuth flows handled by plugins

---

### 8. **Better Error Messages**
**What they do:**
```typescript
const errors: JsoncParseError[] = []
const data = parseJsonc(text, errors)
if (errors.length) {
  const lines = text.split("\n")
  const errorDetails = errors.map((e) => {
    const line = text.substring(0, e.offset).split("\n").length
    const column = /* calculate column */
    const problemLine = lines[line - 1]
    return `${printParseErrorCode(e.error)} at line ${line}, column ${column}
   Line ${line}: ${problemLine}
${"".padStart(column + 9)}^`
  }).join("\n")
  
  throw new JsonError({
    path: configFilepath,
    message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}`
  })
}
```

**Benefits:**
- Shows exact line and column of error
- Displays the problematic line with a pointer
- Full context of what failed

---

## 📊 Comparison: OpenCode vs Composer

| Feature | OpenCode | Composer (Current) | Priority |
|---------|----------|-------------------|----------|
| **JSONC Support** | ✅ Yes | ❌ Plain JSON only | 🔥 HIGH |
| **Env Var Substitution** | ✅ `{env:VAR}` | ❌ Must use actual env | 🔥 HIGH |
| **File References** | ✅ `{file:path}` | ❌ No | 🟡 MEDIUM |
| **Config Merging** | ✅ Deep merge (remeda) | ✅ Basic merge | 🟡 MEDIUM |
| **Provider Loaders** | ✅ Custom per provider | ⚠️ Generic handling | 🔥 HIGH |
| **Models Registry** | ✅ models.dev API | ⚠️ Hardcoded builtin | 🔥 HIGH |
| **Auto-refresh Models** | ✅ Hourly updates | ❌ Static | 🟢 LOW |
| **Plugin Auth** | ✅ Extensible plugins | ❌ Direct only | 🟢 LOW |
| **Error Messages** | ✅ Line numbers + context | ⚠️ Basic Zod errors | 🟡 MEDIUM |
| **URL Normalization** | ❌ No | ✅ Auto-fix URLs | ✅ WIN |
| **Config Validation** | ✅ Zod with descriptions | ✅ Zod schemas | ✅ TIE |
| **Multiple Formats** | ✅ .json, .jsonc, .toml | ⚠️ .json only | 🟡 MEDIUM |

---

## 🚀 Recommended Improvements (Prioritized)

### **Priority 1: High Impact, Low Effort**

#### 1. JSONC Support (Comments in Config)
**Effort:** Low (add `jsonc-parser` package)
**Impact:** High (much better UX)

```typescript
import { parse as parseJsonc } from "jsonc-parser"

function loadConfig(): CustomModelConfig {
  const errors: JsoncParseError[] = []
  const data = parseJsonc(text, errors, { 
    allowTrailingComma: true 
  })
  
  if (errors.length) {
    // Show helpful error with line numbers
  }
  
  return configSchema.parse(data)
}
```

#### 2. Environment Variable Substitution
**Effort:** Low (simple regex replace)
**Impact:** High (security + portability)

```typescript
function processEnvVars(text: string): string {
  return text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || ""
  })
}
```

#### 3. Provider-Specific Loaders
**Effort:** Medium (refactor provider initialization)
**Impact:** High (better provider support)

```typescript
const PROVIDER_LOADERS = {
  anthropic: async () => ({
    options: {
      headers: {
        "anthropic-beta": "prompt-caching-2024-07-31"
      }
    }
  }),
  bedrock: async () => ({
    autoload: Boolean(process.env.AWS_PROFILE),
    options: {
      region: process.env.AWS_REGION ?? "us-east-1"
    }
  })
}
```

---

### **Priority 2: High Impact, Medium Effort**

#### 4. Models.dev Integration
**Effort:** Medium (new API integration)
**Impact:** High (always up-to-date models)

```typescript
async function refreshModels() {
  const cached = path.join(homedir(), ".composer", "models-cache.json")
  
  // Try fetching latest
  const response = await fetch("https://models.dev/api.json", {
    signal: AbortSignal.timeout(10000)
  }).catch(() => null)
  
  if (response?.ok) {
    const data = await response.json()
    await fs.writeFile(cached, JSON.stringify(data))
    return data
  }
  
  // Fall back to cached
  return JSON.parse(await fs.readFile(cached, "utf-8"))
}
```

#### 5. File References
**Effort:** Medium (file loading + resolution)
**Impact:** Medium (better organization)

```typescript
async function processFileRefs(text: string, configDir: string): Promise<string> {
  const matches = text.matchAll(/\{file:([^}]+)\}/g)
  
  for (const match of matches) {
    let filePath = match[1]
    if (filePath.startsWith("~/")) {
      filePath = path.join(os.homedir(), filePath.slice(2))
    }
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(configDir, filePath)
    
    const content = await fs.readFile(resolvedPath, "utf-8")
    // Escape for JSON
    text = text.replace(match[0], JSON.stringify(content).slice(1, -1))
  }
  
  return text
}
```

---

### **Priority 3: Nice-to-Have**

#### 6. Better Error Messages with Line Numbers
**Effort:** Low (enhance existing validation)
**Impact:** Medium (better DX)

#### 7. Auto-refresh Models
**Effort:** Low (background timer)
**Impact:** Low (convenience)

#### 8. Plugin System
**Effort:** High (new architecture)
**Impact:** Low (extensibility for future)

---

## 💡 Quick Wins We Can Ship Today

### 1. JSONC + Env Vars (Combined)
```bash
# Install package
bun add jsonc-parser

# Update loadConfig()
- const data = JSON.parse(text)
+ const errors: JsoncParseError[] = []
+ text = processEnvVars(text)  // {env:VAR} → actual values
+ const data = parseJsonc(text, errors, { allowTrailingComma: true })
```

**Deliverable:** Users can now:
```jsonc
{
  // My Composer config
  "providers": [{
    "id": "anthropic",
    "name": "Anthropic",
    "baseUrl": "https://api.anthropic.com/v1/messages",
    "apiKeyEnv": "ANTHROPIC_API_KEY",  // Or use {env:MY_KEY} directly
    "models": [/* ... */]
  }]
}
```

### 2. Provider Loaders for Anthropic + Bedrock
```typescript
const PROVIDER_LOADERS = {
  anthropic: async (config) => ({
    headers: {
      "anthropic-beta": "prompt-caching-2024-07-31,..."
    },
    baseUrl: config.baseUrl || "https://api.anthropic.com/v1/messages"
  }),
  
  bedrock: async (config) => {
    const region = process.env.AWS_REGION || "us-east-1"
    return {
      baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
      enabled: Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID)
    }
  }
}
```

---

## 🎬 Implementation Plan

### Phase 1: Foundation (1-2 hours)
- [ ] Add JSONC support
- [ ] Add environment variable substitution
- [ ] Add provider-specific loaders (Anthropic, Bedrock, Vertex)
- [ ] Test with existing configs (backwards compatible)

### Phase 2: Registry (2-3 hours)
- [ ] Integrate models.dev API
- [ ] Add caching layer
- [ ] Implement fallback to builtin models
- [ ] Add auto-refresh (optional)

### Phase 3: Polish (1-2 hours)
- [ ] Better error messages with line numbers
- [ ] Add file reference support
- [ ] Update documentation
- [ ] Migration guide for existing users

---

## 🔥 Killer Feature Ideas

### Hybrid Approach: Keep Our URL Normalization!
OpenCode doesn't auto-fix incomplete URLs - **we have an advantage here!**

**Combine both:**
```typescript
const PROVIDER_LOADERS = {
  anthropic: async (config) => {
    // OpenCode's approach: set defaults
    const baseUrl = config.baseUrl || "https://api.anthropic.com/v1/messages"
    
    // Composer's approach: normalize if incomplete
    const normalized = normalizeBaseUrl(baseUrl, "anthropic")
    if (normalized !== baseUrl) {
      console.warn(`[Config] Auto-normalized Anthropic URL`)
    }
    
    return {
      baseUrl: normalized,
      headers: { "anthropic-beta": "..." }
    }
  }
}
```

**Result:** Best of both worlds! 🎉

---

## 📝 Notes

- OpenCode uses `remeda` for deep merging (we could use `lodash.merge` or implement our own)
- They support `.toml` config format (probably not worth it for us)
- Plugin system is complex but powerful - defer to Phase 4+
- models.dev seems actively maintained - good choice for registry

