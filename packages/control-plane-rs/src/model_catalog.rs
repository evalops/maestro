use crate::{model_config_path, read_json_value, Config, MAX_JSON_BODY_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelInfo {
    pub(crate) id: String,
    pub(crate) provider: String,
    pub(crate) name: String,
    pub(crate) api: String,
    pub(crate) context_window: u32,
    pub(crate) max_tokens: u32,
    pub(crate) reasoning: bool,
    pub(crate) cost: ModelCost,
    pub(crate) capabilities: ModelCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCost {
    pub(crate) input: f64,
    pub(crate) output: f64,
    pub(crate) cache_read: f64,
    pub(crate) cache_write: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ModelCapabilities {
    pub(crate) streaming: bool,
    pub(crate) tools: bool,
    pub(crate) vision: bool,
    pub(crate) reasoning: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ModelRegistry {
    pub(crate) models: Vec<ModelInfo>,
    pub(crate) aliases: HashMap<String, String>,
}

pub(crate) async fn available_models(config: &Config) -> ModelRegistry {
    let mut registry = ModelRegistry {
        models: builtin_models(),
        aliases: HashMap::new(),
    };

    if let Some(catalog) = fetch_llm_gateway_model_catalog(config).await {
        merge_llm_gateway_model_catalog(&mut registry, &catalog);
    }

    if let Some(config) = read_json_value(&model_config_path()).await {
        merge_configured_models(&mut registry, &config);
    }
    registry.models.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then(left.id.cmp(&right.id))
    });
    registry
}

async fn fetch_llm_gateway_model_catalog(config: &Config) -> Option<Value> {
    let url = config.llm_gateway_models_url.as_deref()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(config.llm_gateway_timeout_ms))
        .build()
        .ok()?;
    let mut request = client.get(url).header("accept", "application/json");
    if let Some(token) = config.llm_gateway_token.as_deref() {
        request = request.bearer_auth(token);
    }
    if let Some(org_id) = config.llm_gateway_org_id.as_deref() {
        request = request.header("x-organization-id", org_id);
    }

    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.len() > MAX_JSON_BODY_BYTES {
        return None;
    }
    serde_json::from_slice(&body).ok()
}

pub(crate) fn merge_llm_gateway_model_catalog(registry: &mut ModelRegistry, catalog: &Value) {
    if let Some(models) = catalog.get("models").and_then(Value::as_array) {
        merge_gateway_model_array(registry, None, models);
    }

    if let Some(providers) = catalog.get("data").and_then(Value::as_array) {
        merge_gateway_provider_array(registry, providers);
    }

    if let Some(providers) = catalog.get("external_providers").and_then(Value::as_array) {
        merge_gateway_provider_array(registry, providers);
    }
}

fn merge_gateway_provider_array(registry: &mut ModelRegistry, providers: &[Value]) {
    for provider in providers {
        let Some(provider_id) = provider.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if provider_id.is_empty() {
            continue;
        }
        if let Some(models) = provider.get("models").and_then(Value::as_array) {
            merge_gateway_model_array(registry, Some(provider_id), models);
        }
    }
}

fn merge_gateway_model_array(
    registry: &mut ModelRegistry,
    provider_id: Option<&str>,
    models: &[Value],
) {
    for model in models {
        let Some(info) = model_info_from_gateway_value(provider_id, model) else {
            continue;
        };
        upsert_model(&mut registry.models, info);
    }
}

fn model_info_from_gateway_value(provider_id: Option<&str>, model: &Value) -> Option<ModelInfo> {
    let id = model.get("id").and_then(Value::as_str).map(str::trim)?;
    if id.is_empty() {
        return None;
    }
    let provider = model
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
        .or(provider_id)
        .unwrap_or("llm-gateway");
    let name = model
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(id);
    let capabilities = model.get("capabilities");
    let limit = model.get("limit");
    let reasoning = value_bool(model.get("supports_reasoning"))
        .or_else(|| value_bool(model.get("reasoning")))
        .unwrap_or(false);
    let vision =
        value_bool(capabilities.and_then(|capabilities| capabilities.get("supports_vision")))
            .or_else(|| gateway_modalities_include(model, "image"))
            .unwrap_or(false);
    let tools =
        value_bool(capabilities.and_then(|capabilities| capabilities.get("supports_functions")))
            .or_else(|| value_bool(model.get("tool_call")))
            .or_else(|| value_bool(model.get("toolUse")))
            .or_else(|| value_bool(model.get("tools")))
            .unwrap_or(true);
    let streaming =
        value_bool(capabilities.and_then(|capabilities| capabilities.get("supports_streaming")))
            .unwrap_or(true);

    Some(ModelInfo {
        id: id.to_string(),
        provider: provider.to_string(),
        name: name.to_string(),
        api: default_api_for_provider_model(provider, id).to_string(),
        context_window: value_u32(
            capabilities
                .and_then(|capabilities| capabilities.get("context_length"))
                .or_else(|| model.get("contextWindow"))
                .or_else(|| limit.and_then(|limit| limit.get("context"))),
        )
        .unwrap_or(0),
        max_tokens: value_u32(
            capabilities
                .and_then(|capabilities| capabilities.get("max_tokens"))
                .or_else(|| model.get("maxTokens"))
                .or_else(|| limit.and_then(|limit| limit.get("output"))),
        )
        .unwrap_or(0),
        reasoning,
        cost: model_cost_from_value(model.get("pricing").or_else(|| model.get("cost"))),
        capabilities: ModelCapabilities {
            streaming,
            tools,
            vision,
            reasoning,
        },
    })
}

fn gateway_modalities_include(model: &Value, mode: &str) -> Option<bool> {
    let input = model.get("modalities")?.get("input")?.as_array()?;
    Some(input.iter().any(|entry| entry.as_str() == Some(mode)))
}

fn default_api_for_provider_model(provider: &str, model_id: &str) -> &'static str {
    match provider {
        "anthropic" => "anthropic-messages",
        "openai" | "azure-openai" | "azure" if model_id.contains("codex") => {
            "openai-codex-responses"
        }
        "openai" | "azure-openai" | "azure" => "openai-responses",
        "openrouter" => "openai-completions",
        "google" | "google-ai" | "gemini" => "google",
        "bedrock" | "aws-bedrock" => "bedrock",
        _ => "openai-responses",
    }
}

pub(crate) fn merge_configured_models(registry: &mut ModelRegistry, config: &Value) {
    if let Some(aliases) = config.get("aliases").and_then(Value::as_object) {
        registry
            .aliases
            .extend(aliases.iter().filter_map(|(alias, target)| {
                target
                    .as_str()
                    .map(|target| (alias.to_string(), target.trim().to_string()))
            }));
    }

    let Some(providers) = config.get("providers").and_then(Value::as_array) else {
        return;
    };

    for provider in providers {
        if provider.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(provider_id) = provider.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if provider_id.is_empty() {
            continue;
        }
        let provider_api = provider.get("api").and_then(Value::as_str).map(str::trim);
        let Some(models) = provider.get("models").and_then(Value::as_array) else {
            continue;
        };

        for model in models {
            let Some(id) = model.get("id").and_then(Value::as_str).map(str::trim) else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            let name = model
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(id);
            let api = model
                .get("api")
                .and_then(Value::as_str)
                .map(str::trim)
                .or(provider_api)
                .unwrap_or("openai-responses");
            let reasoning = model
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let input_modes = model
                .get("input")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let vision = input_modes
                .iter()
                .any(|mode| mode.as_str() == Some("image"));
            let tools = model
                .get("toolUse")
                .or_else(|| model.get("tools"))
                .and_then(Value::as_bool)
                .unwrap_or(true);

            let info = ModelInfo {
                id: id.to_string(),
                provider: provider_id.to_string(),
                name: name.to_string(),
                api: api.to_string(),
                context_window: value_u32(model.get("contextWindow")).unwrap_or(0),
                max_tokens: value_u32(model.get("maxTokens")).unwrap_or(0),
                reasoning,
                cost: model_cost_from_value(model.get("cost")),
                capabilities: ModelCapabilities {
                    streaming: true,
                    tools,
                    vision,
                    reasoning,
                },
            };
            upsert_model(&mut registry.models, info);
        }
    }
}

fn upsert_model(models: &mut Vec<ModelInfo>, model: ModelInfo) {
    if let Some(existing) = models
        .iter_mut()
        .find(|candidate| candidate.provider == model.provider && candidate.id == model.id)
    {
        *existing = model;
    } else {
        models.push(model);
    }
}

fn value_u32(value: Option<&Value>) -> Option<u32> {
    value?.as_u64().and_then(|value| u32::try_from(value).ok())
}

fn value_bool(value: Option<&Value>) -> Option<bool> {
    value?.as_bool()
}

fn model_cost_from_value(value: Option<&Value>) -> ModelCost {
    let Some(cost) = value.and_then(Value::as_object) else {
        return zero_model_cost();
    };
    ModelCost {
        input: cost.get("input").and_then(Value::as_f64).unwrap_or(0.0),
        output: cost.get("output").and_then(Value::as_f64).unwrap_or(0.0),
        cache_read: cost
            .get("cacheRead")
            .or_else(|| cost.get("cache_read"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        cache_write: cost
            .get("cacheWrite")
            .or_else(|| cost.get("cache_write"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    }
}

fn zero_model_cost() -> ModelCost {
    ModelCost {
        input: 0.0,
        output: 0.0,
        cache_read: 0.0,
        cache_write: 0.0,
    }
}

pub(crate) async fn default_model(config: &Config) -> ModelInfo {
    let registry = available_models(config).await;
    default_model_from_registry(&registry)
}

pub(crate) fn default_model_from_registry(registry: &ModelRegistry) -> ModelInfo {
    env::var("MAESTRO_DEFAULT_MODEL")
        .ok()
        .and_then(|model| resolve_model(&model, registry))
        .or_else(|| registry.models.first().cloned())
        .unwrap_or_else(emergency_default_model)
}

fn default_builtin_model() -> ModelInfo {
    ModelInfo {
        id: "claude-sonnet-4-5-20250514".to_string(),
        provider: "anthropic".to_string(),
        name: "Claude Sonnet 4.5".to_string(),
        api: "anthropic-messages".to_string(),
        context_window: 200_000,
        max_tokens: 64_000,
        reasoning: true,
        cost: ModelCost {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
        },
        capabilities: ModelCapabilities {
            streaming: true,
            tools: true,
            vision: true,
            reasoning: true,
        },
    }
}

pub(crate) fn emergency_default_model() -> ModelInfo {
    default_builtin_model()
}

pub(crate) fn resolve_model(input: &str, registry: &ModelRegistry) -> Option<ModelInfo> {
    let normalized = input.trim();
    if normalized.is_empty() {
        return None;
    }
    let candidate = registry
        .aliases
        .get(normalized)
        .map(String::as_str)
        .unwrap_or(normalized);
    let (provider, id) = candidate
        .split_once('/')
        .map(|(provider, id)| (Some(provider), id))
        .unwrap_or((None, candidate));

    registry
        .models
        .iter()
        .find(|model| {
            model.id == id
                && provider
                    .map(|provider| provider == model.provider)
                    .unwrap_or(true)
        })
        .cloned()
}

pub(crate) fn builtin_models() -> Vec<ModelInfo> {
    vec![
        default_builtin_model(),
        ModelInfo {
            id: "gpt-5.1-codex-max".to_string(),
            provider: "openai".to_string(),
            name: "GPT-5.1 Codex Max".to_string(),
            api: "openai-codex-responses".to_string(),
            context_window: 400_000,
            max_tokens: 128_000,
            reasoning: true,
            cost: ModelCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
            capabilities: ModelCapabilities {
                streaming: true,
                tools: true,
                vision: true,
                reasoning: true,
            },
        },
    ]
}
