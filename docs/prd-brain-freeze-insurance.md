# PRD: Brain Freeze Insurance

**Status** In progress  
**Owner** [Sandeep Parikh](mailto:sandeep.parikh@gemtalksystems.com)  
**Reviewers** [James Foster](mailto:james.foster@gemtalksystems.com)
| [Steven Baker](mailto:steven.baker@gemtalksystems.com)  
**Last Updated** Sep 2, 2026

# 0\. Table of Contents

- [1\. Background](#1.-background)
- [2\. Goals](#2.-goals)
- [3\. Non-goals](#3.-non-goals)
- [4\. Personas](#4.-personas)
- [5\. Surfaces](#5.-surfaces)
- [6\. Critical user journeys](#6.-critical-user-journeys)
  - [CUJ-0 — Setup & data provisioning](#cuj-0-—-setup-&-data-provisioning)
  - [CUJ-1 — Explore the dataset in a notebook](#cuj-1-—-explore-the-dataset-in-a-notebook)
  - [CUJ-2 — Ask questions of the data via AI chat \+ MCP](#cuj-2-—-ask-questions-of-the-data-via-ai-chat-+-mcp)
  - [CUJ-3 — Run the web app: get a quote, file a claim](#cuj-3-—-run-the-web-app:-get-a-quote,-file-a-claim)
  - [CUJ-4 — Extend the schema and redeploy (flavor & toppings)](<#cuj-4-—-extend-the-schema-and-redeploy-(flavor-&-toppings)>)
- [7\. Functional requirements](#7.-functional-requirements)
  - [7.1 Dataset & generator (GitHub-distributed) — supports CUJ-0](<#7.1-dataset-&-generator-(github-distributed)-—-supports-cuj-0>)
  - [7.2 Data import into GemDB — supports CUJ-0 (mechanism itself is a separate workstream)](<#7.2-data-import-into-gemdb-—-supports-cuj-0-(mechanism-itself-is-a-separate-workstream)>)
  - [7.3 Jupyter notebook experience — supports CUJ-1](#7.3-jupyter-notebook-experience-—-supports-cuj-1)
  - [7.4 MCP server — supports CUJ-2](#7.4-mcp-server-—-supports-cuj-2)
  - [7.5 Web app — quote flow — supports CUJ-3](#7.5-web-app-—-quote-flow-—-supports-cuj-3)
  - [7.6 Web app — claims flow — supports CUJ-3](#7.6-web-app-—-claims-flow-—-supports-cuj-3)
  - [7.7 Schema evolution / redeploy — supports CUJ-4](#7.7-schema-evolution-/-redeploy-—-supports-cuj-4)
  - [7.8 Packaging & cross-cutting](#7.8-packaging-&-cross-cutting)
- [8\. Open questions](#8.-open-questions)

# 1\. Background

Brain Freeze Insurance is a fun, low-stakes sample application: a mock insurance product covering kids/teens against "brain freeze" (cold-stimulus headache). It exists to give people evaluating the **GemDB Code** extension a single, coherent scenario they can experience through three different surfaces — a Jupyter notebook, an AI chat client talking to a GemDB-hosted MCP server, and a small local web app — all reading and writing the same live GemDB database.

The underlying dataset (synthetic policyholders \+ claims, generated from a public script) is already built. This PRD covers the demo application layer on top of it: how someone gets the data into GemDB, and what they can then _do_ with it across the three surfaces.

# 2\. Goals

- Give a new GemDB Code user a working, end-to-end example within minutes of installing the extension.
- Showcase three distinct interaction models on top of one shared database: interactive notebook exploration, natural-language/MCP querying, and a conventional web app.
- Demonstrate GemDB's schema evolution story by having the user actually change the schema (add fields) and redeploy, rather than just reading about it.
- Keep the whole thing runnable locally, offline-friendly, and easy to reset (regenerate data from scratch at any time).

# 3\. Non-goals

- Not a real insurance product: no real underwriting, compliance, KYC, or payments.
- Not a scale/performance benchmark for GemDB (single local user, modest data volume — thousands of rows, not millions).
- Not a full auth/multi-tenant system. Assume a single local user/session
- Not a mobile app
- Not a (scalable) data import tool/approach

# 4\. Personas

| Persona            | Description                                                                           | Primary surface(s)                                          |
| :----------------- | :------------------------------------------------------------------------------------ | :---------------------------------------------------------- |
| **Evaluator**      | Developer trying GemDB Code for the first time, deciding if it's worth adopting       | All three, in sequence                                      |
| **Data Explorer**  | Comfortable with Jupyter/pandas-style analysis, wants to poke at data and run queries | Notebook                                                    |
| **AI-native user** | Prefers asking questions in natural language over writing code                        | AI chat \+ MCP                                              |
| **App developer**  | Wants to see GemDB as an app backend, including changing the schema                   | Web app (both quote/claim flows and the schema-change flow) |

# 5\. Surfaces

| Surface  | Interface                                  | Runs on                                                                  | Primary use case                                                                                       |
| :------- | :----------------------------------------- | :----------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| Notebook | Jupyter (bundled with GemDB Code)          | GemDB Code's built-in Python runtime, in-process with GemDB              | Interactive data exploration, ad hoc analysis                                                          |
| AI chat  | Any MCP-capable chat client (Claude, etc.) | GemDB MCP server, running in the persistence layer                       | Natural-language Q\&A over risk/policy data                                                            |
| Web app  | Browser                                    | Local web server \+ GemDB, source included and runnable/editable locally | Product-shaped interactions: get a quote, file a claim; also the vehicle for the schema-change journey |

All three surfaces read/write the **same** GemDB instance and dataset — a change made in one surface (e.g., a claim filed in the web app) should be visible from the others (e.g., queryable from the notebook or via MCP).

# 6\. Critical user journeys

## CUJ-0 — Setup & data provisioning

**Actor:** any persona, first-time setup

1. Install the [GemDB Code extension](https://marketplace.visualstudio.com/items?itemName=GemTalkSystems.gemdb) in VS Code.
2. Clone/download the Brain Freeze Insurance demo repo from GitHub. It contains: the dataset generator script, pre-generated `policyholders.csv` and `claims.csv`, the notebook(s), the MCP server config, and the web app source.
3. Optionally re-run the generator script locally to produce a fresh dataset (or just use the CSVs as shipped).
4. Run the documented import step to load the CSVs into a running GemDB instance. _(Import mechanism TBD separately — treated here as: "given two CSVs, produce a populated GemDB database with a known schema.")_
5. Verify the load succeeded (row counts match, a sample query returns expected data).

**Success:** user has a local GemDB instance populated with the Brain Freeze Insurance dataset and is ready to start any of CUJ-1 through CUJ-4.

---

## CUJ-1 — Explore the dataset in a notebook

**Actor:** Data Explorer

1. Open the bundled notebook using GemDB Code's built-in Jupyter support.
2. Notebook connects to the local GemDB instance (kernel already wired up by the extension, or one documented connection step).
3. Run pre-built cells that: list the schema/classes, load policyholders/claims into familiar Python structures, compute summary stats (risk tier distribution, loss ratio by tier, claim severity distribution), and render a couple of basic charts.
4. Go off-script: write ad hoc queries against the live data using GemDB's Python API directly.

**Success:** user understands the data model and can independently query it; has run at least one aggregate analysis beyond the pre-built cells.

---

## CUJ-2 — Ask questions of the data via AI chat \+ MCP

**Actor:** AI-native user

1. Start the GemDB MCP server (runs in the persistence layer, against the same populated instance from CUJ-0).
2. Connect an MCP-capable AI chat client of their choice to that server.
3. Ask natural-language questions about risk and policy data — e.g. "what's our loss ratio by risk tier," "which coverage plan is least profitable," "show me the 10 policies most likely to file a claim this year."
4. Get answers that are grounded in the live GemDB data (not hallucinated), ideally with the AI showing or citing the query/computation it ran.

**Success:** user gets correct, data-grounded answers to at least a couple of risk/policy questions without writing any code themselves.

---

## CUJ-3 — Run the web app: get a quote, file a claim

**Actor:** Evaluator / general user

1. Start the bundled web app locally (single documented command) and open it in a browser.
2. **Quote flow:** enter a prospective policyholder's info (age, sex, migraine/tension-headache history, favorite trigger, typical eating speed) → app computes a risk tier and premium quote across the available coverage plans, mirroring the logic in the generator.
3. **Claim flow:** as an existing policyholder, file a new claim — pick a trigger, enter event details/severity → app runs it through claim-adjudication logic (deductible, coverage limit, annual claim cap) and returns approved/denied with an amount and, if denied, a reason.
4. See the new quote/claim reflected in the policyholder's record and (per §5) visible from the other surfaces.

**Success:** user completes one full quote flow and one full claim flow end-to-end against live GemDB data.

---

## CUJ-4 — Extend the schema and redeploy (flavor & toppings)

**Actor:** App developer

1. Open the web app source locally.
2. Add two new dimensions to the claim-capture flow: **flavor** (of the trigger — e.g. ice cream flavor) and **toppings** (a list, e.g. sprinkles, hot fudge).
3. Update whatever GemDB schema/class definitions need to change to store the new fields.
4. Update the web UI to capture flavor \+ toppings when filing a claim.
5. Redeploy/restart the app.
6. Verify: existing policies/claims are unaffected (no data loss, no corruption), new claims can store flavor \+ toppings, and check what happens on the other two surfaces

**Success:** developer adds a real field to a live schema and redeploys without a data migration outage, and can articulate what GemDB did (and didn't do) automatically across the three surfaces as a result.

---

# 7\. Functional requirements

Numbered so we can review and adjust item-by-item. Each references the CUJ(s) it supports.

## 7.1 Dataset & generator (GitHub-distributed) — supports CUJ-0

- **FR-1.1** The demo repo (public GitHub) includes the generator script, its dependencies/requirements, and pre-generated `policyholders.csv` \+ `claims.csv` so a user can skip generation entirely.
- **FR-1.2** Running the generator script with no arguments reproduces a dataset with the same shape/columns as the shipped CSVs (seeded RNG for reproducibility, as today).
- **FR-1.3** The repo documents the schema of both CSVs (columns, types, relationship via `policy_id`) so it can be mapped to GemDB classes.
- **FR-1.4** The repo documents minimum tooling versions (Python, any packages) needed to run the generator.

## 7.2 Data import into GemDB — supports CUJ-0 (mechanism itself is a separate workstream)

- **FR-2.1** A documented, single command/procedure loads both CSVs into a running GemDB instance, creating/using classes for policyholders and claims with the relationship preserved.
- **FR-2.2** The import step is idempotent or clearly documents what happens on re-run (append vs. replace vs. error).
- **FR-2.3** After import, a documented "smoke test" (e.g., a query or count) confirms success and expected row counts.
- **FR-2.4** Import errors (malformed CSV, GemDB not running, schema mismatch) produce actionable error messages.

## 7.3 Jupyter notebook experience — supports CUJ-1

- **FR-3.1** A bundled notebook ships in the repo and opens/runs correctly under GemDB Code's built-in Jupyter support with no extra setup beyond CUJ-0.
- **FR-3.2** The notebook connects to the local GemDB instance using a documented, minimal connection pattern (ideally auto-discovered by the extension).
- **FR-3.3** Pre-built cells cover: schema/class introspection, loading policyholders/claims, at least 3 baseline aggregate analyses (e.g. risk tier distribution, loss ratio by tier, claim severity distribution), and at least one chart.
- **FR-3.4** The Python API for querying GemDB from the notebook is documented well enough that a user can write a novel ad hoc query without consulting external docs.
- **FR-3.5** Notebook cells run against live data — re-running after a claim is filed via the web app (CUJ-3) reflects the new claim.

## 7.4 MCP server — supports CUJ-2

- **FR-4.1** A GemDB MCP server can be started locally (documented command) and runs "in the persistence layer" against the populated instance from CUJ-0.
- **FR-4.2** The repo documents how to connect at least one popular MCP-capable AI chat client to the server (connection config, auth if any).
- **FR-4.3** The MCP server exposes enough tool surface (query/read access at minimum) for an AI client to correctly answer representative risk/policy questions (loss ratio by segment, top-N riskiest policies, claim approval rates, etc.).
- **FR-4.4** Answers are grounded in live data — a question asked before and after a change made via the web app or notebook returns updated results.
- **FR-4.5** The MCP server's data access is read-only by default, or if it supports writes, that's explicit and separately callable out (open question: should CUJ-2 support write actions like "file a claim" via chat, or is that out of scope for v1?).

## 7.5 Web app — quote flow — supports CUJ-3

- **FR-5.1** App starts locally with a single documented command and serves a browser UI.
- **FR-5.2** A quote form collects the same underwriting inputs used by the generator (age, sex, migraine/TTH history, favorite trigger, typical consumption speed).
- **FR-5.3** Submitting the form computes a risk score, risk tier, and premium per available coverage plan, using logic consistent with the generator's underwriting model.
- **FR-5.4** The user can view quotes across all coverage plans (Basic/Standard/Premium) side by side before choosing one.
- **FR-5.5** Accepting a quote creates a new policyholder record in GemDB.

## 7.6 Web app — claims flow — supports CUJ-3

- **FR-6.1** An existing policyholder can file a new claim: select trigger, enter event details (temperature/portion/speed or a simplified subset), enter severity/symptoms.
- **FR-6.2** Submitting a claim runs adjudication logic consistent with the generator (deductible, per-incident coverage limit, annual claim cap) and returns approved/denied \+ amount \+ reason if denied.
- **FR-6.3** A policyholder's claim history (past claims, statuses, amounts) is viewable in the app.
- **FR-6.4** New claims are persisted to GemDB and immediately visible to the other two surfaces (per FR-3.5 and FR-4.4).

## 7.7 Schema evolution / redeploy — supports CUJ-4

- **FR-7.1** The web app's claim model/schema can be extended with two new fields — `flavor` (string) and `toppings` (list of strings) — via a documented code change.
- **FR-7.2** The corresponding GemDB class definition can be updated to store the new fields without a separate/manual data migration step for existing records (or, if some step _is_ required, it's documented as part of this requirement rather than discovered by accident).
- **FR-7.3** After redeploying, existing policyholders/claims remain intact and queryable (no data loss).
- **FR-7.4** New claims filed after the change can store `flavor` and `toppings`; old claims are readable without erroring even though they lack these fields.
- **FR-7.5** The demo documents, explicitly, what the notebook and MCP surfaces do when the schema changes underneath them (nothing / auto-pick-up / requires their own update) — this is a documented _finding_ of the journey, not a requirement that all three auto-sync unless we decide that's the story we want to tell.
- **FR-7.6** "Redeploy" is defined precisely for this environment (e.g., restart the web app process vs. a GemDB image update) and documented as a single repeatable step.

## 7.8 Packaging & cross-cutting

- **FR-8.1** All three surfaces (notebook, MCP server, web app) work fully offline after initial setup (no external network dependency at run time), consistent with this being a local demo.
- **FR-8.2** A top-level README in the GitHub repo sequences the journeys (CUJ-0 → 1 → 2 → 3 → 4\) with copy-pasteable commands for each.
- **FR-8.3** The dataset/GemDB instance can be reset to a clean state (re-import from CSV) at any point, so a user can retry a journey without contaminating results from a previous pass.

# 8\. Open questions

**What exactly does the CSV → GemDB import step look like?**  
There will be a Python script that reads the csv files and creates Python objects representing the data as policyholder objects. Each policyholder object will also have a list of claims filed. Those objects will be committed to GemDB.

**Is the MCP server read-only?**

Yes, the demo does not include the ability to make data changes (e.g. file claims) via MCP

**Should the notebook/MCP surfaces auto-reflect the CUJ-4 schema change?**

Yes. After the schema change, a user can return to the Jupyter notebook and see the new data.

**Do we need a "reset demo" command as a first-class feature (FR-8.3), or is re-running import sufficient?**

No.
