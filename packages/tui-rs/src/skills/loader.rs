//! Skill Loader
//!
//! Provides filesystem-based skill discovery and loading from SKILL.md files
//! following the Agent Skills specification (https://agentskills.io/specification).
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
//! use composer_tui::skills::loader::SkillLoader;
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
}

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
    pub fn has_resources(&self) -> bool {
        self.scripts_dir.is_some() || self.references_dir.is_some() || self.assets_dir.is_some()
    }
}

/// Loader for filesystem-based skills following the Agent Skills spec
#[derive(Debug)]
pub struct SkillLoader {
    /// Directories to search for skills
    search_paths: Vec<PathBuf>,
}

impl SkillLoader {
    /// Create a new skill loader with default search paths
    pub fn new() -> Self {
        let mut search_paths = Vec::new();

        // Add global user skills directory
        if let Some(home) = dirs::home_dir() {
            search_paths.push(home.join(".composer").join("skills"));
        }

        // Add project-specific skills directory
        search_paths.push(PathBuf::from(".composer").join("skills"));

        Self { search_paths }
    }

    /// Create a loader with custom search paths
    pub fn with_paths(paths: Vec<PathBuf>) -> Self {
        Self {
            search_paths: paths,
        }
    }

    /// Add a search path
    pub fn add_search_path(&mut self, path: PathBuf) {
        self.search_paths.push(path);
    }

    /// Get the search paths
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
                        "Invalid character '{}'. Only lowercase letters, digits, and hyphens allowed",
                        c
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

    /// Load all skills from all search paths
    pub fn load_all(&self) -> Vec<Result<LoadedSkill, SkillLoadError>> {
        let mut results = Vec::new();

        for search_path in &self.search_paths {
            if search_path.exists() && search_path.is_dir() {
                results.extend(self.load_from_directory(search_path));
            }
        }

        results
    }

    /// Load skills from a specific directory
    pub fn load_from_directory(&self, dir: &Path) -> Vec<Result<LoadedSkill, SkillLoadError>> {
        let mut results = Vec::new();

        // Look for SKILL.md directly in the skills directory (single-file skill)
        let skill_file = dir.join("SKILL.md");
        if skill_file.exists() {
            results.push(self.load_skill_file(&skill_file, SkillSource::User));
        }

        // Look for subdirectories containing SKILL.md
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    let skill_file = path.join("SKILL.md");
                    if skill_file.exists() {
                        // Determine source based on path
                        let source = if dir.starts_with(
                            dirs::home_dir()
                                .unwrap_or_default()
                                .join(".composer")
                                .join("skills"),
                        ) {
                            SkillSource::User
                        } else {
                            SkillSource::Plugin
                        };
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

        Ok(LoadedSkill {
            definition,
            source_path: path.to_path_buf(),
            skill_dir,
            resources,
        })
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

        // Parse YAML frontmatter
        let frontmatter: SkillFrontmatter =
            serde_yaml::from_str(&frontmatter_str).map_err(|e| SkillLoadError::YamlParseError {
                path: path.to_path_buf(),
                message: e.to_string(),
            })?;

        // Validate name per spec
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

    fn create_skill_file(dir: &Path, content: &str) -> PathBuf {
        let skill_file = dir.join("SKILL.md");
        fs::write(&skill_file, content).unwrap();
        skill_file
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
        let content = r#"---
name: test-skill
description: A test skill for testing purposes
allowed-tools: read write
---
# Test Instructions

This is the system prompt for the test skill.
"#;

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
        let content = r#"---
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
"#;

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
        let content = r#"---
name: no-body-skill
description: A skill without a body
---
"#;

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
            r#"---
name: {}
description: Too long name
---
Content.
"#,
            long_name
        );

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(&content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_uppercase() {
        let content = r#"---
name: UpperCase
description: Uppercase name
---
Content.
"#;

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_leading_hyphen() {
        let content = r#"---
name: -leading-hyphen
description: Leading hyphen
---
Content.
"#;

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_trailing_hyphen() {
        let content = r#"---
name: trailing-hyphen-
description: Trailing hyphen
---
Content.
"#;

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::InvalidName { .. })));
    }

    #[test]
    fn test_name_validation_consecutive_hyphens() {
        let content = r#"---
name: double--hyphen
description: Consecutive hyphens
---
Content.
"#;

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
                r#"---
name: {}
description: Valid name test
---
Content.
"#,
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
        let content = r#"---
name: broken
description: Missing end delimiter
"#;

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(
            result,
            Err(SkillLoadError::MissingFrontmatter { .. })
        ));
    }

    #[test]
    fn test_invalid_yaml() {
        let content = r#"---
name: [invalid yaml
description: test
---
Content.
"#;

        let loader = SkillLoader::new();
        let result = loader.parse_skill_content(content, Path::new("test.md"), SkillSource::User);

        assert!(matches!(result, Err(SkillLoadError::YamlParseError { .. })));
    }

    #[test]
    fn test_load_skill_file() {
        let temp_dir = TempDir::new().unwrap();
        let skill_content = r#"---
name: file-test
description: Testing file loading
---
File loaded successfully.
"#;

        let skill_path = create_skill_file(temp_dir.path(), skill_content);
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
            r#"---
name: my-skill
description: A test skill
---
Skill content.
"#,
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
                    r#"---
name: {}
description: Skill description for {}
---
Content.
"#,
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
            r#"---
name: test-skill
description: A test skill
---
Content.
"#,
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
            r#"---
name: registry-skill
description: A skill for registry testing
---
Registered content.
"#,
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
            r#"---
name: valid-skill
description: A valid skill
---
Content.
"#,
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
            r#"---
name: resource-skill
description: A skill with resources
---
Content.
"#,
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
            r#"---
name: partial-resource
description: A skill with partial resources
---
Content.
"#,
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
        let content = r#"---
name: source-test
description: Source test
---
Content.
"#;

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
        let content = r#"---
name: multiline-skill
description: Skill with multiline body
---
# First Section

Some content here.

## Second Section

More content.

- List item 1
- List item 2
"#;

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

        fs::write(
            temp_dir.path().join("SKILL.md"),
            r#"---
name: root-skill
description: Root skill in skills directory
---
Root skill content.
"#,
        )
        .unwrap();

        let loader = SkillLoader::new();
        let results = loader.load_from_directory(temp_dir.path());

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
            r#"---
name: valid
description: Valid skill
---
"#,
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
        let content = r#"---
name: tools-skill
description: Skill with multiple tools
allowed-tools: read write bash edit glob grep
---
Content.
"#;

        let loader = SkillLoader::new();
        let skill = loader
            .parse_skill_content(content, Path::new("test.md"), SkillSource::User)
            .unwrap();

        assert_eq!(
            skill.provided_tools,
            vec!["read", "write", "bash", "edit", "glob", "grep"]
        );
    }
}
