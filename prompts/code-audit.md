## Run first in cursor 

Audit this repository for correctness, maintainability, architecture, and hidden bugs.

Do not modify any files yet.

Focus on:
1. Bugs or logic errors that could produce incorrect results
2. Data ingestion edge cases
3. API error handling, retries, rate limits, and pagination issues
4. Schema/data-model problems
5. Places where tests are missing or weak
6. Dead code, duplicated logic, or unnecessary complexity
7. Parts of the architecture that will make future development harder
8. Security or secrets-handling issues
9. Performance bottlenecks that matter for this project
10. Opportunities to make the code easier to understand without large rewrites

For each finding, provide:
- Severity: critical / high / medium / low
- File(s) involved
- Why it matters
- Proposed fix
- Whether the fix is safe, moderate, or risky
- Whether tests should be added or updated

Prioritize practical improvements over stylistic preferences. Do not recommend large rewrites unless there is a clear payoff.

## Implement fix in cli

Implement only this specific fix: <paste finding>.

Constraints:
- Do not modify unrelated files.
- Do not refactor broadly.
- Preserve existing public interfaces, CLI commands, database schemas, and file formats.
- Add or update tests for the behavior change.
- Run the relevant tests/checks.
- Show a concise summary of changed files, why each change was needed, and remaining risks.