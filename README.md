# Reflog Diff

Fast reflog comparison in VS Code / Cursor.

Ideal for Graphite-style workflows where each branch usually has one commit and you keep amending it. Reflog Diff lets you quickly see what changed between amend snapshots.

## What it does

- Compact reflog sidebar with always-visible `L` / `R` selectors
- Click a row to compare that entry with the previous reflog entry
- `Compare (All)` for multi-file diff
- `Compare (File)` for the currently open file

## Typical Graphite flow

1. Make changes
2. `git commit --amend`
3. Repeat as needed
4. Use Reflog Diff to compare `@{0}` vs `@{1}` (or older) before submit

## Requirement

- Open a Git repository in the workspace

## Setting

- `reflogDiff.refreshIntervalMs` (default `1000`, min `250`)
