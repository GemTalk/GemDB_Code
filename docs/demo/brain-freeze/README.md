# Brain Freeze Insurance has moved

**→ [github.com/GemTalk/brain-freeze](https://github.com/GemTalk/brain-freeze)**

This demo used to live here. Its PRD always intended otherwise — FR-1.1 and
FR-8.2 ask for a public repo of its own — and it now has one, with the notebook
(CUJ-1), the MCP surface (CUJ-2) and the schema change (CUJ-4) that the version
here never covered.

The version that lived here is not gone. It is committed at
[`c9c261a`](https://github.com/GemTalk/GemDB_Code/tree/c9c261ac017fd7831cd29aa71b79da4ee8c1ed9b/docs/demo/brain-freeze),
and everything that cites it — including the new repo, which disagrees with two
of its findings — links to that commit rather than to this path.

## Why you might want the old one

It measured Grail `46c2a68`; the new repo measures `c875e56`. Two of its five
findings do not reproduce there:

- **a schema change keeps `isinstance`** — on `c875e56` it does not
- **calling a function for the first time dirties the session** — on `c875e56`
  a first call to a never-compiled function leaves `needs_commit()` False;
  what dirties the session is running the code at all

Both measurements are reproducible on their own Grail. If you are chasing which
behaviour is current, the old scripts are the other half of that comparison.
