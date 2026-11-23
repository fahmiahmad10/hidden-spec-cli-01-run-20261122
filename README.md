[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fahmiahmad10/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fahmiahmad10/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

An entry for make.fun's [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
("Build mend, one patch tool for every AI edit format"). `main.ts` is mend, a
command-line tool that applies the edits AI models write, in four formats, to a
tree of text files — to the specification that ships in the kit's `SPEC.md`.

Node 22, standard library alone, run as:

    node main.ts [options] [PATCH]

## The four formats

- **Unified diffs** — `diff --git` sections, `---`/`+++` headers, rename/new/deleted
  file modes, hunks applied nearest their stated line, with `\ No newline`
  handling and CRLF files kept CRLF.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  the path taken from the nearest line above the block (or the previous block's).
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, Add/Delete/Update File
  sections, `@@` anchors, a moving cursor and `*** End of File` chunks.
- **JSON edits** — one array of edit objects, or one object per line:
  `create`, `str_replace`, `insert`.

## Matching

Every old block is found at the first of three tiers that has a match: exact
lines, then lines ignoring trailing whitespace, then lines ignoring leading and
trailing whitespace — with new lines re-indented to the file's own indent at
tier 2 and context lines always written as the file's own. `--strict` uses tier
0 only. A block that occurs twice is `ambiguous` (unified and V4A take the
occurrence nearest the stated line, or the first at or after the cursor).

## Behaviour

- Safe paths only: relative, no empty, `.` or `..` segments, no backslashes.
- All or nothing: every edit applies, or a failed edit changes nothing and
  later edits still run; when any edit fails, no file is written at all.
- Output is the `A`/`D`/`M` lines (and `R old -> new` for moves), sorted by
  path, then `ok: N file(s)`; failures print `error: <code> <path>` lines and
  `failed: X of Y edits`. Exit 0 on success, 1 when an edit fails, 2 for
  usage, format, parse and no-patch errors.
- `--check` previews without writing; `--format=` forces one of the four
  formats (or `auto`, the default); the patch comes from the file named, from
  `-`, or from stdin.

## The files

- `main.ts`: the CLI. Its last lines hand a trial over to `runner.ts` when
  `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's trial runner, kept as it is.
- `LICENSE`: MIT.

## Practice score

100 of 100 practice checks pass (practice score 1000): unified 30/30,
search-replace 20/20, v4a 20/20, json 15/15, cli 15/15.
