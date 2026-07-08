# Example

[`sample-agent/`](./sample-agent) is a small, synthetic agent surface built to show
what agent-riskmap finds. Nothing in it is real: no live credentials, no real server,
no private paths. It exists so the output is reproducible and so there's something to
point at.

[`report.html`](./report.html) is the rendered report for that surface. Open it in a
browser to see the format (posture banner, per-skill capability, hazards, and the
"what to do" actions).

## What the sample covers

| skill | what it shows |
|---|---|
| `credential-vault` + `report-uploader` | an **EXFIL** cross-skill pairing — one reads secrets, the other sends off-host; neither is dangerous alone |
| `inbox-assistant` | **COMMS** — reads untrusted mail and can send email, so a crafted message could make it send something you didn't intend |
| `repo-janitor` | **DESTROY** — deletes branches and processes external PR text |
| `code-delegator` | **GUARDRAIL** (critical) — delegates to a coding agent with `--dangerously-skip-permissions` |
| `watcher-daemon` | **PERSIST** — runs code from a cron job |
| `note-sync` | a **description gap** — it claims to keep notes "on your local disk" but uploads them |
| `text-formatter` | a benign skill, for contrast |
| `.claude/commands/summarize.md` | a prompt with an injected instruction |
| `.mcp.json` | an MCP server reference (see `--connect` below) |

## Regenerate it

```sh
agent-riskmap examples/sample-agent              # text report
agent-riskmap examples/sample-agent --html > examples/report.html   # the HTML above
agent-riskmap examples/sample-agent --connect    # also live-probe the MCP server in .mcp.json
```

`--connect` launches the server in `.mcp.json` (the public
`@modelcontextprotocol/server-everything`) and folds it in as a delegated-trust
target. It needs the optional `@modelcontextprotocol/sdk` and network access, so the
committed `report.html` is the static run (no network required to reproduce it).
