---
name: orchestrating-the-build
description: >-
  Use when building, implementing, fixing, scaffolding, or continuing
  Expressions, including the locker, recipe, API, upload, preview, widget,
  or embed, and when the user says to continue, start the next problem, or
  build the product.
---

# Orchestrating the build

This file and [problems.md](problems.md) together are the source of truth for **how** Expressions is built. Read both before dispatching. `docs/prd.md` and `docs/architecture.md` are the source of truth for **what** it does. If the product docs disagree with each other, stop and ask the human. If another skill disagrees with these two files, these two files win. `superpowers:subagent-driven-development` keeps going and lets implementers commit. Here, subagents do not commit, and the session stops at the end of each ordered problem.

**Violating the letter of these rules is violating the spirit of these rules.**

## Who does what

You are the main agent. You receive the human's prompt. You deploy, control, monitor, and end subagents. You do not write product code.

Subagents run in parallel. You wait while they work. You do not poll, sleep, or check on them in a loop. Dispatch with the Task tool, `run_in_background: true`, `subagent_type: generalPurpose`, local environment. When a completion notice arrives, deploy the next ready subproblem if there is one. If every ready subproblem is already in flight, end the turn. The completion notice is the wake-up.

A subagent may own several subproblems when the work is similar and the writes would otherwise collide. One file has one owner at a time.

You alone run the security gate, the git stagger commits, the summary, and the dev server.

## Dispatch rule

Dispatch a subproblem when all three are true:

1. Its dependencies inside the current ordered problem are finished.
2. Its write set does not overlap a subagent that is still running.
3. It belongs to the current ordered problem in [problems.md](problems.md). Later ordered problems stay closed.

Launch every subproblem that passes those three in one turn, as separate Task calls.

Each prompt stands alone. The subagent does not see this conversation. Include the subproblem, the write set, the done-when line, and the exact sections of `docs/prd.md` and `docs/architecture.md` it must satisfy. Tell it: edit only the write set, do not commit, do not push, do not start another subproblem, do not put secrets in files or logs. Tell it what to return: files changed, how it verified, anything blocked.

On failure, dispatch a fix subagent with the failure and the same write set. Do not take the code over yourself.

The next ordered problem is the first one in [problems.md](problems.md) whose done-when is not already true in the tree.

## Security gate

Run it before the stagger commit when that problem's section in [problems.md](problems.md) says the gate is required.

Dispatch one `security-review` subagent. The Task description is exactly `Security Review`. Prompt:

```text
Full Repository Path: /Users/aarondutta/Desktop/Coding/expressions
Diff: uncommitted changes
Custom Instructions: Check the endpoints touched in this diff for missing authorization, IDOR, and a missing rate limit on POST /api/faces. Check that MAGIC_HOUR_API_KEY cannot reach the browser, a log line, or git. Check upload type, size, and decode limits. Check that source blobs are private and bundle blobs are public. Check that logs exclude the API key and image bytes. Report each finding as a file and a line, or report that the diff is clean.
```

A finding goes to a fix subagent, then a fresh security review. Commit only after a clean report. Before `git add`, look yourself for `.env`, credential files, key strings, and private photos in the staged set.

## Git stagger commit

After the problem is finished and the security gate is clean, you commit. Subagents do not commit.

A commit is one key change. Several files that are one change belong in one commit. Each commit leaves tests passing.

The subject starts with one of these types:

- `fix:` a bug in the codebase is patched
- `feat:` a new feature
- `docs:` docs written or updated
- `build:` scaffolding, boilerplate
- `test:` files used to test

Use another type only when none of those fit. The subject says why. Follow the user's git safety protocol: status, diff, and log in parallel first; commit message via heredoc; no git config changes; no `--no-verify`; no force push; no secrets. Do not push unless the human asks.

```text
feat: crop an upload into the canonical smile plate

The locker and the widget need one 1024 canvas to share.
```

## Closeout

When the commits are done, start the dev environment if it is not already running for this repo. Check the terminals folder before starting another server. Link the local URL in the summary. If it fails to boot, say so.

Then send this summary and stop. Do not dispatch the next ordered problem. Do not keep editing.

```markdown
## Problem N complete — <name>

### Commits
- `<short hash>` `<subject>`

### What changed
<what the human can now do that they could not do before>

### How to test
1. <command or click-path>
2. <the failure you would expect to see if it broke>

### Dev server
<url> — started now, or already running
```

The human's next message is what resumes the build.

## Red flags

These mean stop and return to the dispatch rule:

- Writing product code yourself because a subagent would be slower
- One commit for the whole problem
- Starting the next ordered problem in the same turn as the summary
- Inventing recipe sliders, or calling Magic Hour, before the human confirms the spend
- A second writer on a file another subagent owns
- A secret, `.env`, or private photo in a commit
- Polling a running subagent instead of ending the turn
- Treating parallel work as permission to skip the order or the stop
