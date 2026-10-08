# 🍼 Babysitter

A Claude Code mod that watches your background agents. When one loops, stalls, keeps erroring or burns tokens, it writes a fix into the agent's own conversation; if the agent stays stuck, it stops it and respawns the task with what went wrong spelled out. When the agents are done, you get a report.

Needs Claude Code 2.1.287 or newer (Mods).

## Install

```bash
claude plugin marketplace add /path/to/this/repo
```

```bash
claude plugin install babysitter@babysitter-local
```

Or for one session, without installing:

```bash
claude --plugin-dir /path/to/this/repo/babysitter
```

## Use

| Command | What it does |
| --- | --- |
| `/babysit` | Opens the pane: every subagent, its last call, and buttons to correct, kill or respawn it |
| `/babysit report` | Writes the report now |
| `/babysit mode correct\|kill\|nudge\|warn` | Switches how far it goes, for this session |
| `/babysit off` / `on` | Keeps tracking but stops stepping in / starts again |

Thresholds live in the plugin's config (`/plugin` → babysitter → configure): identical failing calls that count as a loop, errors in a row, seconds of silence, minutes and calls before runaway, tokens per agent, respawns per task.

## What it does, step by step

1. **Watches** every subagent: `agent.spawn`, each `tool.call`, each model step's tokens, `turn.complete`.
2. **Detects** loops, error streaks, stalls, runaways and token overruns.
3. **Corrects** in place: a short diagnosis from Haiku, written into the agent's conversation.
4. **Kills** the agent if it trips again, then **respawns** the task with the diagnosis and the calls not to repeat (one respawn per task, then it asks for you).
5. **Reports** once every background agent is done: in the transcript, in `.babysitter/reports/`, and as a push.

## Develop

```bash
claude plugin validate babysitter
```

```bash
claude plugin test babysitter
```
