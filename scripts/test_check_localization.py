"""Regression coverage for display literals that previously bypassed the catalog."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('catalog_check', Path(__file__).with_name('check-localization.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class DisplayCoverage(unittest.TestCase):
    def test_rejects_untranslated_widgets_and_async_status(self):
        for source in ['Span::raw("version ")', 'Paragraph::new("Review access")',
                       'self.state.status\n.replace(format!("Goal {} paused", id))']:
            self.assertEqual(len(check.unlocalized_display(source)), 1, source)

    def test_preserves_dynamic_content_and_keyboard_tokens(self):
        for source in ['Span::raw(user_text)', 'Span::styled("Ctrl+C", style)',
                       'Line::from(format!("{title}: {value}"))',
                       'Paragraph::new(locale.translate("Review access"))']:
            self.assertEqual(check.unlocalized_display(source), [], source)

    def test_ignores_comments_and_test_modules_not_later_production_code(self):
        source = '''// Span::raw("Example text")
#[cfg(test)]
mod tests {
    let brace = '}';
    let raw = r#"{ // raw text }"#;
    let multiline = "first \\
        second";
    Span::raw("Fixture text");
}
fn real_render() { Span::raw("Actual label"); }
'''
        self.assertEqual([key for _, key in check.unlocalized_display(source)], ['Actual label'])

    def test_comment_marker_in_copy_is_preserved(self):
        self.assertEqual(check.unlocalized_display('Line::from("Open https://example.com")'),
                         [(1, 'Open https://example.com')])


if __name__ == '__main__':
    unittest.main()
