"""Regression checks for the upstream-color to native-role mapping."""
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("mapper", Path(__file__).with_name("map-vscode-themes.py"))
mapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mapper)


class ThemeMappingTests(unittest.TestCase):
    def test_palette_owns_canvas_panel_selection_and_dex_accent(self):
        result = mapper.map_theme({"name": "test", "uiTheme": "vs", "theme": {"colors": {
            "editor.background": "#fff", "editor.foreground": "#123456",
            "input.background": "#eeeeee", "list.inactiveSelectionBackground": "#00000080",
            "textLink.foreground": "#369", "terminal.ansiRed": "#ff0000",
        }}})["colors"]
        self.assertEqual(result["assistant_message_bg"], "#ffffff")
        self.assertEqual(result["user_message_bg"], "#eeeeee")
        self.assertEqual(result["tool_pending_bg"], "#777777")
        self.assertEqual(result["accent"], "#336699")
        self.assertEqual(result["error"], "#ff0000")
        self.assertEqual(result["text"], "#123456")

    def test_specific_scopes_and_semantic_tokens_override_generic_rules(self):
        theme = {"tokenColors": [
            {"scope": "variable.other", "settings": {"foreground": "#123456"}},
            {"scope": ["variable", "string"], "settings": {"foreground": "#654321"}},
            {"scope": "source.rust variable.other", "settings": {"foreground": "#ffffff"}},
        ]}
        self.assertEqual(mapper.token(theme, ["variable.other.readwrite"], "#000000", "#ffffff"), "#123456")
        theme["semanticTokenColors"] = {"variable": {"foreground": "#abcdef"}}
        self.assertEqual(mapper.token(theme, ["variable.other.readwrite"], "#000000", "#ffffff", ["variable"]), "#abcdef")

    def test_alpha_is_composited_including_short_hex(self):
        self.assertEqual(mapper.color("#0000", "#ffffff"), "#ffffff")
        self.assertEqual(mapper.color("#fff8", "#000000"), "#888888")
        self.assertIsNone(mapper.color("#12345", "#ffffff"))

    def test_bundled_sources_reproduce_all_registered_palettes(self):
        source = json.loads((mapper.DEST / "source.json").read_text())
        themes = json.loads((mapper.DEST / "themes.json").read_text())
        self.assertEqual(source["commit"], mapper.COMMIT)
        self.assertEqual(themes, [mapper.map_theme(entry) for entry in source["themes"]])
        self.assertEqual(len(themes), 19)
        self.assertEqual(len({theme["name"] for theme in themes}), 19)
        for entry, theme in zip(source["themes"], themes):
            raw = entry["theme"]["colors"].get("editor.background")
            if raw:
                self.assertEqual(theme["colors"]["assistant_message_bg"], mapper.color(raw, "#ffffff" if entry["uiTheme"] in ("vs", "hc-light") else "#000000"))
            for value in theme["colors"].values():
                self.assertRegex(value, r"^#[0-9a-f]{6}$")


if __name__ == "__main__":
    unittest.main()
