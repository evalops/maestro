#!/usr/bin/env python3
"""Reject literal Color:: palettes in the ten migrated production surfaces.

Palette definitions, other components and #[cfg(test)] items are outside this
bounded migration guard. This is a source convention check, not a Rust parser.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
FILES = tuple(
    f"packages/tui-rs/src/components/{name}.rs"
    for name in (
        "approval", "detail_view", "command_palette", "session_switcher",
        "model_selector", "theme_selector", "file_search",
    )
) + (
    "packages/tui-rs/src/app/dex_presentation.rs",
    "packages/presentation-rs/src/components/dex_companion.rs",
    "packages/presentation-rs/src/components/appearance_picker.rs",
)
# Preserve offsets/newlines for diagnostics, while ignoring prose and literals.
LEXEME = re.compile(
    r'//[^\n]*|/\*|(?:br|r)(\#*)"[\s\S]*?"\1|'
    r'b?"(?:\\[\s\S]|[^"\\])*"|b?\'(?:\\.|[^\'\\\n])\''
)
TEST_ITEM = re.compile(r'#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]')
COLOR = re.compile(r'\bColor\s*::\s*[A-Za-z_]\w*')


def blank(text):
    return re.sub(r'[^\n]', ' ', text)


def production_source(source):
    parts, end = [], 0
    while match := LEXEME.search(source, end):
        parts.append(source[end:match.start()])
        stop = match.end()
        if match.group() == '/*':
            depth = 1
            while depth and stop < len(source):
                if source[stop:stop + 2] in ('/*', '*/'):
                    depth += 1 if source[stop:stop + 2] == '/*' else -1
                    stop += 2
                else:
                    stop += 1
        parts.append(blank(source[match.start():stop]))
        end = stop
    parts.append(source[end:])
    code = ''.join(parts)
    # Skip precisely the annotated item, never the rest of its source file.
    while match := TEST_ITEM.search(code):
        opening = re.search(r'[;{]', code[match.end():])
        if opening is None:
            break
        stop = match.end() + opening.end()
        if code[stop - 1] == '{':
            depth = 1
            while depth and stop < len(code):
                depth += (code[stop] == '{') - (code[stop] == '}')
                stop += 1
        code = code[:match.start()] + blank(code[match.start():stop]) + code[stop:]
    return code


def violations(source):
    code = production_source(source)
    return [(code.count('\n', 0, m.start()) + 1, m.group()) for m in COLOR.finditer(code)]


def main():
    failures = []
    for relative in FILES:
        for line, literal in violations((ROOT / relative).read_text()):
            failures.append(f'{relative}:{line}: {literal}: use the current semantic theme')
    if failures:
        print('\n'.join(failures))
        return 1
    print(f'UI consistency: {len(FILES)} migrated production surfaces passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
