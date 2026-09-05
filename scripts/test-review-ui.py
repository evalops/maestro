# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2", "Pillow==11.3.0"]
# ///
"""Review acceptance must reject stale, partial, altered, and unsafe artifacts."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

spec = importlib.util.spec_from_file_location(
    "review_ui", Path(__file__).with_name("review-ui.py")
)
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "review"
        self.output.mkdir()
        (self.output / "after").mkdir()
        self.scene = {
            "id": "startup",
            "label": "Startup",
            "width": 60,
            "height": 10,
            "time_ms": 0,
        }
        self.name = review.case_name(self.scene)
        self.image = self.output / "after" / f"{self.name}.png"
        Image.new("RGB", (8, 8), "black").save(self.image)
        (self.output / "maestro-ui-preview").write_bytes(b"test binary")
        self.font = self.root / "font"
        self.font.write_bytes(b"test font")
        self.manifest = {
            "schema": review.SCHEMA,
            "complete": True,
            "source_sha256": "source",
            "binary_sha256": review.sha(self.output / "maestro-ui-preview"),
            "font": str(self.font),
            "font_sha256": review.sha(self.font),
            "scenes": [self.scene],
            "images": {self.name: review.sha(self.image)},
        }
        self.save()
        self.real_catalog = review.catalog
        for name, value in [("source_digest", "source"), ("catalog", [self.scene])]:
            mock = patch.object(review, name, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)

    def save(self):
        (self.output / "manifest.json").write_text(json.dumps(self.manifest))

    def test_accept_complete_set_atomically_and_refuse_overwrite(self):
        baseline = self.root / "baseline"
        review.accept(self.output, baseline)
        self.assertEqual(
            (baseline / self.image.name).read_bytes(), self.image.read_bytes()
        )
        with self.assertRaisesRegex(ValueError, "exists"):
            review.accept(self.output, baseline)

    def test_finder_metadata_is_not_an_accepted_artifact(self):
        (self.output / "after" / ".DS_Store").write_bytes(b"finder metadata")
        baseline = self.root / "baseline"
        review.accept(self.output, baseline)
        self.assertFalse((baseline / ".DS_Store").exists())

    def test_refuse_partial_set(self):
        self.manifest["images"] = {}
        self.save()
        with self.assertRaisesRegex(ValueError, "partial"):
            review.accept(self.output, self.root / "baseline")
        self.assertFalse((self.root / "baseline").exists())

    def test_refuse_failed_capture(self):
        self.manifest["complete"] = False
        self.save()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            review.verify_review(self.output)

    def test_refuse_stale_sources(self):
        self.manifest["source_sha256"] = "old"
        self.save()
        with self.assertRaisesRegex(ValueError, "source changed"):
            review.verify_review(self.output)

    def test_refuse_altered_image(self):
        Image.new("RGB", (8, 8), "white").save(self.image)
        with self.assertRaisesRegex(ValueError, "capture changed"):
            review.verify_review(self.output)

    def test_refuse_changed_binary_or_font(self):
        (self.output / "maestro-ui-preview").write_bytes(b"other")
        with self.assertRaisesRegex(ValueError, "binary changed"):
            review.verify_review(self.output)
        self.manifest["binary_sha256"] = review.sha(self.output / "maestro-ui-preview")
        self.save()
        self.font.write_bytes(b"other")
        with self.assertRaisesRegex(ValueError, "font changed"):
            review.verify_review(self.output)

    def test_reject_path_and_dimension_injection(self):
        for key, value in [
            ("id", "../elsewhere"),
            ("width", True),
            ("height", 0),
            ("time_ms", -1),
        ]:
            with self.assertRaises(ValueError):
                review.case_name(dict(self.scene, **{key: value}))

    def test_native_scenes_dispatch_stable_ids_without_navigation(self):
        spec = importlib.util.spec_from_file_location(
            "suite", Path(__file__).with_name("capture-tui-suite.py")
        )
        suite = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(suite)
        items = [dict(self.scene, id="accessory-crown", label="Accessory: crown")]
        with patch.object(
            suite.subprocess, "check_output", return_value=json.dumps(items)
        ):
            scene = suite.appearance_scenes("preview")[0]
        self.assertIn({"text": "/dex accessory-crown"}, scene["steps"])
        self.assertFalse(any(step.get("key") == "Down" for step in scene["steps"]))

    def test_filtered_native_baseline_records_only_selected_catalog_case(self):
        import argparse

        spec = importlib.util.spec_from_file_location(
            "suite", Path(__file__).with_name("capture-tui-suite.py")
        )
        suite = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(suite)
        items = [dict(self.scene, id="accessory-crown", label="Accessory: crown")]
        destination = self.root / "native"
        baseline = self.root / "native-baseline"

        def capture(args):
            args.output.mkdir()
            Image.new("RGB", (8, 8), "black").save(args.output / "screen.png")

        with patch.object(suite.preview, "catalog", return_value=items), patch.object(
            suite.capture_tui, "capture", side_effect=capture
        ):
            result = suite.run(argparse.Namespace(
                output=destination, record_baseline=baseline, check_baseline=None,
                catalog_binary="preview", binary="native", font=None,
                case=["accessory-crown"],
            ))
        self.assertEqual(result, 0)
        self.assertEqual(
            [path.name for path in baseline.iterdir()],
            ["accessory-crown-100x30.png"],
        )
        self.assertEqual(len(json.loads((destination / "results.json").read_text())), 1)

    def test_reject_unverified_extra_files_and_symlinks(self):
        extra = self.output / "after" / "unexpected.txt"
        extra.write_text("unreviewed")
        with self.assertRaisesRegex(ValueError, "image set"):
            review.verify_review(self.output)
        extra.unlink()
        self.image.unlink()
        self.image.symlink_to(self.font)
        with self.assertRaisesRegex(ValueError, "regular file"):
            review.verify_review(self.output)

    def test_catalog_rejects_malformed_and_duplicate_entries(self):
        for value in [
            None,
            {},
            [],
            [None],
            [5],
            [dict(self.scene, id=3)],
            [self.scene, self.scene],
        ]:
            with patch.object(review, "run", return_value=json.dumps(value)):
                with self.assertRaises(ValueError):
                    self.real_catalog("preview")

    def invoke_review(
        self, destination, baseline=None, source_values=None, identity="source"
    ):
        def execute(command, **kwargs):
            return identity if "--identity" in command else "ready"

        def render(screen, output, font):
            Image.new("RGB", (8, 8), "black").save(output)

        with (
            patch.object(
                review, "build", return_value=self.output / "maestro-ui-preview"
            ),
            patch.object(review.capture, "font_path", return_value=self.font),
            patch.object(review.capture, "render_png", side_effect=render),
            patch.object(review, "run", side_effect=execute),
        ):
            if source_values:
                with patch.object(review, "source_digest", side_effect=source_values):
                    return review.review(destination, baseline)
            return review.review(destination, baseline)

    def test_orchestration_compares_before_after_and_detects_source_race(self):
        baseline = self.root / "baseline"
        review.accept(self.output, baseline)
        result = self.invoke_review(self.root / "next", baseline)
        self.assertTrue(result["complete"])
        self.assertEqual(result["comparison"][self.name], "unchanged")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            self.invoke_review(self.root / "raced", source_values=["source", "changed"])
        self.assertFalse((self.root / "raced" / "manifest.json").exists())

    def test_orchestration_refuses_wrong_shared_binary_and_altered_baseline(self):
        with self.assertRaisesRegex(ValueError, "copied preview"):
            self.invoke_review(self.root / "wrong-binary", identity="other checkout")
        baseline = self.root / "baseline"
        review.accept(self.output, baseline)
        Image.new("RGB", (8, 8), "white").save(baseline / self.image.name)
        with self.assertRaisesRegex(ValueError, "baseline changed"):
            self.invoke_review(self.root / "altered", baseline)

    def test_orchestration_refuses_font_mismatch_and_reports_removed_scenes(self):
        baseline = self.root / "baseline"
        review.accept(self.output, baseline)
        manifest = json.loads((baseline / "manifest.json").read_text())
        manifest["font_sha256"] = "other"
        (baseline / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "font differs"):
            self.invoke_review(self.root / "font-mismatch", baseline)
        manifest["font_sha256"] = review.sha(self.font)
        removed = dict(self.scene, id="header")
        name = review.case_name(removed)
        manifest["scenes"].append(removed)
        manifest["images"][name] = review.sha(self.image)
        (baseline / f"{name}.png").write_bytes(self.image.read_bytes())
        (baseline / "manifest.json").write_text(json.dumps(manifest))
        result = self.invoke_review(self.root / "removed", baseline)
        self.assertEqual(result["comparison"][name], "removed")

    def test_generated_native_scenarios_pass_real_loader(self):
        spec = importlib.util.spec_from_file_location(
            "suite", Path(__file__).with_name("capture-tui-suite.py")
        )
        suite = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(suite)
        items = [dict(self.scene, id="accessory-crown", label="Accessory: crown")]
        with patch.object(suite.preview, "catalog", return_value=items):
            for scene in suite.appearance_scenes("preview"):
                path = self.root / (scene["name"] + ".json")
                path.write_text(json.dumps(scene))
                self.assertEqual(
                    review.capture.load_scenario(path)["name"], scene["name"]
                )


if __name__ == "__main__":
    unittest.main()
