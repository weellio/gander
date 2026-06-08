# Autopilot — reference

Supporting detail for the `autopilot` skill: guardrails expanded, a worked example, and the permission-mode / cost trade-offs.

## Guardrails, expanded

**Iteration cap (~10).** The cap exists so a wrong assumption can't compound across an entire run unsupervised. Count both your own task iterations and spawned sub-agents toward it. When you reach it, don't silently stop and don't silently barrel on — post a short summary and ask whether to continue. If the user already said "keep going until done" for a large job, you can raise the cap once they confirm, but reset the counter after each check-in.

**Stoppable by the user, always.** Autopilot is not "fire and forget you can't interrupt." The user can hit **Stop** in the Hivemind dashboard or send Telegram **`/stop`** at any moment. This is *why* you're allowed to proceed without per-step confirmation — the human keeps the kill switch. If you're stopped mid-task, leave things in a consistent state and summarize where you got to.

**Dangerous actions never auto-run.** Even in auto/acceptEdits mode, the following always pause for explicit user approval:
- Deploys / releases / publishing packages.
- `git push` to shared branches, force-pushes, tag deletion.
- Deleting files or data you didn't create this session; `rm -rf`, dropping tables, truncating.
- Sending anything outward — emails, Telegram/Slack messages, webhooks, API calls that mutate external state.
- Spending money — paid API tiers beyond the task, provisioning infra, purchases.

**Reversible vs irreversible.** When unsure, ask: "if this is wrong, can I cleanly undo it?" Reversible (a code edit, a local file, a branch commit) → just do it. Irreversible / outward-facing → pause.

**Periodic summaries.** Keep the human able to skim. A good cadence: every ~3 completed tasks, plus at the iteration cap, plus at the end. Two to four lines is enough.

## Worked example — "build a feature autonomously"

User: "Add CSV export to the reports page. Build it autonomously, don't ask me between steps."

1. **Plan** (numbered todo, source of truth):
   1. Locate the reports page + data layer; identify where rows are assembled.
   2. Add a `toCsv(rows)` serializer (handle quoting/escaping, headers).
   3. Wire an "Export CSV" button + download handler in the UI.
   4. Add a unit test for `toCsv` (commas, quotes, newlines, empty set).
   5. Build + run tests; manual smoke check of the download.

2. **Execute with sub-agents where it parallelizes.** Tasks 2 and 4 are independent of the UI work, so spawn them as Task sub-agents (they appear as tiles in Hivemind): one writes `toCsv` + its test, one can scaffold the button. Task 3 depends on 2's function signature, so sequence it after 2 lands. Task 1 (recon) runs first because everything depends on it.

3. **Integrate.** Pull the serializer and the button together; resolve the function signature so the UI calls `toCsv` correctly.

4. **Verify each step.** After task 2: run the new unit test. After task 3: build the app. After integration: run the full test suite and do a smoke check (does the button produce a valid CSV?). Check items off as each passes; move on without asking.

5. **Pause point?** Only if something's genuinely ambiguous — e.g., "should the export respect the current filters or dump everything?" If a reasonable reversible default exists (respect current filters), take it and note the assumption; if it's load-bearing and unclear, ask.

6. **Final summary.** "Completed: CSV export (serializer + button), unit test passing, full suite green, smoke-checked a 200-row export. Deferred: large-export streaming (current impl builds the string in memory — fine for typical report sizes; flag if exports exceed ~50k rows). Follow-up: add an integration test for the download response."

## Permission-mode trade-offs

- **`acceptEdits` / auto** — file edits and safe commands run without prompts. Best for autopilot flow; this is the recommended default. Trade-off: you must self-enforce the dangerous-action carve-outs in section 4, because the harness won't prompt for them either.
- **`plan` mode** — read-only; good for the planning phase but you must leave it to actually execute. Don't get stuck here.
- **`bypassPermissions`** — do **not** use for autopilot. It removes the safety net entirely, including on destructive actions. The whole point of autonomy here is "fast on safe things, careful on dangerous things," and bypass collapses that distinction.

Rule of thumb: stay in `acceptEdits` and treat section 4 (when to pause) as a hard list, not a suggestion.

## Cost awareness

Autonomous runs and parallel sub-agents consume tokens fast. Keep it efficient:
- Spawn a sub-agent per *meaningful* task, not per trivial edit — over-spawning multiplies cost and context overhead.
- Give sub-agents tight, self-contained prompts so they don't re-explore the whole repo.
- Don't re-read files you just wrote to "double check" — the edit tools already confirm success.
- The iteration cap is also a cost cap: it forces a human checkpoint before a runaway loop burns a large budget.
- If a job is clearly huge (dozens of tasks), say so up front and confirm scope before launching a swarm.
