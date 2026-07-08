# @stonefish-labs/agent-riskmap

**Point it at an agent surface. Map what your tools could be tricked into.**

Agents accrete power one skill at a time. Each tool looks reasonable alone — but a
credential reader plus a network sender is an exfiltration path, and nobody decided
to build that; it *emerged* from co-enabling two safe-looking things. `agent-riskmap`
scans an agent surface and maps the dangerous **capability combinations**, the
overall **posture**, and what to **restrict / prune / gate behind HITL**.

No graphs, no decompiler, no LLM required for the scan itself — a fast, deterministic
pass over the same detection data the [parallax](https://github.com/batteryshark/parallax)
engine uses, reimplemented in pure TypeScript.

## Install

```sh
npm i -g @stonefish-labs/agent-riskmap   # or: npx @stonefish-labs/agent-riskmap <dir>
```

## Use

```sh
agent-riskmap ~/.claude          # your whole config surface   (short alias: riskmap)
agent-riskmap ~/.claude/plugins  # installed plugins/skills
agent-riskmap ./my-skill         # a single skill/tool
agent-riskmap <dir> --json       # full machine-readable report
```

## What it looks at — the agent surface

Each discovered element is tagged with a **kind**:

| kind | what it is | found via |
|---|---|---|
| **skill** | a skill pack | `SKILL.md` |
| **tool** | a code tool / extension | `package.json`, `pyproject.toml`, … |
| **mcp** | an MCP server | `server.json`, or a `mcpServers` reference in `settings.json` / `.mcp.json` |
| **hooks** | inline shell that **auto-runs** on agent events | a `hooks` block in a settings file |
| **prompt** | instruction surface that can steer the agent | `CLAUDE.md`, `AGENTS.md`, `commands/` & `agents/` `.md` |

Point it at a project and it finds the tool *and* descends into a bundled `.claude/`
surface. Big data subdirs (transcripts, `node_modules`) are skipped.

## What it flags — dangerous compositions

Every capability rolls up to a family (`NET · BROWSER · EXEC · LOAD · CRED · FSWRITE
· INSTALL · AITM`). Three abuse compositions are each a `source → sink`:

| composition | source | sink | meaning |
|---|---|---|---|
| **EXFIL** | `CRED` | `NET / BROWSER` | read secrets, then send them off-host |
| **RCE** | `NET / BROWSER` | `EXEC / LOAD` | network input drives code execution |
| **DROP** | `FSWRITE` | `EXEC / LOAD` | write a file, then execute it |

A target is **self-sufficient** when it holds both halves alone. Two targets form a
**cross-skill pairing** when one is source-only and the other sink-only — harmless
apart, an abuse path the moment both are co-enabled in one agent. **Posture** = blast
radius (capability severity) × steerability → `minimal / moderate / elevated / critical`.

A **hook** that completes a path is worse than a tool the model must choose to call,
because it runs on its own — so those are flagged `[prune]`, not just `[restrict]`.

## Example

```
$ agent-riskmap ~/.claude/plugins

surface: 23 skills · 4 mcp · 4 tools · 21 prompts

4 targets complete an abuse path alone; 10 co-enable pairings.
52 targets · 10 capable · 0 steerable · 42 inert
posture: elevated — high blast radius; reachable capabilities: EXEC, FSWRITE, NET.

▲ RCE  network input drives code execution
    self-sufficient (completes it alone): …/discord, …/telegram, …/skill-creator
    cross-skill (8 pairings):
      source: …/build-mcp-server, …/mcp-integration, …
      sink:   …/imessage, …/session-report

what to do
  [restrict] RCE: "…/discord" completes it alone — sandbox or gate behind HITL.
  [gate]     RCE: keep [sources] and [sinks] in separate agents or review before both run.
```

## How it runs (the loop)

The CLI is the deterministic half — *always complete*. It lists reachable
combinations but can't tell you which are *real*. For that, the **pi and opencode
extensions** ([`extensions/`](./extensions/README.md)) add the triage loop: the same
scan seeds a ledger, then your harness model adjudicates each finding item-by-item —
reads the cited evidence, follows the flow, and **confirms / dismisses / gates** it.
The ledger owns termination; the model never self-terminates or invents findings.
See [LOOP.md](./LOOP.md).

## Limits

- Regex + shell-head detection, not full parsing — high recall, some coarse edges. It
  finds *reachable capability*, not a proven exploit; treat findings as "gate/review,"
  not "confirmed malicious."
- Generic prompt-injection phrase detection isn't in yet, so prompt targets rarely
  raise *steerability* on their own — see the note in [LOOP.md](./LOOP.md).

Apache-2.0
