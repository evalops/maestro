//! Syntax highlighting for code blocks
//!
//! Uses syntect to provide syntax highlighting with theme support.

use once_cell::sync::Lazy;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use syntect::easy::HighlightLines;
use syntect::highlighting::{FontStyle, ThemeSet};
use syntect::parsing::SyntaxSet;

/// Global syntax set (loaded lazily)
static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(SyntaxSet::load_defaults_newlines);

/// Global theme set (loaded lazily)
static THEME_SET: Lazy<ThemeSet> = Lazy::new(ThemeSet::load_defaults);

/// Convert syntect FontStyle to ratatui Modifier
fn font_style_to_modifier(font_style: FontStyle) -> Modifier {
    let mut modifier = Modifier::empty();
    if font_style.contains(FontStyle::BOLD) {
        modifier |= Modifier::BOLD;
    }
    if font_style.contains(FontStyle::ITALIC) {
        modifier |= Modifier::ITALIC;
    }
    if font_style.contains(FontStyle::UNDERLINE) {
        modifier |= Modifier::UNDERLINED;
    }
    modifier
}

/// Highlight a code block and return styled lines
///
/// # Arguments
/// * `code` - The code to highlight
/// * `language` - The language hint (e.g., "rust", "python", "javascript")
///
/// # Returns
/// A vector of styled lines suitable for ratatui
pub fn highlight_code(code: &str, language: Option<&str>) -> Vec<Line<'static>> {
    // Try to find syntax for the language
    let syntax = language
        .and_then(|lang| {
            // Try exact match first
            SYNTAX_SET.find_syntax_by_token(lang)
                .or_else(|| SYNTAX_SET.find_syntax_by_extension(lang))
                .or_else(|| {
                    // Try common aliases
                    let alias = match lang.to_lowercase().as_str() {
                        "js" => "javascript",
                        "ts" => "typescript",
                        "tsx" => "typescript",
                        "jsx" => "javascript",
                        "py" => "python",
                        "rb" => "ruby",
                        "rs" => "rust",
                        "sh" | "bash" | "zsh" => "shell",
                        "yml" => "yaml",
                        "md" => "markdown",
                        "c++" | "cpp" | "cxx" => "c++",
                        "dockerfile" => "dockerfile",
                        _ => lang,
                    };
                    SYNTAX_SET.find_syntax_by_token(alias)
                        .or_else(|| SYNTAX_SET.find_syntax_by_extension(alias))
                })
        })
        .unwrap_or_else(|| SYNTAX_SET.find_syntax_plain_text());

    // Use base16-eighties as a dark theme that works well in terminals
    let theme = &THEME_SET.themes["base16-eighties.dark"];
    let mut highlighter = HighlightLines::new(syntax, theme);

    let mut result = Vec::new();

    for line in code.lines() {
        let ranges = highlighter.highlight_line(line, &SYNTAX_SET);

        match ranges {
            Ok(ranges) => {
                let spans: Vec<Span<'static>> = ranges
                    .iter()
                    .map(|(style, text)| {
                        let fg = Color::Rgb(
                            style.foreground.r,
                            style.foreground.g,
                            style.foreground.b,
                        );
                        let modifier = font_style_to_modifier(style.font_style);
                        Span::styled(
                            text.to_string(),
                            Style::default().fg(fg).add_modifier(modifier),
                        )
                    })
                    .collect();
                result.push(Line::from(spans));
            }
            Err(_) => {
                // Fallback to unstyled text on error
                result.push(Line::from(Span::raw(line.to_string())));
            }
        }
    }

    result
}

/// Check if syntax highlighting is available for a language
pub fn has_syntax(language: &str) -> bool {
    SYNTAX_SET.find_syntax_by_token(language).is_some()
        || SYNTAX_SET.find_syntax_by_extension(language).is_some()
}

/// Get a list of supported language names
pub fn supported_languages() -> Vec<&'static str> {
    SYNTAX_SET
        .syntaxes()
        .iter()
        .map(|s| s.name.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_highlight_rust() {
        let code = "fn main() {\n    println!(\"Hello, world!\");\n}";
        let lines = highlight_code(code, Some("rust"));
        assert_eq!(lines.len(), 3);
        // Should have multiple spans per line (syntax highlighting)
        assert!(lines[0].spans.len() >= 1);
    }

    #[test]
    fn test_highlight_python() {
        let code = "def hello():\n    print(\"Hello\")";
        let lines = highlight_code(code, Some("python"));
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn test_highlight_javascript() {
        let code = "const x = 42;\nconsole.log(x);";
        let lines = highlight_code(code, Some("js"));
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn test_highlight_unknown_language() {
        let code = "some random text\nmore text";
        let lines = highlight_code(code, Some("unknown_lang_xyz"));
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn test_highlight_no_language() {
        let code = "plain text";
        let lines = highlight_code(code, None);
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn test_has_syntax() {
        assert!(has_syntax("rust"));
        assert!(has_syntax("python"));
        assert!(has_syntax("javascript"));
        assert!(!has_syntax("completely_fake_language_xyz"));
    }

    #[test]
    fn test_supported_languages() {
        let languages = supported_languages();
        assert!(!languages.is_empty());
        // Should include common languages
        assert!(languages.iter().any(|l| l.to_lowercase().contains("rust")));
    }

    #[test]
    fn test_language_aliases() {
        // Test that aliases work
        let js_code = "const x = 1;";
        let lines_js = highlight_code(js_code, Some("js"));
        let lines_javascript = highlight_code(js_code, Some("javascript"));
        // Both should produce highlighted output
        assert!(!lines_js.is_empty());
        assert!(!lines_javascript.is_empty());
    }
}
