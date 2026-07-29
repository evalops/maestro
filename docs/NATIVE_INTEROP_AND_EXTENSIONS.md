# Native interoperability and extensions

Maestro ships the following extension and interoperability surfaces in Rust:

- `maestro plugins install <local-directory>` installs a local plugin.
- `maestro plugins install <git-url> --trust` installs remote code only after an
  explicit trust decision. Installs are bounded and atomic; symbolic links are
  rejected.
- `maestro plugins enable|disable <name>` controls a whole plugin.
- `maestro plugins capability <name> <skills|commands|hooks|mcp> <on|off>`
  controls each executable capability independently.
- `maestro acp` runs an ACP v1 JSON-RPC agent over stdio. It supports
  initialization, new sessions, prompts, streaming session updates, and
  cancellation.
- `maestro models inspect <model-id> [--json]` explains catalog, provider,
  endpoint, authentication, and capability resolution without printing secret
  values.
- `maestro mcp ...`, `/mcp config ...`, and `/mcp-config ...` atomically manage
  user, project, or local MCP configuration. HTTP bearer credentials must be
  named environment-variable references.

Headless stdio clients can request transcript granularity with
`transcript_grade` (`transcriptGrade` on the hosted HTTP surface) set to `off`,
`turn`, `block`, or `delta`. Journals are sequence-numbered, bounded,
cursor-replayable, and redact common credential fields before storage.

Shell safety analysis uses a bounded tree-sitter Bash parse. Parse errors,
oversized inputs, or excessive syntax trees require approval instead of
falling back to string splitting.

Video files (`mp4`, `m4v`, `mov`, `webm`, `mkv`, and `avi`) can be attached to
prompts. Maestro bounds inputs at 100 MiB and invokes `ffmpeg` to sample at most
eight JPEG frames before using the existing vision-provider pipeline. Video
bytes and decoded frames are not persisted by Maestro.
