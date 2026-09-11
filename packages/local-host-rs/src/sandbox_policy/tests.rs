//! Tests for the sandbox policy document and its merge rule.
//!
//! `proptest` is not a dev-dependency of `maestro-tui`, so the merge invariants
//! are checked by exhaustive enumeration instead of random sampling. The rule
//! universe is small enough that every document over it, and every pair and
//! triple of those documents, is enumerated: 128 documents, 16 384 pairs, and
//! 32 768 triples over the reduced universe.

use std::net::IpAddr;
use std::path::PathBuf;
use std::str::FromStr;

use super::*;

// ─────────────────────────────────────────────────────────────
// Table construction
// ─────────────────────────────────────────────────────────────

fn cidr(text: &str) -> NetworkRule {
    NetworkRule::from_str(text).expect("test CIDR parses")
}

/// Nested blocks are included on purpose: `10.0.0.0/16` inside `10.0.0.0/8`
/// exercises the conservative rule-set intersection documented on
/// [`merge_policies`].
fn full_rule_universe() -> Vec<NetworkRule> {
    vec![
        NetworkRule::Loopback,
        cidr("10.0.0.0/8"),
        cidr("10.0.0.0/16"),
    ]
}

fn reduced_rule_universe() -> Vec<NetworkRule> {
    vec![NetworkRule::Loopback, cidr("10.0.0.0/8")]
}

fn rule_subsets(universe: &[NetworkRule]) -> Vec<Vec<NetworkRule>> {
    let count = 1usize << universe.len();
    (0..count)
        .map(|mask| {
            universe
                .iter()
                .enumerate()
                .filter(|(index, _)| mask & (1usize << index) != 0)
                .map(|(_, rule)| *rule)
                .collect()
        })
        .collect()
}

fn network_universe(universe: &[NetworkRule]) -> Vec<NetworkPolicy> {
    let subsets = rule_subsets(universe);
    let mut policies = Vec::new();
    for default in [NetworkAction::Allow, NetworkAction::Deny] {
        for allow in &subsets {
            for deny in &subsets {
                policies.push(NetworkPolicy {
                    default,
                    allow: allow.clone(),
                    deny: deny.clone(),
                });
            }
        }
    }
    policies
}

fn doc_with_network(network: &NetworkPolicy) -> SandboxPolicyDocument {
    SandboxPolicyDocument {
        network: Some(network.clone()),
        ..SandboxPolicyDocument::default()
    }
}

fn addr(text: &str) -> IpAddr {
    IpAddr::from_str(text).expect("test address parses")
}

fn probe_addresses() -> Vec<IpAddr> {
    vec![
        addr("127.0.0.1"),
        addr("::1"),
        addr("10.0.0.1"),
        addr("10.1.0.1"),
        addr("192.168.1.1"),
        addr("169.254.169.254"),
        addr("8.8.8.8"),
        addr("::ffff:10.0.0.1"),
        addr("2001:db8::1"),
    ]
}

fn all_sources() -> [PolicySource; 3] {
    [
        PolicySource::User,
        PolicySource::Repo,
        PolicySource::TeamAdmin,
    ]
}

// ─────────────────────────────────────────────────────────────
// Merge invariants
// ─────────────────────────────────────────────────────────────

/// The load-bearing property: a merged policy never permits a destination that
/// any contributing source refuses.
fn assert_monotonic(documents: &[SandboxPolicyDocument], probes: &[IpAddr]) {
    let labels = all_sources();
    let sources: Vec<(PolicySource, SandboxPolicyDocument)> = documents
        .iter()
        .enumerate()
        .map(|(index, doc)| (labels[index % labels.len()], doc.clone()))
        .collect();
    let merged = merge_policies(&sources);
    let Some(merged_network) = merged.network.as_ref() else {
        assert!(
            documents.iter().all(|doc| doc.network.is_none()),
            "merge dropped an opinionated network policy"
        );
        return;
    };
    for probe in probes {
        if merged_network.decide(*probe) == NetworkAction::Allow {
            for doc in documents {
                if let Some(network) = doc.network.as_ref() {
                    assert_eq!(
                        network.decide(*probe),
                        NetworkAction::Allow,
                        "merged policy {merged_network:?} allowed {probe} that source {network:?} refuses"
                    );
                }
            }
        }
    }
}

#[test]
fn merged_policy_never_permits_what_any_pair_member_refuses() {
    let policies = network_universe(&full_rule_universe());
    assert_eq!(policies.len(), 128);
    let probes = probe_addresses();
    for left in &policies {
        for right in &policies {
            assert_monotonic(&[doc_with_network(left), doc_with_network(right)], &probes);
        }
    }
}

#[test]
fn merged_policy_never_permits_what_any_triple_member_refuses() {
    let policies = network_universe(&reduced_rule_universe());
    assert_eq!(policies.len(), 32);
    let probes = probe_addresses();
    for first in &policies {
        for second in &policies {
            for third in &policies {
                assert_monotonic(
                    &[
                        doc_with_network(first),
                        doc_with_network(second),
                        doc_with_network(third),
                    ],
                    &probes,
                );
            }
        }
    }
}

#[test]
fn merge_is_order_independent_over_all_pairs() {
    let policies = network_universe(&full_rule_universe());
    for left in &policies {
        for right in &policies {
            let forward = merge_policies(&[
                (PolicySource::User, doc_with_network(left)),
                (PolicySource::TeamAdmin, doc_with_network(right)),
            ]);
            let reverse = merge_policies(&[
                (PolicySource::TeamAdmin, doc_with_network(right)),
                (PolicySource::User, doc_with_network(left)),
            ]);
            assert_eq!(forward, reverse, "merge depended on source order");
        }
    }
}

#[test]
fn merge_is_order_independent_over_all_triples() {
    let policies = network_universe(&reduced_rule_universe());
    let labels = all_sources();
    let permutations = [
        [0usize, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    for first in &policies {
        for second in &policies {
            for third in &policies {
                let documents = [
                    doc_with_network(first),
                    doc_with_network(second),
                    doc_with_network(third),
                ];
                let mut merged: Option<SandboxPolicyDocument> = None;
                for order in &permutations {
                    let sources: Vec<(PolicySource, SandboxPolicyDocument)> = order
                        .iter()
                        .map(|index| (labels[*index], documents[*index].clone()))
                        .collect();
                    let candidate = merge_policies(&sources);
                    match &merged {
                        None => merged = Some(candidate),
                        Some(expected) => {
                            assert_eq!(*expected, candidate, "merge depended on source order");
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn merge_is_idempotent() {
    let policies = network_universe(&full_rule_universe());
    for policy in &policies {
        let once = merge_policies(&[(PolicySource::Repo, doc_with_network(policy))]);
        let twice = merge_policies(&[(PolicySource::Repo, once.clone())]);
        assert_eq!(once, twice, "merging an already-merged document changed it");

        let duplicated = merge_policies(&[
            (PolicySource::User, doc_with_network(policy)),
            (PolicySource::Repo, doc_with_network(policy)),
            (PolicySource::TeamAdmin, doc_with_network(policy)),
        ]);
        assert_eq!(
            once, duplicated,
            "merging the same document three times changed it"
        );
    }
}

#[test]
fn merge_decisions_match_the_conjunction_of_sources_without_nested_blocks() {
    // Over a universe with no nested CIDRs, rule-set intersection and
    // address-set intersection coincide, so the merge is exact, not merely
    // conservative. This pins the stronger property where it holds.
    let policies = network_universe(&reduced_rule_universe());
    let probes = probe_addresses();
    for left in &policies {
        for right in &policies {
            let merged = merge_policies(&[
                (PolicySource::User, doc_with_network(left)),
                (PolicySource::Repo, doc_with_network(right)),
            ]);
            let network = merged.network.expect("both sources are opinionated");
            for probe in &probes {
                let expected = if left.decide(*probe) == NetworkAction::Allow
                    && right.decide(*probe) == NetworkAction::Allow
                {
                    NetworkAction::Allow
                } else {
                    NetworkAction::Deny
                };
                assert_eq!(
                    network.decide(*probe),
                    expected,
                    "merged {network:?} disagreed with the conjunction of {left:?} and {right:?} at {probe}"
                );
            }
        }
    }
}

#[test]
fn empty_source_list_yields_an_empty_document() {
    let merged = merge_policies(&[]);
    assert_eq!(merged, SandboxPolicyDocument::default());
    assert!(merged.is_empty());
}

#[test]
fn sources_without_an_opinion_do_not_constrain_the_merge() {
    let opinionated = doc_with_network(&NetworkPolicy::loopback_only());
    let silent = SandboxPolicyDocument::default();
    let merged = merge_policies(&[
        (PolicySource::User, silent.clone()),
        (PolicySource::Repo, opinionated.clone()),
        (PolicySource::TeamAdmin, silent),
    ]);
    assert_eq!(merged.network, opinionated.network);
    assert_eq!(merged.additional_read_paths, None);
    assert_eq!(merged.additional_write_paths, None);
}

#[test]
fn one_deny_default_collapses_the_merged_default() {
    let merged = merge_policies(&[
        (
            PolicySource::User,
            doc_with_network(&NetworkPolicy::allow_all()),
        ),
        (
            PolicySource::Repo,
            doc_with_network(&NetworkPolicy::allow_all()),
        ),
        (
            PolicySource::TeamAdmin,
            doc_with_network(&NetworkPolicy::loopback_only()),
        ),
    ]);
    let network = merged.network.expect("opinionated");
    assert_eq!(network.default, NetworkAction::Deny);
    assert_eq!(network.allow, vec![NetworkRule::Loopback]);
    assert_eq!(network.decide(addr("127.0.0.1")), NetworkAction::Allow);
    assert_eq!(network.decide(addr("8.8.8.8")), NetworkAction::Deny);
}

#[test]
fn deny_lists_union_across_sources() {
    let user = NetworkPolicy {
        default: NetworkAction::Allow,
        allow: Vec::new(),
        deny: vec![cidr("169.254.0.0/16")],
    };
    let repo = NetworkPolicy {
        default: NetworkAction::Allow,
        allow: Vec::new(),
        deny: vec![cidr("192.168.0.0/16")],
    };
    let merged = merge_policies(&[
        (PolicySource::User, doc_with_network(&user)),
        (PolicySource::Repo, doc_with_network(&repo)),
    ]);
    let network = merged.network.expect("opinionated");
    assert_eq!(network.default, NetworkAction::Allow);
    assert_eq!(network.deny.len(), 2);
    assert_eq!(network.decide(addr("169.254.169.254")), NetworkAction::Deny);
    assert_eq!(network.decide(addr("192.168.1.1")), NetworkAction::Deny);
    assert_eq!(network.decide(addr("8.8.8.8")), NetworkAction::Allow);
}

#[test]
fn deny_wins_over_allow_within_one_policy() {
    let policy = NetworkPolicy {
        default: NetworkAction::Deny,
        allow: vec![cidr("10.0.0.0/8")],
        deny: vec![cidr("10.1.0.0/16")],
    };
    assert_eq!(policy.decide(addr("10.0.0.1")), NetworkAction::Allow);
    assert_eq!(policy.decide(addr("10.1.0.1")), NetworkAction::Deny);
}

// ─────────────────────────────────────────────────────────────
// Path merging
// ─────────────────────────────────────────────────────────────

fn doc_with_paths(read: Option<&[&str]>, write: Option<&[&str]>) -> SandboxPolicyDocument {
    SandboxPolicyDocument {
        additional_read_paths: read
            .map(|paths| paths.iter().map(PathBuf::from).collect::<Vec<PathBuf>>()),
        additional_write_paths: write
            .map(|paths| paths.iter().map(PathBuf::from).collect::<Vec<PathBuf>>()),
        ..SandboxPolicyDocument::default()
    }
}

#[test]
fn additional_paths_intersect_across_opinionated_sources() {
    let merged = merge_policies(&[
        (
            PolicySource::User,
            doc_with_paths(Some(&["/srv/a", "/srv/b"]), None),
        ),
        (
            PolicySource::Repo,
            doc_with_paths(Some(&["/srv/b", "/srv/c"]), None),
        ),
    ]);
    assert_eq!(
        merged.additional_read_paths,
        Some(vec![PathBuf::from("/srv/b")])
    );
    assert_eq!(merged.additional_write_paths, None);
}

#[test]
fn an_empty_path_list_collapses_the_intersection() {
    let merged = merge_policies(&[
        (
            PolicySource::User,
            doc_with_paths(None, Some(&["/srv/a", "/srv/b"])),
        ),
        (PolicySource::TeamAdmin, doc_with_paths(None, Some(&[]))),
    ]);
    assert_eq!(merged.additional_write_paths, Some(Vec::new()));
}

#[test]
fn trailing_separators_do_not_defeat_the_intersection() {
    let merged = merge_policies(&[
        (
            PolicySource::User,
            doc_with_paths(Some(&["/srv/data/"]), None),
        ),
        (
            PolicySource::Repo,
            doc_with_paths(Some(&["/srv/data"]), None),
        ),
    ]);
    assert_eq!(
        merged.additional_read_paths,
        Some(vec![PathBuf::from("/srv/data")])
    );
}

#[test]
fn merged_version_is_the_highest_present() {
    let document = SandboxPolicyDocument {
        version: POLICY_DOCUMENT_VERSION,
        ..SandboxPolicyDocument::default()
    };
    let merged = merge_policies(&[
        (PolicySource::User, document.clone()),
        (PolicySource::Repo, document),
    ]);
    assert_eq!(merged.version, POLICY_DOCUMENT_VERSION);
}

// ─────────────────────────────────────────────────────────────
// Rule parsing
// ─────────────────────────────────────────────────────────────

#[test]
fn loopback_rule_matches_both_families() {
    assert!(NetworkRule::Loopback.matches(addr("127.0.0.1")));
    assert!(NetworkRule::Loopback.matches(addr("127.10.0.1")));
    assert!(NetworkRule::Loopback.matches(addr("::1")));
    assert!(!NetworkRule::Loopback.matches(addr("10.0.0.1")));
}

#[test]
fn localhost_is_accepted_as_a_loopback_alias() {
    assert_eq!(
        NetworkRule::from_str("localhost").unwrap(),
        NetworkRule::Loopback
    );
    assert_eq!(
        NetworkRule::from_str("LoopBack").unwrap(),
        NetworkRule::Loopback
    );
}

#[test]
fn bare_addresses_become_single_host_blocks() {
    let rule = NetworkRule::from_str("169.254.169.254").expect("bare address parses");
    assert_eq!(rule.to_string(), "169.254.169.254/32");
    assert!(rule.matches(addr("169.254.169.254")));
    assert!(!rule.matches(addr("169.254.169.253")));
}

#[test]
fn cidr_host_bits_are_cleared_so_equal_blocks_compare_equal() {
    assert_eq!(cidr("192.168.1.5/24"), cidr("192.168.1.0/24"));
    assert_eq!(cidr("192.168.1.5/24").to_string(), "192.168.1.0/24");
}

#[test]
fn ipv4_mapped_ipv6_addresses_cannot_bypass_an_ipv4_rule() {
    let rule = cidr("10.0.0.0/8");
    assert!(rule.matches(addr("::ffff:10.0.0.1")));
}

#[test]
fn hostname_rules_are_rejected_with_an_explanation() {
    let error = NetworkRule::from_str("api.example.com").expect_err("hostnames are unenforceable");
    assert_eq!(error.rule, "api.example.com");
    assert!(
        error.reason.contains("unenforceable"),
        "unhelpful reason: {}",
        error.reason
    );
    assert!(
        error.reason.contains("CIDR"),
        "unhelpful reason: {}",
        error.reason
    );
}

// ─────────────────────────────────────────────────────────────
// Document parsing
// ─────────────────────────────────────────────────────────────

#[test]
fn parses_a_complete_document() {
    let document = parse_policy_toml(
        r#"
version = 1
additional_read_paths = ["/srv/shared"]
additional_write_paths = ["/srv/out"]

[network]
default = "deny"
allow = ["loopback", "10.0.0.0/8"]
deny = ["169.254.0.0/16"]
"#,
    )
    .expect("valid document");
    let network = document.network.as_ref().expect("network section");
    assert_eq!(network.default, NetworkAction::Deny);
    assert_eq!(
        network.allow,
        vec![NetworkRule::Loopback, cidr("10.0.0.0/8")]
    );
    assert_eq!(network.deny, vec![cidr("169.254.0.0/16")]);
    assert_eq!(
        document.additional_read_paths,
        Some(vec![PathBuf::from("/srv/shared")])
    );
    assert_eq!(
        document.additional_write_paths,
        Some(vec![PathBuf::from("/srv/out")])
    );
}

#[test]
fn an_absent_network_section_means_no_opinion() {
    let document = parse_policy_toml("version = 1\n").expect("valid document");
    assert!(document.network.is_none());
    assert!(document.is_empty());
}

#[test]
fn version_defaults_to_the_supported_version() {
    let document = parse_policy_toml("[network]\ndefault = \"allow\"\n").expect("valid document");
    assert_eq!(document.version, POLICY_DOCUMENT_VERSION);
}

#[test]
fn an_unsupported_version_is_rejected() {
    let error = parse_policy_toml("version = 99\n").expect_err("unsupported version");
    assert!(
        matches!(
            error,
            PolicyParseError::UnsupportedVersion { found: 99, .. }
        ),
        "unexpected error: {error}"
    );
}

#[test]
fn a_hostname_rule_fails_the_whole_document() {
    let error = parse_policy_toml(
        r#"
[network]
default = "deny"
allow = ["api.example.com"]
"#,
    )
    .expect_err("hostnames are unenforceable");
    let rendered = error.to_string();
    assert!(
        rendered.contains("unenforceable"),
        "unexpected error: {rendered}"
    );
}

#[test]
fn relative_path_grants_are_rejected() {
    let error = parse_policy_toml("additional_write_paths = [\"relative/path\"]\n")
        .expect_err("relative grants depend on the sandboxed process cwd");
    assert!(
        matches!(
            error,
            PolicyParseError::RelativePath {
                field: "additional_write_paths",
                ..
            }
        ),
        "unexpected error: {error}"
    );
}

#[test]
fn unknown_fields_are_rejected() {
    let error = parse_policy_toml("netwrok = true\n").expect_err("typo must not be ignored");
    assert!(
        matches!(error, PolicyParseError::Toml(_)),
        "unexpected error: {error}"
    );
}

#[test]
fn network_policy_accepts_the_legacy_boolean_encoding() {
    #[derive(serde::Deserialize)]
    struct Holder {
        network_access: NetworkPolicy,
    }

    let allowed: Holder = toml::from_str("network_access = true\n").expect("bool form");
    assert_eq!(allowed.network_access, NetworkPolicy::allow_all());

    let denied: Holder = toml::from_str("network_access = false\n").expect("bool form");
    assert_eq!(denied.network_access, NetworkPolicy::deny_all());

    let structured: Holder =
        toml::from_str("[network_access]\ndefault = \"deny\"\nallow = [\"loopback\"]\n")
            .expect("table form");
    assert_eq!(structured.network_access, NetworkPolicy::loopback_only());
}

#[test]
fn documents_round_trip_through_json() {
    // JSON rather than TOML: `toml::to_string` requires every non-table value
    // to be emitted before any table, and this struct declares `network`
    // (a table) ahead of the two path arrays. Documents are only ever parsed
    // from TOML in production, never written back to it.
    let original = parse_policy_toml(
        r#"
additional_read_paths = ["/srv/shared"]

[network]
default = "deny"
allow = ["loopback"]
deny = ["169.254.0.0/16"]
"#,
    )
    .expect("valid document");
    let rendered = serde_json::to_string(&original).expect("document serializes");
    assert!(
        rendered.contains("\"loopback\""),
        "rules serialize as strings: {rendered}"
    );
    let reparsed: SandboxPolicyDocument = serde_json::from_str(&rendered).expect("re-parses");
    assert_eq!(original, reparsed);
}

// ─────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────

#[test]
fn a_missing_policy_file_is_not_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = dir.path().join("absent.toml");
    assert!(
        load_policy_file(&missing)
            .expect("missing is fine")
            .is_none()
    );
}

#[test]
fn a_malformed_policy_file_is_an_error_rather_than_silence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(POLICY_FILE_NAME);
    std::fs::write(&path, "[network]\ndefault = \"maybe\"\n").expect("write");
    let error = load_policy_file(&path).expect_err("malformed policy must not be ignored");
    assert_eq!(error.path(), path.as_path());
}

#[test]
fn loads_user_and_repo_documents_and_merges_them() {
    let dir = tempfile::tempdir().expect("tempdir");
    let user_path = dir.path().join("user-policy.toml");
    std::fs::write(
        &user_path,
        "[network]\ndefault = \"allow\"\ndeny = [\"169.254.0.0/16\"]\n",
    )
    .expect("write user policy");

    let workspace = dir.path().join("workspace");
    let repo_path = repo_policy_path(&workspace);
    std::fs::create_dir_all(repo_path.parent().expect("parent")).expect("mkdir");
    std::fs::write(
        &repo_path,
        "[network]\ndefault = \"deny\"\nallow = [\"loopback\", \"10.0.0.0/8\"]\n",
    )
    .expect("write repo policy");

    let sources = load_policy_sources_at(Some(&user_path), Some(&repo_path), &NoTeamPolicy)
        .expect("both load");
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0].0, PolicySource::User);
    assert_eq!(sources[1].0, PolicySource::Repo);

    let network = merge_policies(&sources).network.expect("opinionated");
    assert_eq!(network.default, NetworkAction::Deny);
    assert_eq!(network.decide(addr("127.0.0.1")), NetworkAction::Allow);
    assert_eq!(network.decide(addr("10.0.0.1")), NetworkAction::Allow);
    assert_eq!(network.decide(addr("169.254.169.254")), NetworkAction::Deny);
    assert_eq!(network.decide(addr("8.8.8.8")), NetworkAction::Deny);
}

#[test]
fn the_default_team_provider_supplies_nothing() {
    assert!(NoTeamPolicy.team_policy().is_none());
    let sources = load_policy_sources_at(None, None, &NoTeamPolicy).expect("no files");
    assert!(sources.is_empty());
}

#[test]
fn a_team_document_participates_in_the_merge() {
    struct FixedTeamPolicy;
    impl TeamPolicyProvider for FixedTeamPolicy {
        fn team_policy(&self) -> Option<SandboxPolicyDocument> {
            Some(SandboxPolicyDocument {
                network: Some(NetworkPolicy::deny_all()),
                ..SandboxPolicyDocument::default()
            })
        }
    }

    let sources = load_policy_sources_at(None, None, &FixedTeamPolicy).expect("team only");
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].0, PolicySource::TeamAdmin);
    let network = merge_policies(&sources).network.expect("opinionated");
    assert_eq!(network.decide(addr("8.8.8.8")), NetworkAction::Deny);
    assert_eq!(network.decide(addr("127.0.0.1")), NetworkAction::Deny);
}

#[test]
fn repo_policy_path_is_under_the_workspace_dot_maestro_directory() {
    let path = repo_policy_path(std::path::Path::new("/workspace"));
    assert_eq!(
        path,
        PathBuf::from("/workspace/.maestro/sandbox-policy.toml")
    );
}
