## Setup for this machine's database

GemDB Code is set to use a database that this machine's administrator installed and runs, because
[`gemdb.externalDatabase.gemstone`](command:workbench.action.openSettings?%22gemdb.externalDatabase%22)
is set. The administrator looks after the database engine, the database, and shared memory, so
GemDB Code downloads nothing and creates nothing.

Setup installs Python into your database account: Grail, GemTalk Systems' implementation of Python
for GemDB. It keeps its copy of Grail under `~/GemDB`, unless you set
[`gemdb.rootPath`](command:workbench.action.openSettings?%22gemdb.rootPath%22) to another folder.

### When the database is not running

GemDB Code does not start or stop a database that someone else runs. If the database is down,
GemDB Code says so instead of starting it. Ask the administrator to start it.

### Going back to a database of your own

Clear `gemdb.externalDatabase.gemstone` to go back to a database that GemDB Code installs and runs
for you.
