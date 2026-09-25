## The Brain Freeze demo

A small insurance company, living entirely inside the database: a Flask app, a
notebook and an agent's MCP server over one dataset, and no persistence layer
anywhere — no ORM, no schema, no migration. A handler assigns to an object and
commits.

Installing it clones
[brain-freeze](https://github.com/GemTalk/brain-freeze) into `~/GemDB/brain-freeze`
(beside your database, under whatever root path you have set), opens that
folder, and shows its readme, which takes it from there.

- **An empty window** opens the demo in place. **A window with a folder open**
  is left alone, and the demo gets a new window.
- **VS Code asks whether you trust the folder**, as it does for any freshly
  cloned repository. The readme appears once you say yes.
- **Running it again** opens the copy you already have. It never clones over
  it, so your own changes are safe.

It needs `git`, and it doesn't start the database — the first cell you run in
the demo's notebook does that.
