use maestro_tui::ai::{ProviderProtocol, ProviderRegistry};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    cases: Vec<ProviderCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCase {
    provider: String,
    aliases: Vec<String>,
    auth_env: Vec<String>,
}

#[test]
fn frozen_provider_matrix_resolves_ids_aliases_and_auth_precedence() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../test/fixtures/rust-cutover/provider-matrix.json"
    ))
    .expect("valid provider matrix fixture");

    for case in fixture.cases {
        let descriptor = ProviderRegistry::descriptor(&case.provider)
            .unwrap_or_else(|| panic!("missing native provider {}", case.provider));
        assert_eq!(descriptor.id, case.provider);
        assert_eq!(descriptor.aliases, case.aliases);
        assert_eq!(descriptor.auth_env, case.auth_env);

        for name in
            std::iter::once(case.provider.as_str()).chain(case.aliases.iter().map(String::as_str))
        {
            assert_eq!(
                ProviderRegistry::descriptor(name).map(|value| value.id),
                Some(case.provider.as_str()),
                "provider alias {name}"
            );
        }

        let env = case
            .auth_env
            .iter()
            .enumerate()
            .map(|(index, name)| (name.clone(), format!("credential-{index}")))
            .collect::<HashMap<_, _>>();
        let resolved = ProviderRegistry::resolve(&case.provider, &env)
            .unwrap_or_else(|error| panic!("resolve {}: {error:#}", case.provider));
        assert_eq!(resolved.provider.id, case.provider);
        assert_eq!(
            resolved.auth_source.as_deref(),
            case.auth_env.first().map(String::as_str)
        );
    }
}

#[test]
fn compatible_endpoints_use_provider_defaults_and_explicit_overrides() {
    let mut env = HashMap::from([
        ("OPENROUTER_API_KEY".to_string(), "key".to_string()),
        (
            "OPENROUTER_BASE_URL".to_string(),
            "https://gateway.example/v1/".to_string(),
        ),
    ]);
    let resolved = ProviderRegistry::resolve("openrouter/model", &env).unwrap();
    assert_eq!(
        resolved.provider.protocol,
        ProviderProtocol::OpenAiCompatible
    );
    assert_eq!(
        resolved.base_url.as_deref(),
        Some("https://gateway.example/v1")
    );

    env.remove("OPENROUTER_BASE_URL");
    let resolved = ProviderRegistry::resolve("openrouter/model", &env).unwrap();
    assert_eq!(
        resolved.base_url.as_deref(),
        Some("https://openrouter.ai/api/v1")
    );
}

#[test]
fn unknown_explicit_provider_is_a_typed_error() {
    let error = ProviderRegistry::resolve("not-a-provider/model", &HashMap::new())
        .expect_err("unknown prefixes must not silently route to OpenAI");
    assert!(error.to_string().contains("unknown provider"));
}
