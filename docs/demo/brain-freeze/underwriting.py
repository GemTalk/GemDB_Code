"""Brain Freeze Insurance: the questionnaire, the risk score, the money.

This module holds every number the product depends on and every rule that
turns answers into a premium or a claim into a payout.  It imports nothing
from the database, so it can be read, reviewed and changed without thinking
about sessions or commits -- `model.py` stores what this computes, and
`app.py` displays it.

Two house rules, both forced by the environment rather than chosen:

**Money is integer cents, everywhere.**  `decimal` is effectively absent
under Grail (`Decimal('19.99') * 3` raises MessageNotUnderstood, and there is
no `quantize`), and floats would put `0.30000000000000004` in a premium
table.  Cents are exact, and `fmt_money` is the only place a decimal point
is ever written.

**Rounding is spelled out, never delegated to `round()`.**  Grail's `round()`
rounds halves up; CPython's rounds them to even.  `round(2.5)` is 3 in the
database and 2 outside it, so a premium that passed through `round()` could
differ by a cent depending on where it was computed.  `round_div` below does
integer half-away-from-zero and gives the same answer in both.
"""

# --------------------------------------------------------------------------
# ASSUMPTIONS -- the constants block
#
# The PRD (Sep 2 2026) specifies none of the numbers below: not the premium
# formula, not the tier cut-offs, not the deductible, the per-incident limit
# or the annual cap.  Every value here is a choice made so the demo runs.
# They are all in this one block on purpose: changing the product means
# editing these lines and nothing else.
# --------------------------------------------------------------------------

#: What a policy costs before any risk loading, per month.
BASE_MONTHLY_PREMIUM_CENTS = 400

#: No policy is ever cheaper than this, however low the score.
MINIMUM_MONTHLY_PREMIUM_CENTS = 250

#: How long a policy runs.  ASSUMPTION: the PRD never mentions a term.
POLICY_TERM_DAYS = 365

#: Risk score is clamped to this range.  The per-question points below can
#: total more than 100; clamping is deliberate and visible in the breakdown.
SCORE_MIN = 0
SCORE_MAX = 100

#: Score bands.  ASSUMPTION: the PRD asks for a "risk tier" and never says
#: how many or where the cut-offs are.  Four, evenly spaced, named for what
#: they feel like.
TIERS = (
    (0, 24, "Cool Head"),
    (25, 49, "Tender Temple"),
    (50, 74, "Rapid Onset"),
    (75, 100, "Full Ache"),
)

#: The three coverage plans FR-5.4 asks to be shown side by side.
#: `premium_pct` multiplies the base premium; the three limits are the three
#: adjudication parameters FR-6.2 names.  ASSUMPTION: all twelve numbers.
PLANS = (
    {
        "name": "Basic",
        "premium_pct": 100,
        "deductible_cents": 1500,
        "per_incident_limit_cents": 5000,
        "annual_payout_cap_cents": 15000,
        "blurb": "Covers the cone. Does not cover the regret.",
    },
    {
        "name": "Standard",
        "premium_pct": 175,
        "deductible_cents": 1000,
        "per_incident_limit_cents": 12500,
        "annual_payout_cap_cents": 50000,
        "blurb": "The one most people buy, which is how it got the name.",
    },
    {
        "name": "Premium",
        "premium_pct": 300,
        "deductible_cents": 500,
        "per_incident_limit_cents": 30000,
        "annual_payout_cap_cents": 120000,
        "blurb": "For the competitive eater who has made peace with nothing.",
    },
)

#: ASSUMPTION: the PRD's "annual claim cap" (FR-6.2) could mean an annual
#: money cap or an annual count cap.  Both are implemented: the money cap is
#: `annual_payout_cap_cents` per plan, and this is the count.
ANNUAL_CLAIM_COUNT_CAP = 6

#: The most a claim of each severity can ever be worth, whatever is claimed.
#: ASSUMPTION: the PRD asks for "severity/symptoms" as an input and for an
#: amount as an output, and never connects them.  This is the connection:
#: severity sets the ceiling, the claimed amount sets the ask, and the lower
#: of the two is what adjudication starts from.
SEVERITY_SCHEDULE_CENTS = {
    1: 1200,
    2: 3000,
    3: 7500,
    4: 15000,
    5: 30000,
}

SEVERITY_LABELS = {
    1: "1 -- a flicker behind the eyes",
    2: "2 -- had to put the spoon down",
    3: "3 -- pressed a thumb to the roof of the mouth",
    4: "4 -- sat down on the kerb",
    5: "5 -- the full vice, both temples, eyes shut",
}

#: What set the brain freeze off.  ASSUMPTION: the PRD says "favorite
#: trigger" without listing any.
TRIGGERS = (
    "Ice cream",
    "Slushie",
    "Iced water",
    "Popsicle",
    "Milkshake",
    "Frozen yoghurt",
    "Iced coffee",
    "Snow",
    "Other",
)

# --------------------------------------------------------------------------
# Money
# --------------------------------------------------------------------------


def round_div(numerator, denominator):
    """`numerator / denominator` as an integer, halves away from zero.

    Not `round(n / d)`: Grail rounds halves up and CPython rounds them to
    even, so that expression can differ by one between the database and a
    script outside it.  This is integer-only and identical in both.
    """
    if denominator == 0:
        raise ZeroDivisionError("round_div by zero")
    if denominator < 0:
        numerator, denominator = -numerator, -denominator
    if numerator >= 0:
        return (2 * numerator + denominator) // (2 * denominator)
    return -((-2 * numerator + denominator) // (2 * denominator))


def fmt_money(cents):
    """Integer cents as `$1,234.56` -- the only place a decimal point is written."""
    cents = int(cents)
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), 100)
    digits = str(whole)
    grouped = ""
    while len(digits) > 3:
        grouped = "," + digits[-3:] + grouped
        digits = digits[:-3]
    return "%s$%s%s.%02d" % (sign, digits, grouped, frac)


# --------------------------------------------------------------------------
# The questionnaire
#
# Sixteen questions in the register the product deserves: almost, but not
# quite, actuarially serious.  Nothing medical, nothing intrusive -- no
# headache history, no medication, no diagnosis.  What a real underwriter
# would ask is exactly what this product declines to.
#
# `scored` says whether the answer moves the risk score.  Three questions
# are pure colour and are marked as such; they are stored with everything
# else and read back on the policy page, but `score_answers` never looks at
# them.
#
# `rationale` is the one-line justification that appears next to the points
# in a quote's breakdown.  Contributing questions get a straight face.
# --------------------------------------------------------------------------

QUESTIONS = (
    {
        "field": "age",
        "prompt": "How old are you?",
        "kind": "int",
        "min": 5,
        "max": 25,
        "scored": True,
        "rationale": "Cold-stimulus headache peaks in the early teens and eases after; the middle of the range carries the load.",
    },
    {
        "field": "gender",
        "prompt": "Gender",
        "kind": "choice",
        "values": ("female", "male", "other", "prefer not to say"),
        "scored": True,
        "rationale": "The literature reports a modest female skew. Modest is all we load, and declining to answer costs nothing.",
    },
    {
        "field": "hair_colour",
        "prompt": "Hair colour",
        "kind": "choice",
        "values": ("black", "brown", "blonde", "red", "other"),
        "scored": True,
        "rationale": "Redheads have a documented anaesthetic sensitivity. We extend it to ice cream without evidence of any kind.",
    },
    {
        "field": "siblings",
        "prompt": "How many siblings do you have?",
        "kind": "int",
        "min": 0,
        "max": 12,
        "scored": True,
        "rationale": "Each sibling is a second less to finish a shared dessert. We count the first four and stop.",
    },
    {
        "field": "birth_order",
        "prompt": "Where do you come in the family?",
        "kind": "choice",
        "values": ("only", "eldest", "middle", "youngest"),
        "scored": True,
        "rationale": "Youngest children learn to eat quickly or learn to eat nothing.",
    },
    {
        "field": "handedness",
        "prompt": "Which hand do you hold the spoon in?",
        "kind": "choice",
        "values": ("right", "left", "either"),
        "scored": False,
        "rationale": "Pure colour. Collected because the form looked short, and it does not touch the score.",
    },
    {
        "field": "tongue_roll",
        "prompt": "Can you roll your tongue?",
        "kind": "choice",
        "values": ("yes", "no"),
        "scored": True,
        "rationale": "A rolled tongue shelters the palate from the bolus. We are not proud of this one.",
    },
    {
        "field": "cilantro_soap",
        "prompt": "Does cilantro taste like soap to you?",
        "kind": "choice",
        "values": ("yes", "no", "never tried it"),
        "scored": True,
        "rationale": "OR6A2 is a real taste-receptor variant. Its relevance to the sphenopalatine ganglion is entirely invented.",
    },
    {
        "field": "favorite_flavor",
        "prompt": "Favorite ice cream flavor",
        "kind": "choice",
        "values": (
            "vanilla",
            "chocolate",
            "strawberry",
            "mint choc chip",
            "pistachio",
            "rocky road",
            "other",
        ),
        "scored": True,
        "rationale": "Mint carries a menthol cue that makes cold register as colder. The rest is loaded on how fast a flavor invites a second spoonful.",
    },
    {
        "field": "spoon_or_straw",
        "prompt": "Spoon or straw?",
        "kind": "choice",
        "values": ("spoon", "straw", "both", "neither"),
        "scored": True,
        "rationale": "A straw delivers the cold straight to the roof of the mouth under suction. Spoons are, genuinely, safer.",
    },
    {
        "field": "eating_speed",
        "prompt": "How fast do you eat something cold?",
        "kind": "choice",
        "values": ("glacial", "measured", "brisk", "competitive"),
        "scored": True,
        "rationale": "The one input with a plausible mechanism behind it, so it carries the most weight of any single answer.",
    },
    {
        "field": "prior_freezes",
        "prompt": "How many brain freezes in the last 12 months?",
        "kind": "int",
        "min": 0,
        "max": 60,
        "scored": True,
        "rationale": "The best predictor of a claim is a previous claim. Counted up to twelve, because past that it stops being information.",
    },
    {
        "field": "can_whistle",
        "prompt": "Can you whistle?",
        "kind": "choice",
        "values": ("yes", "no"),
        "scored": False,
        "rationale": "Pure colour. We looked for a mechanism and could not find one, so it stays out of the score.",
    },
    {
        "field": "pineapple_pizza",
        "prompt": "Pineapple on pizza?",
        "kind": "choice",
        "values": ("yes", "no", "undecided"),
        "scored": False,
        "rationale": "Pure colour, and the only question on this form with no defensible answer.",
    },
    {
        "field": "shoe_size",
        "prompt": "Shoe size (US)",
        "kind": "int",
        "min": 1,
        "max": 16,
        "scored": True,
        "rationale": "Correlates with body mass, which correlates with portion size. Two correlations and no mechanism, priced accordingly small.",
    },
    {
        "field": "slushies_last_month",
        "prompt": "How many slushies in the last month?",
        "kind": "int",
        "min": 0,
        "max": 60,
        "scored": True,
        "rationale": "Exposure. Underwriting is mostly exposure.",
    },
)

QUESTIONS_BY_FIELD = {q["field"]: q for q in QUESTIONS}

#: Every field the form collects, in form order.
FIELDS = tuple(q["field"] for q in QUESTIONS)

#: The subset that moves the score.
SCORED_FIELDS = tuple(q["field"] for q in QUESTIONS if q["scored"])

# ---- the points tables ---------------------------------------------------
# ASSUMPTION: all of them.  The PRD gives no risk model at all.

_GENDER_POINTS = {"female": 3, "male": 1, "other": 2, "prefer not to say": 2}
_HAIR_POINTS = {"red": 6, "blonde": 3, "brown": 2, "black": 2, "other": 3}
_BIRTH_ORDER_POINTS = {"only": 0, "eldest": 2, "middle": 4, "youngest": 6}
_TONGUE_POINTS = {"yes": 0, "no": 3}
_CILANTRO_POINTS = {"yes": 4, "no": 1, "never tried it": 2}
_FLAVOR_POINTS = {
    "mint choc chip": 6,
    "rocky road": 4,
    "chocolate": 3,
    "other": 3,
    "strawberry": 2,
    "pistachio": 2,
    "vanilla": 1,
}
_VESSEL_POINTS = {"straw": 7, "both": 4, "spoon": 1, "neither": 0}
_SPEED_POINTS = {"glacial": 0, "measured": 5, "brisk": 12, "competitive": 20}


def _age_points(age):
    if age < 8:
        return 4
    if age < 11:
        return 8
    if age < 15:
        return 14
    if age < 19:
        return 11
    return 6


def _points_for(field, value):
    """Points one answer contributes. 0 for anything unscored or unrecognised."""
    if field == "age":
        return _age_points(int(value))
    if field == "gender":
        return _GENDER_POINTS.get(value, 2)
    if field == "hair_colour":
        return _HAIR_POINTS.get(value, 3)
    if field == "siblings":
        return min(int(value), 4) * 2
    if field == "birth_order":
        return _BIRTH_ORDER_POINTS.get(value, 3)
    if field == "tongue_roll":
        return _TONGUE_POINTS.get(value, 0)
    if field == "cilantro_soap":
        return _CILANTRO_POINTS.get(value, 2)
    if field == "favorite_flavor":
        return _FLAVOR_POINTS.get(value, 3)
    if field == "spoon_or_straw":
        return _VESSEL_POINTS.get(value, 1)
    if field == "eating_speed":
        return _SPEED_POINTS.get(value, 5)
    if field == "prior_freezes":
        return min(int(value), 12) * 2
    if field == "shoe_size":
        return min(int(value), 16) // 4
    if field == "slushies_last_month":
        return min(int(value), 30) // 2
    return 0


def tier_for_score(score):
    """The band a score falls in."""
    for low, high, name in TIERS:
        if low <= score <= high:
            return name
    return TIERS[-1][2]


def score_answers(answers):
    """Score a questionnaire.

    Returns `(score, tier, breakdown)`.  `breakdown` is a list of
    `{field, prompt, answer, points, rationale}` in form order, covering
    every question -- the three unscored ones appear with `points` 0 and
    their "pure colour" rationale, because a quote that shows its working
    should show what it ignored too.

    Reads with `answers.get(...)`, so a questionnaire that predates a new
    question scores as if that question were answered at its floor rather
    than raising.  That matters more than it looks: it is the same tolerance
    that lets old records survive a schema change.
    """
    raw = 0
    breakdown = []
    for q in QUESTIONS:
        field = q["field"]
        value = answers.get(field)
        if value is None:
            points = 0
        elif q["scored"]:
            points = _points_for(field, value)
        else:
            points = 0
        raw += points
        breakdown.append(
            {
                "field": field,
                "prompt": q["prompt"],
                "answer": value,
                "points": points,
                "scored": q["scored"],
                "rationale": q["rationale"],
            }
        )
    score = max(SCORE_MIN, min(SCORE_MAX, raw))
    return score, tier_for_score(score), breakdown


# --------------------------------------------------------------------------
# Premium
# --------------------------------------------------------------------------


def plan_named(name):
    for plan in PLANS:
        if plan["name"] == name:
            return plan
    raise KeyError("no such plan: %r" % (name,))


def premium_cents(plan_name, score):
    """Monthly premium for one plan at one score.

    ASSUMPTION, and the only formula in the product:

        base * plan_pct * (100 + score) / 10000

    so the score loads the premium continuously from +0% at 0 to +100% at
    100, and the tier is the band that same score falls in.  Tier and
    premium therefore always agree, which they would not if the tier picked
    a multiplier of its own and a score sat near a cut-off.
    """
    plan = plan_named(plan_name)
    raw = round_div(BASE_MONTHLY_PREMIUM_CENTS * plan["premium_pct"] * (100 + score), 10000)
    return max(MINIMUM_MONTHLY_PREMIUM_CENTS, raw)


def quote_options(score):
    """Every plan priced at this score, in PLANS order -- FR-5.4's side by side."""
    options = []
    for plan in PLANS:
        options.append(
            {
                "plan": plan["name"],
                "blurb": plan["blurb"],
                "monthly_premium_cents": premium_cents(plan["name"], score),
                "deductible_cents": plan["deductible_cents"],
                "per_incident_limit_cents": plan["per_incident_limit_cents"],
                "annual_payout_cap_cents": plan["annual_payout_cap_cents"],
            }
        )
    return options


# --------------------------------------------------------------------------
# Adjudication
# --------------------------------------------------------------------------

DECISION_APPROVED = "approved"
DECISION_DENIED = "denied"


def adjudicate(
    plan_name,
    severity,
    claimed_cents,
    in_term,
    policy_status,
    claims_this_year,
    paid_this_year_cents,
):
    """Decide one claim.

    Every input is a plain value, so this function can be read and tested
    without a database: `model.py` gathers them from the policy and its
    claim history and calls this.

    Returns `{decision, approved_cents, reason, rule}`.  `rule` names the
    step that decided it, which is what makes a denial arguable rather than
    mysterious.
    """
    plan = plan_named(plan_name)
    claimed_cents = int(claimed_cents)
    severity = int(severity)

    if policy_status != "active":
        return _denied(
            "policy-not-active",
            "The policy is %s, so there is no cover in force." % (policy_status,),
        )
    if not in_term:
        return _denied(
            "event-outside-term",
            "The event date falls outside the policy term.",
        )
    if claims_this_year >= ANNUAL_CLAIM_COUNT_CAP:
        return _denied(
            "annual-claim-count-cap",
            "This is claim %d of a %d-claim year." % (claims_this_year + 1, ANNUAL_CLAIM_COUNT_CAP),
        )

    ceiling = SEVERITY_SCHEDULE_CENTS.get(severity, SEVERITY_SCHEDULE_CENTS[1])
    recognised = min(claimed_cents, ceiling)

    after_deductible = recognised - plan["deductible_cents"]
    if after_deductible <= 0:
        return _denied(
            "below-deductible",
            "Recognised loss %s does not exceed the %s deductible of %s."
            % (
                fmt_money(recognised),
                plan["name"],
                fmt_money(plan["deductible_cents"]),
            ),
        )

    payable = min(after_deductible, plan["per_incident_limit_cents"])

    remaining = plan["annual_payout_cap_cents"] - int(paid_this_year_cents)
    if remaining <= 0:
        return _denied(
            "annual-payout-cap-exhausted",
            "The %s annual cap of %s is already paid out for this year."
            % (plan["name"], fmt_money(plan["annual_payout_cap_cents"])),
        )

    if payable > remaining:
        return {
            "decision": DECISION_APPROVED,
            "approved_cents": remaining,
            "rule": "annual-payout-cap-partial",
            "reason": "Paid to the remaining %s of the annual cap." % (fmt_money(remaining),),
        }

    # `rule` names the constraint that actually bound, so the tests run in
    # the order the caps are applied and the tightest one wins.  A $500
    # claim at severity 5 on Standard is capped twice -- by the severity
    # schedule to $300, then by the $125 per-incident limit -- and it is the
    # second cap that decided the number, so that is the one reported.
    if payable < after_deductible:
        rule = "per-incident-limit"
        reason = "Capped at the %s per-incident limit of %s." % (
            plan["name"],
            fmt_money(plan["per_incident_limit_cents"]),
        )
    elif recognised < claimed_cents:
        rule = "severity-schedule-capped"
        reason = (
            "Severity %d recognises at most %s of the %s claimed, less the %s deductible."
            % (
                severity,
                fmt_money(ceiling),
                fmt_money(claimed_cents),
                fmt_money(plan["deductible_cents"]),
            )
        )
    else:
        rule = "paid-in-full"
        reason = "Recognised %s, less the %s deductible." % (
            fmt_money(recognised),
            fmt_money(plan["deductible_cents"]),
        )
    return {
        "decision": DECISION_APPROVED,
        "approved_cents": payable,
        "rule": rule,
        "reason": reason,
    }


def _denied(rule, reason):
    return {
        "decision": DECISION_DENIED,
        "approved_cents": 0,
        "rule": rule,
        "reason": reason,
    }
