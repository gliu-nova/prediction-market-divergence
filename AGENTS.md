# AGENTS.md - Grok Build Instructions

## Core Coding Principles

### 1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.  
Before implementing:

* State your assumptions explicitly. If uncertain, ask.
* If multiple interpretations exist, present them — don't pick silently.
* If a simpler approach exists, say so. Push back when warranted.
* If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.

* No features beyond what was asked.
* No abstractions for single-use code.
* No "flexibility" or "configurability" that wasn't requested.
* No error handling for impossible scenarios.
* If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes
Touch only what you must. Clean up only your own mess.

When editing existing code:
* Don't "improve" adjacent code, comments, or formatting.
* Don't refactor things that aren't broken.
* Match existing style, even if you'd do it differently.
* If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
* Remove imports/variables/functions that YOUR changes made unused.
* Don't remove pre-existing dead code unless asked.

**Test:** Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution
Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
* "Add validation" → "Write tests for invalid inputs, then make them pass"
* "Fix the bug" → "Write a test that reproduces it, then make it pass"

For multi-step tasks, state a brief plan:

[Step] → verify: [check]
[Step] → verify: [check]
[Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Output Style & Readability
- Prioritize **readability and maintainability**.
- Use clear variable/function names.
- Add minimal but helpful comments only where logic is non-obvious.
- Keep functions small and focused.
- Prefer modern, clean Python idioms.

## Testing & Reliability

- Write or update tests for new/changed functionality (unit for core logic, integration for jobs/pipelines).
- Use DuckDB for testing analytics queries where possible.
- Make jobs idempotent and resumable.
- Add input validation and graceful error handling with retries (especially for API polling and R2/D1 operations).
- Prefer deterministic behavior and clear logging for debugging scheduled jobs.

## Documentation

- Update README.md or relevant docs when adding features, new CLI commands, or changing architecture.
- Include usage examples for new CLI commands.
- Keep architecture diagrams (text-based) up to date if present.

## Git & Commit Workflow

After any code change or refactor you perform:
- Always generate a concise, high-quality conventional commit message.
- Follow Conventional Commits format: `<type>(<scope>): <description>`
  - Types: feat, fix, refactor, docs, chore, test, style, perf, ci, build, etc.
- Keep the subject line under 72 characters.
- Include a short body if the change is complex (what + why).
- Output the commit message clearly at the end of your response, e.g.:

```commit
refactor(pipeline): migrate raw storage to tiered R2 + DuckDB architecture

- Moved historical snapshots to partitioned JSONL/Parquet in R2
- Updated D1 tables to only hold compact serving data
- Added build_features and backtest_opportunities batch jobs
- Preserved all existing live bot behavior

## Final Response Marker
**Every time you have fully completed the entire user request, end your final response with exactly:**

**GROK_DONE_✅**

This triggers my iTerm2 sound notification.