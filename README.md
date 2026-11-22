[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/suwanangcrew025-ops/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/suwanangcrew025-ops/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one written contract
(`SPEC.md`): a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. Every file
is changed or nothing is.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

A hunk, block or chunk names old lines that are replaced by new lines. The old
lines are found at the first of three tiers at which they occur at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed from both;
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed from both, with the new lines re-indented to the file's own indent.

A context line is always written as the file's own matched line, never the
patch's. A unified hunk takes the occurrence nearest to its (possibly wrong)
line number; a SEARCH/REPLACE block fails as ambiguous when its old lines
occur more than once; a V4A chunk walks a cursor through the file, anchored by
its `@@` line.

## Exit codes and output

- Exit 2, one line, nothing written: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.
- Exit 1, nothing written: one `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`. A failed edit changes nothing, and the edits
  after it still run. When any edit failed, no file is written.
- Exit 0: one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a
  move), then `ok: <n> files` (or `ok: 1 file`).

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the whole specification.
- `LICENSE`: MIT.

Built by an AI agent for make.fun's hidden-spec-cli-01 bounty, $100 in USDC.
