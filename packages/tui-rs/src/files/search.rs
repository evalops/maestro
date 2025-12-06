//! File search with fuzzy matching
//!
//! Provides fuzzy file search for @ mentions.

use super::workspace::WorkspaceFile;

/// A file match with score
#[derive(Debug, Clone)]
pub struct FileMatch {
    /// The matched file
    pub file: WorkspaceFile,
    /// Match score (higher is better)
    pub score: i32,
    /// Indices of matched characters (for highlighting)
    pub matched_indices: Vec<usize>,
}

impl FileMatch {
    pub fn new(file: WorkspaceFile, score: i32, matched_indices: Vec<usize>) -> Self {
        Self {
            file,
            score,
            matched_indices,
        }
    }
}

/// Result of a file search
#[derive(Debug, Clone, Default)]
pub struct FileSearchResult {
    /// Matched files
    pub matches: Vec<FileMatch>,
    /// Total files searched
    pub total_files: usize,
    /// Search query
    pub query: String,
}

/// File search with fuzzy matching
pub struct FileSearch {
    /// Files to search
    files: Vec<WorkspaceFile>,
    /// Maximum results to return
    max_results: usize,
}

impl FileSearch {
    /// Create a new file search
    pub fn new(files: Vec<WorkspaceFile>) -> Self {
        Self {
            files,
            max_results: 50,
        }
    }

    /// Set maximum results
    pub fn max_results(mut self, max: usize) -> Self {
        self.max_results = max;
        self
    }

    /// Search for files matching the query
    pub fn search(&self, query: &str) -> FileSearchResult {
        let query = query.to_lowercase();
        let total_files = self.files.len();

        if query.is_empty() {
            // Return all files sorted by name
            let matches: Vec<FileMatch> = self
                .files
                .iter()
                .take(self.max_results)
                .map(|f| FileMatch::new(f.clone(), 0, vec![]))
                .collect();

            return FileSearchResult {
                matches,
                total_files,
                query: query.to_string(),
            };
        }

        let mut matches: Vec<FileMatch> = self
            .files
            .iter()
            .filter_map(|file| self.score_match(file, &query))
            .collect();

        // Sort by score descending
        matches.sort_by(|a, b| b.score.cmp(&a.score));
        matches.truncate(self.max_results);

        FileSearchResult {
            matches,
            total_files,
            query: query.to_string(),
        }
    }

    /// Score a file against the query
    fn score_match(&self, file: &WorkspaceFile, query: &str) -> Option<FileMatch> {
        let name_lower = file.name.to_lowercase();
        let path_lower = file.relative_path.to_lowercase();

        // Try different matching strategies
        let mut best_score = 0;
        let mut best_indices = Vec::new();

        // Exact name match
        if name_lower == query {
            return Some(FileMatch::new(file.clone(), 1000, vec![]));
        }

        // Name prefix match
        if name_lower.starts_with(query) {
            let score = 800 - (name_lower.len() - query.len()) as i32;
            if score > best_score {
                best_score = score;
                best_indices = (0..query.len()).collect();
            }
        }

        // Name contains match
        if let Some(pos) = name_lower.find(query) {
            let score = 600 - pos as i32;
            if score > best_score {
                best_score = score;
                best_indices = (pos..pos + query.len()).collect();
            }
        }

        // Fuzzy match on name
        if let Some((score, indices)) = fuzzy_match(&name_lower, query) {
            let adjusted_score = score + 400;
            if adjusted_score > best_score {
                best_score = adjusted_score;
                best_indices = indices;
            }
        }

        // Path contains match (lower priority)
        if best_score == 0 {
            if let Some(pos) = path_lower.find(query) {
                let score = 200 - (pos as i32 / 10);
                if score > best_score {
                    best_score = score;
                    best_indices = vec![];
                }
            }
        }

        // Fuzzy match on path
        if best_score == 0 {
            if let Some((score, _indices)) = fuzzy_match(&path_lower, query) {
                best_score = score;
                best_indices = vec![];
            }
        }

        if best_score > 0 {
            Some(FileMatch::new(file.clone(), best_score, best_indices))
        } else {
            None
        }
    }
}

/// Simple fuzzy matching - returns byte indices (not character indices)
fn fuzzy_match(text: &str, pattern: &str) -> Option<(i32, Vec<usize>)> {
    let pattern_chars: Vec<char> = pattern.chars().collect();

    if pattern_chars.is_empty() {
        return Some((0, vec![]));
    }

    let mut pattern_idx = 0;
    let mut matched_indices = Vec::new(); // Byte indices
    let mut score: i32 = 0;
    let mut consecutive: i32 = 0;
    let mut prev_char: Option<char> = None;
    let mut char_count = 0;

    for (byte_idx, ch) in text.char_indices() {
        if pattern_idx < pattern_chars.len() && ch == pattern_chars[pattern_idx] {
            matched_indices.push(byte_idx); // Use byte index, not char index
            pattern_idx += 1;
            consecutive += 1;
            // Bonus for consecutive matches
            score += 10 + consecutive * 5;
            // Bonus for matching at word boundaries
            if prev_char.is_none() || !prev_char.unwrap().is_alphanumeric() {
                score += 20;
            }
        } else {
            consecutive = 0;
        }
        prev_char = Some(ch);
        char_count += 1;
    }

    if pattern_idx == pattern_chars.len() {
        // Penalty for gaps
        let gap_penalty = (char_count - matched_indices.len()) as i32;
        score = score.saturating_sub(gap_penalty);
        Some((score, matched_indices))
    } else {
        None
    }
}

/// Highlight matched characters in a string (indices are byte indices)
pub fn highlight_matches(text: &str, byte_indices: &[usize]) -> Vec<(char, bool)> {
    text.char_indices()
        .map(|(byte_idx, c)| (c, byte_indices.contains(&byte_idx)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn make_file(name: &str) -> WorkspaceFile {
        WorkspaceFile {
            path: PathBuf::from(format!("/test/{}", name)),
            relative_path: name.to_string(),
            name: name.to_string(),
            extension: name.split('.').last().map(String::from),
            is_dir: false,
        }
    }

    #[test]
    fn exact_match_scores_highest() {
        let files = vec![
            make_file("main.rs"),
            make_file("main.go"),
            make_file("other.rs"),
        ];
        let search = FileSearch::new(files);

        let result = search.search("main.rs");
        assert_eq!(result.matches[0].file.name, "main.rs");
        assert_eq!(result.matches[0].score, 1000);
    }

    #[test]
    fn prefix_match_works() {
        let files = vec![
            make_file("component.tsx"),
            make_file("config.json"),
            make_file("readme.md"),
        ];
        let search = FileSearch::new(files);

        let result = search.search("com");
        assert!(result.matches[0].file.name.starts_with("com"));
    }

    #[test]
    fn fuzzy_match_works() {
        let files = vec![
            make_file("UserProfileComponent.tsx"),
            make_file("readme.md"),
        ];
        let search = FileSearch::new(files);

        let result = search.search("upc");
        assert!(!result.matches.is_empty());
        assert_eq!(result.matches[0].file.name, "UserProfileComponent.tsx");
    }

    #[test]
    fn empty_query_returns_all() {
        let files = vec![
            make_file("a.rs"),
            make_file("b.rs"),
            make_file("c.rs"),
        ];
        let search = FileSearch::new(files);

        let result = search.search("");
        assert_eq!(result.matches.len(), 3);
    }

    #[test]
    fn highlight_matches_works() {
        let result = highlight_matches("hello", &[0, 2, 4]);
        assert!(result[0].1);  // 'h' matched
        assert!(!result[1].1); // 'e' not matched
        assert!(result[2].1);  // 'l' matched
        assert!(!result[3].1); // 'l' not matched
        assert!(result[4].1);  // 'o' matched
    }

    #[test]
    fn fuzzy_match_function() {
        let result = fuzzy_match("hello", "hlo");
        assert!(result.is_some());
        let (score, indices) = result.unwrap();
        assert!(score > 0);
        // h at 0, first l at 2, o at 4
        assert_eq!(indices, vec![0, 2, 4]);
    }

    #[test]
    fn fuzzy_match_no_match() {
        let result = fuzzy_match("hello", "xyz");
        assert!(result.is_none());
    }
}
