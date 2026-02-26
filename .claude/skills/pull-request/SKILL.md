---
name: pull-request
description: Guide for creating pull requests on the comp monorepo. Use this whenever opening a PR.
---

# Pull Request Guide

Use this skill when creating a pull request on the comprehensiveio/comp repo.

## Branch & PR workflow

1. Create a descriptive branch name (e.g., `fix-base-column-wrapping`)
2. Commit your changes with a clear message
3. Push the branch and open a PR against `qa`
4. Keep PR titles short and descriptive — no `fix:` or `feat:` prefixes

## Linking Linear tickets

If your change fixes or addresses a Linear ticket, include the ticket reference in the PR description body:

```
Fixes COM-1234
```

This auto-links the PR to the Linear ticket and moves it to "Done" when the PR merges. Use the exact ticket ID from Linear (e.g., `COM-6822`, `COM-7001`).

- Use `Fixes COM-XXXX` when the PR fully resolves the ticket
- Use `Refs COM-XXXX` when the PR is related but doesn't fully close it

## PR description format

Keep descriptions concise:

```
## Summary
- Brief description of what changed and why

Fixes COM-1234
```

No need for lengthy implementation details — the diff speaks for itself.
