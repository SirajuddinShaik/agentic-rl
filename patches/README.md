# Patch Guide

This directory contains reviewable diffs from the live RTX1 source trees.

| File | Source tree |
| --- | --- |
| `xyne-search-current.patch` | `/data/siraj/xyne_s/xyne-search-test` |
| `polar-current.patch` | `/data/siraj/ARL/ProRL-Agent-Server` |
| `miles-current.patch` | `/data/siraj/ARL/miles` |

## Apply a patch

From the matching upstream checkout:

```bash
git apply --check /path/to/agentic-rl/patches/<patch-file>
git apply /path/to/agentic-rl/patches/<patch-file>
```

If the target tree already contains some changes, use a three-way apply:

```bash
git apply --3way /path/to/agentic-rl/patches/<patch-file>
```

## Notes

- These patches capture tracked-file modifications at snapshot time.
- Untracked new files are already present in this repository under the
  corresponding source directories.
- The source directories in this repository are the primary source of truth.
