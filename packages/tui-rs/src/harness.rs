//! Durable supplemental context for continual agent refinement.
//!
//! The harness stores small, user-visible records that can be carried into
//! later sessions. Records are versioned, scoped, and persisted atomically so
//! a refinement can be inspected or rolled back without changing Maestro's
//! base system prompt.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

const CURRENT_VERSION: u32 = 2;
const MAX_ENTRIES: usize = 128;
const MAX_PROPOSALS: usize = 64;
const MAX_HISTORY: usize = 128;
const MAX_SNAPSHOTS: usize = 64;
const MAX_NAME_CHARS: usize = 128;
const MAX_CONTENT_CHARS: usize = 16_000;
const MAX_EVIDENCE_CHARS: usize = 2_000;
const MAX_PROMPT_CHARS: usize = 24_000;

/// The kind of supplemental record carried by the harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessKind {
    Prompt,
    Memory,
    Skill,
    Subagent,
}

impl HarnessKind {
    pub fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "prompt" | "prompts" => Ok(Self::Prompt),
            "memory" | "mem" => Ok(Self::Memory),
            "skill" | "skills" => Ok(Self::Skill),
            "subagent" | "subagents" | "agent" => Ok(Self::Subagent),
            other => {
                bail!("unknown harness kind '{other}'; use prompt, memory, skill, or subagent")
            }
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Memory => "memory",
            Self::Skill => "skill",
            Self::Subagent => "subagent",
        }
    }
}

/// Persistence scope for a harness entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessScope {
    /// Available in every workspace for this user.
    User,
    /// Available when Maestro is opened in one workspace.
    Workspace,
    /// Available only to one persisted session identifier.
    Session,
}

impl HarnessScope {
    pub fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "user" | "global" => Ok(Self::User),
            "workspace" | "project" | "local" => Ok(Self::Workspace),
            "session" => Ok(Self::Session),
            other => bail!("unknown harness scope '{other}'; use user, workspace, or session"),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Workspace => "workspace",
            Self::Session => "session",
        }
    }
}

/// One supplemental record shown to the model when its scope matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessEntry {
    pub id: String,
    pub kind: HarnessKind,
    pub scope: HarnessScope,
    #[serde(default)]
    pub scope_key: Option<String>,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub evidence: Option<String>,
    pub created_at_unix: u64,
    pub updated_at_unix: u64,
}

/// Review state for an evidence-backed refinement proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessProposalStatus {
    Pending,
    Applied,
    Rejected,
}

/// A proposed harness change that is held until an operator applies it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessProposal {
    pub id: String,
    pub kind: HarnessKind,
    pub scope: HarnessScope,
    #[serde(default)]
    pub scope_key: Option<String>,
    pub name: String,
    pub content: String,
    pub evidence: String,
    pub status: HarnessProposalStatus,
    #[serde(default)]
    pub applied_entry_id: Option<String>,
    #[serde(default)]
    pub review_note: Option<String>,
    pub created_at_unix: u64,
    pub updated_at_unix: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HarnessMutation {
    Create,
    Update,
    Delete,
    Rollback,
    ProposalCreate,
    ProposalApply,
    ProposalReject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessEvent {
    revision: u64,
    mutation: HarnessMutation,
    #[serde(default)]
    entry_id: Option<String>,
    #[serde(default)]
    before: Option<HarnessEntry>,
    #[serde(default)]
    after: Option<HarnessEntry>,
    #[serde(default)]
    note: Option<String>,
    created_at_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessSnapshot {
    revision: u64,
    created_at_unix: u64,
    entries: Vec<HarnessEntry>,
    #[serde(default)]
    proposals: Vec<HarnessProposal>,
}

/// Durable state for the continual harness.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStore {
    pub version: u32,
    pub revision: u64,
    pub entries: Vec<HarnessEntry>,
    #[serde(default)]
    pub proposals: Vec<HarnessProposal>,
    #[serde(default)]
    history: Vec<HarnessEvent>,
    #[serde(default)]
    snapshots: Vec<HarnessSnapshot>,
    #[serde(skip)]
    path: Option<PathBuf>,
}

impl Default for HarnessStore {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            revision: 0,
            entries: Vec::new(),
            proposals: Vec::new(),
            history: Vec::new(),
            snapshots: vec![HarnessSnapshot {
                revision: 0,
                created_at_unix: now_unix(),
                entries: Vec::new(),
                proposals: Vec::new(),
            }],
            path: None,
        }
    }
}

impl HarnessStore {
    /// Load the user harness from `MAESTRO_HARNESS_FILE` or `~/.maestro`.
    pub fn load_default() -> Result<Self> {
        Self::load_from_path(default_path())
    }

    /// Load a harness file, returning an empty store when it does not exist.
    pub fn load_from_path(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Ok(Self::with_path(path));
        }

        let raw = fs::read_to_string(&path)
            .with_context(|| format!("read harness file {}", path.display()))?;
        let mut store: Self = serde_json::from_str(&raw)
            .with_context(|| format!("parse harness file {}", path.display()))?;
        store.path = Some(path);
        store.normalize_loaded_state()?;
        Ok(store)
    }

    /// Create an in-memory store or a store backed by `path`.
    #[must_use]
    pub fn with_path(path: impl AsRef<Path>) -> Self {
        let mut store = Self {
            path: Some(path.as_ref().to_path_buf()),
            ..Self::default()
        };
        store.ensure_snapshot();
        store
    }

    /// Return the backing file when this store is persistent.
    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Build the storage key for a record created in the supplied scope.
    pub fn scope_key(
        scope: HarnessScope,
        workspace: &Path,
        session_id: Option<&str>,
    ) -> Result<Option<String>> {
        match scope {
            HarnessScope::User => Ok(None),
            HarnessScope::Workspace => Ok(Some(normalize_workspace(workspace))),
            HarnessScope::Session => session_id
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .map(Some)
                .context("session-scoped harness entries require an active session"),
        }
    }

    /// Add a record and persist the resulting revision.
    pub fn add(
        &mut self,
        kind: HarnessKind,
        scope: HarnessScope,
        scope_key: Option<String>,
        name: impl Into<String>,
        content: impl Into<String>,
        evidence: Option<String>,
    ) -> Result<String> {
        let name = validate_name(name.into())?;
        let content = validate_content(content.into())?;
        let evidence = validate_evidence(evidence)?;
        validate_scope_key(scope, scope_key.as_deref())?;
        if self.entries.len() >= MAX_ENTRIES {
            bail!("harness entry limit reached ({MAX_ENTRIES})")
        }
        if self.entries.iter().any(|entry| {
            entry.kind == kind
                && entry.scope == scope
                && entry.scope_key == scope_key
                && entry.name == name
        }) {
            bail!(
                "a {} harness entry named '{}' already exists in {} scope",
                kind.as_str(),
                name,
                scope.as_str()
            )
        }

        let previous = self.clone();
        let now = now_unix();
        let id = new_id();
        let entry = HarnessEntry {
            id: id.clone(),
            kind,
            scope,
            scope_key,
            name,
            content,
            evidence: evidence.clone(),
            created_at_unix: now,
            updated_at_unix: now,
        };
        self.entries.push(entry.clone());
        self.commit(
            HarnessMutation::Create,
            Some(id.clone()),
            None,
            Some(entry),
            evidence,
        );
        self.persist_or_rollback(previous)?;
        Ok(id)
    }

    /// Update the content and optional evidence for a record.
    pub fn update(
        &mut self,
        id: &str,
        content: impl Into<String>,
        evidence: Option<String>,
    ) -> Result<()> {
        let content = validate_content(content.into())?;
        let evidence = validate_evidence(evidence)?;
        let index = self
            .entries
            .iter()
            .position(|entry| entry.id == id)
            .with_context(|| format!("unknown harness entry '{id}'"))?;
        let previous = self.clone();
        let before = self.entries[index].clone();
        let after = {
            let entry = &mut self.entries[index];
            entry.content = content;
            entry.evidence = evidence.clone();
            entry.updated_at_unix = now_unix();
            entry.clone()
        };
        self.commit(
            HarnessMutation::Update,
            Some(id.to_owned()),
            Some(before),
            Some(after),
            evidence,
        );
        self.persist_or_rollback(previous)
    }

    /// Hold a refinement until an operator reviews and applies it.
    ///
    /// Proposals must include evidence so a durable prompt change has a
    /// traceable reason. Applying a proposal creates or updates the matching
    /// harness entry and records the proposal outcome in the same snapshot.
    pub fn propose(
        &mut self,
        kind: HarnessKind,
        scope: HarnessScope,
        scope_key: Option<String>,
        name: impl Into<String>,
        content: impl Into<String>,
        evidence: impl Into<String>,
    ) -> Result<String> {
        let name = validate_name(name.into())?;
        let content = validate_content(content.into())?;
        let evidence = validate_evidence(Some(evidence.into()))?
            .context("refinement proposals require evidence")?;
        validate_scope_key(scope, scope_key.as_deref())?;
        if self.proposals.iter().any(|proposal| {
            proposal.status == HarnessProposalStatus::Pending
                && proposal.kind == kind
                && proposal.scope == scope
                && proposal.scope_key == scope_key
                && proposal.name == name
        }) {
            bail!(
                "a pending {} proposal named '{}' already exists in {} scope",
                kind.as_str(),
                name,
                scope.as_str()
            )
        }

        let previous = self.clone();
        if self.proposals.len() >= MAX_PROPOSALS {
            self.proposals
                .retain(|proposal| proposal.status == HarnessProposalStatus::Pending);
            if self.proposals.len() >= MAX_PROPOSALS {
                bail!("harness proposal limit reached ({MAX_PROPOSALS})")
            }
        }
        let now = now_unix();
        let id = new_proposal_id();
        self.proposals.push(HarnessProposal {
            id: id.clone(),
            kind,
            scope,
            scope_key,
            name,
            content,
            evidence: evidence.clone(),
            status: HarnessProposalStatus::Pending,
            applied_entry_id: None,
            review_note: None,
            created_at_unix: now,
            updated_at_unix: now,
        });
        self.commit(
            HarnessMutation::ProposalCreate,
            Some(id.clone()),
            None,
            None,
            Some(evidence),
        );
        self.persist_or_rollback(previous)?;
        Ok(id)
    }

    /// Apply a pending proposal, updating an existing same-key entry when one exists.
    pub fn apply_proposal(&mut self, id: &str) -> Result<String> {
        let proposal_index = self
            .proposals
            .iter()
            .position(|proposal| proposal.id == id)
            .with_context(|| format!("unknown harness proposal '{id}'"))?;
        if self.proposals[proposal_index].status != HarnessProposalStatus::Pending {
            bail!("harness proposal '{id}' is already reviewed")
        }

        let previous = self.clone();
        let proposal = self.proposals[proposal_index].clone();
        let now = now_unix();
        let entry_id = if let Some(entry_index) = self.entries.iter().position(|entry| {
            entry.kind == proposal.kind
                && entry.scope == proposal.scope
                && entry.scope_key == proposal.scope_key
                && entry.name == proposal.name
        }) {
            let entry = &mut self.entries[entry_index];
            let before = entry.clone();
            entry.content = proposal.content.clone();
            entry.evidence = Some(proposal.evidence.clone());
            entry.updated_at_unix = now;
            let entry_id = entry.id.clone();
            let after = entry.clone();
            self.proposals[proposal_index].status = HarnessProposalStatus::Applied;
            self.proposals[proposal_index].applied_entry_id = Some(entry_id.clone());
            self.proposals[proposal_index].updated_at_unix = now;
            self.commit(
                HarnessMutation::ProposalApply,
                Some(entry_id.clone()),
                Some(before),
                Some(after),
                Some(format!("applied proposal {id}")),
            );
            entry_id
        } else {
            if self.entries.len() >= MAX_ENTRIES {
                bail!("harness entry limit reached ({MAX_ENTRIES})")
            }
            let entry_id = new_id();
            let entry = HarnessEntry {
                id: entry_id.clone(),
                kind: proposal.kind,
                scope: proposal.scope,
                scope_key: proposal.scope_key.clone(),
                name: proposal.name.clone(),
                content: proposal.content.clone(),
                evidence: Some(proposal.evidence.clone()),
                created_at_unix: now,
                updated_at_unix: now,
            };
            self.entries.push(entry.clone());
            self.proposals[proposal_index].status = HarnessProposalStatus::Applied;
            self.proposals[proposal_index].applied_entry_id = Some(entry_id.clone());
            self.proposals[proposal_index].updated_at_unix = now;
            self.commit(
                HarnessMutation::ProposalApply,
                Some(entry_id.clone()),
                None,
                Some(entry),
                Some(format!("applied proposal {id}")),
            );
            entry_id
        };
        self.persist_or_rollback(previous)?;
        Ok(entry_id)
    }

    /// Reject a pending proposal without changing active harness entries.
    pub fn reject_proposal(&mut self, id: &str, note: Option<String>) -> Result<()> {
        let proposal_index = self
            .proposals
            .iter()
            .position(|proposal| proposal.id == id)
            .with_context(|| format!("unknown harness proposal '{id}'"))?;
        if self.proposals[proposal_index].status != HarnessProposalStatus::Pending {
            bail!("harness proposal '{id}' is already reviewed")
        }
        let note = note
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if note
            .as_ref()
            .is_some_and(|value| value.chars().count() > MAX_EVIDENCE_CHARS)
        {
            bail!("proposal review note is too long (max {MAX_EVIDENCE_CHARS} characters)")
        }
        let previous = self.clone();
        self.proposals[proposal_index].status = HarnessProposalStatus::Rejected;
        self.proposals[proposal_index].review_note = note.clone();
        self.proposals[proposal_index].updated_at_unix = now_unix();
        self.commit(
            HarnessMutation::ProposalReject,
            Some(id.to_owned()),
            None,
            None,
            note,
        );
        self.persist_or_rollback(previous)
    }

    /// Delete a record and persist the resulting revision.
    pub fn delete(&mut self, id: &str) -> Result<()> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.id == id)
            .with_context(|| format!("unknown harness entry '{id}'"))?;
        let previous = self.clone();
        let before = self.entries.remove(index);
        self.commit(
            HarnessMutation::Delete,
            Some(id.to_owned()),
            Some(before),
            None,
            None,
        );
        self.persist_or_rollback(previous)
    }

    /// Restore the entries captured at a prior revision.
    pub fn rollback(&mut self, revision: u64) -> Result<()> {
        let snapshot = self
            .snapshots
            .iter()
            .find(|snapshot| snapshot.revision == revision)
            .cloned()
            .with_context(|| format!("no harness snapshot is available for revision {revision}"))?;
        let previous = self.clone();
        self.entries = snapshot.entries;
        let mut restored_proposals = snapshot.proposals;
        for proposal in self
            .proposals
            .iter()
            .filter(|proposal| proposal.status == HarnessProposalStatus::Pending)
        {
            if !restored_proposals
                .iter()
                .any(|restored| restored.id == proposal.id)
            {
                restored_proposals.push(proposal.clone());
            }
        }
        if restored_proposals.len() > MAX_PROPOSALS {
            let mut bounded = Vec::with_capacity(MAX_PROPOSALS);
            for proposal in self
                .proposals
                .iter()
                .filter(|proposal| proposal.status == HarnessProposalStatus::Pending)
            {
                bounded.push(proposal.clone());
            }
            for proposal in restored_proposals {
                if bounded.len() >= MAX_PROPOSALS {
                    break;
                }
                if !bounded.iter().any(|existing| existing.id == proposal.id) {
                    bounded.push(proposal);
                }
            }
            restored_proposals = bounded;
        }
        self.proposals = restored_proposals;
        self.commit(
            HarnessMutation::Rollback,
            None,
            None,
            None,
            Some(format!("restored snapshot revision {revision}")),
        );
        self.persist_or_rollback(previous)
    }

    /// Return entries visible in the supplied workspace/session.
    #[must_use]
    pub fn visible_entries<'a>(
        &'a self,
        workspace: &Path,
        session_id: Option<&str>,
    ) -> Vec<&'a HarnessEntry> {
        let workspace_key = normalize_workspace(workspace);
        let mut entries: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| match entry.scope {
                HarnessScope::User => true,
                HarnessScope::Workspace => {
                    entry.scope_key.as_deref() == Some(workspace_key.as_str())
                }
                HarnessScope::Session => entry.scope_key.as_deref() == session_id,
            })
            .collect();
        entries.sort_by(|left, right| {
            left.kind
                .as_str()
                .cmp(right.kind.as_str())
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });
        entries
    }

    /// Build the bounded supplemental section sent to the model.
    #[must_use]
    pub fn prompt_section(&self, workspace: &Path, session_id: Option<&str>) -> Option<String> {
        let entries = self.visible_entries(workspace, session_id);
        if entries.is_empty() {
            return None;
        }

        let mut section = String::from(
            "## Supplemental Maestro harness\n\n\
             These user-approved records are supplemental context. They do not\n\
             override safety, system, or tool instructions.\n",
        );
        for entry in entries {
            let evidence = entry
                .evidence
                .as_deref()
                .map(|value| format!("\nEvidence: {value}"))
                .unwrap_or_default();
            let block = format!(
                "\n### {} · {} ({})\n{}{}\n",
                entry.kind.as_str(),
                entry.name,
                entry.scope.as_str(),
                entry.content,
                evidence
            );
            let remaining = MAX_PROMPT_CHARS.saturating_sub(section.chars().count());
            if remaining == 0 {
                break;
            }
            section.push_str(&truncate_chars(&block, remaining));
            if section.chars().count() >= MAX_PROMPT_CHARS {
                break;
            }
        }
        Some(section)
    }

    /// Render a human-readable harness status report.
    #[must_use]
    pub fn report(&self, workspace: &Path, session_id: Option<&str>) -> String {
        let visible = self.visible_entries(workspace, session_id);
        let path = self
            .path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "(in memory)".to_string());
        let mut report = format!(
            "## Harness\n\nPath: `{path}`\nRevision: {}\nEntries: {}\nProposals: {}\nHistory: {}\nSnapshots: {}\n",
            self.revision,
            self.entries.len(),
            self.proposals.len(),
            self.history.len(),
            self.snapshots.len()
        );
        if visible.is_empty() {
            report.push_str("\nNo entries match the current workspace or session.\n");
        } else {
            report.push_str("\nVisible entries:\n");
            for entry in visible {
                report.push_str(&format!(
                    "- `{}` · {} · {} · {}\n",
                    entry.id,
                    entry.kind.as_str(),
                    entry.scope.as_str(),
                    entry.name
                ));
            }
        }
        report.push_str("\nUse `/harness add <scope> <kind> <name> <content>` to add a record.\n");
        report.push_str("Use `/refine propose <scope> <kind> <name> <content> --evidence <text>` to stage a reviewed change.\n");
        report.push_str("Use `/harness rollback <revision>` to restore a saved snapshot.\n");
        report
    }

    /// Render only the entries visible to the current workspace/session.
    #[must_use]
    pub fn list_report(&self, workspace: &Path, session_id: Option<&str>) -> String {
        let entries = self.visible_entries(workspace, session_id);
        if entries.is_empty() {
            return "No harness entries match the current workspace or session.".to_string();
        }
        let mut report = String::from("## Harness entries\n\n");
        for entry in entries {
            let evidence = entry
                .evidence
                .as_deref()
                .map(|value| format!("\n  Evidence: {value}"))
                .unwrap_or_default();
            report.push_str(&format!(
                "- `{}` · {} · {} · {}\n  {}{}\n",
                entry.id,
                entry.kind.as_str(),
                entry.scope.as_str(),
                entry.name,
                entry.content,
                evidence
            ));
        }
        report
    }

    /// Render proposals for operator review.
    #[must_use]
    pub fn proposal_report(&self) -> String {
        if self.proposals.is_empty() {
            return "No harness refinement proposals.".to_string();
        }
        let mut report = String::from("## Harness refinement proposals\n\n");
        for proposal in self.proposals.iter().rev() {
            report.push_str(&format!(
                "- `{}` · {} · {} · {} · {}\n  {}\n  Evidence: {}\n",
                proposal.id,
                match proposal.status {
                    HarnessProposalStatus::Pending => "pending",
                    HarnessProposalStatus::Applied => "applied",
                    HarnessProposalStatus::Rejected => "rejected",
                },
                proposal.kind.as_str(),
                proposal.scope.as_str(),
                proposal.name,
                proposal.content,
                proposal.evidence
            ));
            if let Some(entry_id) = &proposal.applied_entry_id {
                report.push_str(&format!("  Applied entry: `{entry_id}`\n"));
            }
            if let Some(note) = &proposal.review_note {
                report.push_str(&format!("  Review note: {note}\n"));
            }
        }
        report.push_str("\nUse `/refine apply <id>` or `/refine reject <id> [note]`.\n");
        report
    }

    fn normalize_loaded_state(&mut self) -> Result<()> {
        if self.version < CURRENT_VERSION {
            self.version = CURRENT_VERSION;
        }
        if self.version > CURRENT_VERSION {
            bail!(
                "harness file uses unsupported version {} (current {})",
                self.version,
                CURRENT_VERSION
            );
        }
        if self.entries.len() > MAX_ENTRIES {
            bail!("harness file contains more than {MAX_ENTRIES} entries");
        }
        if self.proposals.len() > MAX_PROPOSALS {
            bail!("harness file contains more than {MAX_PROPOSALS} proposals");
        }
        for entry in &self.entries {
            validate_entry(entry)?;
        }
        for proposal in &self.proposals {
            validate_proposal(proposal)?;
        }
        self.history.truncate(MAX_HISTORY);
        self.snapshots.truncate(MAX_SNAPSHOTS);
        self.ensure_snapshot();
        Ok(())
    }

    fn ensure_snapshot(&mut self) {
        if !self
            .snapshots
            .iter()
            .any(|snapshot| snapshot.revision == self.revision)
        {
            self.snapshots.push(HarnessSnapshot {
                revision: self.revision,
                created_at_unix: now_unix(),
                entries: self.entries.clone(),
                proposals: self.proposals.clone(),
            });
        }
    }

    fn commit(
        &mut self,
        mutation: HarnessMutation,
        entry_id: Option<String>,
        before: Option<HarnessEntry>,
        after: Option<HarnessEntry>,
        note: Option<String>,
    ) {
        self.revision = self.revision.saturating_add(1);
        self.history.push(HarnessEvent {
            revision: self.revision,
            mutation,
            entry_id,
            before,
            after,
            note,
            created_at_unix: now_unix(),
        });
        if self.history.len() > MAX_HISTORY {
            let drop_count = self.history.len() - MAX_HISTORY;
            self.history.drain(..drop_count);
        }
        self.snapshots.push(HarnessSnapshot {
            revision: self.revision,
            created_at_unix: now_unix(),
            entries: self.entries.clone(),
            proposals: self.proposals.clone(),
        });
        if self.snapshots.len() > MAX_SNAPSHOTS {
            let drop_count = self.snapshots.len() - MAX_SNAPSHOTS;
            self.snapshots.drain(..drop_count);
        }
    }

    fn persist_or_rollback(&mut self, previous: Self) -> Result<()> {
        if let Err(error) = self.save() {
            *self = previous;
            return Err(error);
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let raw = serde_json::to_string_pretty(self).context("serialize harness state")?;
        crate::fs_atomic::write_atomic(path, raw.as_bytes())
            .with_context(|| format!("write harness file {}", path.display()))?;
        Ok(())
    }
}

fn default_path() -> PathBuf {
    if let Some(value) = std::env::var_os("MAESTRO_HARNESS_FILE") {
        let path = PathBuf::from(value);
        return if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(&path))
                .unwrap_or(path)
        };
    }
    crate::path_utils::maestro_home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("harness.json")
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn new_id() -> String {
    let id = uuid::Uuid::new_v4().to_string();
    format!("h-{}", &id[..8])
}

fn new_proposal_id() -> String {
    let id = uuid::Uuid::new_v4().to_string();
    format!("p-{}", &id[..8])
}

fn validate_name(name: String) -> Result<String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        bail!("harness entry name must not be empty")
    }
    if name.chars().count() > MAX_NAME_CHARS {
        bail!("harness entry name is too long (max {MAX_NAME_CHARS} characters)")
    }
    Ok(name)
}

fn validate_content(content: String) -> Result<String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        bail!("harness entry content must not be empty")
    }
    if content.chars().count() > MAX_CONTENT_CHARS {
        bail!("harness entry content is too long (max {MAX_CONTENT_CHARS} characters)")
    }
    Ok(content)
}

fn validate_evidence(evidence: Option<String>) -> Result<Option<String>> {
    let evidence = evidence
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if evidence
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_EVIDENCE_CHARS)
    {
        bail!("harness evidence is too long (max {MAX_EVIDENCE_CHARS} characters)")
    }
    Ok(evidence)
}

fn validate_scope_key(scope: HarnessScope, scope_key: Option<&str>) -> Result<()> {
    match scope {
        HarnessScope::User if scope_key.is_some() => {
            bail!("user-scoped harness entries cannot have a scope key")
        }
        HarnessScope::Workspace | HarnessScope::Session if scope_key.is_none() => {
            bail!(
                "{}-scoped harness entries require a scope key",
                scope.as_str()
            )
        }
        _ => Ok(()),
    }
}

fn validate_entry(entry: &HarnessEntry) -> Result<()> {
    validate_name(entry.name.clone())?;
    validate_content(entry.content.clone())?;
    validate_evidence(entry.evidence.clone())?;
    validate_scope_key(entry.scope, entry.scope_key.as_deref())
}

fn validate_proposal(proposal: &HarnessProposal) -> Result<()> {
    validate_name(proposal.name.clone())?;
    validate_content(proposal.content.clone())?;
    validate_evidence(Some(proposal.evidence.clone()))?;
    validate_scope_key(proposal.scope, proposal.scope_key.as_deref())
}

fn normalize_workspace(workspace: &Path) -> String {
    dunce::canonicalize(workspace)
        .unwrap_or_else(|_| {
            if workspace.is_absolute() {
                workspace.to_path_buf()
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(workspace))
                    .unwrap_or_else(|_| workspace.to_path_buf())
            }
        })
        .to_string_lossy()
        .to_string()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn workspace_key(path: &Path) -> String {
        normalize_workspace(path)
    }

    #[test]
    fn add_persists_scoped_entries_and_filters_prompt_context() {
        let temp = TempDir::new().expect("tempdir");
        let path = temp.path().join("harness.json");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        let mut store = HarnessStore::with_path(&path);

        store
            .add(
                HarnessKind::Memory,
                HarnessScope::User,
                None,
                "release-proof",
                "The release proof requires the native smoke command.",
                Some("runbook.md#release-proof".to_string()),
            )
            .expect("user entry");
        store
            .add(
                HarnessKind::Prompt,
                HarnessScope::Workspace,
                Some(workspace_key(&workspace)),
                "review-mode",
                "Review the diff before changing files.",
                None,
            )
            .expect("workspace entry");

        let loaded = HarnessStore::load_from_path(&path).expect("load persisted state");
        let visible = loaded.visible_entries(&workspace, None);
        assert_eq!(visible.len(), 2);
        let prompt = loaded
            .prompt_section(&workspace, None)
            .expect("prompt section");
        assert!(prompt.contains("release-proof"));
        assert!(prompt.contains("review-mode"));
        assert!(prompt.contains("runbook.md#release-proof"));

        let other_workspace = temp.path().join("other");
        fs::create_dir_all(&other_workspace).expect("other workspace");
        let other_prompt = loaded
            .prompt_section(&other_workspace, None)
            .expect("user prompt section");
        assert!(other_prompt.contains("release-proof"));
        assert!(!other_prompt.contains("review-mode"));
    }

    #[test]
    fn rollback_creates_a_new_revision_and_restores_snapshot() {
        let temp = TempDir::new().expect("tempdir");
        let path = temp.path().join("harness.json");
        let workspace = workspace_key(temp.path());
        let mut store = HarnessStore::with_path(&path);

        store
            .add(
                HarnessKind::Skill,
                HarnessScope::Workspace,
                Some(workspace),
                "tests",
                "Run focused tests after edits.",
                None,
            )
            .expect("add");
        let revision_after_add = store.revision;
        let id = store.entries[0].id.clone();
        store
            .update(
                &id,
                "Run focused tests and the relevant workspace suite.",
                None,
            )
            .expect("update");
        assert!(store.entries[0].content.contains("workspace suite"));

        store.rollback(revision_after_add).expect("rollback");
        assert!(
            store.entries[0]
                .content
                .contains("focused tests after edits")
        );
        assert!(store.revision > revision_after_add);

        let loaded = HarnessStore::load_from_path(&path).expect("reload");
        assert_eq!(loaded.entries[0].content, store.entries[0].content);
    }

    #[test]
    fn rejects_duplicate_scope_names_and_oversized_content() {
        let mut store = HarnessStore::default();
        store
            .add(
                HarnessKind::Prompt,
                HarnessScope::User,
                None,
                "same",
                "first",
                None,
            )
            .expect("first entry");
        let duplicate = store.add(
            HarnessKind::Prompt,
            HarnessScope::User,
            None,
            "same",
            "second",
            None,
        );
        assert!(duplicate.is_err());

        let oversized = store.add(
            HarnessKind::Memory,
            HarnessScope::User,
            None,
            "large",
            "x".repeat(MAX_CONTENT_CHARS + 1),
            None,
        );
        assert!(oversized.is_err());
    }

    #[test]
    fn refinement_proposal_requires_evidence_and_applies_atomically() {
        let temp = TempDir::new().expect("tempdir");
        let path = temp.path().join("harness.json");
        let workspace = workspace_key(temp.path());
        let mut store = HarnessStore::with_path(&path);

        let missing_evidence = store.propose(
            HarnessKind::Memory,
            HarnessScope::Workspace,
            Some(workspace.clone()),
            "release",
            "Run the release proof.",
            " ",
        );
        assert!(missing_evidence.is_err());

        let proposal_id = store
            .propose(
                HarnessKind::Memory,
                HarnessScope::Workspace,
                Some(workspace),
                "release",
                "Run the release proof.",
                "runbook.md#release-proof",
            )
            .expect("proposal");
        assert_eq!(store.proposals.len(), 1);
        assert!(store.proposal_report().contains(&proposal_id));

        let entry_id = store.apply_proposal(&proposal_id).expect("apply proposal");
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.entries[0].id, entry_id);
        assert_eq!(store.proposals[0].status, HarnessProposalStatus::Applied);

        let loaded = HarnessStore::load_from_path(&path).expect("load");
        assert_eq!(loaded.entries[0].id, entry_id);
        assert_eq!(loaded.proposals[0].status, HarnessProposalStatus::Applied);
    }

    #[test]
    fn rejected_proposal_does_not_change_entries() {
        let mut store = HarnessStore::default();
        let proposal_id = store
            .propose(
                HarnessKind::Prompt,
                HarnessScope::User,
                None,
                "review",
                "Review the diff.",
                "review checklist",
            )
            .expect("proposal");
        store
            .reject_proposal(&proposal_id, Some("duplicate guidance".to_string()))
            .expect("reject");
        assert!(store.entries.is_empty());
        assert_eq!(store.proposals[0].status, HarnessProposalStatus::Rejected);
        assert_eq!(
            store.proposals[0].review_note.as_deref(),
            Some("duplicate guidance")
        );
    }

    #[test]
    fn applying_proposal_updates_existing_entry_and_retains_identity() {
        let mut store = HarnessStore::default();
        let entry_id = store
            .add(
                HarnessKind::Memory,
                HarnessScope::User,
                None,
                "release",
                "Old release guidance.",
                Some("old evidence".to_string()),
            )
            .expect("entry");
        let proposal_id = store
            .propose(
                HarnessKind::Memory,
                HarnessScope::User,
                None,
                "release",
                "Updated release guidance.",
                "new evidence",
            )
            .expect("proposal");

        let applied_id = store.apply_proposal(&proposal_id).expect("apply");
        assert_eq!(applied_id, entry_id);
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.entries[0].content, "Updated release guidance.");
        assert_eq!(store.entries[0].evidence.as_deref(), Some("new evidence"));
    }

    #[test]
    fn reviewed_proposals_are_pruned_before_the_cap_blocks_new_work() {
        let mut store = HarnessStore::default();
        for index in 0..MAX_PROPOSALS {
            let proposal_id = store
                .propose(
                    HarnessKind::Prompt,
                    HarnessScope::User,
                    None,
                    format!("proposal-{index}"),
                    "Apply this guidance.",
                    "test evidence",
                )
                .expect("proposal");
            store.reject_proposal(&proposal_id, None).expect("reject");
        }

        let proposal_id = store
            .propose(
                HarnessKind::Prompt,
                HarnessScope::User,
                None,
                "after-cap",
                "Apply this guidance.",
                "test evidence",
            )
            .expect("reviewed proposals should be reclaimable");
        assert_eq!(store.proposals.len(), 1);
        assert_eq!(store.proposals[0].id, proposal_id);
    }

    #[test]
    fn rollback_preserves_pending_proposals_created_after_snapshot() {
        let mut store = HarnessStore::default();
        store
            .add(
                HarnessKind::Memory,
                HarnessScope::User,
                None,
                "baseline",
                "Baseline guidance.",
                None,
            )
            .expect("baseline entry");
        let revision = store.revision;
        let proposal_id = store
            .propose(
                HarnessKind::Prompt,
                HarnessScope::User,
                None,
                "pending",
                "Pending guidance.",
                "observed failure",
            )
            .expect("proposal");

        store.rollback(revision).expect("rollback");
        assert!(store.proposals.iter().any(|proposal| {
            proposal.id == proposal_id && proposal.status == HarnessProposalStatus::Pending
        }));
    }
}
