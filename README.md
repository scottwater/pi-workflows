# pi-workflows

Named slash-command workflows for launching [`pi-subagents`](https://github.com/nicobailon/pi-subagents) chains.

The default policy is **agent-owned models**: workflow files describe orchestration, while each subagent file owns its `model`, `thinking`, tools, and role prompt.

## Why

Prompt templates are convenient for `/review-agents`, `/review-deep`, etc., but model-enabled prompt templates resolve a model before delegation and pass it as a subagent override. That makes the template own the model.

`pi-workflows` keeps the easy slash-command UX while launching `pi-subagents` directly. Unless a workflow explicitly opts out, model overrides are rejected.

## Install

```bash
pi install https://github.com/scottwater/pi-workflows.git
```

Restart Pi or run `/reload`.

> Requires `pi-subagents` to be installed and loaded.

## Where workflows live

Workflows are intentionally **not bundled as active commands** in this extension. The extension only provides the launcher. Put workflow files in:

| Scope | Directory |
|---|---|
| Global/user | `~/.pi/agent/workflows/` |
| Project | `<repo>/.pi/workflows/` |

Project workflows override global workflows with the same `name`.

Direct slash commands are registered for global/user workflows at startup/reload and again when a session starts. Project-local workflows are intentionally discovered through `/workflow <name> ...` (and `/workflow --list`) so repo-local aliases do not leak into unrelated repos for the rest of the Pi process. If a project workflow has the same `name` as a global direct command, the project workflow still overrides it when that direct command is invoked from the project cwd.

## Examples

Example workflows and agents live under `examples/` only:

```text
examples/workflows/review-agents.jsonc
examples/workflows/review-deep.jsonc
examples/workflows/oracle-review.jsonc
examples/agents/review-synthesizer.md
```

Install all review examples globally:

```bash
./scripts/install-review-examples.sh
```

Then reload Pi.

## Usage

After installing workflows into `~/.pi/agent/workflows` or `.pi/workflows`:

```text
/review-agents current git diff
/review-deep changes since main
/oracle-review current plan before implementation
```

Generic runner:

```text
/workflow review-agents current git diff
/workflow --list
```

While a workflow runs in the TUI, `pi-workflows` shows a single compact live widget with active agents, tool counts, current tools, and token/duration stats. When the workflow completes, it renders the final successful subagent output back into the conversation as an expandable result card instead of only showing the `pi-subagents` chain summary. Press **Ctrl+O** on the final card to show per-agent progress, recent tools/output, child session paths, saved outputs, and artifact paths. If the underlying subagent run fails, it renders failure text and propagates the failure instead of showing a stale successful step output.

Runtime flags:

```text
/review-agents --fork current diff       # force forked context when parent session forking is available
/review-agents --fresh current diff      # force fresh context
/review-agents --bg current diff         # background/async
/review-agents --clarify current diff    # open subagent clarify UI
/review-agents --worktree current diff   # worktree isolation where supported
/review-agents --cwd=/path/to/repo ...
/review-agents --agent-scope=project ...
```

## Workflow format

Workflows are JSON/JSONC files ending in `.json` or `.jsonc`.

```jsonc
{
  "name": "review-agents",
  "description": "Multi-agent code review",
  "modelPolicy": "agent",
  "context": "fresh",
  "clarify": false,
  "agentScope": "both",
  "chain": [
    {
      "parallel": [
        {
          "agent": "skeptical-engineer",
          "task": "Review skeptically. Scope: {{args}}"
        },
        {
          "agent": "code-reviewer",
          "task": "Review correctness and guidelines. Scope: {{args}}"
        }
      ],
      "failFast": false
    },
    {
      "agent": "review-synthesizer",
      "task": "Synthesize these outputs: {{previous}}"
    }
  ]
}
```

Supported top-level execution fields:

- `chain` — sequential chain with optional `{ "parallel": [...] }` steps.
- `tasks` — top-level parallel task list.
- `agent` + `task` — single subagent task.
- `context` — `"fresh"` or `"fork"`.
- `clarify` — boolean.
- `async` — boolean.
- `worktree` — boolean.
- `cwd` — string.
- `chainDir` — string.
- `agentScope` — `"user"`, `"project"`, or `"both"`.
- `model` — single-task model override. Rejected unless `modelPolicy` is `"workflow"`.
- `modelPolicy` — `"agent"` by default. Set `"workflow"` only if you intentionally want workflow-level model overrides.
- `forkFallback` — `"fresh"` by default. If `context: "fork"` fails because Pi cannot create a forked subagent session, retry once with fresh context. Set `"error"` to fail instead.

Supported template variables in task strings:

- `{{args}}` or `{{$@}}` — full slash-command args after runtime flags are removed.
- `{{1}}`, `{{2}}`, ... — positional args with simple shell-style quoting.
- `{{cwd}}` — invocation cwd.
- `{{previous}}` — converted to `pi-subagents` `{previous}`.
- `{{task}}` — converted to `{task}`.
- `{{chain_dir}}` — converted to `{chain_dir}`.

## Context mode

For code-review workflows, `context: "fresh"` is usually the safest default: reviewers can inspect the repository directly, and the workflow does not depend on Pi being able to fork the current conversation session.

Use `context: "fork"` when the workflow genuinely needs the parent conversation history. Pi's forked subagent context requires a persisted parent session and a leaf entry that exists in the session file. In UI sessions, `pi-workflows` creates or persists a startup entry before dispatching forked workflows; if that entry cannot be persisted, the workflow fails before launch rather than silently losing parent history. If fork creation is unavailable after that, `pi-workflows` retries once with `context: "fresh"` by default and includes a note in the result. Non-required workflow persistence is best-effort: if session persistence machinery is unavailable for non-fork/final-result paths, the workflow continues and logs a diagnostic instead of turning successful work into a failure. To make fork failures hard errors, set:

```jsonc
{ "forkFallback": "error" }
```

## Oracle workflows

`oracle-review` is a high-context decision-consistency review workflow. Use it when you want a forked advisory pass over the current conversation, plan, or implementation direction before committing to the next step:

```text
/oracle-review current plan before implementation
/workflow oracle-review check for drift before I implement the migration
```

Oracle workflows should usually keep:

```jsonc
{
  "context": "fork",
  "forkFallback": "error"
}
```

Unlike normal code-review workflows, `oracle` needs the inherited parent-session context to reconstruct decisions, constraints, and open questions. If forked context is unavailable, failing loudly is safer than silently retrying with fresh context.

Do not treat `oracle` as a generic diff reviewer, and do not automatically chain `oracle` into `oracle-executor`. The intended loop is: Oracle advises, the main agent/user approves a direction, and only then an executor implements the approved direction.

## Model ownership

By default, this is valid and uses the agent's configured model:

```jsonc
{ "agent": "code-reviewer", "task": "Review {{args}}" }
```

This is rejected by default:

```jsonc
{ "agent": "code-reviewer", "model": "anthropic/claude-opus-4-5", "task": "Review {{args}}" }
```

To allow workflow-owned models, set:

```jsonc
{
  "modelPolicy": "workflow",
  "agent": "code-reviewer",
  "model": "anthropic/claude-opus-4-5",
  "task": "Review {{args}}"
}
```

## Invalid workflow files

Workflow discovery is fault-tolerant: one malformed JSON/JSONC file is skipped with a warning that includes the file path and parse/validation message, while other valid workflows continue to load. `/workflow --list` includes skipped-file warnings when discovery finds invalid files.

## Notes

* This extension currently launches workflows through the `pi-subagents` slash bridge event protocol, so `pi-subagents` must be loaded in the same Pi session.
* The extension draws a lot of inspiration from [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model)
