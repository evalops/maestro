# Skills

Skills are reusable packages (centered on `SKILL.md`) that specialize agent behavior. They can also register as slash commands when marked user-invocable.

Authoring guide: [Skill Cookbook](../../../../docs/cookbook/skills/README.md).

---

## Locations

| Scope | Path |
|-------|------|
| Project (preferred) | `.maestro/skills/<name>/SKILL.md` |
| User | under Maestro home skills (and CLI skill packages) |
| Legacy | `~/.composer/skills/`, `.composer/skills/` |

Repo-bundled examples live under the workspace `skills/` tree (for example `pr-review`, `release-verification`, `incident-triage`).

---

## Minimal skill

```bash
maestro skill new reviewing-prs --description "Review pull requests. Use when the user asks for PR review."
maestro skill lint .maestro/skills/reviewing-prs
```

Generated layout typically includes:

```text
reviewing-prs/
  SKILL.md
  reference/
  scripts/
  toolbox/
  mcp.json.example
```

Keep `SKILL.md` short; put long references under `reference/`. Optional `mcp.json` should filter tools with `includeTools`. Toolbox helpers should respond to `MAESTRO_TOOLBOX_ACTION=describe`.

---

## In-session management

```text
/skills
/skills list
/skills activate <name>
/skills deactivate <name>
/skills reload
/skills info <name>
```

Alias: `/skill`.

User-invocable skills also appear as `/<skill-name>` when the name does not collide with a built-in.

---

## Prompt / command templates

Related Grok-style extensions (not full skill packages):

- `.maestro/prompts/*.md`
- `.maestro/commands/*.md`
- User-level copies under `~/.maestro/…`
- Legacy: `~/.composer/prompts/`, `.composer/prompts/`

Invoke with `/<name> …`. Built-ins always win on name collision.

---

## CLI

```bash
maestro skill new <name>
maestro skill lint .maestro/skills
```

Validation and package rules are enforced by the skill package CLI (native Rust surface).
