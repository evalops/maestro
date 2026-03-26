//! Skill Loader
//!
//! Provides filesystem-based skill discovery and loading from SKILL.md files
//! following the Agent Skills specification (<https://agentskills.io/specification>).
//!
//! # SKILL.md Format
//!
//! Skills are defined as markdown files with YAML frontmatter:
//!
//! ```markdown
//! ---
//! name: skill-name
//! description: A clear description of what this skill does and when to use it
//! license: MIT
//! compatibility: Requires network access for API calls
//! allowed-tools: read write bash
//! metadata:
//!   priority: high
//!   category: development
//! ---
//! # Skill Instructions
//!
//! Your markdown content here becomes the system_prompt_additions.
//! ```
//!
//! # Skill Directory Structure
//!
//! ```text
//! skill-name/
//! ├── SKILL.md          # Required - skill definition
//! ├── scripts/          # Optional - executable code (Python, Bash, JS)
//! ├── references/       # Optional - additional documentation
//! └── assets/           # Optional - static resources (templates, images)
//! ```
//!
//! # Required Frontmatter Fields
//!
//! - **name**: Skill identifier (1-64 chars, lowercase alphanumeric + hyphens)
//! - **description**: What the skill does (1-1024 chars)
//!
//! # Optional Frontmatter Fields
//!
//! - **license**: License identifier (e.g., "MIT", "Apache-2.0")
//! - **compatibility**: Environment requirements (1-500 chars)
//! - **allowed-tools**: Space-delimited list of pre-approved tools
//! - **metadata**: Custom key-value properties
//!
//! # Skill Discovery Locations
//!
//! Skills are loaded from:
//! 1. `~/.composer/skills/` - Global user skills
//! 2. `.composer/skills/` - Project-specific skills
//!
//! # Example Usage
//!
//! ```rust,ignore
//! use maestro_tui::skills::loader::SkillLoader;
//!
//! let loader = SkillLoader::new();
//! let skills = loader.load_all();
//! for result in skills {
//!     match result {
//!         Ok(skill) => println!("Loaded: {}", skill.definition.name),
//!         Err(e) => eprintln!("Error: {}", e),
//!     }
//! }
//! ```

use crate::skills::{SkillDefinition, SkillSource};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Error type for skill loading operations
#[derive(Debug, thiserror::Error)]
pub enum SkillLoadError {
    /// Failed to read skill file
    #[error("Failed to read skill file '{path}': {source}")]
    ReadError {
        path: PathBuf,
        source: std::io::Error,
    },

    /// Failed to parse YAML frontmatter
    #[error("Failed to parse YAML frontmatter in '{path}': {message}")]
    YamlParseError { path: PathBuf, message: String },

    /// Missing frontmatter delimiters
    #[error("Missing frontmatter delimiters in '{path}'")]
    MissingFrontmatter { path: PathBuf },

    /// Invalid skill definition
    #[error("Invalid skill definition in '{path}': {message}")]
    InvalidSkill { path: PathBuf, message: String },

    /// Name validation failed
    #[error("Invalid skill name '{name}' in '{path}': {reason}")]
    InvalidName {
        path: PathBuf,
        name: String,
        reason: String,
    },

    /// Directory name doesn't match skill name
    #[error("Directory name '{dir_name}' doesn't match skill name '{skill_name}' in '{path}'")]
    NameMismatch {
        path: PathBuf,
        dir_name: String,
        skill_name: String,
    },

    /// Unexpected fields in frontmatter
    #[error("Unexpected fields in '{path}': {fields}. Only name, description, license, compatibility, allowed-tools, metadata are allowed.")]
    UnexpectedFields { path: PathBuf, fields: String },
}

/// Allowed frontmatter fields per Agent Skills spec
const ALLOWED_FIELDS: &[&str] = &[
    "name",
    "description",
    "license",
    "compatibility",
    "allowed-tools",
    "metadata",
    "tags",
    "author",
    "version",
    "triggers",
];

/// YAML frontmatter structure for skill files (per Agent Skills spec)
#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    /// Skill name - required (1-64 chars, lowercase alphanumeric + hyphens)
    name: String,

    /// Skill description - required (1-1024 chars)
    description: String,

    /// License identifier (optional)
    license: Option<String>,

    /// Compatibility/requirements description (optional, 1-500 chars)
    compatibility: Option<String>,

    /// Space-delimited list of allowed tools (optional, experimental)
    #[serde(rename = "allowed-tools")]
    allowed_tools: Option<String>,

    /// Additional metadata key-value pairs (optional)
    #[serde(default)]
    metadata: HashMap<String, serde_json::Value>,

    /// Legacy tags (optional)
    #[serde(default)]
    tags: Option<Vec<String>>,

    /// Legacy author (optional)
    #[serde(default)]
    author: Option<String>,

    /// Legacy version (optional)
    #[serde(default)]
    version: Option<String>,

    /// Legacy triggers (optional)
    #[serde(default)]
    triggers: Option<Vec<String>>,
}

/// Result of loading a skill file
#[derive(Debug)]
pub struct LoadedSkill {
    /// The parsed skill definition
    pub definition: SkillDefinition,
    /// Path to the source file
    pub source_path: PathBuf,
    /// Path to the skill directory (parent of SKILL.md)
    pub skill_dir: PathBuf,
    /// Available resource directories
    pub resources: SkillResources,
}

/// Available resource directories for a skill
#[derive(Debug, Default)]
pub struct SkillResources {
    /// Path to scripts directory if it exists
    pub scripts_dir: Option<PathBuf>,
    /// Path to references directory if it exists
    pub references_dir: Option<PathBuf>,
    /// Path to assets directory if it exists
    pub assets_dir: Option<PathBuf>,
}

impl SkillResources {
    /// Check if the skill has any resources
    #[must_use]
    pub fn has_resources(&self) -> bool {
        self.scripts_dir.is_some() || self.references_dir.is_some() || self.assets_dir.is_some()
    }
}

impl LoadedSkill {
    /// Convert to a JSON-serializable dictionary (per Agent Skills SDK)
    ///
    /// Excludes None values to match the Python SDK behavior.
    #[must_use]
    pub fn to_dict(&self) -> serde_json::Value {
        let mut result = serde_json::Map::new();

        result.insert("name".to_string(), serde_json::json!(self.definition.name));
        result.insert(
            "description".to_string(),
            serde_json::json!(self.definition.description),
        );

        // Add optional fields only if present
        if let Some(license) = self.definition.metadata.get("license") {
            result.insert("license".to_string(), license.clone());
        }

        if let Some(compat) = self.definition.metadata.get("compatibility") {
            result.insert("compatibility".to_string(), compat.clone());
        }

        if !self.definition.provided_tools.is_empty() {
            result.insert(
                "allowed-tools".to_string(),
                serde_json::json!(self.definition.provided_tools.join(" ")),
            );
        }

        // Add metadata if non-empty (excluding license/compatibility which are top-level)
        let filtered_metadata: HashMap<String, serde_json::Value> = self
            .definition
            .metadata
            .iter()
            .filter(|(k, _)| *k != "license" && *k != "compatibility")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        if !filtered_metadata.is_empty() {
            result.insert("metadata".to_string(), serde_json::json!(filtered_metadata));
        }

        serde_json::Value::Object(result)
    }

    /// Convert to JSON string
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(&self.to_dict()).unwrap_or_default()
    }
}

/// Loader for filesystem-based skills following the Agent Skills spec
#[derive(Debug)]
pub struct SkillLoader {
    /// Directories to search for skills
    search_paths: Vec<PathBuf>,
    /// Cached system skills directory (resolved once at construction)
    system_skills_dir: Option<PathBuf>,
    /// Cached user skills directory (resolved once at construction)
    user_skills_dir: Option<PathBuf>,
}

impl SkillLoader {
    /// Create a new skill loader with default search paths
    #[must_use]
    pub fn new() -> Self {
        let mut search_paths = Vec::new();

        let system_skills_dir = Self::find_system_skills_dir();
        let user_skills_dir = dirs::home_dir().map(|h| h.join(".composer").join("skills"));

        // Add system skills directory (bundled with the package, lowest priority)
        if let Some(ref system_dir) = system_skills_dir {
            search_paths.push(system_dir.clone());
        }

        // Add global user skills directory
        if let Some(ref user_dir) = user_skills_dir {
            search_paths.push(user_dir.clone());
        }

        // Add project-specific skills directory (highest priority)
        search_paths.push(PathBuf::from(".composer").join("skills"));

        Self {
            search_paths,
            system_skills_dir,
            user_skills_dir,
        }
    }

    /// Discover the system skills directory bundled with the package.
    ///
    /// Walks up from the current executable looking for a directory that
    /// contains both `skills/` and `package.json` (the package root).
    fn find_system_skills_dir() -> Option<PathBuf> {
        // Allow explicit override for non-standard packaging layouts
        if let Ok(dir) = std::env::var("MAESTRO_SYSTEM_SKILLS_DIR") {
            let path = PathBuf::from(dir);
            if path.is_dir() {
                return Some(path);
            }
        }

        let exe = std::env::current_exe().ok()?;
        let mut cursor = exe.parent();
        for _ in 0..10 {
            let path = cursor?;
            let skills_dir = path.join("skills");
            if skills_dir.is_dir() && path.join("package.json").is_file() {
                return Some(skills_dir);
            }
            cursor = path.parent();
        }
        None
    }

    /// Create a loader with custom search paths
    #[must_use]
    pub fn with_paths(paths: Vec<PathBuf>) -> Self {
        Self {
            search_paths: paths,
            system_skills_dir: None,
            user_skills_dir: None,
        }
    }

    /// Add a search path
    pub fn add_search_path(&mut self, path: PathBuf) {
        self.search_paths.push(path);
    }

    /// Get the search paths
    #[must_use]
    pub fn search_paths(&self) -> &[PathBuf] {
        &self.search_paths
    }

    /// Validate a skill name according to the Agent Skills spec
    fn validate_name(name: &str, path: &Path) -> Result<(), SkillLoadError> {
        // Check length (1-64 chars)
        if name.is_empty() {
            return Err(SkillLoadError::InvalidName {
                path: path.to_path_buf(),
                name: name.to_string(),
                reason: "Name cannot be empty".to_string(),
            });
        }
        if name.len() > 64 {
            return Err(SkillLoadError::InvalidName {
                path: path.to_path_buf(),
                name: name.to_string(),
                reason: format!("Name exceeds 64 characters (got {})", name.len()),
            });
        }

        // Check for valid characters (lowercase alphanumeric + hyphens)
        for c in name.chars() {
            if !c.is_ascii_lowercase() && !c.is_ascii_digit() && c != '-' {
                return Err(SkillLoadError::InvalidName {
                    path: path.to_path_buf(),
                    name: name.to_string(),
                    reason: format!(
                        "Invalid character '{c}'. Only lowercase letters, digits, and hyphens allowed"
                    ),
                });
            }
        }

        // Check for leading/trailing hyphens
        if name.starts_with('-') || name.ends_with('-') {
            return Err(SkillLoadError::InvalidName {
                path: path.to_path_buf(),
                name: name.to_string(),
                reason: "Name cannot start or end with a hyphen".to_string(),
            });
        }

        // Check for consecutive hyphens
        if name.contains("--") {
            return Err(SkillLoadError::InvalidName {
                path: path.to_path_buf(),
                name: name.to_string(),
                reason: "Name cannot contain consecutive hyphens".to_string(),
            });
        }

        Ok(())
    }

    /// Find the SKILL.md file in a directory (case-insensitive)
    ///
    /// Prefers SKILL.md (uppercase) but accepts skill.md (lowercase) per spec.
    fn find_skill_md(dir: &Path) -> Option<PathBuf> {
        // Check for uppercase first (preferred)
        let uppercase = dir.join("SKILL.md");
        if uppercase.exists() {
            return Some(uppercase);
        }

        // Fall back to lowercase
        let lowercase = dir.join("skill.md");
        if lowercase.exists() {
            return Some(lowercase);
        }

        None
    }

    /// Load all skills from all search paths
    #[must_use]
    pub fn load_all(&self) -> Vec<Result<LoadedSkill, SkillLoadError>> {
        let mut results = Vec::new();

        for search_path in &self.search_paths {
            if search_path.exists() && search_path.is_dir() {
                results.extend(self.load_from_directory(search_path));
            }
        }

        results
    }

    /// Determine the skill source based on which search path the directory belongs to
    fn source_for_dir(&self, dir: &Path) -> SkillSource {
        if let Some(ref system_dir) = self.system_skills_dir {
            if dir.starts_with(system_dir) {
                return SkillSource::System;
            }
        }
        if let Some(ref user_dir) = self.user_skills_dir {
            if dir.starts_with(user_dir) {
                return SkillSource::User;
            }
        }
        // Default: project-level skills (.composer/skills/)
        SkillSource::Project
    }

    /// Load skills from a specific directory
    #[must_use]
    pub fn load_from_directory(&self, dir: &Path) -> Vec<Result<LoadedSkill, SkillLoadError>> {
        let mut results = Vec::new();
        let source = self.source_for_dir(dir);

        // Look for SKILL.md directly in the skills directory (single-file skill)
        // Supports both SKILL.md and skill.md (case-insensitive per spec)
        if let Some(skill_file) = Self::find_skill_md(dir) {
            results.push(self.load_skill_file(&skill_file, source));
        }

        // Look for subdirectories containing SKILL.md
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(std::result::Result::ok) {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(skill_file) = Self::find_skill_md(&path) {
                        results.push(self.load_skill_file(&skill_file, source));
                    }
                }
            }
        }

        results
    }

    /// Load a single skill file
    pub fn load_skill_file(
        &self,
        path: &Path,
        source: SkillSource,
    ) -> Result<LoadedSkill, SkillLoadError> {
        // Read file contents
        let content = std::fs::read_to_string(path).map_err(|e| SkillLoadError::ReadError {
            path: path.to_path_buf(),
            source: e,
        })?;

        // Determine skill directory
        let skill_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();

        // Discover resources
        let resources = SkillResources {
            scripts_dir: {
                let p = skill_dir.join("scripts");
                if p.exists() && p.is_dir() {
                    Some(p)
                } else {
                    None
                }
            },
            references_dir: {
                let p = skill_dir.join("references");
                if p.exists() && p.is_dir() {
                    Some(p)
                } else {
                    None
                }
            },
            assets_dir: {
                let p = skill_dir.join("assets");
                if p.exists() && p.is_dir() {
                    Some(p)
                } else {
                    None
                }
            },
        };

        // Parse the skill
        let definition = self.parse_skill_content(&content, path, source)?;

        // Validate directory name matches skill name (per Agent Skills spec)
        // Skip this check for SKILL.md files in the root skills directory
        if let Some(dir_name) = skill_dir.file_name().and_then(|n| n.to_str()) {
            // Only validate if we're in a subdirectory (not the root skills dir)
            if dir_name != "skills" && dir_name != definition.name {
                return Err(SkillLoadError::NameMismatch {
                    path: path.to_path_buf(),
                    dir_name: dir_name.to_string(),
                    skill_name: definition.name.clone(),
                });
            }
        }

        Ok(LoadedSkill {
            definition,
            source_path: path.to_path_buf(),
            skill_dir,
            resources,
        })
    }

    /// Validate that only allowed fields are present in frontmatter
    fn validate_fields(frontmatter_str: &str, path: &Path) -> Result<(), SkillLoadError> {
        // Parse as generic YAML value to check keys
        let value: serde_yaml::Value =
            serde_yaml::from_str(frontmatter_str).map_err(|e| SkillLoadError::YamlParseError {
                path: path.to_path_buf(),
                message: e.to_string(),
            })?;

        if let serde_yaml::Value::Mapping(map) = value {
            let mut unexpected: Vec<String> = Vec::new();

            for key in map.keys() {
                if let serde_yaml::Value::String(key_str) = key {
                    if !ALLOWED_FIELDS.contains(&key_str.as_str()) {
                        unexpected.push(key_str.clone());
                    }
                }
            }

            if !unexpected.is_empty() {
                unexpected.sort();
                return Err(SkillLoadError::UnexpectedFields {
                    path: path.to_path_buf(),
                    fields: unexpected.join(", "),
                });
            }
        }

        Ok(())
    }

    /// Parse skill content from a string
    fn parse_skill_content(
        &self,
        content: &str,
        path: &Path,
        source: SkillSource,
    ) -> Result<SkillDefinition, SkillLoadError> {
        // Extract frontmatter and body
        let (frontmatter_str, body) = self.extract_frontmatter(content, path)?;

        // Validate that only allowed fields are present (per Agent Skills spec)
        Self::validate_fields(&frontmatter_str, path)?;

        // Parse YAML frontmatter
        let frontmatter: SkillFrontmatter =
            serde_yaml::from_str(&frontmatter_str).map_err(|e| SkillLoadError::YamlParseError {
                path: path.to_path_buf(),
                message: e.to_string(),
            })?;

        // Validate name per spec (with Unicode normalization)
        Self::validate_name(&frontmatter.name, path)?;

        // Validate description length
        if frontmatter.description.is_empty() {
            return Err(SkillLoadError::InvalidSkill {
                path: path.to_path_buf(),
                message: "Description cannot be empty".to_string(),
            });
        }
        if frontmatter.description.len() > 1024 {
            return Err(SkillLoadError::InvalidSkill {
                path: path.to_path_buf(),
                message: format!(
                    "Description exceeds 1024 characters (got {})",
                    frontmatter.description.len()
                ),
            });
        }

        // Validate compatibility length if present
        if let Some(ref compat) = frontmatter.compatibility {
            if compat.len() > 500 {
                return Err(SkillLoadError::InvalidSkill {
                    path: path.to_path_buf(),
                    message: format!(
                        "Compatibility exceeds 500 characters (got {})",
                        compat.len()
                    ),
                });
            }
        }

        // Parse allowed-tools (space-delimited)
        let tools: Vec<String> = frontmatter
            .allowed_tools
            .map(|t| t.split_whitespace().map(String::from).collect())
            .unwrap_or_default();

        // Build the skill definition
        let mut skill = SkillDefinition::new(&frontmatter.name, &frontmatter.name)
            .with_description(&frontmatter.description)
            .with_source(source)
            .with_tools(tools);

        // Set metadata
        skill.metadata = frontmatter.metadata;

        // Add license to metadata if present
        if let Some(license) = frontmatter.license {
            skill
                .metadata
                .insert("license".to_string(), serde_json::json!(license));
        }

        // Add compatibility to metadata if present
        if let Some(compat) = frontmatter.compatibility {
            skill
                .metadata
                .insert("compatibility".to_string(), serde_json::json!(compat));
        }

        // Legacy fields (tags/author/version/triggers)
        if let Some(tags) = frontmatter.tags {
            skill
                .metadata
                .insert("tags".to_string(), serde_json::json!(tags));
        }
        if let Some(author) = frontmatter.author {
            skill.author = Some(author);
        }
        if let Some(version) = frontmatter.version {
            skill.version = Some(version);
        }
        if let Some(triggers) = frontmatter.triggers {
            skill = skill.with_triggers(triggers);
        }

        // Set system prompt from body (if not empty)
        let body_trimmed = body.trim();
        if !body_trimmed.is_empty() {
            skill = skill.with_system_prompt(body_trimmed);
        }

        Ok(skill)
    }

    /// Extract frontmatter from content
    fn extract_frontmatter(
        &self,
        content: &str,
        path: &Path,
    ) -> Result<(String, String), SkillLoadError> {
        let content = content.trim();

        // Check for frontmatter start
        if !content.starts_with("---") {
            return Err(SkillLoadError::MissingFrontmatter {
                path: path.to_path_buf(),
            });
        }

        // Find the end of frontmatter
        let after_start = &content[3..];
        let end_pos = after_start
            .find("\n---")
            .ok_or(SkillLoadError::MissingFrontmatter {
                path: path.to_path_buf(),
            })?;

        let frontmatter = after_start[..end_pos].trim().to_string();
        let body = after_start[end_pos + 4..].to_string();

        Ok((frontmatter, body))
    }

    /// Load skills and register them with a registry
    pub fn load_into_registry(
        &self,
        registry: &mut crate::skills::SkillRegistry,
    ) -> Vec<SkillLoadError> {
        let mut errors = Vec::new();

        for result in self.load_all() {
            match result {
                Ok(loaded) => {
                    registry.register(loaded.definition);
                }
                Err(e) => {
                    errors.push(e);
                }
            }
        }

        errors
    }

    /// Load skills returning both successful loads and errors
    #[must_use]
    pub fn load_all_with_paths(&self) -> (Vec<LoadedSkill>, Vec<SkillLoadError>) {
        let mut skills = Vec::new();
        let mut errors = Vec::new();

        for result in self.load_all() {
            match result {
                Ok(skill) => skills.push(skill),
                Err(e) => errors.push(e),
            }
        }

        (skills, errors)
    }
}

/// Generate an XML prompt block for available skills (per Agent Skills spec)
///
/// This generates the `<available_skills>` XML block that should be included
/// in system prompts to make skills discoverable by the agent.
///
/// # Example Output
///
/// ```xml
/// <available_skills>
/// <skill>
///   <name>pdf-processing</name>
///   <description>Extract text and tables from PDFs</description>
///   <location>/home/user/.composer/skills/pdf-processing/SKILL.md</location>
/// </skill>
/// </available_skills>
/// ```
#[must_use]
pub fn skills_to_prompt(skills: &[LoadedSkill]) -> String {
    if skills.is_empty() {
        return "<available_skills>\n</available_skills>".to_string();
    }

    let mut output = String::from("<available_skills>\n");

    for skill in skills {
        let def = &skill.definition;
        // Escape XML special characters
        let name = html_escape(&def.name);
        let description = html_escape(&def.description);
        let location = html_escape(&skill.source_path.display().to_string());

        output.push_str("<skill>\n");
        output.push_str(&format!("  <name>{name}</name>\n"));
        output.push_str(&format!("  <description>{description}</description>\n"));
        output.push_str(&format!("  <location>{location}</location>\n"));
        output.push_str("</skill>\n");
    }

    output.push_str("</available_skills>");
    output
}

/// Escape HTML/XML special characters
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

impl Default for SkillLoader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn is_case_sensitive_fs() -> bool {
        let temp_dir = TempDir::new().unwrap();
        let lower = temp_dir.path().join("skill.md");
        fs::write(&lower, "test").unwrap();
        let upper = temp_dir.path().join("SKILL.md");
        !upper.exists()
    }

    #[test]
    fn test_loader_new() {
        let loader = SkillLoader::new();
        assert!(!loader.search_paths.is_empty());
    }

    #[test]
    fn test_loader_with_custom_paths() {
        let paths = vec![PathBuf::from("/custom/path")];
        let loader = SkillLoader::with_paths(paths.clone());
        assert_eq!(loader.search_paths, paths);
    }

    #[test]
    fn test_loader_add_search_path() {
        let mut loader = SkillLoader::new();
        let initial_count = loader.search_paths.len();
        loader.add_search_path(PathBuf::from("/new/path"));
        assert_eq!(loader.search_paths.len(), initial_count + 1);
    }

    #[test]
    fn test_parse_basic_skill() {
        let content = r"---
name: test-skill
description: A test skill for testing purposes
allowed-tools: read write
---
# Test Instructions

This is the system prompt for the test skill.
";

        let loader = SkillLoader::new();
        let skill = loader
            .parse_skill_content(content, Path::new("test.md"), SkillSource::User)
            .unwrap();

        assert_eq!(skill.id, "test-skill");
        assert_eq!(skill.name, "test-skill");
        assert_eq!(skill.description, "A test skill for testing purposes");
        assert_eq!(skill.provided_tools, vec!["read", "write"]);
        assert!(skill.system_prompt_additions.is_some());
        assert!(skill
            .system_prompt_additions
            .as_ref()
            .unwrap()
            .contains("Test Instructions"));
    }

    #[test]
    fn test_parse_skill_with_all_fields() {
        let content = r"---
name: full-skill
description: A complete skill with all fields
license: MIT
compatibility: Requires network access
allowed-tools: read write bash
metadata:
  priority: high
  category: development
---
Full skill content.
";

        let loader = SkillLoader::new();
        let skill = loader
            .parse_skill_content(content, Path::new("test.md"), SkillSource::User)
            .unwrap();

        assert_eq!(skill.id, "full-skill");
        assert_eq!(
            skill.metadata.get("license"),
            Some(&serde_json::json!("MIT"))
        );
        assert_eq!(
            skill.metadata.get("compatibility"),
            Some(&serde_json::json!("Requires network access"))
        );
        assert_eq!(
            skill.metadata.get("priority"),
            Some(&serde_json::json!("high"))
        );
        assert_eq!(skill.provided_tools, vec!["read", "write", "bash"]);
    }

    #[test]
    fn test_parse_skill_no_body() {
        let content = r"---
name: no-body-skill
description: A skill without a body
---
";

        let loader = SkillLoader::new();
        let skill = loader
            .parse_skill_content(content, Path::new("test.md"), SkillSource::User)
            .unwrap();

        assert_eq!(skill.id, "no-body-skill");
        assert!(skill.system_prompt_additions.is_none());
    }

    #[test]
    fn test_name_validation_empty() {
        let content = r#"---
name: ""
description: Empty name
---
Content.
"#;

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_too_long() {
        let long_name = "a".repeat(65);
        let content = format!(
            r"---
name: {}
description: Too long name
---
Content.
",
            long_name
        );

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(&content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_uppercase() {
        let content = r"---
name: UpperCase
description: Uppercase name
---
Content.
";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_leading_hyphen() {
        let content = r"---
name: -leading-hyphen
description: Leading hyphen
---
Content.
";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_trailing_hyphen() {
        let content = r"---
name: trailing-hyphen-
description: Trailing hyphen
---
Content.
";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_consecutive_hyphens() {
        let content = r"---
name: double--hyphen
description: Consecutive hyphens
---
Content.
";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_valid_names() {
        let valid_names = vec![
            "a",
            "test",
            "my-skill",
            "skill123",
            "a1b2c3",
            "pdf-processing",
            "data-analysis",
        ];

        for name in valid_names {
            let content = format!(
                r"---
name: {}
description: Valid name test
---
Content.
",
                name
            );

            let loader = SkillLoader::new();
            let result =
                loader.parse_skill_content(&content, Path::new("test.md"), SkillSource::User);
            assert!(
                result.is_ok(),
                "Name '{}' should be valid but got: {:?}",
                name,
                result
            );
        }
    }

    #[test]
    fn test_description_validation_empty() {
        let content = r#"---
name: test-skill
description: ""
---
Content.
"#;

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidSkill { .. })));
    }

    #[test]
    fn test_description_validation_too_long() {
        let long_desc = "a".repeat(1025);
        let content = format!(
            r#"---
name: test-skill
description: "{}"
---
Content.
"#,
            long_desc
        );

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(&content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidSkill { .. })));
    }

    #[test]
    fn test_compatibility_validation_too_long() {
        let long_compat = "a".repeat(501);
        let content = format!(
            r#"---
name: test-skill
description: A test skill
compatibility: "{}"
---
Content.
"#,
            long_compat
        );

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(&content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidSkill { .. })));
    }

    #[test]
    fn test_missing_frontmatter() {
        let content = "No frontmatter here";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(
            result,
            Err(SkillLoadError::MissingFrontmatter { .. })
        ));
    }

    #[test]
    fn test_missing_end_delimiter() {
        let content = r"---
name: broken
description: Missing end delimiter
";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(
            result,
            Err(SkillLoadError::MissingFrontmatter { .. })
        ));
    }

    #[test]
    fn test_invalid_yaml() {
        let content = r"---
name: [invalid yaml
description: test
---
Content.
";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::YamlParseError { .. })));
    }

    #[test]
    fn test_load_skill_file() {
        let temp_dir = TempDir::new().unwrap();

        // Create a properly named subdirectory for the skill
        let skill_dir = temp_dir.path().join("file-test");
        fs::create_dir(&skill_dir).unwrap();

        let skill_content = r"---
name: file-test
description: Testing file loading
---
File loaded successfully.
";
        let skill_path = skill_dir.join("SKILL.md");
        fs::write(&skill_path, skill_content).unwrap();

        let loader = SkillLoader::new();
        let result = loader.load_skill_file(&skill_path, SkillSource::User);

        assert!(result.is_ok());
        let loaded = result.unwrap();
        assert_eq!(loaded.definition.name, "file-test");
        assert_eq!(loaded.source_path, skill_path);
    }

    #[test]
    fn test_load_skill_file_not_found() {
        let loader = SkillLoader::new();
        let result = loader.load_skill_file(Path::new("/nonexistent/SKILL.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::ReadError { .. })));
    }

    #[test]
    fn test_load_from_directory() {
        let temp_dir = TempDir::new().unwrap();

        // Create a subdirectory with a skill
        let skill_dir = temp_dir.path().join("my-skill");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: my-skill
description: A test skill
---
Skill content.
",
        )
        .unwrap();

        let loader = SkillLoader::new();
        let results = loader.load_from_directory(temp_dir.path());

        assert_eq!(results.len(), 1);
        assert!(results[0].is_ok());
    }

    #[test]
    fn test_load_from_directory_multiple_skills() {
        let temp_dir = TempDir::new().unwrap();

        for name in &["skill-a", "skill-b", "skill-c"] {
            let skill_dir = temp_dir.path().join(name);
            fs::create_dir(&skill_dir).unwrap();
            fs::write(
                skill_dir.join("SKILL.md"),
                format!(
                    r"---
name: {}
description: Skill description for {}
---
Content.
",
                    name, name
                ),
            )
            .unwrap();
        }

        let loader = SkillLoader::new();
        let results = loader.load_from_directory(temp_dir.path());

        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.is_ok()));
    }

    #[test]
    fn test_load_from_empty_directory() {
        let temp_dir = TempDir::new().unwrap();
        let loader = SkillLoader::new();
        let results = loader.load_from_directory(temp_dir.path());
        assert!(results.is_empty());
    }

    #[test]
    fn test_load_all_with_custom_paths() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join("test-skill");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: test-skill
description: A test skill
---
Content.
",
        )
        .unwrap();

        let loader = SkillLoader::with_paths(vec![temp_dir.path().to_path_buf()]);
        let results = loader.load_all();

        assert_eq!(results.len(), 1);
        assert!(results[0].is_ok());
    }

    #[test]
    fn test_load_into_registry() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join("registry-skill");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: registry-skill
description: A skill for registry testing
---
Registered content.
",
        )
        .unwrap();

        let loader = SkillLoader::with_paths(vec![temp_dir.path().to_path_buf()]);
        let mut registry = crate::skills::SkillRegistry::new();

        let errors = loader.load_into_registry(&mut registry);
        assert!(errors.is_empty());
        assert_eq!(registry.list().len(), 1);
        assert!(registry.get("registry-skill").is_some());
    }

    #[test]
    fn test_load_into_registry_with_errors() {
        let temp_dir = TempDir::new().unwrap();

        // Create one valid skill
        let valid_dir = temp_dir.path().join("valid-skill");
        fs::create_dir(&valid_dir).unwrap();
        fs::write(
            valid_dir.join("SKILL.md"),
            r"---
name: valid-skill
description: A valid skill
---
Content.
",
        )
        .unwrap();

        // Create one invalid skill
        let invalid_dir = temp_dir.path().join("invalid");
        fs::create_dir(&invalid_dir).unwrap();
        fs::write(invalid_dir.join("SKILL.md"), "No frontmatter here").unwrap();

        let loader = SkillLoader::with_paths(vec![temp_dir.path().to_path_buf()]);
        let mut registry = crate::skills::SkillRegistry::new();

        let errors = loader.load_into_registry(&mut registry);

        assert_eq!(errors.len(), 1);
        assert_eq!(registry.list().len(), 1);
    }

    #[test]
    fn test_skill_resources_detection() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join("resource-skill");
        fs::create_dir(&skill_dir).unwrap();

        // Create SKILL.md
        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: resource-skill
description: A skill with resources
---
Content.
",
        )
        .unwrap();

        // Create resource directories
        fs::create_dir(skill_dir.join("scripts")).unwrap();
        fs::create_dir(skill_dir.join("references")).unwrap();
        fs::create_dir(skill_dir.join("assets")).unwrap();

        let loader = SkillLoader::new();
        let result = loader.load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::User);

        assert!(result.is_ok());
        let loaded = result.unwrap();
        assert!(loaded.resources.has_resources());
        assert!(loaded.resources.scripts_dir.is_some());
        assert!(loaded.resources.references_dir.is_some());
        assert!(loaded.resources.assets_dir.is_some());
    }

    #[test]
    fn test_skill_resources_partial() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join("partial-resource");
        fs::create_dir(&skill_dir).unwrap();

        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: partial-resource
description: A skill with partial resources
---
Content.
",
        )
        .unwrap();

        // Only create scripts directory
        fs::create_dir(skill_dir.join("scripts")).unwrap();

        let loader = SkillLoader::new();
        let result = loader.load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::User);

        assert!(result.is_ok());
        let loaded = result.unwrap();
        assert!(loaded.resources.has_resources());
        assert!(loaded.resources.scripts_dir.is_some());
        assert!(loaded.resources.references_dir.is_none());
        assert!(loaded.resources.assets_dir.is_none());
    }

    #[test]
    fn test_skill_source_detection() {
        let content = r"---
name: source-test
description: Source test
---
Content.
";

        let loader = SkillLoader::new();

        let skill_user = loader
            .parse_skill_content(content, Path::new("test.md"), SkillSource::User)
            .unwrap();
        assert_eq!(skill_user.source, SkillSource::User);

        let skill_plugin = loader
            .parse_skill_content(content, Path::new("test.md"), SkillSource::Plugin)
            .unwrap();
        assert_eq!(skill_plugin.source, SkillSource::Plugin);
    }

    #[test]
    fn test_multiline_body() {
        let content = r"---
name: multiline-skill
description: Skill with multiline body
---
# First Section

Some content here.

## Second Section

More content.

- List item 1
- List item 2
";

        let loader = SkillLoader::new();
        let skill = loader
            .parse_skill_content(content, Path::new("test.md"), SkillSource::User)
            .unwrap();

        let prompt = skill.system_prompt_additions.unwrap();
        assert!(prompt.contains("# First Section"));
        assert!(prompt.contains("## Second Section"));
        assert!(prompt.contains("- List item 1"));
    }

    #[test]
    fn test_skill_error_display() {
        let error = SkillLoadError::ReadError {
            path: PathBuf::from("/test/path"),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "file not found"),
        };

        let display = format!("{}", error);
        assert!(display.contains("/test/path"));
        assert!(display.contains("read"));
    }

    #[test]
    fn test_default_trait() {
        let loader: SkillLoader = Default::default();
        assert!(!loader.search_paths.is_empty());
    }

    #[test]
    fn test_search_paths_accessor() {
        let paths = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        let loader = SkillLoader::with_paths(paths.clone());
        assert_eq!(loader.search_paths(), paths.as_slice());
    }

    #[test]
    fn test_load_all_nonexistent_paths() {
        let loader =
            SkillLoader::with_paths(vec![PathBuf::from("/nonexistent/path/that/does/not/exist")]);
        let results = loader.load_all();
        assert!(results.is_empty());
    }

    #[test]
    fn test_skill_in_root_of_skills_dir() {
        let temp_dir = TempDir::new().unwrap();

        // Create a "skills" directory to simulate the actual skills directory
        let skills_dir = temp_dir.path().join("skills");
        fs::create_dir(&skills_dir).unwrap();

        fs::write(
            skills_dir.join("SKILL.md"),
            r"---
name: root-skill
description: Root skill in skills directory
---
Root skill content.
",
        )
        .unwrap();

        let loader = SkillLoader::new();
        let results = loader.load_from_directory(&skills_dir);

        assert_eq!(results.len(), 1);
        assert!(results[0].is_ok());
        let skill = results[0].as_ref().unwrap();
        assert_eq!(skill.definition.name, "root-skill");
    }

    #[test]
    fn test_load_all_with_paths() {
        let temp_dir = TempDir::new().unwrap();

        // Create valid skill
        let valid_dir = temp_dir.path().join("valid");
        fs::create_dir(&valid_dir).unwrap();
        fs::write(
            valid_dir.join("SKILL.md"),
            r"---
name: valid
description: Valid skill
---
",
        )
        .unwrap();

        // Create invalid skill
        let invalid_dir = temp_dir.path().join("invalid");
        fs::create_dir(&invalid_dir).unwrap();
        fs::write(invalid_dir.join("SKILL.md"), "Invalid").unwrap();

        let loader = SkillLoader::with_paths(vec![temp_dir.path().to_path_buf()]);
        let (skills, errors) = loader.load_all_with_paths();

        assert_eq!(skills.len(), 1);
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn test_allowed_tools_parsing() {
        let content = r"---
name: tools-skill
description: Skill with multiple tools
allowed-tools: read write bash edit glob grep
---
Content.
";

        let loader = SkillLoader::new();
        let skill = loader
            .parse_skill_content(content, Path::new("test.md"), SkillSource::User)
            .unwrap();

        assert_eq!(
            skill.provided_tools,
            vec!["read", "write", "bash", "edit", "glob", "grep"]
        );
    }

    #[test]
    fn test_directory_name_mismatch() {
        let temp_dir = TempDir::new().unwrap();

        // Create a skill with a mismatched directory name
        let skill_dir = temp_dir.path().join("wrong-name");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: correct-name
description: Skill with mismatched directory
---
Content.
",
        )
        .unwrap();

        let loader = SkillLoader::new();
        let result = loader.load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::NameMismatch { .. })));
    }

    #[test]
    fn test_directory_name_matches() {
        let temp_dir = TempDir::new().unwrap();

        // Create a skill with matching directory name
        let skill_dir = temp_dir.path().join("my-skill");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: my-skill
description: Skill with matching directory
---
Content.
",
        )
        .unwrap();

        let loader = SkillLoader::new();
        let result = loader.load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::User);

        assert!(result.is_ok());
    }

    #[test]
    fn test_skills_to_prompt_empty() {
        let result = skills_to_prompt(&[]);
        assert_eq!(result, "<available_skills>\n</available_skills>");
    }

    #[test]
    fn test_skills_to_prompt_single() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join("test-skill");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: test-skill
description: A test skill for prompt generation
---
Content.
",
        )
        .unwrap();

        let loader = SkillLoader::new();
        let skill = loader
            .load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::User)
            .unwrap();

        let result = skills_to_prompt(&[skill]);

        assert!(result.contains("<available_skills>"));
        assert!(result.contains("</available_skills>"));
        assert!(result.contains("<name>test-skill</name>"));
        assert!(result.contains("<description>A test skill for prompt generation</description>"));
        assert!(result.contains("<location>"));
    }

    #[test]
    fn test_skills_to_prompt_escapes_xml() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join("xml-skill");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            r#"---
name: xml-skill
description: Skill with <xml> & "special" 'chars'
---
Content.
"#,
        )
        .unwrap();

        let loader = SkillLoader::new();
        let skill = loader
            .load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::User)
            .unwrap();

        let result = skills_to_prompt(&[skill]);

        // Check XML escaping
        assert!(result.contains("&lt;xml&gt;"));
        assert!(result.contains("&amp;"));
        assert!(result.contains("&quot;special&quot;"));
        assert!(result.contains("&#39;chars&#39;"));
    }

    #[test]
    fn test_skills_to_prompt_multiple() {
        let temp_dir = TempDir::new().unwrap();
        let mut skills = Vec::new();

        for name in &["skill-a", "skill-b"] {
            let skill_dir = temp_dir.path().join(name);
            fs::create_dir(&skill_dir).unwrap();
            fs::write(
                skill_dir.join("SKILL.md"),
                format!(
                    r"---
name: {}
description: Description for {}
---
",
                    name, name
                ),
            )
            .unwrap();

            let loader = SkillLoader::new();
            skills.push(
                loader
                    .load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::User)
                    .unwrap(),
            );
        }

        let result = skills_to_prompt(&skills);

        assert!(result.contains("<name>skill-a</name>"));
        assert!(result.contains("<name>skill-b</name>"));
        assert_eq!(result.matches("<skill>").count(), 2);
    }

    #[test]
    fn test_html_escape() {
        assert_eq!(html_escape("hello"), "hello");
        assert_eq!(html_escape("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
        assert_eq!(html_escape("a<b>c"), "a&lt;b&gt;c");
    }

    #[test]
    fn test_lowercase_skill_md() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join("lowercase-skill");
        fs::create_dir(&skill_dir).unwrap();

        // Use lowercase skill.md instead of SKILL.md
        fs::write(
            skill_dir.join("skill.md"),
            r"---
name: lowercase-skill
description: A skill with lowercase filename
---
Content.
",
        )
        .unwrap();

        let loader = SkillLoader::new();
        let results = loader.load_from_directory(temp_dir.path());

        assert_eq!(results.len(), 1);
        assert!(results[0].is_ok());
        assert_eq!(
            results[0].as_ref().unwrap().definition.name,
            "lowercase-skill"
        );
    }

    #[test]
    fn test_uppercase_preferred_over_lowercase() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join("prefer-skill");
        fs::create_dir(&skill_dir).unwrap();
        let case_sensitive = is_case_sensitive_fs();

        // Create both uppercase and lowercase - uppercase should be preferred
        fs::write(
            skill_dir.join("SKILL.md"),
            r"---
name: prefer-skill
description: From uppercase SKILL.md
---
",
        )
        .unwrap();

        fs::write(
            skill_dir.join("skill.md"),
            r"---
name: prefer-skill
description: From lowercase skill.md
---
",
        )
        .unwrap();

        let loader = SkillLoader::new();
        let skill = loader
            .load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::User)
            .unwrap();

        if case_sensitive {
            assert!(skill.definition.description.contains("uppercase"));
        } else {
            assert!(skill.definition.description.contains("lowercase"));
        }
    }

    #[test]
    fn test_unexpected_fields_rejected() {
        let content = r"---
name: field-test
description: Testing field validation
unknown_field: should fail
another_bad_field: also fails
---
Content.
";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(
            result,
            Err(SkillLoadError::UnexpectedFields { .. })
        ));

        if let Err(SkillLoadError::UnexpectedFields { fields, .. }) = result {
            assert!(fields.contains("unknown_field"));
            assert!(fields.contains("another_bad_field"));
        }
    }

    #[test]
    fn test_allowed_fields_accepted() {
        let content = r"---
name: all-fields-skill
description: Testing all allowed fields
license: MIT
compatibility: Requires Python 3.10+
allowed-tools: read write bash
metadata:
  category: testing
  priority: high
---
Content.
";

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(result.is_ok());
        let skill = result.unwrap();
        assert_eq!(skill.name, "all-fields-skill");
        assert_eq!(
            skill.metadata.get("license"),
            Some(&serde_json::json!("MIT"))
        );
    }

    #[test]
    fn test_find_skill_md_uppercase() {
        let temp_dir = TempDir::new().unwrap();
        fs::write(temp_dir.path().join("SKILL.md"), "test").unwrap();

        let result = SkillLoader::find_skill_md(temp_dir.path());
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("SKILL.md"));
    }

    #[test]
    fn test_find_skill_md_lowercase() {
        let temp_dir = TempDir::new().unwrap();
        fs::write(temp_dir.path().join("skill.md"), "test").unwrap();

        let result = SkillLoader::find_skill_md(temp_dir.path());
        assert!(result.is_some());
        let path = result.unwrap();
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if is_case_sensitive_fs() {
            assert_eq!(file_name, "skill.md");
        } else {
            assert_eq!(file_name, "SKILL.md");
        }
    }

    #[test]
    fn test_find_skill_md_none() {
        let temp_dir = TempDir::new().unwrap();

        let result = SkillLoader::find_skill_md(temp_dir.path());
        assert!(result.is_none());
    }
}
