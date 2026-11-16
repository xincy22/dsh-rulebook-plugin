# dsh-rulebook — Standing rules with a human-only write channel

User-written standing rules are injected into the **system prompt on every model step**. They survive long conversations and context compaction without relying on semantic recall.

The only write channel is the `/rule` slash command, triggered by the user. The model has no tool for writing rules and cannot trigger the command.

This plugin and `dsh-hindsight` occupy different seams: Hindsight is a semantic recall library (the model must call `hindsight_recall`), while this plugin is always-on injection.

## Install

```
dsh plugin --profile desktop add link:/path/to/dsh-rulebook-plugin
```

Open a new session and run `/rule list`.

## Three layers

| Layer | Path | Visible to |
|---|---|---|
| Global | `<rulebookDir>/global.md` | every session in every profile |
| Workspace | `<rulebookDir>/workspaces/<normalized-path>.md` | sessions in that workspace |
| Session | `<rulebookDir>/sessions/<session-id>.md` | only that session |

`rulebookDir` defaults to `$DSH_HOME/rulebook` (or `~/.dsh/rulebook`). To make the global layer profile-private, point it at `$DSH_PROFILE_DIR/rulebook`.

Files are plain Markdown: one rule per line prefixed with `- `. Lines starting with `#` are comments: they are not counted as rules but are still injected. Files can be edited by hand; changes take effect on the next model request without a restart.

## Commands

| Command | Effect |
|---|---|
| `/rule add [-g\|-w\|-s] <text>` | append a rule (default: global) |
| `/rule list` | list all layers, rule IDs, paths, and character usage |
| `/rule rm <ID> [ID...]` | delete one or more rules by ID |
| `/rule help` | print help |

Each rule has a content-derived ID like `g:3f2a1c`: the first letter is the layer (`g` global / `w` workspace / `s` session), followed by the first 6 hex digits of `sha256(layer + normalized-text)`. IDs are **not stored in files**; the files stay clean text that you can edit by hand. An ID changes when the text changes. `add` and `list` both show IDs.

`rm` accepts only IDs. Substring matching was removed on purpose: one fragment could match several rules, and the result would not tell you which ones were deleted.

## Config

Config lives in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `rulebookDir` | `$DSH_HOME/rulebook` | rule root; `~` expanded, absolute as-is, relative resolved against plugin dir |
| `maxChars` | `3000` | per-layer injected body cap |
| `totalMaxChars` | `6000` | combined cap for all three layers |
| `order` | `700` | prompt section order (between `TEAM_POLICY` 600 and `PTC_ONLY` 800) |
| `includeWorkspaceRules` | `true` | inject the workspace layer |
| `includeSessionRules` | `true` | inject the session layer |
| `includeSubagents` | `true` | inject into subagent sessions |
| `commandName` | `rule` | slash command name |
| `guardEnabled` | `true` | register the tool guard |
| `guardedTools` | `["write","edit","pwsh","terminal_send"]` | tools checked by the guard |
| `cleanupSessionFiles` | `false` | clean session rule files when a session is deleted |

When `includeWorkspaceRules` or `includeSessionRules` is false, `add -w` / `add -s` fail with an explanation instead of silently writing a rule the model will never see.

## Model-side write channel

No tool is registered for writing rules, and commands are user-only by type (`CommandSourceMap` has one member, `user`). Command definitions use `recordInput: false` so rule text is not written to the session log.

A `ctx.tools.guard` is a second line of defense: it rejects `write`/`edit` calls whose resolved path is inside the rule root, and `pwsh`/`terminal_send` calls whose command text contains an absolute path to the rule root. Read attempts are rejected too; use `/rule list` to inspect rules from the model side.

The guard is string matching, not a security boundary: it cannot stop variable-built paths, symlinks, encodings, or relative-path shell writes. The real boundary is that the model has no rule-writing tool.

## Tests

```
node test/smoke.mjs
```

## Design

See [docs/DESIGN.md](docs/DESIGN.md) for source-level evidence behind the prompt-seam choice and the revision history.

## License

MIT
