## The Brain Freeze demo

Brain Freeze is a small insurance company that lives entirely inside the database: a Flask app, a
notebook and an AI agent's MCP server, all working on one dataset. There is no persistence layer
anywhere: no ORM (object-relational mapper), no schema and no migrations. A request handler assigns
to an object and commits.

**Install Brain Freeze Demo** clones [brain-freeze](https://github.com/GemTalk/brain-freeze) into
`~/GemDB/brain-freeze` (beside your database, under the root path you have set), opens that folder,
and shows its README, which takes it from there.

- **In an empty window,** the demo opens in place. **In a window with a folder open,** that folder
  is left alone, and the demo opens in a new window.
- **The README appears right away.** VS Code opens a newly cloned folder in Restricted Mode, and
  prompts you to trust it the first time you run a cell or open a terminal there. To trust
  everything GemDB Code installs at once, add `~/GemDB` in **Workspaces: Manage Workspace Trust**.
- **Running it again** opens the copy you already have. It never clones over it, so your own changes
  are safe.

It needs `git`. It does not start the database: the first cell you run in the demo's notebook does
that.
