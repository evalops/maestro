#![allow(dead_code)]

pub(crate) const NAME_MAX_LENGTH: usize = 128;
pub(crate) const NAMESPACE_MAX_LENGTH: usize = 64;
pub(crate) const RESERVED_RESPONSES_NAMESPACES: &[&str] = &[
    "api_tool",
    "browser",
    "computer",
    "container",
    "file_search",
    "functions",
    "image_gen",
    "multi_tool_use",
    "python",
    "python_user_visible",
    "submodel_delegator",
    "terminal",
    "tool_search",
    "web",
];
pub(crate) const RESERVED_NAMES: &[&str] = &["mcp"];
pub(crate) const RESERVED_NAME_PREFIXES: &[&str] = &["mcp__"];
pub(crate) const DYNAMIC_TOOL_CALL_METHOD: &str = "item/tool/call";

pub(crate) fn is_valid_identifier(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn is_reserved_identifier(value: &str) -> bool {
    RESERVED_NAMES.contains(&value)
        || RESERVED_NAME_PREFIXES
            .iter()
            .any(|prefix| value.starts_with(prefix))
}

pub(crate) fn is_reserved_namespace(value: &str) -> bool {
    is_reserved_identifier(value) || RESERVED_RESPONSES_NAMESPACES.contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../test/fixtures/codex/app-server-dynamic-tools-v1.json"
        ))
        .expect("fixture parses")
    }

    #[test]
    fn constants_match_codex_app_server_fixture() {
        let fixture = fixture();
        let dynamic_tool_spec = &fixture["dynamicToolSpec"];
        let dynamic_tool_call = &fixture["dynamicToolCall"];

        assert_eq!(
            NAME_MAX_LENGTH,
            dynamic_tool_spec["nameMaxLength"].as_u64().unwrap() as usize
        );
        assert_eq!(
            NAMESPACE_MAX_LENGTH,
            dynamic_tool_spec["namespaceMaxLength"].as_u64().unwrap() as usize
        );
        assert_eq!(
            RESERVED_NAMES,
            dynamic_tool_spec["reservedNames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect::<Vec<_>>()
                .as_slice()
        );
        assert_eq!(
            RESERVED_NAME_PREFIXES,
            dynamic_tool_spec["reservedNamePrefixes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect::<Vec<_>>()
                .as_slice()
        );
        assert_eq!(
            RESERVED_RESPONSES_NAMESPACES,
            dynamic_tool_spec["reservedNamespaces"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect::<Vec<_>>()
                .as_slice()
        );
        assert_eq!(
            DYNAMIC_TOOL_CALL_METHOD,
            dynamic_tool_call["method"].as_str().unwrap()
        );
    }

    #[test]
    fn validates_responses_safe_identifiers() {
        assert!(is_valid_identifier("gh_pr", NAME_MAX_LENGTH));
        assert!(is_valid_identifier("parallel-ripgrep", NAME_MAX_LENGTH));
        assert!(!is_valid_identifier("", NAME_MAX_LENGTH));
        assert!(!is_valid_identifier("ticket lookup", NAME_MAX_LENGTH));
        assert!(!is_valid_identifier("ticket:lookup", NAME_MAX_LENGTH));
        assert!(!is_valid_identifier(
            &"a".repeat(NAME_MAX_LENGTH + 1),
            NAME_MAX_LENGTH
        ));
    }

    #[test]
    fn reserves_mcp_identifiers_and_responses_namespaces() {
        assert!(is_reserved_identifier("mcp"));
        assert!(is_reserved_identifier("mcp__read"));
        assert!(!is_reserved_identifier("mcptool"));
        assert!(is_reserved_namespace("browser"));
        assert!(is_reserved_namespace("mcp__tool"));
        assert!(!is_reserved_namespace("maestro_browser"));
    }
}
