#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2", "Pillow==11.3.0"]
# ///
"""Build native shared widgets, render their catalog, and review explicit baselines."""

import argparse
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PRODUCT = HERE.parent
SCHEMA = 1
spec = importlib.util.spec_from_file_location("capture_tui", HERE / "capture-tui.py")
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(command, **kwargs):
    return subprocess.check_output(
        command, text=True, timeout=kwargs.pop("timeout", 120), **kwargs
    )


def source_digest():
    # Include ignored-independent source additions and all tracked inputs outside PNG
    # baselines. Cargo remains the build freshness authority; this binds review output.
    paths = run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
    ).split("\0")
    digest = hashlib.sha256()
    for name in sorted(set(filter(None, paths))):
        if name.startswith(
            "products/maestro/test/fixtures/tui-capture/baselines/"
        ) and name.endswith(".png"):
            continue
        path = ROOT / name
        digest.update(name.encode() + b"\0")
        if path.is_symlink():
            digest.update(b"link\0" + os.readlink(path).encode())
        elif path.is_file():
            digest.update(path.read_bytes())
        else:
            digest.update(b"missing")
        digest.update(b"\0")
    return digest.hexdigest()


def case_name(scene):
    if not isinstance(scene, dict) or set(scene) != {
        "id",
        "label",
        "width",
        "height",
        "time_ms",
    }:
        raise ValueError("invalid scene schema")
    if not isinstance(scene["id"], str) or not re.fullmatch(
        r"[a-z0-9]+(?:-[a-z0-9]+)*", scene["id"]
    ):
        raise ValueError("unsafe scene ID")
    if not isinstance(scene["label"], str):
        raise ValueError("invalid scene label")
    for field, low, high in [
        ("width", 8, 240),
        ("height", 3, 100),
        ("time_ms", 0, 86400000),
    ]:
        if type(scene[field]) is not int or not low <= scene[field] <= high:
            raise ValueError(f"invalid {field}")
    return f"{scene['id']}-{scene['width']}x{scene['height']}-{scene['time_ms']}ms"


def catalog(binary):
    scenes = json.loads(run([str(binary), "--list"]))
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("empty scene catalog")
    names = [case_name(scene) for scene in scenes]
    if len(set(names)) != len(names):
        raise ValueError("duplicate scene ID and dimensions")
    return scenes


def build(expected_source=None):
    env = dict(os.environ)
    target = Path(
        env.setdefault(
            "CARGO_TARGET_DIR",
            str(
                Path(env.get("XDG_CACHE_HOME", Path.home() / ".cache"))
                / "platform-target"
            ),
        )
    ).resolve()
    env["CARGO_TARGET_DIR"] = str(target)
    env["MAESTRO_PREVIEW_SOURCE_DIGEST"] = expected_source or source_digest()
    env.setdefault("CARGO_BUILD_JOBS", "4")
    env.setdefault("CARGO_INCREMENTAL", "0")
    env.setdefault("CARGO_PROFILE_DEV_DEBUG", "0")
    subprocess.run(
        ["make", "local-build-capacity-check"], cwd=ROOT, env=env, check=True
    )
    # Always let Cargo validate its complete dependency graph before reusing a binary.
    output = run(
        [
            "cargo",
            "build",
            "--manifest-path",
            str(PRODUCT / "Cargo.toml"),
            "--locked",
            "-p",
            "maestro-ui-preview",
            "--bin",
            "maestro-ui-preview",
            "--message-format=json",
        ],
        cwd=ROOT,
        env=env,
        timeout=1200,
    )
    executables = [
        entry["executable"]
        for line in output.splitlines()
        if (entry := json.loads(line)).get("reason") == "compiler-artifact"
        and entry.get("executable")
        and entry["target"]["name"] == "maestro-ui-preview"
    ]
    if len(executables) != 1:
        raise ValueError("Cargo did not identify exactly one preview executable")
    binary = Path(executables[0])
    if run([str(binary), "--identity"]).strip() != env["MAESTRO_PREVIEW_SOURCE_DIGEST"]:
        raise ValueError("shared build output changed before capture; retry")
    return binary


def verify_review(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("schema") != SCHEMA or manifest.get("complete") is not True:
        raise ValueError("incomplete or incompatible review")
    if manifest["source_sha256"] != source_digest():
        raise ValueError("source changed since capture; regenerate the review")
    binary = directory / "maestro-ui-preview"
    if sha(binary) != manifest["binary_sha256"]:
        raise ValueError("preview binary changed")
    if sha(manifest["font"]) != manifest["font_sha256"]:
        raise ValueError("font changed")
    scenes = catalog(binary)
    expected = {case_name(scene) for scene in scenes}
    if manifest["scenes"] != scenes or set(manifest["images"]) != expected:
        raise ValueError("partial or changed scene catalog")
    if {p.name for p in (directory / "after").iterdir() if p.name != ".DS_Store"} != {
        name + ".png" for name in expected
    }:
        raise ValueError("image set does not match catalog")
    for name, digest in manifest["images"].items():
        if (directory / "after" / f"{name}.png").is_symlink():
            raise ValueError("capture must be a regular file")
        if sha(directory / "after" / f"{name}.png") != digest:
            raise ValueError(f"capture changed: {name}")
    return manifest


def accept(directory, baseline):
    manifest = verify_review(directory)
    # A new versioned directory avoids silently replacing a previously reviewed set.
    if baseline.exists():
        raise ValueError(
            "baseline destination exists; choose a new reviewed baseline directory"
        )
    baseline.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".baseline-", dir=baseline.parent) as temp:
        stage = Path(temp) / "accepted"
        stage.mkdir()
        for name in manifest["images"]:
            shutil.copy2(directory / "after" / f"{name}.png", stage / f"{name}.png")
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        stage.rename(baseline)


def review(output, baseline=None, font=None, scene_ids=None):
    if output.exists():
        raise ValueError("output exists; choose a new review directory")
    if output.is_relative_to(ROOT):
        ignored = (
            subprocess.run(
                ["git", "check-ignore", "-q", str(output / "manifest.json")], cwd=ROOT
            ).returncode
            == 0
        )
        if not ignored:
            raise ValueError(
                "review output must be outside the checkout or in a git-ignored directory"
            )
    before_source = source_digest()
    binary = build(before_source)
    font = capture.font_path(font)
    output.mkdir(parents=True)
    pinned = output / "maestro-ui-preview"
    shutil.copy2(binary, pinned)
    scenes = catalog(pinned)
    if scene_ids:
        requested = set(scene_ids)
        missing = requested - {scene["id"] for scene in scenes}
        if missing:
            raise ValueError("unknown scene: " + ", ".join(sorted(missing)))
        scenes = [scene for scene in scenes if scene["id"] in requested]
    if run([str(pinned), "--identity"]).strip() != before_source:
        raise ValueError("copied preview does not match current source inputs")
    manifest = {
        "schema": SCHEMA,
        "complete": False,
        "selection": sorted(set(scene_ids or [])),
        "source_sha256": before_source,
        "binary_sha256": sha(pinned),
        "font": str(font),
        "font_sha256": sha(font),
        "scenes": scenes,
        "images": {},
        "comparison": {},
    }
    for name in ["before", "after", "diff"]:
        (output / name).mkdir()
    baseline_manifest = None
    if baseline:
        baseline_manifest = json.loads((baseline / "manifest.json").read_text())
        if (
            baseline_manifest.get("schema") != SCHEMA
            or baseline_manifest.get("complete") is not True
        ):
            raise ValueError("invalid baseline manifest")
        if baseline_manifest["font_sha256"] != manifest["font_sha256"]:
            raise ValueError(
                "baseline font differs; use the same font for meaningful comparison"
            )
    rows = []
    if baseline_manifest:
        declared = {case_name(scene) for scene in baseline_manifest["scenes"]}
        if set(baseline_manifest["images"]) != declared:
            raise ValueError("baseline image set does not match its catalog")
        for name in sorted(declared - {case_name(scene) for scene in scenes}) if not scene_ids else []:
            old = baseline / f"{name}.png"
            if sha(old) != baseline_manifest["images"][name]:
                raise ValueError(f"baseline changed: {name}")
            shutil.copy2(old, output / "before" / old.name)
            manifest["comparison"][name] = "removed"
            rows.append(
                f'<tr><th>{html.escape(name)}<br>removed</th><td><img src="before/{name}.png" alt="removed scene"></td><td>—</td><td>—</td></tr>'
            )
    for scene in scenes:
        name = case_name(scene)
        ansi = run(
            [
                str(pinned),
                "--scene",
                scene["id"],
                "--width",
                str(scene["width"]),
                "--height",
                str(scene["height"]),
                "--time-ms",
                str(scene["time_ms"]),
            ]
        )
        image = output / "after" / f"{name}.png"
        capture.render_png(
            capture.screen_from_ansi(ansi, scene["width"], scene["height"]), image, font
        )
        manifest["images"][name] = sha(image)
        status = "new"
        if baseline_manifest and name in baseline_manifest["images"]:
            old = baseline / f"{name}.png"
            if sha(old) != baseline_manifest["images"][name]:
                raise ValueError(f"baseline changed: {name}")
            shutil.copy2(old, output / "before" / old.name)
            with Image.open(old) as a, Image.open(image) as b:
                if a.size != b.size:
                    status = "size changed"
                else:
                    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
                    status = "unchanged" if diff.getbbox() is None else "changed"
                    diff.save(output / "diff" / old.name)
        manifest["comparison"][name] = status
        cells = "".join(
            f'<td><img loading="lazy" src="{folder}/{name}.png" alt="{folder}"></td>'
            if (output / folder / f"{name}.png").exists()
            else "<td>—</td>"
            for folder in ["before", "after", "diff"]
        )
        rows.append(f"<tr><th>{html.escape(name)}<br>{status}</th>{cells}</tr>")
    if before_source != source_digest() or sha(pinned) != manifest["binary_sha256"]:
        raise ValueError("inputs changed during review; regenerate")
    manifest["complete"] = not bool(scene_ids)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><title>Dex Code UI review</title><style>body{font:14px system-ui;background:#1b1c1e;color:#e6e4e0;padding:24px}table{border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #444;text-align:left}img{max-width:38vw}th{font-weight:400}</style><h1>Dex Code component review</h1><p>Shared native widgets with supplied state. Focused captures cannot be accepted as a complete baseline.</p><table><tr><th>Scene</th><th>Before</th><th>After</th><th>Difference</th></tr>'
        + "".join(rows)
        + "</table>"
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--font")
    parser.add_argument("--scene", action="append", help="render one scene ID at all catalog sizes; repeatable; cannot be accepted as a full baseline")
    parser.add_argument(
        "--accept",
        type=Path,
        help="accept a complete review into a NEW --baseline directory",
    )
    args = parser.parse_args()
    try:
        if args.accept:
            if not args.baseline or args.output or args.scene:
                parser.error("--accept requires --baseline and cannot use --output")
            accept(args.accept.resolve(), args.baseline.resolve())
            print(f"Accepted reviewed images: {args.baseline}")
        else:
            if not args.output:
                parser.error("--output is required")
            result = review(
                args.output.resolve(),
                args.baseline.resolve() if args.baseline else None,
                args.font,
                scene_ids=args.scene,
            )
            print(
                f"Rendered {len(result['images'])} scenes: {args.output / 'index.html'}"
            )
    except (ValueError, OSError, subprocess.SubprocessError, KeyError) as error:
        parser.exit(1, f"UI review failed: {error}\n")


if __name__ == "__main__":
    main()
