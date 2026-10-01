## The Brain Freeze demo

Brain Freeze is a small insurance company's web app, built with Flask. Its data, classes, and views
are all stored in the database, and the app, a notebook, and an AI agent all work with the same
data. There is no object-relational mapper (ORM), schema, or migration: to save a change, the app
updates a Python object and commits.

### Before you install

GemDB Code uses `git` to clone the demo, so `git` must be installed on your computer. Installing the
demo does not start the database. If the database is stopped, it starts when you run the first cell
in the demo's notebook.

### Installing it

Click **Install Brain Freeze Demo**, or choose it from the **⋯** menu in the GemDB Code sidebar.
GemDB Code clones the demo from GitHub into `~/GemDB/brain-freeze`, opens that folder, and displays
the demo's README, which walks you through the required steps and notes important details.

- If your window is empty, the demo opens in it. Otherwise, it opens in a new window and leaves your
  current folder as it is.
- VS Code opens the new folder in Restricted Mode, and prompts you to trust it the first time you
  run a cell or open a terminal there. To trust everything GemDB Code installs at once, add
  `~/GemDB` in **Workspaces: Manage Workspace Trust**.
- If you install the demo again, GemDB Code opens your existing copy instead, so your current
  version and any changes you made are not overwritten.
