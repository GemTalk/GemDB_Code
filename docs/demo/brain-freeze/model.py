"""Brain Freeze Insurance: the objects, and where they live in the database.

Nothing here opens a file, chooses a format or serialises anything.  The
classes are plain Python; putting one in `gemdb.root` is what makes it
outlive the process.  `underwriting.py` decides what the numbers are, this
module decides what is stored and how it is found again.

------------------------------------------------------------------------
Three rules this module follows, each of them measured rather than assumed
------------------------------------------------------------------------

**1. Commit once, straight after the imports.**  Importing a `.py`-backed
module is a *write*: compiling it creates its class in the repository.  So a
script's first `with gemdb.transaction():` raises PendingChangesError before
running a line of its own.  The fix is `connect()` below, and the choice
between `commit()` and `abort()` there is not cosmetic:

    import gemdb, model      # compiles model.py -> a class in the repository
    gemdb.commit()           # keeps that class ...
    gemdb.abort()            # ... or throws it away

Measured 2026-09-07 against Grail 46c2a68: with `commit()`, a later session
that imports the same unchanged module gets *the same class* back, and
`isinstance(old_record, model.Claim)` is True.  With `abort()` the compiled
class is discarded, the next session compiles a throwaway one, and the same
`isinstance` is False -- for records written five seconds earlier by
identical source.  Committing after the imports is therefore not
housekeeping; it is what keeps class identity stable across sessions.

**2. Read optional fields with `getattr(obj, field, default)`.**  Adding a
field to a class here does not add it to records already stored.  Grail
updates the class in place -- `isinstance` keeps working, existing records
keep their data -- but a record written before the change has no slot for
the new field, and `claim.flavor` on one of those raises AttributeError.
`getattr(claim, "flavor", None)` is the whole migration.  This is CUJ-4,
and it is why the claim accessors below all go through `getattr`.

**3. Find records by walking the index, not by `isinstance`.**  The indexes
in the store are dictionaries keyed by id, so nothing needs to filter a
heterogeneous collection by class.  Where a class check is genuinely wanted,
`kind_of(obj)` compares `type(obj).__name__`, which survives every class
version.

**4. Commit again immediately before every transaction.**  Rule 1 is not
enough on its own, and this is the one that costs an afternoon.  Grail
compiles a Python function to a Smalltalk method the *first time it is
called*, and that compilation is a repository write.  So a session can be
clean, call one pure arithmetic function, and be dirty again -- with nothing
of its own in the changes.  Measured 2026-09-07:

    gemdb.commit()                     # clean
    gemdb.needs_commit()               # False
    score, tier, rows = uw.score_answers(answers)
    gemdb.needs_commit()               # True  <- nothing was stored
    gemdb.commit()
    score, tier, rows = uw.score_answers(answers)
    gemdb.needs_commit()               # False -- second call is compiled

The PendingChangesError this produces cannot explain itself either:
`gemdb._pending_imports()` answers `[]`, because no *import* is pending, so
the message falls back to blaming the caller for changes the caller never
made.  `_settle()` below is the whole fix, and every write in this module
calls it.
"""

import datetime

import gemdb

import underwriting as uw

#: The one key this demo owns in the database's root.
ROOT_KEY = "brain_freeze"

#: Bumped when the shape of the store changes, so a reader can tell.
STORE_VERSION = 1

_ID_PREFIXES = {
    "holder": "BFI-H",
    "policy": "BFI-P",
    "claim": "BFI-C",
    "quote": "BFI-Q",
}


# --------------------------------------------------------------------------
# The objects
# --------------------------------------------------------------------------


class Questionnaire:
    """One completed form.

    The answers live in a plain dict rather than as sixteen attributes, and
    that is a deliberate contrast with `Claim`: adding a question is then not
    a schema change at all, while adding a claim field (CUJ-4) is.  The demo
    gets to show both halves.
    """

    def __init__(self, answers, taken_on=None):
        self.answers = dict(answers)
        self.taken_on = taken_on or datetime.date.today()

    def get(self, field, default=None):
        return self.answers.get(field, default)


class RiskAssessment:
    """A score, the band it falls in, and the working."""

    def __init__(self, score, tier, breakdown, assessed_on=None):
        self.score = int(score)
        self.tier = tier
        self.breakdown = list(breakdown)
        self.assessed_on = assessed_on or datetime.date.today()


class Quote:
    """A priced questionnaire: every plan, at this applicant's score."""

    def __init__(self, quote_id, questionnaire, assessment, options, applicant_name, applicant_email):
        self.quote_id = quote_id
        self.questionnaire = questionnaire
        self.assessment = assessment
        self.options = list(options)
        self.applicant_name = applicant_name
        self.applicant_email = applicant_email
        self.created_on = datetime.date.today()
        self.accepted_plan = None
        self.policy_id = None


class Policyholder:
    def __init__(self, holder_id, name, email, questionnaire):
        self.holder_id = holder_id
        self.name = name
        self.email = email
        self.questionnaire = questionnaire
        self.joined_on = datetime.date.today()


class Policy:
    """Cover in force: one plan, one term, one premium, one status."""

    STATUSES = ("active", "lapsed", "cancelled")

    def __init__(self, policy_id, holder_id, plan, monthly_premium_cents, assessment, term_start=None):
        self.policy_id = policy_id
        self.holder_id = holder_id
        self.plan = plan
        self.monthly_premium_cents = int(monthly_premium_cents)
        self.assessment = assessment
        self.term_start = term_start or datetime.date.today()
        self.term_end = self.term_start + datetime.timedelta(days=uw.POLICY_TERM_DAYS)
        self.status = "active"

    def covers(self, event_date):
        return self.term_start <= event_date <= self.term_end


class Adjudication:
    """What the claim rules decided, and which rule decided it."""

    def __init__(self, decision, approved_cents, reason, rule, adjudicated_on=None):
        self.decision = decision
        self.approved_cents = int(approved_cents)
        self.reason = reason
        self.rule = rule
        self.adjudicated_on = adjudicated_on or datetime.date.today()

    @property
    def approved(self):
        return self.decision == uw.DECISION_APPROVED


class Claim:
    """One brain freeze, as filed.

    CUJ-4 adds `flavor` and `toppings` to this class.  Read every optional
    field through `claim_field` below rather than as an attribute, so a claim
    written before the change stays readable after it.
    """

    def __init__(self, claim_id, policy_id, event_date, trigger, severity, claimed_cents, notes=""):
        self.claim_id = claim_id
        self.policy_id = policy_id
        self.event_date = event_date
        self.trigger = trigger
        self.severity = int(severity)
        self.claimed_cents = int(claimed_cents)
        self.notes = notes
        self.filed_on = datetime.date.today()
        self.adjudication = None


def kind_of(obj):
    """`type(obj).__name__` -- a class check that survives class versions.

    `isinstance` is fine here as long as the module was committed after
    import (see rule 1), but it is fine only for the class version this
    session happens to hold.  A name comparison is true of every version, so
    it is what any code that must classify a record it did not create should
    use.
    """
    return type(obj).__name__


def claim_field(claim, field, default=None):
    """Read a possibly-newer field off a possibly-older claim.

    The whole of CUJ-4's data migration, in one function.
    """
    return getattr(claim, field, default)


# --------------------------------------------------------------------------
# The store
# --------------------------------------------------------------------------


def connect():
    """Make the session usable, and hand back this demo's store.

    Commits first -- see rule 1 at the top of this file.  Creates the store
    on first use, so there is no separate install step.
    """
    _settle()
    store = gemdb.root.get(ROOT_KEY)
    if store is None:
        _settle()
        with gemdb.transaction():
            store = gemdb.root.get(ROOT_KEY)
            if store is None:
                store = _empty_store()
                gemdb.root[ROOT_KEY] = store
    return store


def refresh():
    """Take the latest committed view, so other sessions' writes show up.

    `gemdb.refresh()` refuses when the session holds changes, which is
    exactly right and exactly what a long-running web app hits: its own
    imports are changes.  Committing those first is safe -- they are class
    definitions, not data -- and then the refresh cannot discard anything.
    """
    _settle()
    gemdb.refresh()
    return connect()


def _settle():
    """Commit whatever compiling Python has just written -- see rule 4.

    Safe by construction here: every data write in this module happens
    inside a `with gemdb.transaction():` block, so anything dirty at the
    moment this is called came from the machinery rather than from a
    caller's half-finished work.
    """
    if gemdb.needs_commit():
        gemdb.commit()


def _empty_store():
    """The persistent root structure, and the indexes the app reads.

    Four dictionaries keyed by id are the records; two more are the
    reverse indexes that make a policy's claims and a holder's policies a
    lookup rather than a scan.
    """
    return {
        "version": STORE_VERSION,
        "policyholders": {},
        "policies": {},
        "claims": {},
        "quotes": {},
        "policies_by_holder": {},
        "claims_by_policy": {},
        "counters": {"holder": 0, "policy": 0, "claim": 0, "quote": 0},
    }


def _next_id(store, kind):
    """Allocate the next id. Caller must already be in a transaction."""
    counters = store["counters"]
    counters[kind] = counters.get(kind, 0) + 1
    return "%s-%06d" % (_ID_PREFIXES[kind], counters[kind])


# --------------------------------------------------------------------------
# Writes.  Each opens its own transaction, so none of them may be called
# from inside another -- gemdb transaction blocks do not nest.
# --------------------------------------------------------------------------


def record_quote(store, answers, applicant_name="", applicant_email=""):
    """Score a questionnaire, price every plan, and keep the result."""
    score, tier, breakdown = uw.score_answers(answers)
    _settle()
    with gemdb.transaction():
        quote_id = _next_id(store, "quote")
        quote = Quote(
            quote_id,
            Questionnaire(answers),
            RiskAssessment(score, tier, breakdown),
            uw.quote_options(score),
            applicant_name,
            applicant_email,
        )
        store["quotes"][quote_id] = quote
    return quote


def accept_quote(store, quote_id, plan_name):
    """Turn a quote into a policyholder and a policy -- FR-5.5.

    ASSUMPTION (the PRD's A5): a policy is `active` the moment it is bought.
    There is no payment step and no effective date, so a holder who has just
    accepted a quote can file a claim immediately.
    """
    quote = store["quotes"][quote_id]
    option = None
    for candidate in quote.options:
        if candidate["plan"] == plan_name:
            option = candidate
            break
    if option is None:
        raise KeyError("quote %s has no %s option" % (quote_id, plan_name))

    _settle()
    with gemdb.transaction():
        holder_id = _next_id(store, "holder")
        holder = Policyholder(
            holder_id,
            quote.applicant_name or "Unnamed applicant",
            quote.applicant_email or "",
            quote.questionnaire,
        )
        store["policyholders"][holder_id] = holder

        policy_id = _next_id(store, "policy")
        policy = Policy(
            policy_id,
            holder_id,
            plan_name,
            option["monthly_premium_cents"],
            quote.assessment,
        )
        store["policies"][policy_id] = policy
        store["policies_by_holder"].setdefault(holder_id, []).append(policy_id)
        store["claims_by_policy"][policy_id] = []

        quote.accepted_plan = plan_name
        quote.policy_id = policy_id
    return holder, policy


def file_claim(store, policy_id, event_date, trigger, severity, claimed_cents, notes="", extra=None):
    """File and adjudicate one claim -- FR-6.1, FR-6.2.

    `extra` is how CUJ-4 arrives without this signature changing again: any
    key in it is set on the claim, so adding `flavor` and `toppings` to the
    form is a change to `Claim.__init__` and the template, not to the write
    path.
    """
    policy = store["policies"][policy_id]
    year = event_date.year
    claims = claims_for_policy(store, policy_id)
    same_year = [c for c in claims if c.event_date.year == year]
    paid = 0
    for claim in same_year:
        adj = claim.adjudication
        if adj is not None and adj.decision == uw.DECISION_APPROVED:
            paid += adj.approved_cents

    verdict = uw.adjudicate(
        policy.plan,
        severity,
        claimed_cents,
        policy.covers(event_date),
        policy.status,
        len(same_year),
        paid,
    )

    _settle()
    with gemdb.transaction():
        claim_id = _next_id(store, "claim")
        claim = Claim(claim_id, policy_id, event_date, trigger, severity, claimed_cents, notes)
        for key, value in (extra or {}).items():
            setattr(claim, key, value)
        claim.adjudication = Adjudication(
            verdict["decision"],
            verdict["approved_cents"],
            verdict["reason"],
            verdict["rule"],
        )
        store["claims"][claim_id] = claim
        store["claims_by_policy"].setdefault(policy_id, []).append(claim_id)
    return claim


def set_policy_status(store, policy_id, status):
    if status not in Policy.STATUSES:
        raise ValueError("status must be one of %r" % (Policy.STATUSES,))
    _settle()
    with gemdb.transaction():
        store["policies"][policy_id].status = status
    return store["policies"][policy_id]


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------


def claims_for_policy(store, policy_id):
    """A policy's claims, oldest first, through the index rather than a scan."""
    ids = store["claims_by_policy"].get(policy_id, [])
    return [store["claims"][cid] for cid in ids if cid in store["claims"]]


def policies_for_holder(store, holder_id):
    ids = store["policies_by_holder"].get(holder_id, [])
    return [store["policies"][pid] for pid in ids if pid in store["policies"]]


def all_policies(store):
    """Every policy, ordered by id -- iterating the index, never filtering by class."""
    return [store["policies"][pid] for pid in sorted(store["policies"].keys())]


def all_claims(store):
    return [store["claims"][cid] for cid in sorted(store["claims"].keys())]


def premium_billed_cents(policy, as_of=None):
    """Premium billed on this policy so far.

    Whole months elapsed since the term started, at least one and never more
    than twelve, times the monthly premium.  Defined here, once, because
    "loss ratio" needs a denominator and the PRD never gives one.
    """
    as_of = as_of or datetime.date.today()
    days = (as_of - policy.term_start).days
    months = days // 30 + 1
    months = max(1, min(12, months))
    return months * policy.monthly_premium_cents


def claims_paid_cents(store, policy_id):
    total = 0
    for claim in claims_for_policy(store, policy_id):
        adj = claim.adjudication
        if adj is not None and adj.decision == uw.DECISION_APPROVED:
            total += adj.approved_cents
    return total


def stats(store, as_of=None):
    """The aggregates CUJ-1 and CUJ-2 ask about.

    "Loss ratio" is claims approved to date over premium billed to date, on
    the same policies -- the definition the review flagged as missing.  It is
    computed in integer basis points, so it is exact and the same number
    everywhere.
    """
    as_of = as_of or datetime.date.today()
    by_tier = {}
    for policy in all_policies(store):
        tier = getattr(getattr(policy, "assessment", None), "tier", "unknown")
        bucket = by_tier.setdefault(
            tier, {"tier": tier, "policies": 0, "premium_billed_cents": 0, "claims_paid_cents": 0}
        )
        bucket["policies"] += 1
        bucket["premium_billed_cents"] += premium_billed_cents(policy, as_of)
        bucket["claims_paid_cents"] += claims_paid_cents(store, policy.policy_id)
    for bucket in by_tier.values():
        billed = bucket["premium_billed_cents"]
        bucket["loss_ratio_bp"] = (
            uw.round_div(bucket["claims_paid_cents"] * 10000, billed) if billed else 0
        )

    severity_counts = {}
    approved = 0
    denied = 0
    for claim in all_claims(store):
        severity_counts[claim.severity] = severity_counts.get(claim.severity, 0) + 1
        adj = claim.adjudication
        if adj is not None and adj.decision == uw.DECISION_APPROVED:
            approved += 1
        else:
            denied += 1
    total = approved + denied

    return {
        "as_of": as_of.isoformat(),
        "policyholders": len(store["policyholders"]),
        "policies": len(store["policies"]),
        "quotes": len(store["quotes"]),
        "claims": total,
        "by_tier": [by_tier[t] for t in sorted(by_tier.keys())],
        "severity_distribution": [
            {"severity": s, "claims": severity_counts[s]} for s in sorted(severity_counts.keys())
        ],
        "claims_approved": approved,
        "claims_denied": denied,
        "approval_rate_bp": uw.round_div(approved * 10000, total) if total else 0,
    }


# --------------------------------------------------------------------------
# JSON shapes, shared by the API routes and anything else that wants a dict
# --------------------------------------------------------------------------


def claim_as_dict(claim):
    adj = claim.adjudication
    return {
        "claim_id": claim.claim_id,
        "policy_id": claim.policy_id,
        "event_date": claim.event_date.isoformat(),
        "filed_on": claim.filed_on.isoformat(),
        "trigger": claim.trigger,
        "severity": claim.severity,
        "claimed_cents": claim.claimed_cents,
        "notes": claim.notes,
        # CUJ-4's fields, read the way rule 2 requires.  Present as null on
        # every claim filed before they existed.
        "flavor": claim_field(claim, "flavor"),
        "toppings": claim_field(claim, "toppings"),
        "decision": adj.decision if adj else None,
        "approved_cents": adj.approved_cents if adj else None,
        "reason": adj.reason if adj else None,
        "rule": adj.rule if adj else None,
    }


def policy_as_dict(store, policy, with_claims=False):
    assessment = getattr(policy, "assessment", None)
    out = {
        "policy_id": policy.policy_id,
        "holder_id": policy.holder_id,
        "holder_name": getattr(store["policyholders"].get(policy.holder_id), "name", None),
        "plan": policy.plan,
        "status": policy.status,
        "monthly_premium_cents": policy.monthly_premium_cents,
        "term_start": policy.term_start.isoformat(),
        "term_end": policy.term_end.isoformat(),
        "risk_score": getattr(assessment, "score", None),
        "risk_tier": getattr(assessment, "tier", None),
        "premium_billed_cents": premium_billed_cents(policy),
        "claims_paid_cents": claims_paid_cents(store, policy.policy_id),
    }
    if with_claims:
        out["claims"] = [claim_as_dict(c) for c in claims_for_policy(store, policy.policy_id)]
    return out
