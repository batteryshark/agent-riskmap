# @stonefish-labs/agent-riskmap

**Point it at an agent surface. Map what your tools could be tricked into.**

Agents accrete power one skill at a time. Each tool looks reasonable on its own,
but a credential reader plus a network sender is an exfiltration path, and nobody
decided to build that. It *emerged* from co-enabling two safe-looking things.
`agent-riskmap` scans an agent surface and maps the dangerous **capability
combinations**, the overall **posture**, and what to **restrict / prune / gate
behind HITL**.

No graphs, no decompiler, no LLM needed for the scan itself. It is a fast,
deterministic pass over a bundled detection ruleset, written in pure TypeScript with
no runtime dependencies.

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
agent-riskmap <dir> --html       # self-contained HTML report (pipe to a file)
agent-riskmap <dir> --html --ledger  # HTML report merged with triage verdicts
```

## What it looks at: the agent surface

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

## What it flags: dimensions & hazards

Each skill is profiled along **eight risk dimensions** (see
[docs/RISK-TAXONOMY.md](./docs/RISK-TAXONOMY.md)):

> ① **Action Authority** (send / post / delete) · ② **Data Access & Scope** ·
> ③ **Latent Capability / Delegation** (run code, spawn agents) · ④ **Guardrail
> Posture** (bypass permissions) · ⑤ **Steerability / Injection** (consumes untrusted
> input) · ⑥ **Reach** (egress) · ⑦ **Persistence / Autonomy** · ⑧ **Delegated Trust**
> (an opaque MCP server that can change under you, poison your context, or drive your inference)

Dimensions compose into **six hazards**, either self-sufficient (one skill holds both
parts) or a cross-skill pairing (two co-enabled skills each hold a part):

| hazard | composition | meaning |
|---|---|---|
| **EXFIL** | data × reach | read sensitive data, send it off-host |
| **COMMS** | outbound-authority × steerability | sends something you didn't intend |
| **DESTROY** | destructive-authority × steerability | destroys something you didn't intend |
| **GUARDRAIL** | latent × guardrail-bypass | runs code / delegates while bypassing safety |
| **RCE** | untrusted-input × latent | untrusted input drives code execution |
| **PERSIST** | latent × persistence | standing autonomous capability |

**Posture is pessimistic**, "critical until proven otherwise": a guardrail bypass or
autonomy on a capable skill defaults to `critical`, and the review loop only
downgrades on the record. Code atoms (real `subprocess`/credential reads) count as
high blast; a mere *mention* of "API keys" in prose counts as medium, because a
mention is not an access. A **hook** that completes a hazard is worse than a tool the
model must choose to call, so those are `[prune]`, not just `[restrict]`.

## Example

```
$ agent-riskmap ~/.claude/plugins

surface: 74 skills

10 skills can complete a hazard alone; 21 co-enable pairings.
74 skills · 58 capable · 6 steerable · 15 no-signal
posture: critical — high blast radius, guardrail multiplier; power: authority, data, latent.

▲ GUARDRAIL  runs code / delegates while bypassing safety
    self-sufficient: autonomous-ai-agents/claude-code, autonomous-ai-agents/codex, …

riskiest skills
  critical  autonomous-ai-agents/claude-code  authority, data, latent, guardrail, persistence  ⚑ GUARDRAIL/PERSIST
  critical  apple/macos-computer-use          authority, data, latent, steerability            ⚑ DESTROY/RCE
  critical  productivity/google-workspace     authority, data, reach, steerability             ⚑ EXFIL/COMMS

what to do
  [restrict] GUARDRAIL: "…/claude-code" is self-sufficient for this hazard — sandbox or gate behind HITL.
```

For a full worked example you can run yourself, see [`examples/`](./examples): a
synthetic agent surface plus its rendered [`report.html`](./examples/report.html).

## How it runs (the loop)

The CLI is the deterministic half, and it is *always complete*. It lists reachable
combinations but cannot tell you which are *real*. For that, the **pi and opencode
extensions** ([`extensions/`](./extensions/README.md)) add the triage loop: the same
scan seeds a ledger, then your harness model adjudicates each finding item by item,
reads the cited evidence, follows the flow, and **confirms / dismisses / gates** it.
The ledger owns termination; the model never self-terminates or invents findings.
See [LOOP.md](./LOOP.md).

## MCP servers you cannot read

Skills, hooks, and prompts you can read. A remote MCP server you often cannot. Point
agent-riskmap at an MCP config and it connects as a client, captures the advertised
surface with no source, and profiles it like everything else:

```sh
agent-riskmap mcp mcp.json                  # protocol version, tools, prompts, resources, capabilities
agent-riskmap mcp mcp.json --read-resources # also read resource bodies (a poisoning surface)
agent-riskmap mcp mcp.json --drive-search   # drive a tool-search meta-tool to reveal hidden tools
agent-riskmap <dir> --connect               # fold the surface's MCP servers into the main report
```

It never invokes a tool, only `initialize`, the list methods, and resource reads. It
records what the server tries to do to *you* during the probe (ask to run your model,
prompt your user, read your filesystem roots), scrubs secrets from what it captures,
and flags the delegated-trust facets: opaque, volatile (the tool set can change),
poisoning, sampling, elicitation.

Two caveats worth remembering. What you capture is a snapshot, and it depends on the
headers you send, which is why the tool takes a whole `mcp.json` with its auth. A
server can serve different tools to different callers, so treat everything it tells
you as untrusted. Live MCP probing uses the optional `@modelcontextprotocol/sdk`;
install it if you want the `mcp` command (the static scan needs nothing).

## Limits

- Regex + shell-head detection, not full parsing. High recall, some coarse edges. It
  finds *reachable capability*, not a proven exploit, so treat findings as
  "gate/review," not "confirmed malicious."
- Generic prompt-injection phrase detection is not in yet, so prompt targets rarely
  raise *steerability* on their own. See the note in [LOOP.md](./LOOP.md).

Apache-2.0
