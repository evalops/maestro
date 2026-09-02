//! Structured sandbox policy documents with monotonic multi-source merge.
//!
//! # Why this module exists
//!
//! [`crate::sandbox::SandboxPolicy::WorkspaceWrite`] currently carries a single
//! boolean, `network_access`. A boolean can only express "all outbound and
//! inbound traffic" or "none", so an operator who wants a sandboxed command to
//! reach `crates.io` but not the cloud instance-metadata endpoint
//! (`169.254.169.254`) has no way to say so. This module introduces the
//! document that can say so, and the merge rule that makes the answer safe when
//! more than one party has an opinion.
//!
//! # Model
//!
//! A [`SandboxPolicyDocument`] is a set of *optional* fields. `None` means "this
//! source has no opinion about this field"; it is not the same as an empty list.
//! Three principals may each supply a document ([`PolicySource`]):
//!
//! - [`PolicySource::User`] — `$MAESTRO_HOME/sandbox-policy.toml`
//!   (default `~/.maestro/sandbox-policy.toml`)
//! - [`PolicySource::Repo`] — `<workspace>/.maestro/sandbox-policy.toml`
//! - [`PolicySource::TeamAdmin`] — supplied by a [`TeamPolicyProvider`]
//!   implementation; the in-tree default is [`NoTeamPolicy`], which supplies
//!   nothing.
//!
//! [`merge_policies`] combines them. The merge is *monotonic toward
//! restriction*: no combination of documents can produce a merged document that
//! permits something a single contributing document forbids. Concretely, for
//! every destination address `ip`:
//!
//! ```text
//! merged.network.decide(ip) == Allow  =>  every opinionated source decides Allow
//! ```
//!
//! and equivalently, if any opinionated source decides `Deny`, so does the
//! merged document. The tests at the bottom of this file check that implication
//! exhaustively over a table of documents and addresses.
//!
//! The merge is deliberately *conservative* rather than exact. `allow` lists are
//! intersected as sets of rules, not as sets of addresses: merging
//! `allow = ["10.0.0.0/8"]` with `allow = ["10.0.0.0/16"]` yields an empty allow
//! list, not `10.0.0.0/16`. That is stricter than strictly necessary, which is
//! the safe direction, and it keeps the merge cheap and explainable.
//!
//! # Rule vocabulary
//!
//! [`NetworkRule`] is a CIDR block or the symbolic `loopback`. Host and domain
//! rules are rejected at parse time with an explicit error: a name-based rule
//! cannot be enforced by Seatbelt or Landlock, both of which see addresses, not
//! names. Enforcing one would require terminating egress at a proxy, which
//! Maestro does not run. Silently accepting a rule that is not enforced is the
//! failure mode this module exists to avoid.
//!
//! # Merge rationale
//!
//! The document shape and three-principal source list keep policy input explicit.
//! Deny lists are unioned and additional path grants and allow lists are
//! intersected so no merge can widen authority supplied by any principal (see
//! [`merge_policies`]).
//!
//! # Native enforcement
//!
//! [`crate::managed_setup::ManagedSetupClient::native_sandbox_policy`] maps the
//! merged document to the native sandbox's coarser controls. Partial network
//! grants become network-denied, write roots are intersected with the session
//! baseline, and read-path constraints become read-only rather than widening.

use std::collections::BTreeSet;
use std::fmt;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use ipnet::IpNet;
use serde::de::{Error as DeError, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The only document version this build understands.
pub const POLICY_DOCUMENT_VERSION: u32 = 1;

/// File name used for both the user-level and repository-level policy.
pub const POLICY_FILE_NAME: &str = "sandbox-policy.toml";

// ─────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────

/// A single enforceable network rule.
///
/// Only address-shaped rules exist. A hostname rule is rejected by
/// [`NetworkRule::from_str`] because neither Seatbelt nor Landlock can enforce
/// one without an egress proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NetworkRule {
    /// An IPv4 or IPv6 CIDR block, stored with host bits cleared.
    Cidr(IpNet),
    /// The loopback interface: `127.0.0.0/8` and `::1/128`.
    Loopback,
}

impl NetworkRule {
    /// Returns true when `addr` falls inside this rule.
    ///
    /// IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`) are folded to their IPv4
    /// form first, so an IPv4 CIDR rule cannot be sidestepped by dialing the
    /// mapped form.
    pub fn matches(&self, addr: IpAddr) -> bool {
        let addr = normalize_addr(addr);
        match self {
            Self::Cidr(net) => net.contains(&addr),
            Self::Loopback => addr.is_loopback(),
        }
    }
}

fn normalize_addr(addr: IpAddr) -> IpAddr {
    match addr {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        other => other,
    }
}

impl fmt::Display for NetworkRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cidr(net) => write!(f, "{net}"),
            Self::Loopback => f.write_str("loopback"),
        }
    }
}

/// Error returned when a rule string cannot be turned into a [`NetworkRule`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid network rule {rule:?}: {reason}")]
pub struct NetworkRuleParseError {
    /// The rejected input.
    pub rule: String,
    /// Why it was rejected.
    pub reason: String,
}

impl FromStr for NetworkRule {
    type Err = NetworkRuleParseError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let trimmed = text.trim();
        let lowered = trimmed.to_ascii_lowercase();
        if lowered == "loopback" || lowered == "localhost" {
            return Ok(Self::Loopback);
        }
        if let Ok(net) = IpNet::from_str(trimmed) {
            return Ok(Self::Cidr(net.trunc()));
        }
        if let Ok(addr) = IpAddr::from_str(trimmed) {
            let bits = if addr.is_ipv4() { 32 } else { 128 };
            let net = IpNet::new(addr, bits).map_err(|err| NetworkRuleParseError {
                rule: trimmed.to_string(),
                reason: err.to_string(),
            })?;
            return Ok(Self::Cidr(net));
        }
        Err(NetworkRuleParseError {
            rule: trimmed.to_string(),
            reason: "host and domain rules are unenforceable without an egress \
                     proxy, which Maestro does not run; use a CIDR block \
                     (for example \"10.0.0.0/8\"), a bare address, or \"loopback\""
                .to_string(),
        })
    }
}

impl Serialize for NetworkRule {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for NetworkRule {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::from_str(&text).map_err(D::Error::custom)
    }
}

// ─────────────────────────────────────────────────────────────
// Network policy
// ─────────────────────────────────────────────────────────────

/// What to do with a destination no explicit rule covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkAction {
    /// Permit the connection.
    Allow,
    /// Refuse the connection.
    Deny,
}

/// A network policy: a default plus explicit allow and deny rules.
///
/// Evaluation order is deny, then allow, then the default. A destination
/// matched by both an allow rule and a deny rule is denied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkPolicy {
    /// Decision for destinations no rule matches.
    pub default: NetworkAction,
    /// Destinations permitted even when `default` is [`NetworkAction::Deny`].
    pub allow: Vec<NetworkRule>,
    /// Destinations refused even when `default` is [`NetworkAction::Allow`].
    pub deny: Vec<NetworkRule>,
}

impl NetworkPolicy {
    /// Everything permitted. Equivalent to the legacy `network_access = true`.
    pub fn allow_all() -> Self {
        Self {
            default: NetworkAction::Allow,
            allow: Vec::new(),
            deny: Vec::new(),
        }
    }

    /// Everything refused. Equivalent to the legacy `network_access = false`.
    pub fn deny_all() -> Self {
        Self {
            default: NetworkAction::Deny,
            allow: Vec::new(),
            deny: Vec::new(),
        }
    }

    /// Loopback permitted, everything else refused.
    pub fn loopback_only() -> Self {
        Self {
            default: NetworkAction::Deny,
            allow: vec![NetworkRule::Loopback],
            deny: Vec::new(),
        }
    }

    /// True when this policy permits at least one destination.
    ///
    /// Used by callers that still need the old boolean question answered, for
    /// example to decide whether to advertise a network-capable tool at all.
    pub fn permits_anything(&self) -> bool {
        self.default == NetworkAction::Allow || !self.allow.is_empty()
    }

    /// True when this policy permits every destination with no exceptions.
    pub fn permits_everything(&self) -> bool {
        self.default == NetworkAction::Allow && self.deny.is_empty()
    }

    /// Decide whether `addr` may be contacted.
    pub fn decide(&self, addr: IpAddr) -> NetworkAction {
        if self.deny.iter().any(|rule| rule.matches(addr)) {
            return NetworkAction::Deny;
        }
        if self.allow.iter().any(|rule| rule.matches(addr)) {
            return NetworkAction::Allow;
        }
        self.default
    }
}

impl Default for NetworkPolicy {
    /// Refuse everything. The conservative choice: a caller that forgot to set
    /// a policy gets no network rather than all of it.
    fn default() -> Self {
        Self::deny_all()
    }
}

/// Serialized shape of a [`NetworkPolicy`] in its map form.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NetworkPolicyRepr {
    default: NetworkAction,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    allow: Vec<NetworkRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    deny: Vec<NetworkRule>,
}

impl Serialize for NetworkPolicy {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        NetworkPolicyRepr {
            default: self.default,
            allow: self.allow.clone(),
            deny: self.deny.clone(),
        }
        .serialize(serializer)
    }
}

struct NetworkPolicyVisitor;

impl<'de> Visitor<'de> for NetworkPolicyVisitor {
    type Value = NetworkPolicy;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a boolean or a network policy table")
    }

    /// Accepts the legacy `network_access = true|false` encoding so existing
    /// configs and persisted sessions keep deserializing.
    fn visit_bool<E: DeError>(self, value: bool) -> Result<Self::Value, E> {
        Ok(if value {
            NetworkPolicy::allow_all()
        } else {
            NetworkPolicy::deny_all()
        })
    }

    fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
        let repr =
            NetworkPolicyRepr::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
        Ok(NetworkPolicy {
            default: repr.default,
            allow: repr.allow,
            deny: repr.deny,
        })
    }
}

impl<'de> Deserialize<'de> for NetworkPolicy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NetworkPolicyVisitor)
    }
}

// ─────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────

fn default_version() -> u32 {
    POLICY_DOCUMENT_VERSION
}

/// One principal's sandbox policy. Every field is optional; `None` means "no
/// opinion", which is distinct from an empty list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxPolicyDocument {
    /// Document schema version. Only [`POLICY_DOCUMENT_VERSION`] is accepted.
    #[serde(default = "default_version")]
    pub version: u32,
    /// Network rules, or `None` for no opinion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<NetworkPolicy>,
    /// Absolute paths this principal is willing to expose for reading, or
    /// `None` for no opinion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_read_paths: Option<Vec<PathBuf>>,
    /// Absolute paths this principal is willing to expose for writing, or
    /// `None` for no opinion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_write_paths: Option<Vec<PathBuf>>,
}

impl Default for SandboxPolicyDocument {
    fn default() -> Self {
        Self {
            version: POLICY_DOCUMENT_VERSION,
            network: None,
            additional_read_paths: None,
            additional_write_paths: None,
        }
    }
}

impl SandboxPolicyDocument {
    /// True when this document expresses no opinion at all.
    pub fn is_empty(&self) -> bool {
        self.network.is_none()
            && self.additional_read_paths.is_none()
            && self.additional_write_paths.is_none()
    }
}

/// Which principal supplied a document.
///
/// The ordering is the escalation order used for reporting, not a precedence
/// order: [`merge_policies`] gives no source authority over another, because a
/// merge that let one source relax another would not be monotonic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PolicySource {
    /// The invoking user's own configuration.
    User,
    /// The checked-out repository.
    Repo,
    /// An organization administrator.
    TeamAdmin,
}

impl fmt::Display for PolicySource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::User => "user",
            Self::Repo => "repo",
            Self::TeamAdmin => "team-admin",
        })
    }
}

// ─────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────

/// Merge policy documents from any number of principals into one.
///
/// # Rules
///
/// - `version`: the highest version present, or [`POLICY_DOCUMENT_VERSION`]
///   when there are no sources.
/// - `network`: `None` when no source has an opinion. Otherwise
///   - `default` is [`NetworkAction::Deny`] if any opinionated source says
///     `Deny`, else `Allow`;
///   - `deny` is the union of every source's deny rules;
///   - `allow` is the intersection of the allow lists of the sources whose own
///     `default` is `Deny`. A source whose `default` is `Allow` places no
///     restriction on the allow list, because such a source already permits
///     everything its deny list does not cover. When no source denies by
///     default, the allow list is inert (the default already permits) and the
///     union is kept for readability.
/// - `additional_read_paths` / `additional_write_paths`: `None` when no source
///   has an opinion; otherwise the set intersection of the opinionated sources'
///   lists. One source offering an empty list therefore collapses the merged
///   list to empty.
///
/// # Invariants
///
/// The result is order-independent and idempotent, and it never permits a
/// destination that a contributing source refuses. See the tests in this file.
pub fn merge_policies(sources: &[(PolicySource, SandboxPolicyDocument)]) -> SandboxPolicyDocument {
    let version = sources
        .iter()
        .map(|(_, doc)| doc.version)
        .max()
        .unwrap_or(POLICY_DOCUMENT_VERSION);

    let networks: Vec<&NetworkPolicy> = sources
        .iter()
        .filter_map(|(_, doc)| doc.network.as_ref())
        .collect();

    let read_lists: Vec<&Vec<PathBuf>> = sources
        .iter()
        .filter_map(|(_, doc)| doc.additional_read_paths.as_ref())
        .collect();
    let write_lists: Vec<&Vec<PathBuf>> = sources
        .iter()
        .filter_map(|(_, doc)| doc.additional_write_paths.as_ref())
        .collect();

    SandboxPolicyDocument {
        version,
        network: merge_network(&networks),
        additional_read_paths: intersect_paths(&read_lists),
        additional_write_paths: intersect_paths(&write_lists),
    }
}

fn merge_network(sources: &[&NetworkPolicy]) -> Option<NetworkPolicy> {
    if sources.is_empty() {
        return None;
    }

    let default = if sources
        .iter()
        .any(|policy| policy.default == NetworkAction::Deny)
    {
        NetworkAction::Deny
    } else {
        NetworkAction::Allow
    };

    let deny: BTreeSet<NetworkRule> = sources
        .iter()
        .flat_map(|policy| policy.deny.iter().copied())
        .collect();

    let allow: BTreeSet<NetworkRule> = if default == NetworkAction::Deny {
        let mut restricting = sources
            .iter()
            .filter(|policy| policy.default == NetworkAction::Deny);
        // `default == Deny` means at least one source denies by default.
        let mut merged: BTreeSet<NetworkRule> = restricting
            .next()
            .map(|policy| policy.allow.iter().copied().collect())
            .unwrap_or_default();
        for policy in restricting {
            let other: BTreeSet<NetworkRule> = policy.allow.iter().copied().collect();
            merged = merged.intersection(&other).copied().collect();
        }
        merged
    } else {
        sources
            .iter()
            .flat_map(|policy| policy.allow.iter().copied())
            .collect()
    };

    Some(NetworkPolicy {
        default,
        allow: allow.into_iter().collect(),
        deny: deny.into_iter().collect(),
    })
}

fn intersect_paths(sources: &[&Vec<PathBuf>]) -> Option<Vec<PathBuf>> {
    let (first, rest) = sources.split_first()?;
    let mut merged: BTreeSet<PathBuf> = first.iter().map(|path| normalize_path(path)).collect();
    for list in rest {
        let other: BTreeSet<PathBuf> = list.iter().map(|path| normalize_path(path)).collect();
        merged = merged.intersection(&other).cloned().collect();
    }
    Some(merged.into_iter().collect())
}

/// Strip trailing separators so `/srv/data` and `/srv/data/` intersect.
fn normalize_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let trimmed = text.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.to_path_buf()
    } else {
        PathBuf::from(trimmed)
    }
}

// ─────────────────────────────────────────────────────────────
// Team policy provider
// ─────────────────────────────────────────────────────────────

/// Supplies the [`PolicySource::TeamAdmin`] document.
///
/// Maestro ships [`NoTeamPolicy`]. A hosted deployment substitutes an
/// implementation that reads the organization's policy from its own control
/// plane. The trait is `Send + Sync` because the sandbox is resolved from tool
/// execution tasks on the tokio runtime.
pub trait TeamPolicyProvider: Send + Sync {
    /// Return the administrator's document, or `None` for no opinion.
    fn team_policy(&self) -> Option<SandboxPolicyDocument>;
}

/// The in-tree [`TeamPolicyProvider`]: no administrator opinion.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoTeamPolicy;

impl TeamPolicyProvider for NoTeamPolicy {
    fn team_policy(&self) -> Option<SandboxPolicyDocument> {
        None
    }
}

// ─────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────

/// Why a policy document could not be parsed.
#[derive(Debug, thiserror::Error)]
pub enum PolicyParseError {
    /// The text is not valid TOML, or a field has the wrong type or an
    /// unenforceable rule.
    #[error("sandbox policy is not valid: {0}")]
    Toml(#[from] toml::de::Error),

    /// `version` names a schema this build does not implement.
    #[error(
        "unsupported sandbox policy version {found}; this build implements version {supported}"
    )]
    UnsupportedVersion {
        /// The version found in the document.
        found: u32,
        /// The version this build implements.
        supported: u32,
    },

    /// A path grant was relative. Relative grants depend on the process working
    /// directory, which the sandboxed command controls.
    #[error("{field} entry {path} must be an absolute path")]
    RelativePath {
        /// Which list the path came from.
        field: &'static str,
        /// The offending path.
        path: String,
    },
}

/// Parse a policy document from TOML.
///
/// # Example
///
/// ```
/// use maestro_tui::sandbox_policy::{parse_policy_toml, NetworkAction};
///
/// let doc = parse_policy_toml(
///     r#"
///     version = 1
///     [network]
///     default = "deny"
///     allow = ["loopback", "10.0.0.0/8"]
///     deny = ["169.254.0.0/16"]
///     "#,
/// )
/// .expect("valid policy");
/// let network = doc.network.expect("network section");
/// assert_eq!(network.default, NetworkAction::Deny);
/// assert_eq!(network.allow.len(), 2);
/// ```
pub fn parse_policy_toml(text: &str) -> Result<SandboxPolicyDocument, PolicyParseError> {
    let document: SandboxPolicyDocument = toml::from_str(text)?;
    if document.version != POLICY_DOCUMENT_VERSION {
        return Err(PolicyParseError::UnsupportedVersion {
            found: document.version,
            supported: POLICY_DOCUMENT_VERSION,
        });
    }
    check_absolute(
        "additional_read_paths",
        document.additional_read_paths.as_ref(),
    )?;
    check_absolute(
        "additional_write_paths",
        document.additional_write_paths.as_ref(),
    )?;
    Ok(document)
}

fn check_absolute(
    field: &'static str,
    paths: Option<&Vec<PathBuf>>,
) -> Result<(), PolicyParseError> {
    for path in paths.into_iter().flatten() {
        if !path.is_absolute() {
            return Err(PolicyParseError::RelativePath {
                field,
                path: path.display().to_string(),
            });
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────

/// Why a policy file could not be loaded.
#[derive(Debug, thiserror::Error)]
pub enum PolicyLoadError {
    /// The file exists but could not be read.
    #[error("failed to read sandbox policy {path}: {source}")]
    Read {
        /// The file that could not be read.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },

    /// The file was read but its contents are not a valid policy.
    #[error("failed to parse sandbox policy {path}: {source}")]
    Parse {
        /// The offending file.
        path: PathBuf,
        /// The parse failure.
        source: PolicyParseError,
    },
}

impl PolicyLoadError {
    /// The file that caused the failure.
    pub fn path(&self) -> &Path {
        match self {
            Self::Read { path, .. } | Self::Parse { path, .. } => path,
        }
    }
}

/// Path of the user-level policy, or `None` when no home directory resolves.
pub fn user_policy_path() -> Option<PathBuf> {
    crate::path_utils::maestro_home_dir().map(|home| home.join(POLICY_FILE_NAME))
}

/// Path of the repository-level policy for `workspace_root`.
pub fn repo_policy_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".maestro").join(POLICY_FILE_NAME)
}

/// Read and parse one policy file.
///
/// A missing file is `Ok(None)`: not having a policy is not an error. An
/// unreadable or malformed file is an error, because treating a typo as "no
/// policy" would silently widen the sandbox.
pub fn load_policy_file(path: &Path) -> Result<Option<SandboxPolicyDocument>, PolicyLoadError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(PolicyLoadError::Read {
                path: path.to_path_buf(),
                source: err,
            });
        }
    };
    parse_policy_toml(&text)
        .map(Some)
        .map_err(|source| PolicyLoadError::Parse {
            path: path.to_path_buf(),
            source,
        })
}

/// Collect the documents that exist, from explicit paths.
///
/// Sources are returned in [`PolicySource`] order. `merge_policies` is
/// order-independent, so the order is for reporting only.
pub fn load_policy_sources_at(
    user_policy: Option<&Path>,
    repo_policy: Option<&Path>,
    team: &dyn TeamPolicyProvider,
) -> Result<Vec<(PolicySource, SandboxPolicyDocument)>, PolicyLoadError> {
    let mut sources = Vec::new();
    if let Some(path) = user_policy {
        if let Some(document) = load_policy_file(path)? {
            sources.push((PolicySource::User, document));
        }
    }
    if let Some(path) = repo_policy {
        if let Some(document) = load_policy_file(path)? {
            sources.push((PolicySource::Repo, document));
        }
    }
    if let Some(document) = team.team_policy() {
        sources.push((PolicySource::TeamAdmin, document));
    }
    Ok(sources)
}

/// Collect the documents that exist for `workspace_root` from the standard
/// locations plus `team`.
pub fn load_policy_sources(
    workspace_root: &Path,
    team: &dyn TeamPolicyProvider,
) -> Result<Vec<(PolicySource, SandboxPolicyDocument)>, PolicyLoadError> {
    let user = user_policy_path();
    let repo = repo_policy_path(workspace_root);
    load_policy_sources_at(user.as_deref(), Some(repo.as_path()), team)
}

/// Load every source for `workspace_root` and merge them.
pub fn resolve_effective_policy(
    workspace_root: &Path,
    team: &dyn TeamPolicyProvider,
) -> Result<SandboxPolicyDocument, PolicyLoadError> {
    let sources = load_policy_sources(workspace_root, team)?;
    Ok(merge_policies(&sources))
}

#[cfg(test)]
mod tests;
