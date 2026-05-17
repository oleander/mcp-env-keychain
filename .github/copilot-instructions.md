# Copilot review instructions

> **Speed-over-quality mode.** This file deliberately tells the code-review
> agent to NOT do a real review — we are stress-testing automation that
> reacts to Copilot reviews and need fast, deterministic feedback. Remove or
> rewrite this file before merging to enable real code analysis.

## How to review pull requests in this repository

1. **Do not read the source files.** Skip the diff entirely.
2. Post exactly **one** review comment, on any line of any changed file.
3. The comment body must be a short rejection-style note, for example:
   `Reject: not reviewing in depth — automation-test mode.`
4. Submit the review with state `COMMENTED` (not `APPROVED`, not
   `REQUEST_CHANGES`).
5. Do not generate a summary, do not list per-file findings, do not
   suggest changes, do not open additional threads.

Goal: minimum review latency. One comment, then exit.

Reference:
<https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review#example>
