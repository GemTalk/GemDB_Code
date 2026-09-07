# Brain Freeze Insurance

A small insurance company that covers the cold-stimulus headache, living
entirely inside the database. It exists to answer one question an evaluator
asks after the rabbit comes out of the hat: *fine, but can I build an
application on this?*

The scripts are in [`demo/brain-freeze/`](demo/brain-freeze/), and
[Reproducing this](#reproducing-this) is the order to run them in. Every
command and every line of output below was run on 2026-09-07 against a real
GemStone/S 3.7.5 stone carrying Grail `5e8fc42`; where something surprised
me, it is written down rather than tidied away — five of the findings cost
enough time that they are the most useful part of this document.

This implements the quote flow (FR-5.x) and the claims flow (FR-6.x) of the
[Brain Freeze Insurance PRD](prd-brain-freeze-insurance.md), which is in this
directory so every citation below can be checked. It does not implement the
notebook (CUJ-1), the MCP server (CUJ-2), the CSV import (§7.2) or the schema
change (CUJ-4) — but it is built so CUJ-4 is a ten-line edit, and the
measurements below are why.

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

Everything else in the directory exists so that this document can be re-run
rather than believed:

| File | What it is for |
| --- | --- |
| `seed.py` | the dataset every transcript below reads: three quotes, three policies, seventeen claims, all nine adjudication rules |
| `calm.json` | the sixteen answers Act 3 posts to `/api/quote` as JSON, integers and all |
| `lapse.py`, `reinstate.py` | Act 5 — one policy's status, changed from a session of its own while the app serves |
| `dirty.py` | finding 2, and nothing else: it stores nothing and reads no record |
| `toppings.py` | finding 3, over the two claim shapes `seed.py` leaves in the store |
| `class-identity/` | finding 1: four scripts, two arms, one token of difference |

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
$ curl -s localhost:8720/api/questions | jq '.[0]'
{
  "field": "age",
  "kind": "int",
  "max": 25,
  "min": 5,
  "prompt": "How old are you?",
  "rationale": "Cold-stimulus headache peaks in the early teens and eases after; the middle of the range carries the load.",
  "scored": true,
  "values": null
}
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
    -d 'pineapple_pizza=undecided' -d 'shoe_size=7' -d 'slushies_last_month=14' \
  | grep -E '^HTTP/|^Location:'
HTTP/1.1 302 FOUND
Location: /quote/BFI-Q-000001
```

```console
$ curl -s localhost:8720/quote/BFI-Q-000001 \
  | grep -E 'Risk score|tier <strong>|<h3>|class="price"'
<p>Risk score <strong>100</strong> of 100 --
   tier <strong>Full Ache</strong>.</p>
    <h3>Basic</h3>
    <div class="price">$8.00<span class="tag">/month</span></div>
    <h3>Standard</h3>
    <div class="price">$14.00<span class="tag">/month</span></div>
    <h3>Premium</h3>
    <div class="price">$24.00<span class="tag">/month</span></div>
```

A thirteen-year-old redhead with three older siblings who drinks
competitively through a straw scores 101 before clamping, which is a
reasonable place for the worst realistic profile to land.

The same flow in JSON, for a calmer applicant:

```console
$ curl -s -X POST localhost:8720/api/quote -H 'Content-Type: application/json' \
    --data @calm.json \
  | jq -c '{quote_id, risk_score, risk_tier},
           (.options[] | {plan, monthly_premium_cents, deductible_cents,
                          per_incident_limit_cents, annual_payout_cap_cents})'
{"quote_id":"BFI-Q-000002","risk_score":14,"risk_tier":"Cool Head"}
{"plan":"Basic","monthly_premium_cents":456,"deductible_cents":1500,"per_incident_limit_cents":5000,"annual_payout_cap_cents":15000}
{"plan":"Standard","monthly_premium_cents":798,"deductible_cents":1000,"per_incident_limit_cents":12500,"annual_payout_cap_cents":50000}
{"plan":"Premium","monthly_premium_cents":1368,"deductible_cents":500,"per_incident_limit_cents":30000,"annual_payout_cap_cents":120000}
```

456, 798 and 1368 cents: $4.56, $7.98 and $13.68 once `fmt_money` has had
them, which is what the HTML quote page shows for the same three plans. The
API answers in cents because cents are what the database holds, and the one
decimal point in the product is in one function.

`calm.json` is also where finding 4 came from. Five of its sixteen answers
are JSON integers rather than the strings an HTML form posts, which is a
difference `parse_answers` did not survive the first time.

Buying is one POST, and creates a policyholder and a policy:

```console
$ curl -s -o /dev/null -w '%{redirect_url}\n' \
    -X POST localhost:8720/quote/BFI-Q-000001/accept -d 'plan=Standard'
http://localhost:8720/policy/BFI-P-000001
```

## Act 4 — Claims, and nine ways to decide one

Adjudication runs the deductible, the per-incident limit, the annual payout
cap and an annual claim count, in that order, and reports **which rule
actually bound** — not the first one that could have. A $500 claim at
severity 5 on Standard is capped twice, by the severity schedule to $300 and
then by the $125 per-incident limit, and it is the second cap that decided
the number.

`seed.py` is where the dataset comes from. It scores three real
questionnaires, buys three policies and files seventeen claims through the
same `model.record_quote`, `accept_quote` and `file_claim` that the web
routes call, so a seeded store and a store filled in through the browser are
the same store. It also names the rule that decided each claim, and says so
if any of the nine went unexercised:

```console
$ gemdb seed.py
BFI-Q-000001  Priya Raman      score 100  Full Ache       ->  BFI-P-000001  Standard  $14.00/mo
BFI-Q-000002  Tomas Lindqvist  score  14  Cool Head       ->  BFI-P-000002  Basic     $4.56/mo
BFI-Q-000003  Marisol Okonkwo  score  59  Rapid Onset     ->  BFI-P-000003  Premium   $19.08/mo
...
seeded: 3 policyholder(s), 3 policy(ies), 3 quote(s), 17 claim(s)
adjudication rules exercised: 9 of 9
```

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
lapsed by *another* session. `lapse.py` is that session, and `reinstate.py`
is the same line with the other status, so the change can be watched in both
directions while the web app keeps serving — which is the part worth
watching:

```console
$ curl -s localhost:8720/api/policy/BFI-P-000001 | jq -r '"status via HTTP: " + .status'
status via HTTP: lapsed

$ gemdb reinstate.py             # a separate process, a separate session
BFI-P-000001 was: lapsed
BFI-P-000001 is now: active

$ curl -s localhost:8720/api/policy/BFI-P-000001 | jq -r '"status via HTTP: " + .status'
status via HTTP: active

$ gemdb lapse.py
BFI-P-000001 was: active
BFI-P-000001 is now: lapsed

$ curl -s localhost:8720/api/policy/BFI-P-000001 | jq -r '"status via HTTP: " + .status'
status via HTTP: lapsed
```

No restart, no cache invalidation, no polling. Every request in `app.py`
begins with `model.refresh()`, and that is the whole of section 5's
cross-surface promise.

Then the hard version. Stop the app, stop the database entirely, start it
again, and read:

```console
$ stopstone bfstone DataCurator swordfish | grep Info
stopstone[Info]: GemStone version '3.7.5'
stopstone[Info]: initiating 'bfstone' shutdown...
stopstone[Info]: Stone repository monitor 'bfstone' has been stopped.

$ startstone bfstone | grep 'has been started'
startstone[Info]: GemStone server bfstone has been started, process 3685

$ gemdb verify.py
3 policyholder(s), 3 policy(ies), 3 quote(s), 17 claim(s): 10 approved, 7 denied (58.82% approved)
```

Byte-identical to the run before the shutdown, including the lapsed status
and the toppings. Nothing was exported, nothing was loaded, and no file
format was chosen.

---

# The five findings

These are the ones that cost time. Anyone building a second application on
this should read them before writing a line.

## 1. Committing after the imports is what keeps class identity

`import gemdb, model` is a *write*: compiling a `.py`-backed module creates
its class in the repository. So a script's first `with gemdb.transaction():`
raises `PendingChangesError` before running a line of its own, and CLAUDE.md
already says to `commit()` or `abort()` first.

**Which one you pick is not cosmetic.** Measured with the four scripts in
[`class-identity/`](demo/brain-freeze/class-identity/): two arms that differ
in one token, `gemdb.commit()` against `gemdb.abort()`, each writing one
record of a three-line class and reading it back in a second process.

| after the imports | later session's `isinstance(record, Sample)` |
| --- | --- |
| `gemdb.commit()` | **True** |
| `gemdb.abort()` | **False** |

```console
$ gemdb class-identity/commit_write.py
stored n = 7
id(Sample) in the writing session: 296375

$ gemdb class-identity/commit_read.py
read n = 7
isinstance(record, Sample): True
type(record) is Sample: True
id(Sample) in this session: 296375

$ gemdb class-identity/abort_write.py
stored n = 7
id(Sample) in the writing session: 296979

$ gemdb class-identity/abort_read.py
read n = 7
isinstance(record, Sample): False
type(record) is Sample: False
id(Sample) in this session: 297465
```

With `abort()`, the compiled class is discarded, the next session compiles a
throwaway one, and records written five seconds earlier by *identical source*
are no longer instances of it. Nothing about the record looks broken —
`read n = 7` in both arms — and the two `id(Sample)` values are the recompile,
visible. With `commit()` the class is persisted and every later session gets
the same one back.

Those four `id` values are the one thing above that will not come back the
same: they are repository allocations and they move with the extent. What
reproduces is the relation between them — the same number in the committing
arm's two processes, two different numbers in the aborting arm's — and that
is the whole finding.

The two arms need two identical copies of the class, in `sample_committed.py`
and `sample_aborted.py`, for the same reason the finding exists. A committed
class is found by every later session, so once one arm has persisted
`Sample`, the other arm's import has nothing left to compile and would
measure the first arm's answer instead of its own.

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
gemdb._pending_imports(): []
```

Nothing was stored. `score_answers` is pure arithmetic over a dict. The
session is dirty anyway, so the next transaction block refuses — and the
refusal cannot explain itself, because `gemdb._pending_imports()` answers
`[]`: no *import* is pending, so the message falls back to blaming the caller
for changes the caller never made.

That transcript only comes out of a repository where `score_answers` has
never been called, and finding this out is worth the second run: the compile
is a repository write, and committing it makes it *everyone's*. Run
`dirty.py` again against the same stone, in a new session, and the first call
reports clean.

```console
$ gemdb dirty.py                 # same stone, a new session
after imports+commit: False
score 100 Full Ache | after first score_answers call: False
after SECOND score_answers call: False
gemdb._pending_imports(): []
```

`model._settle()` is the whole fix, and every write in `model.py` calls it
immediately before opening its transaction. The bound is therefore tighter
than "once per process": a function compiles once per *repository*, so the
hazard is the first request through a new code path after a fresh install or
a code change — not the first request after every restart. Which is worse in
one way, because it will not show up in a developer's second run, and it is
the run a reviewer does.

`_settle()` also has to survive losing the race. Two sessions calling the
same function for the first time both compile it, so both try to commit the
same method, and the loser gets a `ConflictError` naming a Write-Write
conflict on machinery neither of them typed. A failed commit leaves the
changes in place, so an app that lets one through answers 500 to *every*
later request rather than just the one that collided — measured, and it
wedged this app permanently until `_settle()` learned to abort and carry on.
Discarding is safe here for the same reason the commit was: nothing of the
caller's is ever pending at that point. All of finding 2 is filed as
[Grail #851](https://github.com/GemTalk/Grail/issues/851), the race included.

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
its logging path, and the client gets a 500 it can read:

```console
$ curl -si -X POST localhost:8720/api/quote -H 'Content-Type: application/json' \
    -d '{"answers": 5}' | grep -E '^HTTP/|^500 '
HTTP/1.1 500 INTERNAL SERVER ERROR
500 AttributeError: 'SmallInteger' object has no attribute 'get'
```

The bug that found this was the same shape, one layer in, and it no longer
reproduces because it is fixed: `parse_answers` assumed the HTML form's
strings, `/api/quote` posted `calm.json`'s real integers, and the answer came
back `'SmallInteger' object has no attribute 'strip'`. It took thirty seconds
to find with the handler and had already taken an hour without it. Any Flask
app under Grail should carry those five lines.

**Two things about the handler are load-bearing, and both were found by it
failing.** It must print with `print(traceback.format_exc())` and not
`traceback.print_exc()`, because Grail leaves `sys.stdout` and `sys.stderr`
as None in a gem — so `print_exc`, which writes to `sys.stderr`, raises
`AttributeError: 'NoneType' object has no attribute 'write'` *inside the
handler*, and werkzeug abandons the connection exactly as it does without a
handler at all. `print()` is the one route out of a gem that works, because
Grail sends it to the console the driver installed.
[Grail #848](https://github.com/GemTalk/Grail/issues/848).

And what arrives is not a traceback. Grail's `format_exc()` answers a single
line — the exception's type and message, with no `File "…", line N` frames
and no source echo:

```console
$ gemdb -c 'import traceback
try:
    (5).get("x")
except Exception:
    print(repr(traceback.format_exc()))'
"AttributeError: 'SmallInteger' object has no attribute 'get'\n"
```

The cause is that a Grail exception carries no `__traceback__` at all, so
there is nothing for `traceback` to format —
[Grail #849](https://github.com/GemTalk/Grail/issues/849).

So the handler's value is the 500 body, which names the fault at the client
rather than dropping the connection. Locating it is still on you — but a
named exception in the right file beats `curl: (52)` by about an hour.

## 5. `gemdb file.py` cannot import the file next to it

`python3 file.py` puts the script's own directory on `sys.path` as entry 0,
so a script can import its siblings. `gemdb file.py` does not, and nothing
else fills the gap: Grail resolves a module against `grailDir`, its bundled
stdlib, its own extra search roots and then `sys.path`, and under
`importlib runPath:` that last list is empty.

```console
$ gemdb -c 'import sys; print("sys.path:", sys.path)'
sys.path: []
```

So every script that imports `model` or `underwriting` — which is every entry
point in the directory — fails at its first import until it says where it
lives:

```python
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
```

Two lines, at the top of each entry point, before the sibling import. They
are exactly the two lines CPython makes unnecessary, `os.path.abspath`
resolves `__file__` against the directory the command was run from, and
`model.py` needs none of them because by the time anything imports it the
entry point has already put the directory on the path.

The gap belongs in Grail rather than here — CPython's behaviour is
documented and this is a deviation from it — but a demo that cannot be run
is worth less than one that carries the workaround and says why. Filed as
[Grail #847](https://github.com/GemTalk/Grail/issues/847); `sys.argv` has the
same shape and is [#850](https://github.com/GemTalk/Grail/issues/850).

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
| Policy term | 365 days, active on purchase | CUJ-3 goes quote → accept → claim with no payment step and no effective date in between, so a just-accepted holder has to be claim-eligible; the term itself is nowhere in the PRD |
| Triggers | nine, from ice cream to snow | "favorite trigger" is named and never enumerated |
| Loss ratio | claims approved to date ÷ premium billed to date, billed as whole months elapsed × monthly premium, floored at 1 and capped at 12 | used by CUJ-1 and CUJ-2 and defined nowhere |
| Questionnaire | the sixteen questions, their allowed values, and all thirteen points tables | the PRD lists five inputs (age, sex, migraine/TTH history, favorite trigger, eating speed); the medical two are deliberately not asked |
| Identity | `BFI-H-`/`P-`/`C-`/`Q-` plus a six-digit counter | §3 rules out auth ("a single local user/session"), so a policy id is how a claim finds its policy |
| Bind address | `127.0.0.1`, overridable by `BFI_HOST` | the app has no authentication and can commit, so a port on every interface would be an unauthenticated writer facing the network |
| Port | 8720, overridable by `BFI_PORT` | "single documented command" (FR-5.1) needs a port |

One PRD input was deliberately dropped: **migraine and tension-headache
history** (CUJ-3, FR-5.2). It is the only medical question in the set, and
this product does not ask medical questions. The register James asked for is
"almost but not quite silly", and a headache history is neither.

---

# Reproducing this

Every transcript in this document is a script or a request in
[`demo/brain-freeze/`](demo/brain-freeze/). From a stone started on a fresh
copy of `extent/gemdb.dbf`:

```sh
export PATH="$HOME/GemDB/bin:$PATH"   # not needed in a VS Code terminal
cd docs/demo/brain-freeze
```

| Order | Command | Produces |
| --- | --- | --- |
| 1 | `gemdb dirty.py` | finding 2 — and it has to be first |
| 2 | `gemdb class-identity/commit_write.py`, then `commit_read.py` | finding 1, the committing arm |
| 3 | `gemdb class-identity/abort_write.py`, then `abort_read.py` | finding 1, the aborting arm |
| 4 | `gemdb seed.py` | the dataset: three quotes, three policies, seventeen claims |
| 5 | `gemdb verify.py` | Act 4, and the reading either side of Act 5's restart |
| 6 | `gemdb toppings.py` | finding 3 |
| 7 | `gemdb app.py`, in a second terminal | Act 1, and then Acts 2 and 3's requests |
| 8 | `gemdb reinstate.py` and `gemdb lapse.py`, with the app still up | Act 5, and finding 4's 500 |

Four things about that order are load-bearing:

- **`dirty.py` has to run first.** The compile it measures happens once per
  repository, so the only session that sees `score_answers` dirty a clean
  session is the first one ever to call it. Anything run before it spends
  that measurement, and `seed.py` certainly does. Finding 2.
- **`seed.py` refuses a store that already holds records.** The ids in every
  transcript here come out of counters that only count up, so `BFI-Q-000001`
  exists exactly once per extent. Start again from a fresh copy of the
  extent rather than trying to clear the store.
- **Acts 2 and 3 are requests against a running app, and two of them
  write.** The quote POST and the accept POST allocate the next ids, so
  against a seeded store they produce `BFI-Q-000004` and `BFI-P-000004`
  rather than the `BFI-Q-000001` and `BFI-P-000001` printed above. Act 3's
  transcripts were measured on a second stone, also from a fresh extent,
  with nothing quoted yet — the same three applicants, the same scores and
  the same prices as `seed.py` gives them, because it is the same
  `record_quote` either way. Run Act 3 first to watch the flow allocate the
  ids, or `seed.py` first to get the dataset Act 4 reads; the two cannot
  share one extent.
- **`verify.py`, `toppings.py` and `dirty.py` only read.** They can be run at
  any point after `seed.py`, as often as you like, and none of them changes
  what the next run prints.

---

# How this was measured

Everything above ran on 2026-09-07 against a stone started on a fresh copy of
the Grail-loaded extent (`extent/gemdb.dbf`, Grail `5e8fc42`) with its own
`GEMSTONE_GLOBAL_DIR`. `curl` and `jq` ran outside the database as separate
processes on the host. The transcripts were first captured against Grail
`46c2a68` and have all been re-run against `5e8fc42`, which is the payload
this checkout builds; where the two disagreed, `5e8fc42` is what is printed.

Four honest caveats about the transcripts:

- The `gemdb file.py` commands are written the way a user runs them. The
  actual driver was a linked topaz session issuing
  `importlib grailDir: … ; importlib runPath: '<file>'` — which is what
  `cli.ts:279` does for `gemdb file.py`, but it is not the generated wrapper
  itself, because that wrapper belongs to an extension-managed `~/GemDB`
  install and this ran against a scratch stone of its own.
- `app.py` wants generous temporary object memory: `topaz -T 400000` for a
  linked session, or the netldi's `-E gemconfig` for RPC gems. `import flask`
  alone comes close to the default, and a session that runs out reports
  `AlmostOutOfMemory` (notification 6013) rather than anything about Flask.
- The claim field was named `flavour` when these transcripts were first
  captured and is `flavor` in the code now, to match FR-7.1 and the rest of
  the PRD's spelling. Everything above has since been re-run against the
  renamed code, so the transcripts are the renamed code's own output rather
  than a relabelling.
- **`app.py` needs one line of setup that the scripts do not**, and it is a
  bug in this repository rather than in the demo. `import flask` reaches
  `import re`, `re` imports `_sre`, and `_sre` is one of the CPython shim's
  built-ins — so it resolves only if the extent has the shim's library path
  recorded in it, which happens at install time from `SHIM_LIB_PATH`.
  `scripts/bundle-extent.sh:88` points that variable at
  `grail/src/c/shim/libcpython_ua.so`, a path `bundle-grail.sh` no longer
  produces — it stages the shim under `grail/prebuilt/<platform>/` instead —
  so `install-grail.sh` warns, clears the variable, and the extent records
  nothing. Measured against the extent in this checkout:

      $ CPythonShim libraryPath
      RAISED: CPythonShim library path not configured.
      $ import re
      ModuleNotFoundError: No module named '_sre'

  One committed statement fixes it for the life of a database, and `import
  flask` then works:

      CPythonShim libraryPath:
          '<checkout>/grail/prebuilt/<platform>/libcpython_ua.<ext>'.
      System commitTransaction.

  This is not only the demo's problem. A user who installs a `.vsix` gets a
  database copied from that same extent and never files Grail in, so their
  database records nothing either — `print(6 * 7)` works and `import re` does
  not, until something re-files Grail. `seed.py`, `verify.py`, `dirty.py`,
  `toppings.py` and `class-identity/` need none of it and were measured on an
  untouched extent; it is only the web app. Not fixed here — it is upstream
  of this demo, and it wants a regression test in `preloaded.test.ts` rather
  than a line in a demo doc.

One environment note worth keeping: the socket belongs to the **gem**
process, a child of the netldi, not to the topaz client that drove it.
Killing topaz leaves the port bound and the next start fails with
`EADDRINUSE` from `server_bind`.
