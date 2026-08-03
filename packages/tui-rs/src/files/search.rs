//! File search with fuzzy matching
//!
//! Provides fuzzy file search for @ mentions.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

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
    #[must_use]
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

struct SearchableFile {
    file: WorkspaceFile,
    name_lower: String,
    path_lower: String,
    order: usize,
}

impl SearchableFile {
    fn new(order: usize, file: WorkspaceFile) -> Self {
        Self {
            name_lower: file.name.to_lowercase(),
            path_lower: file.relative_path.to_lowercase(),
            file,
            order,
        }
    }
}

#[derive(Clone, Copy)]
enum MatchKind {
    None,
    NameRange { start: usize, len: usize },
    NameFuzzy,
}

struct ScoredFile<'a> {
    entry: &'a SearchableFile,
    score: i32,
    order: usize,
    match_kind: MatchKind,
}

impl ScoredFile<'_> {
    fn matched_indices(&self, pattern_chars: &[char]) -> Vec<usize> {
        match self.match_kind {
            MatchKind::None => Vec::new(),
            MatchKind::NameRange { start, len } => (start..start + len).collect(),
            MatchKind::NameFuzzy => fuzzy_match(&self.entry.name_lower, pattern_chars)
                .map(|(_, indices)| indices)
                .unwrap_or_default(),
        }
    }
}

struct RankedItem<T> {
    item: T,
    score: i32,
    order: usize,
}

impl<T> PartialEq for RankedItem<T> {
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score && self.order == other.order
    }
}

impl<T> Eq for RankedItem<T> {}

impl<T> PartialOrd for RankedItem<T> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<T> Ord for RankedItem<T> {
    fn cmp(&self, other: &Self) -> Ordering {
        // BinaryHeap keeps the worst retained result at the root so a better
        // candidate can replace it without materializing every match.
        other
            .score
            .cmp(&self.score)
            .then_with(|| self.order.cmp(&other.order))
    }
}

fn select_top_k<T, I, F>(items: I, limit: usize, mut rank: F) -> Vec<T>
where
    F: FnMut(&T) -> (i32, usize),
    I: IntoIterator<Item = T>,
{
    if limit == 0 {
        return Vec::new();
    }

    // `select_nth_unstable` is faster while the candidate set is small. Keep
    // that path for normal searches, but switch to a bounded heap before a
    // large workspace can retain every matching file.
    const SMALL_CANDIDATE_LIMIT: usize = 2_048;
    let materialize_limit = limit.saturating_mul(64).min(SMALL_CANDIDATE_LIMIT);
    let mut items = items.into_iter();
    let mut prefix = Vec::with_capacity(materialize_limit.saturating_add(1));
    for _ in 0..=materialize_limit {
        let Some(item) = items.next() else {
            sort_top_k(&mut prefix, limit, &mut rank);
            return prefix;
        };
        prefix.push(item);
    }

    let mut heap = BinaryHeap::with_capacity(limit.min(SMALL_CANDIDATE_LIMIT));
    for item in prefix {
        push_ranked(&mut heap, item, limit, &mut rank);
    }
    for item in items {
        push_ranked(&mut heap, item, limit, &mut rank);
    }

    let mut items = heap
        .into_iter()
        .map(|ranked| ranked.item)
        .collect::<Vec<_>>();
    items.sort_unstable_by(|a, b| {
        let (a_score, a_order) = rank(a);
        let (b_score, b_order) = rank(b);
        b_score.cmp(&a_score).then_with(|| a_order.cmp(&b_order))
    });
    items
}

fn push_ranked<T, F>(heap: &mut BinaryHeap<RankedItem<T>>, item: T, limit: usize, rank: &mut F)
where
    F: FnMut(&T) -> (i32, usize),
{
    let (score, order) = rank(&item);
    let candidate = RankedItem { item, score, order };
    if heap.len() < limit {
        heap.push(candidate);
    } else if heap
        .peek()
        .is_some_and(|worst| candidate.cmp(worst) == Ordering::Less)
    {
        heap.pop();
        heap.push(candidate);
    }
}

fn sort_top_k<T, F>(items: &mut Vec<T>, limit: usize, rank: &mut F)
where
    F: FnMut(&T) -> (i32, usize),
{
    if items.len() > limit {
        items.select_nth_unstable_by(limit - 1, |a, b| {
            let (a_score, a_order) = rank(a);
            let (b_score, b_order) = rank(b);
            b_score.cmp(&a_score).then_with(|| a_order.cmp(&b_order))
        });
        items.truncate(limit);
    }

    items.sort_unstable_by(|a, b| {
        let (a_score, a_order) = rank(a);
        let (b_score, b_order) = rank(b);
        b_score.cmp(&a_score).then_with(|| a_order.cmp(&b_order))
    });
}

/// File search with fuzzy matching
pub struct FileSearch {
    /// Files to search
    files: Vec<SearchableFile>,
    /// Maximum results to return
    max_results: usize,
}

impl FileSearch {
    /// Create a new file search
    #[must_use]
    pub fn new(files: Vec<WorkspaceFile>) -> Self {
        let mut files: Vec<SearchableFile> = files
            .into_iter()
            .enumerate()
            .map(|(order, file)| SearchableFile::new(order, file))
            .collect();
        files.sort_unstable_by(|a, b| {
            a.file
                .name
                .cmp(&b.file.name)
                .then_with(|| a.file.relative_path.cmp(&b.file.relative_path))
                .then_with(|| a.order.cmp(&b.order))
        });

        Self {
            files,
            max_results: 50,
        }
    }

    /// Set maximum results
    #[must_use]
    pub fn max_results(mut self, max: usize) -> Self {
        self.max_results = max;
        self
    }

    /// Filter to only source code files
    #[must_use]
    pub fn source_code_only(mut self) -> Self {
        self.files.retain(|entry| entry.file.is_source_code());
        self
    }

    /// Filter to only config files
    #[must_use]
    pub fn config_only(mut self) -> Self {
        self.files.retain(|entry| entry.file.is_config());
        self
    }

    /// Filter by file extensions
    #[must_use]
    pub fn with_extensions(mut self, extensions: &[&str]) -> Self {
        self.files
            .retain(|entry| entry.file.has_extension(extensions));
        self
    }

    /// Search for files matching the query
    #[must_use]
    pub fn search(&self, query: &str) -> FileSearchResult {
        let query = query.to_lowercase();
        let total_files = self.files.len();

        if query.is_empty() {
            let matches = self
                .files
                .iter()
                .take(self.max_results)
                .map(|entry| &entry.file)
                .map(|file| FileMatch::new(file.clone(), 0, Vec::new()))
                .collect();

            return FileSearchResult {
                matches,
                total_files,
                query,
            };
        }

        if self.max_results == 0 {
            return FileSearchResult {
                matches: Vec::new(),
                total_files,
                query,
            };
        }

        let pattern_chars: Vec<char> = query.chars().collect();
        let matches = select_top_k(
            self.files
                .iter()
                .filter_map(|entry| self.score_match(entry, &query, &pattern_chars)),
            self.max_results,
            |candidate| (candidate.score, candidate.order),
        );
        let matches = matches
            .into_iter()
            .map(|candidate| {
                FileMatch::new(
                    candidate.entry.file.clone(),
                    candidate.score,
                    candidate.matched_indices(&pattern_chars),
                )
            })
            .collect();

        FileSearchResult {
            matches,
            total_files,
            query,
        }
    }

    /// Score a file against the query
    fn score_match<'a>(
        &self,
        entry: &'a SearchableFile,
        query: &str,
        pattern_chars: &[char],
    ) -> Option<ScoredFile<'a>> {
        // Try different matching strategies
        let mut best_score = 0;
        let mut match_kind = MatchKind::None;

        // Exact name match
        if entry.name_lower == query {
            return Some(ScoredFile {
                entry,
                score: 1000,
                order: entry.order,
                match_kind: MatchKind::None,
            });
        }

        // Name prefix match
        if entry.name_lower.starts_with(query) {
            let score = 800 - (entry.name_lower.len() - query.len()) as i32;
            if score > best_score {
                best_score = score;
                match_kind = MatchKind::NameRange {
                    start: 0,
                    len: query.len(),
                };
            }
        }

        // Name contains match
        if let Some(pos) = entry.name_lower.find(query) {
            let score = 600 - pos as i32;
            if score > best_score {
                best_score = score;
                match_kind = MatchKind::NameRange {
                    start: pos,
                    len: query.len(),
                };
            }
        }

        // Fuzzy match on name
        if let Some(score) = fuzzy_score(&entry.name_lower, pattern_chars) {
            let adjusted_score = score + 400;
            if adjusted_score > best_score {
                best_score = adjusted_score;
                match_kind = MatchKind::NameFuzzy;
            }
        }

        // Path contains match (lower priority)
        if best_score == 0 {
            if let Some(pos) = entry.path_lower.find(query) {
                let score = 200 - (pos as i32 / 10);
                if score > best_score {
                    best_score = score;
                    match_kind = MatchKind::None;
                }
            }
        }

        // Fuzzy match on path
        if best_score == 0 {
            if let Some(score) = fuzzy_score(&entry.path_lower, pattern_chars) {
                best_score = score;
                match_kind = MatchKind::None;
            }
        }

        if best_score > 0 {
            Some(ScoredFile {
                entry,
                score: best_score,
                order: entry.order,
                match_kind,
            })
        } else {
            None
        }
    }
}

fn fuzzy_score(text: &str, pattern: &[char]) -> Option<i32> {
    if pattern.is_empty() {
        return Some(0);
    }

    let mut pattern_idx = 0;
    let mut score: i32 = 0;
    let mut consecutive: i32 = 0;
    let mut prev_char: Option<char> = None;
    let mut char_count = 0;
    let mut matched_count = 0;

    for ch in text.chars() {
        if pattern_idx < pattern.len() && ch == pattern[pattern_idx] {
            pattern_idx += 1;
            matched_count += 1;
            consecutive += 1;
            score += 10 + consecutive * 5;
            if prev_char.is_none() || !prev_char.unwrap().is_alphanumeric() {
                score += 20;
            }
        } else {
            consecutive = 0;
        }
        prev_char = Some(ch);
        char_count += 1;
    }

    if pattern_idx == pattern.len() {
        let gap_penalty = char_count - matched_count;
        Some(score.saturating_sub(gap_penalty))
    } else {
        None
    }
}

/// Simple fuzzy matching - returns byte indices (not character indices)
fn fuzzy_match(text: &str, pattern: &[char]) -> Option<(i32, Vec<usize>)> {
    if pattern.is_empty() {
        return Some((0, vec![]));
    }

    let mut pattern_idx = 0;
    let mut matched_indices = Vec::new(); // Byte indices
    let mut score: i32 = 0;
    let mut consecutive: i32 = 0;
    let mut prev_char: Option<char> = None;
    let mut char_count = 0;

    for (byte_idx, ch) in text.char_indices() {
        if pattern_idx < pattern.len() && ch == pattern[pattern_idx] {
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

    if pattern_idx == pattern.len() {
        // Penalty for gaps
        let gap_penalty = (char_count - matched_indices.len()) as i32;
        score = score.saturating_sub(gap_penalty);
        Some((score, matched_indices))
    } else {
        None
    }
}

/// Highlight matched characters in a string (indices are byte indices)
#[must_use]
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
            extension: name.split('.').next_back().map(String::from),
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
    fn normalized_index_preserves_case_insensitive_search() {
        let search = FileSearch::new(vec![make_file("UserProfileComponent.tsx")]);

        let result = search.search("USERPROFILECOMPONENT.TSX");

        assert_eq!(result.query, "userprofilecomponent.tsx");
        assert_eq!(result.matches[0].file.name, "UserProfileComponent.tsx");
        assert_eq!(result.matches[0].score, 1000);
    }

    #[test]
    fn empty_query_returns_all() {
        let files = vec![make_file("a.rs"), make_file("b.rs"), make_file("c.rs")];
        let search = FileSearch::new(files);

        let result = search.search("");
        assert_eq!(result.matches.len(), 3);
        assert_eq!(result.matches[0].file.name, "a.rs");
        assert_eq!(result.matches[1].file.name, "b.rs");
        assert_eq!(result.matches[2].file.name, "c.rs");
    }

    #[test]
    fn nonempty_ties_preserve_input_order() {
        let search = FileSearch::new(vec![make_file("alpha.rs"), make_file("alpha.go")]);

        let result = search.search("a");

        assert_eq!(
            result
                .matches
                .iter()
                .map(|matched| matched.file.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha.rs", "alpha.go"]
        );
    }

    #[test]
    fn highlight_matches_works() {
        let result = highlight_matches("hello", &[0, 2, 4]);
        assert!(result[0].1); // 'h' matched
        assert!(!result[1].1); // 'e' not matched
        assert!(result[2].1); // 'l' matched
        assert!(!result[3].1); // 'l' not matched
        assert!(result[4].1); // 'o' matched
    }

    #[test]
    fn fuzzy_match_function() {
        let pattern: Vec<char> = "hlo".chars().collect();
        let result = fuzzy_match("hello", &pattern);
        assert!(result.is_some());
        let (score, indices) = result.unwrap();
        assert!(score > 0);
        // h at 0, first l at 2, o at 4
        assert_eq!(indices, vec![0, 2, 4]);
    }

    #[test]
    fn fuzzy_match_no_match() {
        let pattern: Vec<char> = "xyz".chars().collect();
        let result = fuzzy_match("hello", &pattern);
        assert!(result.is_none());
    }

    #[test]
    fn top_k_selection_keeps_best_scores_and_stable_ties() {
        let candidates = select_top_k(
            vec![(0usize, 10i32), (1, 30), (2, 20), (3, 30), (4, 5)],
            3,
            |(index, score)| (*score, *index),
        );

        assert_eq!(candidates, vec![(1, 30), (3, 30), (2, 20)]);
    }

    #[test]
    fn bounded_top_k_selection_keeps_best_scores_and_stable_ties() {
        let candidates = select_top_k(
            (0usize..3_000).map(|index| {
                let score = match index {
                    17 | 29 => 1_000,
                    41 => 999,
                    _ => 0,
                };
                (index, score)
            }),
            3,
            |(index, score)| (*score, *index),
        );

        assert_eq!(candidates, vec![(17, 1_000), (29, 1_000), (41, 999)]);
    }

    #[test]
    fn huge_top_k_limit_does_not_preallocate_the_requested_limit() {
        let candidates = select_top_k(
            (0usize..3_000).map(|index| (index, index as i32)),
            usize::MAX,
            |(index, score)| (*score, *index),
        );

        assert_eq!(candidates.len(), 3_000);
        assert_eq!(candidates.first(), Some(&(2_999, 2_999)));
        assert_eq!(candidates.last(), Some(&(0, 0)));
    }
}
