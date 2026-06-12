---
name: autopilot
description: Autonomously execute a multi-step task — plan it, spawn sub-agents per task, and run to completion without asking for confirmation between steps. Use when the user says "build/do X autonomously", "keep going until done", or "don't ask me, just finish it".
---

# Autopilot — run a task to completion on your own

You are in autopilot mode. The user wants the whole job done with minimal interruptions. Your job is to plan the work, execute it task-by-task, verify as you go, and keep moving — **not** to check in after every step. The agents you spawn show up live in the **Gander** dashboard, so the user can watch progress (and stop you) without you narrating every move.

See `reference.md` for guardrail detail, a worked example, and permission-mode trade-offs.

## 1. Plan first (the source of truth)

Before doing any work, produce a concrete **numbered plan** as a todo list (use the TodoWrite tool if available, otherwise a numbered markdown list). Each item should be a verifiable unit of work, ordered so dependencies come first.

This plan is the single source of truth. Keep it updated continuously: mark items in-progress / done, and add or split items as reality demands. Re-show the current plan when it changes materially.

## 2. Work the plan top-to-bottom

Go through the list in order. For each task:

- **Independent / parallelizable tasks** → spawn a sub-agent with the **Task** tool (one focused agent per task). Give each a tight, self-contained prompt and a clear definition of done. These appear as tiles in the **Gander dashboard**. You may run several in parallel when they don't touch the same files or depend on each other's output.
- **Dependent tasks** → do them in order yourself (or spawn them sequentially), feeding each result into the next.

Don't over-parallelize: if two tasks edit the same files or one needs the other's output, sequence them.

## 3. Verify, check off, continue — automatically

After each task: **verify it actually works** (build, run tests, lint, re-read the changed file, or run the relevant command). If it passes, check the item off and **immediately move to the next task**. If it fails, fix it (or spawn a fixer agent) before advancing.

Do **not** stop to ask "should I proceed?" between completed steps. Continuing is the default.

## 4. When to actually pause and ask

Pause and ask the user **only** for:

- **Blocking ambiguity** — a requirement is genuinely unclear and you can't make a reasonable, reversible assumption.
- **Destructive / irreversible / outward-facing actions** — deploys, `git push --force`, deleting data or files you didn't create, sending messages/emails, spending money, anything that touches the outside world.
- **A guardrail tripping** (see below).

For everything else, make the sensible call, note your assumption in the plan, and keep going.

## 5. Guardrails (explicit)

- **Iteration cap:** run at most **~10 autonomous task iterations or sub-agents** without a check-in. When you hit the cap, post a short progress summary and confirm you should continue.
- **User can stop you anytime:** the user can halt autopilot from the **Gander dashboard** (the **Stop** button) or via **Telegram `/stop`**. You don't need to ask permission to keep working — they hold the brake.
- **Permission mode:** prefer `acceptEdits` / auto mode so file edits flow without prompts, but **never** bypass confirmation on dangerous actions (deploys, deletions, network sends, spends) — those always route through section 4.
- **Periodic summaries:** every few completed tasks (or at the iteration cap), post a 2–4 line progress update so the dashboard/log stays legible.
- **No silent scope creep:** if you discover the job is much bigger than planned, update the plan and surface it rather than quietly tripling the work.

## 6. Final summary

When the plan is complete (or you've stopped), end with a clear summary:

- **Completed** — what got done, with how it was verified.
- **Deferred / blocked** — anything skipped, why, and what's needed to finish it.
- **Follow-ups** — suggested next steps, if any.
