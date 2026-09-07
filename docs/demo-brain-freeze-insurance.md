# Brain Freeze Insurance

A small insurance company that covers the cold-stimulus headache, living
entirely inside the database. It exists to answer one question an evaluator
asks after the rabbit comes out of the hat: *fine, but can I build an
application on this?*

The scripts are in [`demo/brain-freeze/`](demo/brain-freeze/). Every command
and every line of output below was run on 2026-09-07 against a real
GemStone/S 3.7.5 stone carrying Grail `46c2a68`; where something surprised
me, it is written down rather than tidied away — four of the findings cost
enough time that they are the most useful part of this document.

This implements the quote flow (FR-5.x) and the claims flow (FR-6.x) of the
Brain Freeze Insurance PRD. It does not implement the notebook (CUJ-1), the
MCP server (CUJ-2), the CSV import (§7.2) or the schema change (CUJ-4) — but
it is built so CUJ-4 is a ten-line edit, and the measurements below are why.

> **Before you start.** A terminal opened in VS Code has `gemdb` on its PATH
> already; in any other terminal, put it there:
>
> ```sh
> export PATH="$HOME/GemDB/bin:$PATH"   # not needed in a VS Code terminal
> cd docs/demo/brain-freeze
> ```

---

## What it is

Four files, and no framework beyond Flask:

| File | What it owns |
| --- | --- |
| `underwriting.py` | the questionnaire, the risk score, the premium formula, the claim rules — every number the product depends on, in one constants block |
| `model.py` | the objects, the persistent root structure, the indexes, and the four rules for storing Python in a live database |
| `app.py` | the Flask app: the quote flow, the claims flow, and a handful of JSON endpoints |
| `verify.py` | read the whole database back from a session of its own; also the smoke test |

`underwriting.py` imports nothing from the database and `app.py` contains no
arithmetic, so the product rules can be read, argued about and changed
without thinking about sessions, and the app can be changed without
re-deriving a premium.

That split has a second payoff worth knowing about: because
`underwriting.py` is pure, **plain CPython can import it and check the
numbers in this document** — no database, no engine, no Grail. Every premium,
the risk score of 101 before clamping, and all seventeen adjudications in
Act 4 were re-derived that way while reviewing this file:

```console
$ cd docs/demo/brain-freeze && python3 -c "
import underwriting as uw
print(uw.fmt_money(uw.premium_cents('Standard', 100)))
print(uw.adjudicate('Standard', 5, 50000, True, 'active', 0, 0)['rule'])"
$14.00
per-incident-limit
```

## Act 1 — Start it

```console
$ gemdb app.py
Brain Freeze Insurance on http://127.0.0.1:8720/  (ctrl-c to stop)
```

That is the whole deployment. There is no database driver, no connection
string, no ORM and no migration, because the app is not talking to a
database over a socket — it *is* running in the database, and `gemdb.root` is
the same dictionary the shell and a notebook see.

`app.py` calls `werkzeug.serving.make_server` directly rather than
`app.run()`: one explicit server object on one port, holding this session for
as long as it serves. It binds `127.0.0.1` unless `BFI_HOST` says otherwise,
because the app has no authentication and can commit.

## Act 2 — Sixteen questions

The questionnaire is almost, but not quite, actuarially serious. Nothing
medical and nothing intrusive — no headache history, no medication, no
diagnosis. What a real underwriter would ask is exactly what this product
declines to.

```console
$ curl -s localhost:8720/api/questions | head -20
[
    {
        "field": "age",
        "kind": "int",
        "max": 25,
        "min": 5,
        "prompt": "How old are you?",
        "rationale": "Cold-stimulus headache peaks in the early teens and eases after; the middle of the range carries the load.",
        "scored": true,
        "values": null
    },
```

Thirteen of the sixteen move the price. Three — handedness, whistling, and
pineapple on pizza — are marked `"scored": false` and are there because the
form looked short. They are stored with everything else and shown back on
the quote, greyed out, at zero points: a quote that shows its working should
show what it ignored too.

Every contributing question carries a one-line rationale, and every rationale
is delivered with a straight face:

- **hair colour** — Redheads have a documented anaesthetic sensitivity. We extend it to ice cream without evidence of any kind.
- **spoon or straw** — A straw delivers the cold straight to the roof of the mouth under suction. Spoons are, genuinely, safer.
- **cilantro** — OR6A2 is a real taste-receptor variant. Its relevance to the sphenopalatine ganglion is entirely invented.
- **shoe size** — Correlates with body mass, which correlates with portion size. Two correlations and no mechanism, priced accordingly small.
- **slushies last month** — Exposure. Underwriting is mostly exposure.

## Act 3 — A quote, across all three plans

```console
$ curl -si -X POST localhost:8720/quote \
    --data-urlencode 'applicant_name=Priya Raman' -d 'age=13' -d 'gender=female' \
    -d 'hair_colour=red' -d 'siblings=3' -d 'birth_order=youngest' \
    -d 'handedness=left' -d 'tongue_roll=no' -d 'cilantro_soap=yes' \
    --data-urlencode 'favorite_flavor=mint choc chip' -d 'spoon_or_straw=straw' \
    -d 'eating_speed=competitive' -d 'prior_freezes=9' -d 'can_whistle=no' \
    -d 'pineapple_pizza=undecided' -d 'shoe_size=7' -d 'slushies_last_month=14'
HTTP/1.1 302 FOUND
Location: /quote/BFI-Q-000001
```

```console
$ curl -s localhost:8720/quote/BFI-Q-000001
...
<p>Risk score <strong>100</strong> of 100 -- tier <strong>Full Ache</strong>.</p>
    <h3>Basic</h3>    <div class="price">$8.00<span class="tag">/month</span></div>
    <h3>Standard</h3> <div class="price">$14.00<span class="tag">/month</span></div>
    <h3>Premium</h3>  <div class="price">$24.00<span class="tag">/month</span></div>
```

A thirteen-year-old redhead with three older siblings who drinks
competitively through a straw scores 101 before clamping, which is a
reasonable place for the worst realistic profile to land.

The same flow in JSON, for a calmer applicant:

```console
$ curl -s -X POST localhost:8720/api/quote -H 'Content-Type: application/json' \
    --data @calm.json
quote_id BFI-Q-000002 | score 14 - Cool Head
  Basic      $4.56/mo  deductible $15.00  per-incident  $50.00  annual cap  $150.00
  Standard   $7.98/mo  deductible $10.00  per-incident $125.00  annual cap  $500.00
  Premium   $13.68/mo  deductible  $5.00  per-incident $300.00  annual cap $1200.00
```

Buying is one POST, and creates a policyholder and a policy:

```console
$ curl -s -o /dev/null -w '%{redirect_url}\n' \
    -X POST localhost:8720/quote/BFI-Q-000001/accept -d 'plan=Standard'
http://127.0.0.1:8720/policy/BFI-P-000001
```

## Act 4 — Claims, and nine ways to decide one

Adjudication runs the deductible, the per-incident limit, the annual payout
cap and an annual claim count, in that order, and reports **which rule
actually bound** — not the first one that could have. A $500 claim at
severity 5 on Standard is capped twice, by the severity schedule to $300 and
then by the $125 per-incident limit, and it is the second cap that decided
the number.

Every rule, exercised over three policies:

```console
$ gemdb verify.py
Brain Freeze Insurance -- as committed to the database
store version 1

3 policyholder(s), 3 policy(ies), 3 quote(s), 17 claim(s): 10 approved, 7 denied (58.82% approved)

BFI-P-000001  Standard  Priya Raman       score 100  Full Ache         $14.00/mo  lapsed
    BFI-C-000001  Slushie          sev 4  claimed    $42.00  ->  denied       $0.00  event-outside-term
    BFI-C-000002  Ice cream        sev 4  claimed    $42.00  ->  approved    $32.00  paid-in-full
    BFI-C-000003  Iced water       sev 1  claimed     $8.00  ->  denied       $0.00  below-deductible
    BFI-C-000004  Milkshake        sev 5  claimed   $500.00  ->  approved   $125.00  per-incident-limit
    BFI-C-000016  Ice cream        sev 3  claimed    $30.00  ->  denied       $0.00  policy-not-active
BFI-P-000002  Basic     Tomas Lindqvist   score  14  Cool Head          $4.56/mo  active
    BFI-C-000005  Popsicle         sev 5  claimed    $90.00  ->  approved    $50.00  per-incident-limit
    BFI-C-000006  Popsicle         sev 5  claimed    $90.00  ->  approved    $50.00  per-incident-limit
    BFI-C-000007  Popsicle         sev 5  claimed    $90.00  ->  approved    $50.00  per-incident-limit
    BFI-C-000008  Popsicle         sev 5  claimed    $90.00  ->  denied       $0.00  annual-payout-cap-exhausted
    BFI-C-000017  Ice cream        sev 3  claimed    $25.00  ->  denied       $0.00  annual-payout-cap-exhausted  [mint choc chip + sprinkles, hot fudge]
BFI-P-000003  Premium   Marisol Okonkwo   score  59  Rapid Onset       $19.08/mo  active
    BFI-C-000009  Frozen yoghurt   sev 2  claimed   $100.00  ->  approved    $25.00  severity-schedule-capped
    BFI-C-000010  Snow             sev 5  claimed   $500.00  ->  approved   $295.00  severity-schedule-capped
    BFI-C-000011  Snow             sev 5  claimed   $500.00  ->  approved   $295.00  severity-schedule-capped
    BFI-C-000012  Snow             sev 5  claimed   $500.00  ->  approved   $295.00  severity-schedule-capped
    BFI-C-000013  Snow             sev 5  claimed   $500.00  ->  approved   $290.00  annual-payout-cap-partial
    BFI-C-000014  Snow             sev 5  claimed   $500.00  ->  denied       $0.00  annual-payout-cap-exhausted
    BFI-C-000015  Snow             sev 5  claimed   $500.00  ->  denied       $0.00  annual-claim-count-cap
```

The loss ratios `verify.py` then prints are four figures long, and that is
not a bug: a year of claims was filed in one afternoon against one month of
billed premium. Loss ratio is defined once, in `model.stats()`, as claims
approved to date over premium billed to date — the PRD does not define it, so
the demo does, in one place, so that every surface reports the same number.

## Act 5 — A different session, and then no database at all

The claim above that reads `policy-not-active` was decided against a policy
lapsed by *another* session while the web app was still running:

```console
$ gemdb lapse.py                 # a separate process, a separate session
BFI-P-000001 is now: lapsed

$ curl -s localhost:8720/api/policy/BFI-P-000001 | grep status
status via HTTP: lapsed
```

No restart, no cache invalidation, no polling. Every request in `app.py`
begins with `model.refresh()`, and that is the whole of section 5's
cross-surface promise.

Then the hard version. Stop the app, stop the database entirely, start it
again, and read:

```console
$ stopstone bfstone DataCurator swordfish
stopstone[Info]: Stone repository monitor 'bfstone' has been stopped.

$ startstone bfstone
startstone[Info]: GemStone server bfstone has been started, process 13011

$ gemdb verify.py
3 policyholder(s), 3 policy(ies), 3 quote(s), 17 claim(s): 10 approved, 7 denied (58.82% approved)
```

Byte-identical to the run before the shutdown, including the lapsed status
and the toppings. Nothing was exported, nothing was loaded, and no file
format was chosen.

---

# The four findings

These are the ones that cost time. Anyone building a second application on
this should read them before writing a line.

## 1. Committing after the imports is what keeps class identity

`import gemdb, model` is a *write*: compiling a `.py`-backed module creates
its class in the repository. So a script's first `with gemdb.transaction():`
raises `PendingChangesError` before running a line of its own, and CLAUDE.md
already says to `commit()` or `abort()` first.

**Which one you pick is not cosmetic.** Measured with two scripts and one
unchanged class:

| after the imports | later session's `isinstance(old_record, model.Claim)` |
| --- | --- |
| `gemdb.commit()` | **True** |
| `gemdb.abort()` | **False** |

With `abort()`, the compiled class is discarded, the next session compiles a
throwaway one, and records written five seconds earlier by *identical source*
are no longer instances of it. With `commit()` the class is persisted and
every later session gets the same one back. `id(model.Claim)` was the same
number across three separate processes.

This is worth saying plainly because the earlier probe that produced "class
versioning breaks `isinstance`" had used `abort()`. Against a committed
module, `isinstance` is stable — including across a class change (see 3).

## 2. Calling a function for the first time dirties the session

Rule 1 is not enough on its own, and this is the one that costs an
afternoon. Grail compiles a Python function to a Smalltalk method the *first
time it is called*, and that compilation is a repository write:

```console
$ gemdb dirty.py
after imports+commit: False
score 100 Full Ache | after first score_answers call: True
after SECOND score_answers call: False
uncommitted_imports-ish: []
```

Nothing was stored. `score_answers` is pure arithmetic over a dict. The
session is dirty anyway, so the next transaction block refuses — and the
refusal cannot explain itself, because `gemdb._pending_imports()` answers
`[]`: no *import* is pending, so the message falls back to blaming the caller
for changes the caller never made.

`model._settle()` is the whole fix, and every write in `model.py` calls it
immediately before opening its transaction. In a long-running server the
effect is bounded — each function compiles once — but a web app that does not
do this fails on the *first* request through every new code path.

## 3. A schema change keeps `isinstance` and loses the attribute

CUJ-4 adds `flavor` and `toppings` to `Claim`. What actually happens, with
the module committed per finding 1:

```console
$ gemdb toppings.py
read back through claim_as_dict -- the same function for both shapes:
  BFI-C-000005  flavor=None  toppings=None
  BFI-C-000017  flavor='mint choc chip'  toppings=['sprinkles', 'hot fudge']

isinstance(old_claim, model.Claim): True
kind_of(old_claim): Claim
direct attribute access on the older claim: AttributeError - 'Claim' object has no attribute 'flavor'
```

So: no data loss, no migration, no outage, and `isinstance` keeps working —
but a record written before the change has no slot for the new field, and
reading it as an attribute raises. `getattr(claim, "flavor", None)` is the
entire migration, and it is why every optional field in `model.py` is read
through `model.claim_field`.

FR-7.4's "old claims are readable without erroring" is therefore true, but
only of code written this way. Code that reaches for `claim.flavor` gets an
`AttributeError` on exactly the records the requirement is about.

## 4. An exception in a view is invisible, because Flask's logging is a stub

Flask logs an unhandled exception with `app.logger.error(..., exc_info=True)`.
Grail's `logging` is a stub whose `Logger.error` takes no `exc_info`, so a bug
in a view raises a *second* exception inside the error handler, werkzeug
abandons the connection, and the client sees:

```console
$ curl -si -X POST localhost:8720/quote -d ...
curl: (52) Empty reply from server
```

…with nothing in the log but a mangled traceback ending in
`TypeError: Logger.error() got an unexpected keyword argument 'exc_info'`.
An hour went into looking for that bug in the wrong file.

`app.py` registers a handler for `Exception`, which means Flask never reaches
its logging path. The real traceback reaches stdout and the client gets a 500
it can read:

```console
$ curl -si -X POST localhost:8720/api/quote -H 'Content-Type: application/json' --data @calm.json
HTTP/1.1 500 INTERNAL SERVER ERROR
500 AttributeError: 'SmallInteger' object has no attribute 'strip'
```

That was a real bug — `parse_answers` assumed the HTML form's strings and
`/api/quote` posts real integers — and it took thirty seconds to find with the
handler and would have taken another hour without it. Any Flask app under
Grail should carry those five lines.

---

# Money, and one other constraint

**Integer cents, everywhere.** `decimal` is effectively absent under Grail —
`Decimal("19.99") * 3` raises `MessageNotUnderstood`, and there is no
`quantize` — and floats would put `0.30000000000000004` in a premium table.
`underwriting.fmt_money` is the only place a decimal point is ever written,
and `app.dollars_to_cents` parses `"12.50"` into `1250` without going through
a float.

**Rounding is spelled out, never delegated to `round()`.** Grail rounds halves
up; CPython rounds them to even. `round(2.5)` is 3 in the database and 2
outside it, so a premium that passed through `round()` could differ by a cent
depending on where it was computed — surfacing later as the notebook and the
web app disagreeing. `underwriting.round_div` does integer half-away-from-zero
and gives the same answer in both.

**No `strptime`.** `app.parse_date` splits an ISO date by hand, which is one
fewer module behind the CPython shim for no loss.

---

# Assumptions

The PRD specifies none of the numbers this product runs on. Every one of
them is a choice made here, all of them in one block at the top of
`underwriting.py`, each a single line to change.

| What | Chosen | Why it had to be chosen |
| --- | --- | --- |
| Premium formula | `base * plan% * (100 + score) / 10000` | FR-5.3 says "consistent with the generator's underwriting model"; the generator is not linked and the model is not stated |
| Base premium | $4.00/month, floor $2.50 | nowhere in the PRD |
| Risk tiers | four bands, 0-24 / 25-49 / 50-74 / 75-100 | FR-5.3 asks for a "risk tier" and never says how many or where |
| Tier vs premium | the score loads the premium continuously; the tier is the band that same score falls in | so tier and premium always agree, which they would not if the tier picked a multiplier of its own |
| Score clamp | 0-100, and the per-question points can total 120 | the honest alternative to re-weighting sixteen questions to sum to exactly 100 |
| Plans | Basic / Standard / Premium at 100% / 175% / 300% | FR-5.4 names the three plans and no numbers |
| Deductibles | $15.00 / $10.00 / $5.00 | FR-6.2 names a deductible and no value |
| Per-incident limits | $50.00 / $125.00 / $300.00 | same |
| Annual payout caps | $150.00 / $500.00 / $1,200.00 | same |
| "Annual claim cap" | **both** a money cap (per plan, above) and a count cap (6) | FR-6.2's phrase reads either way, so both are implemented |
| Severity schedule | 1→$12, 2→$30, 3→$75, 4→$150, 5→$300 | FR-6.1 asks for severity as an input and FR-6.2 for an amount as an output, and never connects them. This is the connection |
| Policy term | 365 days, active on purchase | the PRD's A5: a just-quoted holder is claim-eligible immediately, with no payment step and no effective date |
| Triggers | nine, from ice cream to snow | "favorite trigger" is named and never enumerated |
| Loss ratio | claims approved to date ÷ premium billed to date, billed as whole months elapsed × monthly premium, floored at 1 and capped at 12 | used by CUJ-1 and CUJ-2 and defined nowhere |
| Questionnaire | the sixteen questions, their allowed values, and all thirteen points tables | the PRD lists five inputs (age, sex, migraine/TTH history, favorite trigger, eating speed); the medical two are deliberately not asked |
| Identity | `BFI-H-`/`P-`/`C-`/`Q-` plus a six-digit counter | the PRD's M7 — there is no auth, so a policy id is how a claim finds its policy |
| Bind address | `127.0.0.1`, overridable by `BFI_HOST` | the app has no authentication and can commit, so a port on every interface would be an unauthenticated writer facing the network |
| Port | 8720, overridable by `BFI_PORT` | "single documented command" (FR-5.1) needs a port |

One PRD input was deliberately dropped: **migraine and tension-headache
history** (CUJ-3, FR-5.2). It is the only medical question in the set, and
this product does not ask medical questions. The register James asked for is
"almost but not quite silly", and a headache history is neither.

---

# How this was measured

Everything above ran in this container, as OS user `gsadmin`, against a stone
started on a copy of the Grail-loaded extent (`extent/gemdb.dbf`, Grail
`46c2a68`) with its own `GEMSTONE_GLOBAL_DIR` and netldi. `curl` ran outside
the database as a separate process on the host.

Three honest caveats about the transcripts:

- The `gemdb file.py` commands are written the way a user runs them. The
  actual driver was an RPC topaz session issuing
  `importlib grailDir: … ; importlib runPath: '<file>'` — which is what
  `cli.ts:279` does for `gemdb file.py`, but it is not the generated wrapper
  itself, because that wrapper belongs to an extension-managed `~/GemDB`
  install this harness did not have.
- Memory tuning reached the gems through the netldi's `-E gemconfig`
  (`GEM_TEMPOBJ_CACHE_SIZE = 400000; GEM_TEMPOBJ_CODE_SIZE = 300000;`) rather
  than topaz's `-T`/`-C`, which apply only to a linked session.
- The claim field was named `flavour` when these transcripts were captured
  and is `flavor` in the code now, to match FR-7.1 and the rest of the PRD's
  spelling. The transcripts above have been relabelled to match the code;
  nothing else about them changed.

Four short helper scripts produced some of the output above and are **not**
in this directory: `calm.json` (the JSON quote body), `lapse.py` (Act 5's
separate session), `dirty.py` (finding 2) and `toppings.py` (finding 3).
They were written in the harness that ran the demo. Everything the four
committed files do is reachable without them, but those four transcripts
cannot be reproduced from this repository as it stands.

One environment note worth keeping: the socket belongs to the **gem**
process, a child of the netldi, not to the topaz client that drove it.
Killing topaz leaves the port bound and the next start fails with
`EADDRINUSE` from `server_bind`.
