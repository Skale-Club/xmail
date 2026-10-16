#!/usr/bin/env python3
"""Stuscle craft-fair registry, deterministic scoring and Google Calendar sync.

CLI used by the Hermes agent through its terminal tool. Every subcommand prints a
single JSON document to stdout. Failures print {"ok": false, "error": "..."} and exit 1.

The LLM extracts facts; this script scores them, so results are reproducible.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import difflib
import json
import math
import os
import re
import sys
import tempfile
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable

# --------------------------------------------------------------------------- #
# Scoring constants (the single place to tune the radar)
# --------------------------------------------------------------------------- #
EVENT_TYPE_POINTS = {"craft": 30, "holiday": 30, "artisan": 30, "mixed": 18, "festival": 18, "farmers": 5}
TOWN_TIER_POINTS = {"A": 25, "B": 17, "C": 8, "unknown": 8}
RECURRENCE_POINTS = {"one_off": 15, "annual": 15, "seasonal": 15, "monthly": 7, "weekly": 0, "unknown": 7}

BOOTH_FEE_TARGET_USD = 75       # <= target: full points
BOOTH_FEE_MID_USD = 150         # <= mid: partial points, above: none
# Listings rarely show the booth fee, and the big expensive shows are the ones that hide it, so an unknown fee
# earns little: a bit for a 1-day event (small stake), nothing for 2+ days (likely a big show).
BOOTH_FEE_POINTS = {"target": 20, "mid": 8, "high": 0, "unknown_1day": 5, "unknown_multi": 0}

COMPETITION_POINTS = {"juried": 10, "small": 7, "default": 5, "large": 2}
SMALL_VENDOR_COUNT = 40         # <= small: little competition
LARGE_VENDOR_COUNT = 100        # > large: crowded

RADIUS_MILES = 30
DISTANCE_PENALTY = -15
# Towns come in two zones (references/towns.json). "core" is the 30-mile radius around Framingham: beyond it the
# distance penalty applies. "coast" is the North Shore and South Shore coastal towns the owner wants even though they
# are farther away: no distance penalty, never an `excecao` because of distance, flag `litoral`.
ZONE_CORE = "core"
ZONE_COAST = "coast"
REGION_LABELS = {"north_shore": "North Shore", "south_shore": "South Shore"}

SAME_EVENT_DATE_WINDOW_DAYS = 14  # same name+town+year within this window is one event with a corrected date

OPPORTUNITY_MIN_SCORE = 55      # >= goes to the calendar
MAYBE_MIN_SCORE = 40            # 40..54 is reported but not calendared
EXCEPTION_MIN_SCORE = 75        # fee unknown/above target or beyond the radius needs a near-perfect score on the rest
LONG_SEASON_DAYS = 14           # more days than this is a season (Christmas village, summer market), not a fair: maybe at best

DECISION_RANK = {"skip": 0, "maybe": 1, "opportunity": 2}
APPLICATION_STATUS_CAPS = {"closed": ("inscricao_encerrada", "maybe"), "waitlist": ("lista_de_espera", "maybe")}

EVENT_TYPES = tuple(EVENT_TYPE_POINTS)
APPLICATION_STATUSES = ("open", "waitlist", "closed", "unknown")
RECURRENCES = tuple(RECURRENCE_POINTS)
STATUSES = ("opportunity", "maybe", "skip", "confirmed", "done", "discarded")
DEFAULT_LIST_STATUSES = ("opportunity", "maybe", "confirmed")
RESCORE_STATUSES = ("opportunity", "maybe", "skip")   # confirmed, done and discarded are owner decisions: scoring never moves them
CALENDAR_CONFIRMED_STATUSES = ("confirmed", "done")   # these live in the "confirmed" calendar
NOTION_MIRRORED_STATUSES = ("opportunity", "maybe", "confirmed", "done", "discarded")  # skip is never created
RESULT_ASK_MIN_DAYS = 7         # days before asking again about a fair that has no result yet
RESULT_ASK_MAX = 2              # at most this many asks per fair

# --------------------------------------------------------------------------- #
# Paths, scopes and defaults
# --------------------------------------------------------------------------- #
DEFAULT_CONFIG_PATH = "/opt/data/stuscle-fairs/config.json"
DEFAULT_SKILL_DIR = "/opt/data/skills/skale-club/stuscle-fairs"
CALENDAR_SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
]
CONFIG_DEFAULTS: dict[str, Any] = {
    "state_dir": "/opt/data/stuscle-fairs",
    "skill_dir": None,
    "service_account_file": "/opt/data/secrets/stuscle-calendar-sa.json",
    "calendar_opportunities_id": None,
    "calendar_confirmed_id": None,
    "notion_token_file": "/opt/data/secrets/notion-token",
    "notion_fairs_data_source_id": "c942d066-ec7d-43a4-86b9-93292e78cfac",
    "notion_results_data_source_id": "8afba059-0a31-4e1b-bb0b-3a7f84f53120",
    "notion_journal_page_id": "3f5b7a68-6121-81c0-99f2-ec6d668d3add",
    "timezone": "America/New_York",
    "discovery_interval_days": 6.5,
    "max_searches_per_run": 40,
    "max_extracts_per_run": 20,
    # Rotating per-town discovery: every weekly search runs one web_search per town of the next slice of the rotation.
    "towns_per_discovery": 25,
    "town_query_template": "craft fair OR holiday fair OR artisan market OR vendors wanted {town} MA {year}",
}

EVENT_TYPE_PT = {
    "craft": "feira de artesanato", "holiday": "feira de fim de ano", "artisan": "feira de artesãos",
    "mixed": "evento misto", "festival": "festival", "farmers": "feira de produtores",
}
APPLICATION_STATUS_PT = {"open": "aberta", "waitlist": "lista de espera", "closed": "encerrada",
                         "unknown": "não informada"}
RECURRENCE_PT = {
    "one_off": "evento único", "annual": "anual", "seasonal": "sazonal",
    "monthly": "mensal", "weekly": "semanal", "unknown": "não informada",
}


class FairError(Exception):
    """Expected, user-facing failure (bad input, missing record, bad config)."""


class ValidationError(FairError):
    pass


# --------------------------------------------------------------------------- #
# Config, files, time
# --------------------------------------------------------------------------- #
def config_path() -> str:
    return os.environ.get("STUSCLE_FAIRS_CONFIG") or DEFAULT_CONFIG_PATH


def default_skill_dir() -> str:
    here = Path(__file__).resolve().parent.parent
    return str(here) if (here / "references").is_dir() else DEFAULT_SKILL_DIR


def load_config(path: str | None = None) -> dict[str, Any]:
    path = path or config_path()
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        raise FairError(f"config file not found: {path}") from None
    except json.JSONDecodeError as exc:
        raise FairError(f"config file is not valid JSON ({path}): {exc}") from None
    if not isinstance(raw, dict):
        raise FairError(f"config file must contain a JSON object: {path}")
    cfg = {**CONFIG_DEFAULTS, **{k: v for k, v in raw.items() if v is not None}}
    cfg["skill_dir"] = cfg.get("skill_dir") or default_skill_dir()
    return cfg


def get_tz(name: str) -> dt.tzinfo:
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # tzdata missing (e.g. Windows dev box): fixed EST is close enough for date math
        return dt.timezone(dt.timedelta(hours=-5), "EST")


def now_in(cfg: dict[str, Any]) -> dt.datetime:
    return dt.datetime.now(get_tz(cfg["timezone"]))


def iso(ts: dt.datetime) -> str:
    return ts.replace(microsecond=0).isoformat()


def read_json(path: Path | str, default: Any) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as exc:
        raise FairError(f"corrupt JSON file {path}: {exc}") from None


def write_json(path: Path | str, data: Any) -> None:
    """Atomic write: temp file in the same directory, then rename."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def file_lock(path: Path | str):
    """Exclusive advisory lock so the cron run and the chat session never interleave writes."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import fcntl
    except ImportError:  # Windows dev box
        yield
        return
    with open(path, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


class StatePaths:
    def __init__(self, state_dir: str | Path):
        self.root = Path(state_dir)
        self.state = self.root / "state.json"
        self.pending = self.root / "pending.json"
        self.pages = self.root / "pages"
        self.fairs = self.root / "fairs.json"
        self.journal_pending = self.root / "journal_pending.json"
        self.lock = self.root / ".lock"


# --------------------------------------------------------------------------- #
# Text normalisation, towns, keys
# --------------------------------------------------------------------------- #
def strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def norm_text(text: str) -> str:
    text = strip_accents(text).lower().replace("&", " and ")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def norm_town(town: str) -> str:
    text = strip_accents(town).lower().strip()
    text = re.sub(r"(?:,\s*|\s+)(?:ma|mass\.?|massachusetts)$", "", text)
    text = re.sub(r"^(?:town|city) of\s+", "", text)
    return norm_text(text)


def load_towns(skill_dir: str | Path) -> dict[str, dict[str, Any]]:
    path = Path(skill_dir) / "references" / "towns.json"
    data = read_json(path, None)
    if not data or "towns" not in data:
        raise FairError(f"towns.json not found or malformed: {path}")
    return {norm_town(t["town"]): t for t in data["towns"]}


def load_town_list(skill_dir: str | Path) -> list[dict[str, Any]]:
    """The towns exactly as listed in towns.json (the rotation needs the list, not the lookup dict)."""
    path = Path(skill_dir) / "references" / "towns.json"
    data = read_json(path, None)
    if not data or "towns" not in data:
        raise FairError(f"towns.json not found or malformed: {path}")
    return list(data["towns"])


# --------------------------------------------------------------------------- #
# Rotating per-town discovery
# --------------------------------------------------------------------------- #
ROTATION_TIER_RANK = {"A": 0, "B": 1, "C": 2}   # anything else (unknown tier) goes last
STATE_ROTATION_CURSOR = "town_rotation_cursor"


def rotation_order(towns: list[dict[str, Any]]) -> list[str]:
    """Stable order in which the weekly search visits the towns: tier A, B, C, unknown, then nearest first.

    Core and coast towns are interleaved by the same rule (a coast town is just a town with its own tier).
    Nothing is excluded."""
    def key(t: dict[str, Any]) -> tuple:
        miles = t.get("approx_miles_from_framingham")
        straight = t.get("straight_line_miles")
        return (ROTATION_TIER_RANK.get(t.get("income_tier"), len(ROTATION_TIER_RANK)),
                miles if miles is not None else float("inf"),
                straight if straight is not None else float("inf"),
                t["town"])
    return [t["town"] for t in sorted(towns, key=key)]


def rotation_slice(order: list[str], cursor: int, size: int) -> list[str]:
    """The next `size` towns starting at `cursor`, wrapping around the end of the order."""
    count = len(order)
    if count == 0 or size <= 0:
        return []
    start = cursor % count
    return [order[(start + i) % count] for i in range(min(size, count))]


def rotation_label(cursor: int, size: int, total: int) -> str:
    """'26-50 of 131', or '121-131 and 1-14 of 131' when the slice wraps."""
    if total <= 0 or size <= 0:
        return f"0 of {total}"
    start = cursor % total
    first, last = start + 1, start + size
    if last <= total:
        return f"{first}-{last} of {total}"
    return f"{first}-{total} and 1-{last - total} of {total}"


def discovery_year_text(today: dt.date) -> str:
    """The year(s) for a search query: this year until Sep 30, then 'this OR next' (fall shows are over by then)."""
    if (today.month, today.day) < (10, 1):
        return str(today.year)
    return f"{today.year} OR {today.year + 1}"


def town_query(template: str, town: str, year_text: str) -> str:
    return template.replace("{town}", town).replace("{year}", year_text)


_NAME_STOPWORDS = {"the", "annual"}


def name_tokens(name: str, town: str) -> list[str]:
    """Tokens that identify a fair independent of year, ordinal and the town name."""
    tokens = [
        t for t in norm_text(name).split()
        if t not in _NAME_STOPWORDS
        and not re.fullmatch(r"(?:19|20)\d\d", t)
        and not re.fullmatch(r"\d+(?:st|nd|rd|th)", t)
    ]
    town_tokens = set(norm_town(town).split())
    stripped = [t for t in tokens if t not in town_tokens]
    return stripped or tokens


def make_key(name: str, town: str, start_date: str) -> str:
    base = "-".join(name_tokens(name, town))[:60].strip("-") or "fair"
    return f"{base}-{norm_town(town).replace(' ', '-')}-{start_date[:4]}"


def name_similarity(a: str, b: str, town: str) -> float:
    return difflib.SequenceMatcher(None, " ".join(name_tokens(a, town)), " ".join(name_tokens(b, town))).ratio()


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
_ALLOWED_FIELDS = (
    "name", "town", "start_date", "end_date", "start_time", "end_time", "event_type", "recurrence",
    "booth_fee_usd", "vendor_count", "juried", "application_deadline", "application_status", "application_url",
    "event_url", "contact_email", "contact_other", "source_id", "notes",
)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_EMAIL_RE = re.compile(r"^[^@\s,;<>()]+@[^@\s,;<>()]+\.[^@\s,;<>()]{2,}$")


def _parse_date(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _DATE_RE.match(value):
        raise ValidationError(f"{field} must be a date string YYYY-MM-DD, got {value!r}")
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        raise ValidationError(f"{field} is not a real calendar date: {value!r}") from None
    return value


def _opt_str(value: Any, field: str, max_len: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be a string or null")
    value = value.strip()
    if len(value) > max_len:
        raise ValidationError(f"{field} is too long (max {max_len} characters)")
    return value or None


def _opt_url(value: Any, field: str) -> str | None:
    value = _opt_str(value, field, 500)
    if value is not None and not re.match(r"^https?://\S+$", value):
        raise ValidationError(f"{field} must be an http(s) URL or null")
    return value


def _opt_email(value: Any, field: str) -> str | None:
    value = _opt_str(value, field, 254)
    if value is not None and not _EMAIL_RE.match(value):
        raise ValidationError(f"{field} must be a valid email address or null")
    return value


def validate_fair(raw: Any, today: dt.date) -> dict[str, Any]:
    """Return only the fields the caller provided, validated. Defaults are applied on insert."""
    if not isinstance(raw, dict):
        raise ValidationError("fair must be a JSON object")
    unknown = sorted(set(raw) - set(_ALLOWED_FIELDS))
    if unknown:
        raise ValidationError(f"unknown field(s): {', '.join(unknown)}. Allowed: {', '.join(_ALLOWED_FIELDS)}")

    out: dict[str, Any] = {}
    for field in ("name", "town", "start_date"):
        if raw.get(field) in (None, ""):
            raise ValidationError(f"{field} is required")
    out["name"] = _opt_str(raw["name"], "name", 200)
    out["town"] = _opt_str(raw["town"], "town", 80)
    if not out["name"] or not out["town"]:
        raise ValidationError("name and town must not be blank")
    out["start_date"] = _parse_date(raw["start_date"], "start_date")

    if "end_date" in raw:
        out["end_date"] = None if raw["end_date"] is None else _parse_date(raw["end_date"], "end_date")
    if "application_deadline" in raw:
        deadline = raw["application_deadline"]
        out["application_deadline"] = None if deadline is None else _parse_date(deadline, "application_deadline")

    start = dt.date.fromisoformat(out["start_date"])
    end = dt.date.fromisoformat(out["end_date"]) if out.get("end_date") else start
    if end < start:
        raise ValidationError("end_date is before start_date")
    if start < today or end < today:
        raise ValidationError(f"event is in the past (today is {today.isoformat()}): not recorded")

    for field in ("start_time", "end_time"):
        if field in raw:
            value = raw[field]
            if value is not None and (not isinstance(value, str) or not _TIME_RE.match(value)):
                raise ValidationError(f"{field} must be HH:MM (24h) or null")
            out[field] = value
    if out.get("start_time") and out.get("end_time") and end == start and out["end_time"] <= out["start_time"]:
        raise ValidationError("end_time must be after start_time on a single-day event")

    if "event_type" in raw:
        if raw["event_type"] not in EVENT_TYPES:
            raise ValidationError(f"event_type must be one of {', '.join(EVENT_TYPES)}")
        out["event_type"] = raw["event_type"]
    if "recurrence" in raw:
        if raw["recurrence"] not in RECURRENCES:
            raise ValidationError(f"recurrence must be one of {', '.join(RECURRENCES)}")
        out["recurrence"] = raw["recurrence"]

    if "application_status" in raw:
        if raw["application_status"] is not None and raw["application_status"] not in APPLICATION_STATUSES:
            raise ValidationError(f"application_status must be one of {', '.join(APPLICATION_STATUSES)} or null")
        out["application_status"] = raw["application_status"]

    if "booth_fee_usd" in raw:
        fee = raw["booth_fee_usd"]
        if fee is not None and (isinstance(fee, bool) or not isinstance(fee, (int, float)) or fee < 0):
            raise ValidationError("booth_fee_usd must be a non-negative number or null (no currency symbol)")
        out["booth_fee_usd"] = fee
    if "vendor_count" in raw:
        count = raw["vendor_count"]
        if count is not None and (isinstance(count, bool) or not isinstance(count, int) or count < 0):
            raise ValidationError("vendor_count must be a non-negative integer or null")
        out["vendor_count"] = count
    if "juried" in raw:
        if raw["juried"] is not None and not isinstance(raw["juried"], bool):
            raise ValidationError("juried must be true, false or null")
        out["juried"] = raw["juried"]

    if "application_url" in raw:
        out["application_url"] = _opt_url(raw["application_url"], "application_url")
    if "event_url" in raw:
        out["event_url"] = _opt_url(raw["event_url"], "event_url")
    if "contact_email" in raw:
        out["contact_email"] = _opt_email(raw["contact_email"], "contact_email")
    if "contact_other" in raw:
        out["contact_other"] = _opt_str(raw["contact_other"], "contact_other", 300)
    if "source_id" in raw:
        out["source_id"] = _opt_str(raw["source_id"], "source_id", 80)
    if "notes" in raw:
        out["notes"] = _opt_str(raw["notes"], "notes", 600)
    return out


# --------------------------------------------------------------------------- #
# Results of a fair that already happened
# --------------------------------------------------------------------------- #
RESULT_NUMERIC_FIELDS = (
    "revenue", "sales_count", "items_sold", "booth_cost", "other_costs", "cogs", "payment_fees",
    "hours_total", "hours_open", "first_sale_minutes", "visitors_stopped", "contacts", "orders",
)
RESULT_TEXT_FIELDS = ("best_sellers", "most_viewed_no_buy", "price_objections", "notes")
RESULT_WEATHER = ("Sol", "Nublado", "Chuva", "Frio", "Calor", "Indoor")   # stored as the Notion option names
RESULT_WOULD_RETURN = ("yes", "maybe", "no")
_RESULT_FIELDS = RESULT_NUMERIC_FIELDS + RESULT_TEXT_FIELDS + ("weather", "would_return")
_RESULT_TEXT_MAX = 1000


def validate_result(raw: Any) -> dict[str, Any]:
    """Return only the non-null fields the caller provided, validated (null means 'keep what is stored')."""
    if not isinstance(raw, dict):
        raise ValidationError("result must be a JSON object")
    unknown = sorted(set(raw) - set(_RESULT_FIELDS))
    if unknown:
        raise ValidationError(f"unknown field(s): {', '.join(unknown)}. Allowed: {', '.join(_RESULT_FIELDS)}")
    out: dict[str, Any] = {}
    for field in RESULT_NUMERIC_FIELDS:
        value = raw.get(field)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValidationError(f"{field} must be a non-negative number or null (no currency symbol)")
        out[field] = value
    for field in RESULT_TEXT_FIELDS:
        value = _opt_str(raw.get(field), field, _RESULT_TEXT_MAX)
        if value is not None:
            out[field] = value
    weather = raw.get("weather")
    if weather is not None:
        if weather not in RESULT_WEATHER:
            raise ValidationError(f"weather must be one of {', '.join(RESULT_WEATHER)} or null")
        out["weather"] = weather
    would_return = raw.get("would_return")
    if would_return is not None:
        if would_return not in RESULT_WOULD_RETURN:
            raise ValidationError(f"would_return must be one of {', '.join(RESULT_WOULD_RETURN)} or null")
        out["would_return"] = would_return
    return out


def _ratio(num: float | None, den: float | None) -> float | None:
    if num is None or not den:
        return None
    return round(num / den, 2)


def result_summary(result: dict[str, Any] | None) -> dict[str, Any]:
    """Derived numbers (the same ones the Notion formula columns show); None when the inputs are missing."""
    result = result or {}
    cost_fields = [result[f] for f in ("booth_cost", "other_costs", "cogs", "payment_fees") if result.get(f) is not None]
    total_costs = round(sum(cost_fields), 2) if cost_fields else None
    revenue = result.get("revenue")
    profit = round(revenue - total_costs, 2) if revenue is not None and total_costs is not None else None
    return {
        "total_costs": total_costs,
        "profit": profit,
        "profit_per_hour": _ratio(profit, result.get("hours_total")),
        "revenue_per_open_hour": _ratio(revenue, result.get("hours_open")),
        "avg_ticket": _ratio(revenue, result.get("sales_count")),
    }


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
def decide(total: int) -> str:
    if total >= OPPORTUNITY_MIN_SCORE:
        return "opportunity"
    if total >= MAYBE_MIN_SCORE:
        return "maybe"
    return "skip"


def cap_decision(decision: str, ceiling: str) -> str:
    """A cap only ever lowers a decision."""
    return decision if DECISION_RANK[decision] <= DECISION_RANK[ceiling] else ceiling


def score_fair(fair: dict[str, Any], towns: dict[str, dict[str, Any]]) -> dict[str, Any]:
    town = towns.get(norm_town(fair["town"]))
    tier = town["income_tier"] if town else "unknown"
    miles = town.get("approx_miles_from_framingham") if town else None
    coast = bool(town) and town.get("zone") == ZONE_COAST
    region = town.get("region") if coast else None

    days = fair_days(fair)
    fee = fair.get("booth_fee_usd")
    if fee is None:
        fee_points = BOOTH_FEE_POINTS["unknown_1day"] if days == 1 else BOOTH_FEE_POINTS["unknown_multi"]
    elif fee <= BOOTH_FEE_TARGET_USD:
        fee_points = BOOTH_FEE_POINTS["target"]
    elif fee <= BOOTH_FEE_MID_USD:
        fee_points = BOOTH_FEE_POINTS["mid"]
    else:
        fee_points = BOOTH_FEE_POINTS["high"]

    vendors = fair.get("vendor_count")
    if fair.get("juried") is True:
        competition = COMPETITION_POINTS["juried"]
    elif vendors is not None and vendors <= SMALL_VENDOR_COUNT:
        competition = COMPETITION_POINTS["small"]
    elif vendors is not None and vendors > LARGE_VENDOR_COUNT:
        competition = COMPETITION_POINTS["large"]
    else:
        competition = COMPETITION_POINTS["default"]

    flags: list[str] = []
    distance = 0
    beyond_radius = miles is not None and miles > RADIUS_MILES and not coast   # the coastal zone is exempt
    if miles is None:
        flags.append("distancia_desconhecida")
    elif beyond_radius:
        distance = DISTANCE_PENALTY
    if coast:
        flags.append("litoral")
    if fee is None:
        flags.append("taxa_desconhecida")

    breakdown = {
        "event_type": EVENT_TYPE_POINTS[fair["event_type"]],
        "town": TOWN_TIER_POINTS[tier],
        "recurrence": RECURRENCE_POINTS[fair["recurrence"]],
        "booth_fee": fee_points,
        "competition": competition,
        "distance": distance,
    }
    total = max(0, min(100, sum(breakdown.values())))
    decision = decide(total)

    if days > LONG_SEASON_DAYS:
        flags.append("temporada_longa")
        decision = cap_decision(decision, "maybe")
    status_cap = APPLICATION_STATUS_CAPS.get(fair.get("application_status") or "unknown")
    if status_cap:
        flags.append(status_cap[0])
        decision = cap_decision(decision, status_cap[1])

    # A multi-day fair with an unknown fee is "outside target" like a known fee above it or a town beyond the radius:
    # big multi-day shows hide their prices and are usually expensive. One-day local fairs rarely publish a fee, so
    # for them an unknown fee only costs points. Only the known cases are flagged `excecao`.
    known_outside = (fee is not None and fee > BOOTH_FEE_TARGET_USD) or beyond_radius
    unknown_multi_day = fee is None and days > 1
    if decision == "opportunity" and (known_outside or unknown_multi_day):
        if total < EXCEPTION_MIN_SCORE:
            decision = "maybe"
        elif known_outside:
            flags.append("excecao")
    return {"total": total, "breakdown": breakdown, "decision": decision, "flags": flags,
            "income_tier": tier, "approx_miles": miles, "zone": ZONE_COAST if coast else ZONE_CORE, "region": region}


# --------------------------------------------------------------------------- #
# Calendar event bodies (PT-BR, owner-facing)
# --------------------------------------------------------------------------- #
def _money(value: float | int | None) -> str:
    if value is None:
        return "não informado"
    return f"US$ {int(value)}" if float(value).is_integer() else f"US$ {value:.2f}"


def _yes_no(value: bool | None) -> str:
    return "não informado" if value is None else ("sim" if value else "não")


def fmt_br(day: str) -> str:
    """YYYY-MM-DD -> DD/MM/YYYY (owner-facing text)."""
    return dt.date.fromisoformat(day).strftime("%d/%m/%Y")


def fair_days(rec: dict[str, Any]) -> int:
    start = dt.date.fromisoformat(rec["start_date"])
    end = dt.date.fromisoformat(rec["end_date"]) if rec.get("end_date") else start
    return (end - start).days + 1


def price_per_day(rec: dict[str, Any]) -> float | None:
    """Booth fee per day, only for multi-day fairs with a known fee."""
    fee, days = rec.get("booth_fee_usd"), fair_days(rec)
    if fee is None or days <= 1:
        return None
    return round(fee / days, 2)


def when_text(rec: dict[str, Any]) -> str:
    """DD/MM/YYYY, or 'DD/MM/YYYY a DD/MM/YYYY' for multi-day fairs."""
    if fair_days(rec) > 1:
        return f"{fmt_br(rec['start_date'])} a {fmt_br(rec['end_date'])}"
    return fmt_br(rec["start_date"])


def fair_title(rec: dict[str, Any]) -> str:
    prefix = ("✅ " if rec.get("status") == "done" else "") + ("⚠️ " if "excecao" in rec.get("flags", []) else "")
    return f"{prefix}🎪 {rec['name']} — {rec['town']}"


def fair_description(rec: dict[str, Any]) -> str:
    b = rec["breakdown"]
    lines = []
    if rec["status"] == "confirmed":
        lines.append("CONFIRMADA pelo dono.")
    elif rec["status"] == "done":
        lines.append("REALIZADA. Resultado no Notion.")
    lines += [
        f"Score: {rec['score']}/100",
        f"Detalhe: tipo {b['event_type']}, cidade (faixa {rec['income_tier']}) {b['town']}, "
        f"recorrência {b['recurrence']}, taxa {b['booth_fee']}, concorrência {b['competition']}, "
        f"distância {b['distance']}",
    ]
    if "excecao" in rec["flags"]:
        lines.append("EXCEÇÃO: taxa acima de US$ 75 ou mais de 30 milhas, mas o resto compensa.")
    if "distancia_desconhecida" in rec["flags"]:
        lines.append("Distância desconhecida (cidade fora da lista).")
    if "litoral" in rec["flags"]:
        region = REGION_LABELS.get(rec.get("region") or "")
        lines.append(f"Litoral ({region})" if region else "Litoral")
    if "taxa_desconhecida" in rec["flags"]:
        lines.append("Taxa de booth não informada: confirme o valor antes de se inscrever.")
    if "temporada_longa" in rec["flags"]:
        lines.append(f"Temporada longa: {fair_days(rec)} dias.")
    if "inscricao_encerrada" in rec["flags"]:
        lines.append("Inscrições encerradas.")
    if "lista_de_espera" in rec["flags"]:
        lines.append("Só há lista de espera.")
    miles = rec.get("approx_miles")
    lines += [
        f"Tipo: {EVENT_TYPE_PT[rec['event_type']]}",
        f"Recorrência: {RECURRENCE_PT[rec['recurrence']]}",
        f"Taxa de booth: {_money(rec.get('booth_fee_usd'))}",
        f"Dias: {fair_days(rec)}",
        f"Expositores: {rec['vendor_count'] if rec.get('vendor_count') is not None else 'não informado'}",
        f"Seleção (juried): {_yes_no(rec.get('juried'))}",
        f"Distância aproximada: {f'{miles} milhas' if miles is not None else 'não informada'}",
        f"Prazo de inscrição: {rec.get('application_deadline') or 'não informado'}",
        f"Inscrição: {APPLICATION_STATUS_PT[rec.get('application_status') or 'unknown']}",
    ]
    per_day = price_per_day(rec)
    if per_day is not None:
        lines.insert(lines.index(f"Dias: {fair_days(rec)}") + 1, f"Preço por dia: {_money(per_day)}")
    if rec.get("contact_email"):
        lines.append(f"E-mail de contato: {rec['contact_email']}")
    if rec.get("contact_other"):
        lines.append(f"Outro contato: {rec['contact_other']}")
    if rec.get("application_url"):
        lines.append(f"Link de inscrição: {rec['application_url']}")
    if rec.get("event_url"):
        lines.append(f"Evento: {rec['event_url']}")
    if rec.get("source_id"):
        lines.append(f"Fonte: {rec['source_id']}")
    if rec.get("notes"):
        lines.append(f"Notas: {rec['notes']}")
    lines.append(f"Chave: {rec['key']}")
    return "\n".join(lines)


def _when(rec: dict[str, Any], tz_name: str, patch: bool) -> tuple[dict[str, Any], dict[str, Any]]:
    start = dt.date.fromisoformat(rec["start_date"])
    end = dt.date.fromisoformat(rec["end_date"]) if rec.get("end_date") else start
    if rec.get("start_time") and rec.get("end_time"):
        s = {"dateTime": f"{start.isoformat()}T{rec['start_time']}:00", "timeZone": tz_name}
        e = {"dateTime": f"{end.isoformat()}T{rec['end_time']}:00", "timeZone": tz_name}
        if patch:
            s["date"] = None
            e["date"] = None
    else:
        s = {"date": start.isoformat()}
        e = {"date": (end + dt.timedelta(days=1)).isoformat()}
        if patch:
            s.update(dateTime=None, timeZone=None)
            e.update(dateTime=None, timeZone=None)
    return s, e


def fair_event_body(rec: dict[str, Any], tz_name: str, patch: bool = False) -> dict[str, Any]:
    start, end = _when(rec, tz_name, patch)
    return {
        "summary": fair_title(rec),
        "description": fair_description(rec),
        "location": f"{rec['town']}, MA",
        "start": start,
        "end": end,
        "extendedProperties": {"private": {"fairKey": rec["key"], "kind": "fair"}},
    }


def deadline_event_body(rec: dict[str, Any]) -> dict[str, Any]:
    day = dt.date.fromisoformat(rec["application_deadline"])
    lines = [f"Último dia para se inscrever em {rec['name']} ({rec['town']}, {rec['start_date']})."]
    if rec.get("application_url"):
        lines.append(f"Inscrição: {rec['application_url']}")
    elif rec.get("event_url"):
        lines.append(f"Evento: {rec['event_url']}")
    lines.append(f"Chave: {rec['key']}")
    return {
        "summary": f"⏰ Inscrição: {rec['name']}",
        "description": "\n".join(lines),
        "start": {"date": day.isoformat()},
        "end": {"date": (day + dt.timedelta(days=1)).isoformat()},
        "extendedProperties": {"private": {"fairKey": rec["key"], "kind": "deadline"}},
    }


# --------------------------------------------------------------------------- #
# Google Calendar client (lazy imports; tests inject a fake with the same methods)
# --------------------------------------------------------------------------- #
def http_error_text(exc: Exception) -> str:
    status = getattr(getattr(exc, "resp", None), "status", None)
    detail = ""
    content = getattr(exc, "content", None)
    if content:
        try:
            detail = json.loads(content.decode("utf-8", "replace")).get("error", {}).get("message", "")
        except (ValueError, AttributeError):
            detail = ""
    if status is not None:
        hint = " (calendar not shared with the service account, or wrong calendar id)" if status in (403, 404) else ""
        return f"Google API HTTP {status}: {detail or 'error'}{hint}"
    return f"{type(exc).__name__}: {exc}"


class GoogleCalendar:
    def __init__(self, service: Any):
        self.svc = service

    @classmethod
    def from_config(cls, cfg: dict[str, Any]) -> "GoogleCalendar":
        key_file = cfg.get("service_account_file")
        if not key_file or not os.path.isfile(key_file):
            raise FairError(f"service account key file not found: {key_file}")
        try:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build
        except ImportError as exc:
            raise FairError(f"Google client libraries missing ({exc.name}); run with /opt/hermes/.venv/bin/python") from None
        creds = service_account.Credentials.from_service_account_file(key_file, scopes=CALENDAR_SCOPES)
        return cls(build("calendar", "v3", credentials=creds, cache_discovery=False))

    def get_calendar(self, cal_id: str) -> dict[str, Any]:
        return self.svc.calendars().get(calendarId=cal_id).execute()

    def find(self, cal_id: str, key: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        token = None
        while True:
            params: dict[str, Any] = {"calendarId": cal_id, "privateExtendedProperty": f"fairKey={key}",
                                      "showDeleted": False, "maxResults": 50}
            if token:
                params["pageToken"] = token
            resp = self.svc.events().list(**params).execute()
            items += resp.get("items", [])
            token = resp.get("nextPageToken")
            if not token:
                return items

    def insert(self, cal_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.svc.events().insert(calendarId=cal_id, body=body).execute()

    def patch(self, cal_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.svc.events().patch(calendarId=cal_id, eventId=event_id, body=body).execute()

    def delete(self, cal_id: str, event_id: str) -> None:
        self.svc.events().delete(calendarId=cal_id, eventId=event_id).execute()

    def move(self, cal_id: str, event_id: str, destination: str) -> dict[str, Any]:
        return self.svc.events().move(calendarId=cal_id, eventId=event_id, destination=destination).execute()


def _kind(event: dict[str, Any]) -> str:
    return (event.get("extendedProperties", {}).get("private", {}) or {}).get("kind", "fair")


# --------------------------------------------------------------------------- #
# Notion mirror: pure property mapping (no HTTP)
# --------------------------------------------------------------------------- #
# Property names are fixed by the owner's Notion workspace (Portuguese); values written follow the same maps.
NOTION_VERSION = "2025-09-03"
NOTION_API = "https://api.notion.com"
NOTION_MIN_INTERVAL_S = 0.34          # <= 3 requests per second
NOTION_TEXT_LIMIT = 2000              # Notion's cap for one rich_text item / paragraph
NOTION_SHARE_HINT = ("share the hub page 'Feiras da Stuscle — radar, agenda e resultados' with the Notion "
                     "integration named 'Hermes' (••• → Connections)")

NOTION_STATUS = {"opportunity": "Oportunidade", "maybe": "Talvez", "confirmed": "Confirmada", "done": "Realizada",
                 "discarded": "Descartada", "skip": "Abaixo da nota"}
NOTION_EVENT_TYPE = {"craft": "Craft", "holiday": "Holiday", "artisan": "Artesanal", "mixed": "Misto",
                     "festival": "Festival", "farmers": "Farmers"}
NOTION_RECURRENCE = {"one_off": "Única", "annual": "Anual", "seasonal": "Sazonal", "monthly": "Mensal",
                     "weekly": "Semanal", "unknown": "?"}
NOTION_TIER = {"A": "A", "B": "B", "C": "C", "unknown": "?"}
NOTION_APPLICATION_STATUS = {"open": "Aberta", "waitlist": "Lista de espera", "closed": "Encerrada", "unknown": "?"}
NOTION_FLAGS = {"excecao": "Exceção", "litoral": "Litoral", "distancia_desconhecida": "Distância desconhecida",
                "taxa_desconhecida": "Taxa desconhecida", "temporada_longa": "Temporada longa",
                "inscricao_encerrada": "Inscrição encerrada", "lista_de_espera": "Lista de espera"}
NOTION_WOULD_RETURN = {"yes": "Sim", "maybe": "Talvez", "no": "Não"}
# Formula columns computed by Notion itself: writing them would be an API error, so they are never sent.
NOTION_FORMULA_PROPERTIES = ("Preço por dia", "Custos totais", "Lucro líquido", "Lucro por hora",
                             "Receita por hora de feira", "Ticket médio")


def _n_title(text: str) -> dict[str, Any]:
    return {"title": [{"type": "text", "text": {"content": text[:NOTION_TEXT_LIMIT]}}]}


def _n_text(text: str | None) -> dict[str, Any]:
    text = (text or "").strip()
    return {"rich_text": [{"type": "text", "text": {"content": text[:NOTION_TEXT_LIMIT]}}] if text else []}


def _n_select(name: str | None) -> dict[str, Any]:
    return {"select": {"name": name} if name else None}


def _n_number(value: float | int | None) -> dict[str, Any]:
    return {"number": value}


def _n_date(start: str | None, end: str | None = None) -> dict[str, Any]:
    return {"date": {"start": start, "end": end} if start else None}


def fair_to_notion_properties(rec: dict[str, Any]) -> dict[str, Any]:
    """Properties of the 'Feiras' database for one registry record. Null values clear the property."""
    multi_day = fair_days(rec) > 1
    juried = rec.get("juried")
    return {
        "Feira": _n_title(rec["name"]),
        "Status": _n_select(NOTION_STATUS[rec["status"]]),
        "Data": _n_date(rec["start_date"], rec["end_date"] if multi_day else None),
        "Cidade": _n_text(rec["town"]),
        "Nível da cidade": _n_select(NOTION_TIER.get(rec.get("income_tier") or "unknown", "?")),
        "Distância (mi)": _n_number(rec.get("approx_miles")),
        "Tipo": _n_select(NOTION_EVENT_TYPE[rec["event_type"]]),
        "Recorrência": _n_select(NOTION_RECURRENCE[rec["recurrence"]]),
        "Booth (US$)": _n_number(rec.get("booth_fee_usd")),
        "Dias": _n_number(fair_days(rec)),
        "E-mail de contato": {"email": rec.get("contact_email")},
        "Outro contato": _n_text(rec.get("contact_other")),
        "Prazo de inscrição": _n_date(rec.get("application_deadline")),
        "Inscrição": _n_select(NOTION_APPLICATION_STATUS[rec.get("application_status") or "unknown"]),
        "Link de inscrição": {"url": rec.get("application_url")},
        "Link do evento": {"url": rec.get("event_url")},
        "Juried": _n_select("?" if juried is None else ("Sim" if juried else "Não")),
        "Expositores": _n_number(rec.get("vendor_count")),
        "Nota": _n_number(rec.get("score")),
        "Alertas": {"multi_select": [{"name": NOTION_FLAGS[f]} for f in rec.get("flags", []) if f in NOTION_FLAGS]},
        "Fonte": _n_text(", ".join(rec.get("sources", []))),
        "Observações": _n_text(rec.get("notes")),
        "Chave": _n_text(rec["key"]),
    }


_RESULT_NUMBER_PROPERTIES = {
    "revenue": "Receita bruta", "sales_count": "Vendas (nº)", "items_sold": "Itens vendidos",
    "booth_cost": "Custo do booth", "other_costs": "Outros custos", "cogs": "Custo das peças vendidas",
    "payment_fees": "Taxas de pagamento", "hours_total": "Horas totais", "hours_open": "Horas de feira",
    "first_sale_minutes": "Primeira venda após (min)", "visitors_stopped": "Visitantes que pararam",
    "contacts": "Contatos captados", "orders": "Encomendas",
}
_RESULT_TEXT_PROPERTIES = {
    "best_sellers": "Mais vendidos", "most_viewed_no_buy": "Mais olhados sem compra",
    "price_objections": "Objeções de preço", "notes": "Notas",
}


def result_to_notion_properties(rec: dict[str, Any], fair_page_id: str | None) -> dict[str, Any]:
    """Properties of one row of 'Resultados por feira'. Formula columns are left to Notion."""
    result = rec.get("result") or {}
    multi_day = fair_days(rec) > 1
    props: dict[str, Any] = {
        "Participação": _n_title(f"{rec['name']} — {fmt_br(rec['start_date'])}"),
        "Feira": {"relation": [{"id": fair_page_id}] if fair_page_id else []},
        "Data": _n_date(rec["start_date"], rec["end_date"] if multi_day else None),
        "Clima": _n_select(result.get("weather")),
        "Voltaria?": _n_select(NOTION_WOULD_RETURN.get(result.get("would_return"))),
        "Chave": _n_text(rec["key"]),
    }
    for field, name in _RESULT_NUMBER_PROPERTIES.items():
        props[name] = _n_number(result.get(field))
    for field, name in _RESULT_TEXT_PROPERTIES.items():
        props[name] = _n_text(result.get(field))
    return props


def chunk_text(text: str, limit: int = NOTION_TEXT_LIMIT) -> list[str]:
    """Split on whitespace where possible so no chunk exceeds `limit` characters."""
    text = text.strip()
    chunks: list[str] = []
    while len(text) > limit:
        cut = text.rfind(" ", 0, limit)
        cut = cut if cut > limit // 2 else limit
        chunks.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        chunks.append(text)
    return chunks


def journal_blocks(day: str, text: str, with_heading: bool) -> list[dict[str, Any]]:
    def block(kind: str, content: str) -> dict[str, Any]:
        return {"object": "block", "type": kind, kind: {"rich_text": [{"type": "text", "text": {"content": content}}]}}

    blocks = [block("heading_3", fmt_br(day))] if with_heading else []
    return blocks + [block("paragraph", chunk) for chunk in chunk_text(text)]


# --------------------------------------------------------------------------- #
# Notion REST client (lazy `requests`; tests inject a fake with the same public methods)
# --------------------------------------------------------------------------- #
class NotionError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class NotionClient:
    def __init__(self, token: str, session: Any = None, sleep: Callable[[float], None] | None = None,
                 clock: Callable[[], float] | None = None):
        self._token = token
        self._session = session
        self._sleep = sleep or time.sleep
        self._clock = clock or time.monotonic
        self._last_request: float | None = None

    @classmethod
    def from_config(cls, cfg: dict[str, Any]) -> "NotionClient | None":
        """None (Notion disabled) when the token file is missing or empty."""
        path = cfg.get("notion_token_file")
        if not path or not os.path.isfile(path):
            return None
        try:
            lines = [line.strip() for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
        except OSError:
            return None
        return cls(lines[0]) if lines else None

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}", "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json"}

    def _redact(self, text: str) -> str:
        return text.replace(self._token, "***") if self._token else text

    def _throttle(self) -> None:
        now = self._clock()
        if self._last_request is not None:
            wait = NOTION_MIN_INTERVAL_S - (now - self._last_request)
            if wait > 0:
                self._sleep(wait)
                now = self._clock()
        self._last_request = now

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._session is None:
            import requests  # lazy: tests and --help never need it
            self._session = requests.Session()
        response = None
        for attempt in (0, 1):
            self._throttle()
            try:
                response = self._session.request(method, NOTION_API + path, headers=self._headers(), json=body,
                                                 timeout=30)
            except Exception as exc:
                raise NotionError(self._redact(f"network error: {type(exc).__name__}")) from None
            if attempt == 0 and (response.status_code == 429 or response.status_code >= 500):
                try:
                    delay = float(response.headers.get("Retry-After", ""))
                except (TypeError, ValueError):
                    delay = 1.0
                self._sleep(min(max(delay, 0.0), 60.0))
                continue
            break
        assert response is not None
        if response.status_code >= 400:
            detail = ""
            try:
                detail = str(response.json().get("message", ""))
            except Exception:
                detail = ""
            raise NotionError(self._redact(f"Notion HTTP {response.status_code}: {detail or 'error'}"),
                              response.status_code)
        try:
            return response.json()
        except ValueError:
            return {}

    # -- API surface used by FairService ------------------------------------ #
    def create_page(self, data_source_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/v1/pages", {
            "parent": {"type": "data_source_id", "data_source_id": data_source_id}, "properties": properties})

    def update_page(self, page_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", f"/v1/pages/{page_id}", {"properties": properties})

    def query_data_source(self, data_source_id: str, filter_: dict[str, Any]) -> list[dict[str, Any]]:
        resp = self._request("POST", f"/v1/data_sources/{data_source_id}/query", {"filter": filter_, "page_size": 5})
        return resp.get("results", [])

    def append_children(self, page_id: str, children: list[dict[str, Any]]) -> dict[str, Any]:
        return self._request("PATCH", f"/v1/blocks/{page_id}/children", {"children": children})

    def get_data_source(self, data_source_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/data_sources/{data_source_id}")

    def get_page(self, page_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/pages/{page_id}")


def notion_key_filter(key: str) -> dict[str, Any]:
    return {"property": "Chave", "rich_text": {"equals": key}}


LIST_SORTS = ("date", "profit_per_hour")
NOTION_ID_KEYS = ("notion_fairs_data_source_id", "notion_results_data_source_id", "notion_journal_page_id")


# --------------------------------------------------------------------------- #
# Service: registry + calendar reconciliation
# --------------------------------------------------------------------------- #
def compact(rec: dict[str, Any]) -> dict[str, Any]:
    fields = ("key", "name", "town", "start_date", "end_date", "status", "score", "flags", "income_tier",
              "approx_miles", "event_type", "recurrence", "booth_fee_usd", "vendor_count", "juried",
              "application_deadline", "application_status", "application_url", "event_url", "contact_email",
              "contact_other")
    out = {f: rec.get(f) for f in fields}
    out["application_status"] = rec.get("application_status") or "unknown"
    out.update(days=fair_days(rec), price_per_day=price_per_day(rec))
    return out


_UNSET: Any = object()


class FairService:
    def __init__(self, cfg: dict[str, Any], towns: dict[str, dict[str, Any]] | None = None,
                 calendar: Any = None, now_fn: Callable[[], dt.datetime] | None = None, notion: Any = _UNSET):
        self.cfg = cfg
        self.paths = StatePaths(cfg["state_dir"])
        self._towns = towns
        self._calendar = calendar
        self._notion = notion       # _UNSET: build from config on first use; None: Notion disabled
        self._now_fn = now_fn or (lambda: now_in(cfg))

    # -- plumbing ---------------------------------------------------------- #
    @property
    def towns(self) -> dict[str, dict[str, Any]]:
        if self._towns is None:
            self._towns = load_towns(self.cfg["skill_dir"])
        return self._towns

    @property
    def calendar(self) -> Any:
        if self._calendar is None:
            for field in ("calendar_opportunities_id", "calendar_confirmed_id"):
                if not self.cfg.get(field):
                    raise FairError(f"config.{field} is not set")
            self._calendar = GoogleCalendar.from_config(self.cfg)
        return self._calendar

    @property
    def notion(self) -> Any:
        """The Notion client, or None when Notion sync is disabled (token file or ids missing)."""
        if not all(self.cfg.get(k) for k in NOTION_ID_KEYS):
            return None
        if self._notion is _UNSET:
            self._notion = NotionClient.from_config(self.cfg)
        return self._notion

    def now(self) -> dt.datetime:
        return self._now_fn()

    def today(self) -> dt.date:
        return self.now().date()

    def _load(self) -> dict[str, Any]:
        data = read_json(self.paths.fairs, {"version": 1, "fairs": {}})
        data.setdefault("fairs", {})
        return data

    def _save(self, data: dict[str, Any]) -> None:
        write_json(self.paths.fairs, data)

    def _require(self, data: dict[str, Any], key: str) -> dict[str, Any]:
        rec = data["fairs"].get(key)
        if rec is None:
            near = [m["key"] for m in self._search(data, key)[:3]]
            hint = f" Similar keys: {', '.join(near)}" if near else ""
            raise FairError(f"no fair with key {key!r}.{hint}")
        return rec

    def _locate(self, fairs: dict[str, Any], clean: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        key = make_key(clean["name"], clean["town"], clean["start_date"])
        start = dt.date.fromisoformat(clean["start_date"])
        known = fairs.get(key)
        if known is not None:
            if abs((start - dt.date.fromisoformat(known["start_date"])).days) <= SAME_EVENT_DATE_WINDOW_DAYS:
                return key, known
            # same name, town and year but weeks apart: a second occurrence, not a corrected date
            key = f"{key}-{start:%m%d}"
            if key in fairs:
                return key, fairs[key]
        town = norm_town(clean["town"])
        for other_key, rec in fairs.items():
            if norm_town(rec["town"]) == town and rec["start_date"] == clean["start_date"] \
                    and name_similarity(rec["name"], clean["name"], clean["town"]) >= 0.8:
                return other_key, rec
        return key, None

    def _apply_score(self, rec: dict[str, Any]) -> None:
        result = score_fair(rec, self.towns)
        rec.update(score=result["total"], breakdown=result["breakdown"], flags=result["flags"],
                   income_tier=result["income_tier"], approx_miles=result["approx_miles"],
                   region=result["region"], decision=result["decision"])

    # -- upsert ------------------------------------------------------------ #
    def upsert(self, raw: Any) -> dict[str, Any]:
        clean = validate_fair(raw, self.today())
        stamp = iso(self.now())
        with file_lock(self.paths.lock):
            data = self._load()
            fairs = data["fairs"]
            key, rec = self._locate(fairs, clean)

            if rec is not None and rec["status"] == "discarded":
                return {"ok": True, "action": "ignored_discarded", "announce": False, "fair": compact(rec),
                        "message": "fair was discarded by the owner; nothing changed"}

            if rec is None:
                rec = {"key": key, "event_type": "mixed", "recurrence": "unknown", "end_date": None,
                       "start_time": None, "end_time": None, "booth_fee_usd": None, "vendor_count": None,
                       "juried": None, "application_deadline": None, "application_status": "unknown", "application_url": None,
                       "event_url": None, "contact_email": None, "contact_other": None, "notes": None,
                       "sources": [], "aliases": [], "created_at": stamp, "announced_at": None, "status": "skip"}
                rec.update({k: v for k, v in clean.items() if v is not None})
                previous_status, action = None, "created"
                before = notion_before = None
            else:
                before = json.dumps(compact(rec), sort_keys=True)
                notion_before = json.dumps(fair_to_notion_properties(rec), sort_keys=True)
                previous_status = rec["status"]
                fill_only = previous_status in CALENDAR_CONFIRMED_STATUSES
                for field, value in clean.items():
                    if value is None or field in ("name", "town"):
                        continue
                    if field == "application_status" and value == "unknown":
                        continue                    # "I found nothing" never erases a known status
                    known = rec.get(field) is not None and not (field == "application_status" and rec[field] == "unknown")
                    if fill_only and known:
                        continue
                    rec[field] = value
                if clean["name"] != rec["name"] and clean["name"] not in rec["aliases"]:
                    rec["aliases"].append(clean["name"])
                action = "updated"

            source = clean.get("source_id")
            if source and source not in rec["sources"]:
                rec["sources"].append(source)

            self._apply_score(rec)
            if rec["status"] not in CALENDAR_CONFIRMED_STATUSES:
                rec["status"] = rec["decision"]
            rec["updated_at"] = stamp
            if action == "updated" and json.dumps(compact(rec), sort_keys=True) == before:
                action = "unchanged"
            if notion_before is None or json.dumps(fair_to_notion_properties(rec), sort_keys=True) != notion_before:
                rec["notion_dirty"] = True
            fairs[key] = rec
            self._save(data)

            result = {"ok": True, "action": action, "previous_status": previous_status, "fair": compact(rec),
                      "breakdown": rec["breakdown"],
                      "announce": rec["status"] in ("opportunity", "maybe") and rec.get("announced_at") is None}
            result["calendar"] = self._sync_calendar(rec, result)
            result["notion"] = self._notion_push(data, rec)
            return result

    # -- calendar reconciliation ------------------------------------------- #
    def _ensure(self, cal_id: str, existing: list[dict[str, Any]], body_new: dict[str, Any],
                body_patch: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        cal = self.calendar
        if existing:
            for extra in existing[1:]:
                cal.delete(cal_id, extra["id"])
            return "updated", cal.patch(cal_id, existing[0]["id"], body_patch)
        return "created", cal.insert(cal_id, body_new)

    def _delete_all(self, cal_id: str, events: list[dict[str, Any]]) -> int:
        for event in events:
            self.calendar.delete(cal_id, event["id"])
        return len(events)

    def _sync_calendar(self, rec: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        """Idempotent reconcile of the calendar with rec's status. Failures never lose registry data."""
        try:
            return self._reconcile(rec)
        except FairError:
            raise
        except Exception as exc:
            result["ok"] = False
            result["saved_in_registry"] = True
            result["error"] = f"registry updated but calendar sync failed: {http_error_text(exc)}"
            return {"synced": False}

    def _reconcile(self, rec: dict[str, Any], delete_confirmed: bool = False) -> dict[str, Any]:
        opp, conf = self.cfg["calendar_opportunities_id"], self.cfg["calendar_confirmed_id"]
        tz, today = self.cfg["timezone"], self.today()
        cal, key, status = self.calendar, rec["key"], rec["status"]
        out: dict[str, Any] = {"synced": True}

        opp_events = cal.find(opp, key)
        opp_fair = [e for e in opp_events if _kind(e) == "fair"]
        opp_deadline = [e for e in opp_events if _kind(e) == "deadline"]

        if status in CALENDAR_CONFIRMED_STATUSES:
            out["deadline_event"] = f"deleted:{self._delete_all(opp, opp_deadline)}" if opp_deadline else "none"
            conf_fair = [e for e in cal.find(conf, key) if _kind(e) == "fair"]
            if conf_fair:
                self._delete_all(opp, opp_fair)  # stale copy left behind by an interrupted move
            elif opp_fair:
                try:
                    conf_fair = [cal.move(opp, opp_fair[0]["id"], conf)]
                    self._delete_all(opp, opp_fair[1:])
                    out["fair_event"] = "moved"
                except Exception:
                    # events.move can be refused with writer-only sharing: recreate, then drop the original
                    conf_fair = [cal.insert(conf, fair_event_body(rec, tz))]
                    self._delete_all(opp, opp_fair)
                    out["fair_event"] = "recreated"
            action, event = self._ensure(conf, conf_fair, fair_event_body(rec, tz), fair_event_body(rec, tz, patch=True))
            out.setdefault("fair_event", action)
            out["calendar"] = "confirmed"
            out["event_id"] = event.get("id")
        elif status == "opportunity":
            action, event = self._ensure(opp, opp_fair, fair_event_body(rec, tz), fair_event_body(rec, tz, patch=True))
            out.update(calendar="opportunities", fair_event=action, event_id=event.get("id"))
            deadline = rec.get("application_deadline")
            if deadline and dt.date.fromisoformat(deadline) >= today:
                body = deadline_event_body(rec)
                d_action, _ = self._ensure(opp, opp_deadline, body, body)
                out["deadline_event"] = d_action
            else:
                out["deadline_event"] = f"deleted:{self._delete_all(opp, opp_deadline)}" if opp_deadline else "none"
        else:  # maybe, skip, discarded: nothing belongs in the opportunities calendar
            removed = self._delete_all(opp, opp_events)
            out.update(calendar="none", fair_event=f"deleted:{removed}" if removed else "none")
            if delete_confirmed:
                gone = self._delete_all(conf, cal.find(conf, key))
                out["confirmed_calendar"] = f"deleted:{gone}" if gone else "none"
        return out

    # -- Notion mirror ------------------------------------------------------ #
    def _notion_error_text(self, exc: Exception) -> str:
        text = str(exc) if isinstance(exc, NotionError) else http_error_text(exc)
        if isinstance(exc, NotionError) and exc.status in (403, 404):
            text += f" ({NOTION_SHARE_HINT})"
        return text

    def _push_fair_page(self, client: Any, rec: dict[str, Any]) -> None:
        page_id = rec.get("notion_page_id")
        if not page_id and rec["status"] not in NOTION_MIRRORED_STATUSES:
            return                                  # a "skip" record is never created in Notion
        props = fair_to_notion_properties(rec)
        if page_id:
            client.update_page(page_id, props)
            return
        found = client.query_data_source(self.cfg["notion_fairs_data_source_id"], notion_key_filter(rec["key"]))
        if found:                                   # the page id was lost: adopt the existing page, never duplicate
            rec["notion_page_id"] = found[0]["id"]
            client.update_page(found[0]["id"], props)
        else:
            rec["notion_page_id"] = client.create_page(self.cfg["notion_fairs_data_source_id"], props)["id"]

    def _push_result_page(self, client: Any, rec: dict[str, Any]) -> None:
        props = result_to_notion_properties(rec, rec.get("notion_page_id"))
        page_id = rec.get("notion_result_page_id")
        ds_id = self.cfg["notion_results_data_source_id"]
        if page_id:
            client.update_page(page_id, props)
            return
        found = client.query_data_source(ds_id, notion_key_filter(rec["key"]))
        if found:
            rec["notion_result_page_id"] = found[0]["id"]
            client.update_page(found[0]["id"], props)
        else:
            rec["notion_result_page_id"] = client.create_page(ds_id, props)["id"]

    def _notion_push(self, data: dict[str, Any], rec: dict[str, Any], force: bool = False) -> dict[str, Any]:
        """Mirror one record (fair page, then result page). Never raises: a failure leaves notion_dirty set."""
        client = self.notion
        if client is None:
            return {"enabled": False}
        out: dict[str, Any] = {"enabled": True, "synced": True, "page_id": rec.get("notion_page_id"), "error": None}
        if not (force or rec.get("notion_dirty")):
            return out
        try:
            self._push_fair_page(client, rec)
            if rec.get("result") and rec.get("notion_page_id"):
                self._push_result_page(client, rec)
            rec["notion_dirty"] = False
        except Exception as exc:
            rec["notion_dirty"] = True
            out.update(synced=False, error=self._notion_error_text(exc), http_status=getattr(exc, "status", None))
        finally:
            self._save(data)                        # also persists page ids created before a later failure
        out["page_id"] = rec.get("notion_page_id")
        if rec.get("result"):
            out["result_page_id"] = rec.get("notion_result_page_id")
        return out

    # -- journal (history page) ---------------------------------------------- #
    def _journal_append(self, client: Any, day: str, text: str) -> None:
        state = read_json(self.paths.state, {"version": 1, "sources": {}})
        blocks = journal_blocks(day, text, with_heading=state.get("last_journal_date") != day)
        for start in range(0, len(blocks), 100):    # Notion accepts at most 100 children per request
            client.append_children(self.cfg["notion_journal_page_id"], blocks[start:start + 100])
        state["last_journal_date"] = day
        write_json(self.paths.state, state)

    def _journal_flush(self) -> dict[str, Any]:
        """Write queued entries in order, stopping at the first failure. Caller holds the lock."""
        client = self.notion
        if client is None:
            return {"enabled": False}
        entries = read_json(self.paths.journal_pending, {"entries": []}).get("entries", [])
        written, error = 0, None
        while entries:
            try:
                self._journal_append(client, entries[0]["date"], entries[0]["text"])
            except Exception as exc:
                error = self._notion_error_text(exc)
                break
            entries.pop(0)
            written += 1
            write_json(self.paths.journal_pending, {"entries": entries})
        return {"enabled": True, "written": written, "pending": len(entries), "error": error}

    def _journal_log(self, text: str, day: str | None = None) -> dict[str, Any]:
        """Queue an entry, then try to flush the queue (keeps order after an earlier failure). Never raises."""
        if self.notion is None:
            return {"enabled": False}
        entries = read_json(self.paths.journal_pending, {"entries": []}).get("entries", [])
        entries.append({"date": day or self.today().isoformat(), "text": text})
        write_json(self.paths.journal_pending, {"entries": entries})
        return self._journal_flush()

    def journal(self, text: str, day: str | None = None) -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            raise ValidationError("--text must not be empty")
        day = _parse_date(day, "--date") if day else None
        if self.notion is None:
            raise FairError("Notion is not configured (token file or data source ids missing): journal entry not written")
        with file_lock(self.paths.lock):
            journal = self._journal_log(text, day)
        return {"ok": True, "action": "journal", "journal": journal}

    @staticmethod
    def _journal_confirm_text(rec: dict[str, Any]) -> str:
        fee = rec.get("booth_fee_usd")
        booth = f"Booth {_money(fee)}." if fee is not None else "Taxa do booth não informada."
        return f"Confirmamos a {rec['name']} em {rec['town']}, {when_text(rec)}. {booth}"

    @staticmethod
    def _journal_discard_text(rec: dict[str, Any], reason: str | None) -> str:
        return (f"Descartamos a {rec['name']} ({rec['town']}, {when_text(rec)}): "
                f"{(reason or '').strip() or 'sem motivo informado'}.")

    @staticmethod
    def _journal_result_text(rec: dict[str, Any], summary: dict[str, Any]) -> str:
        revenue = (rec.get("result") or {}).get("revenue")
        parts = []
        if revenue is not None:
            parts.append(f"receita {_money(revenue)}")
        if summary["profit"] is not None:
            parts.append(f"lucro {_money(summary['profit'])}")
        if summary["profit_per_hour"] is not None:
            parts.append(f"{_money(summary['profit_per_hour'])} por hora de trabalho")
        return f"{rec['name']}: {', '.join(parts)}." if parts else f"{rec['name']}: resultado registrado."

    # -- sync ----------------------------------------------------------------- #
    def sync(self, everything: bool = False) -> dict[str, Any]:
        """Push every dirty record (or all mirrored records with --all) and flush the journal queue."""
        if self.notion is None:
            return {"ok": True, "notion": {"enabled": False}}
        with file_lock(self.paths.lock):
            data = self._load()
            pushed = failed = skipped = 0
            errors: list[str] = []
            aborted = None
            for rec in data["fairs"].values():
                wanted = rec.get("notion_dirty") or (everything and (
                    rec["status"] in NOTION_MIRRORED_STATUSES or rec.get("notion_page_id")))
                if not wanted:
                    skipped += 1
                    continue
                out = self._notion_push(data, rec, force=True)
                if out["synced"]:
                    pushed += 1
                    continue
                failed += 1
                errors.append(f"{rec['key']}: {out['error']}")
                if out.get("http_status") in (401, 403):  # systemic (bad token / page not shared): stop hammering the API
                    aborted = "stopped after an authorization error; remaining records stay dirty"
                    break
            journal = self._journal_flush()
        result = {"ok": True, "notion": {"enabled": True}, "records_synced": pushed, "records_failed": failed,
                  "records_skipped": skipped, "journal": journal}
        if errors:
            result["errors"] = errors[:5]
        if aborted:
            result["aborted"] = aborted
        return result

    # -- rescore ---------------------------------------------------------------- #
    def rescore(self) -> dict[str, Any]:
        """Re-apply the current scoring to every opportunity, maybe and skip record, then sync Notion.

        Never touches confirmed, done or discarded records, and never touches `announced_at`. A calendar or Notion
        failure on one record is reported and does not stop the others.
        """
        stamp = iso(self.now())
        transitions: dict[str, int] = {}
        changed: list[dict[str, Any]] = []
        to_reconcile: list[dict[str, Any]] = []
        examined = 0
        with file_lock(self.paths.lock):
            data = self._load()
            for rec in data["fairs"].values():
                if rec["status"] not in RESCORE_STATUSES:
                    continue
                examined += 1
                old = {"status": rec["status"], "score": rec.get("score"), "flags": list(rec.get("flags", [])),
                       "breakdown": rec.get("breakdown")}
                notion_before = json.dumps(fair_to_notion_properties(rec), sort_keys=True)
                self._apply_score(rec)
                rec["status"] = rec["decision"]
                content_changed = (rec["score"], rec["flags"], rec["breakdown"]) != (old["score"], old["flags"], old["breakdown"])
                status_changed = rec["status"] != old["status"]
                if content_changed or status_changed:
                    rec["updated_at"] = stamp
                    changed.append({"key": rec["key"], "old_status": old["status"], "new_status": rec["status"],
                                    "old_score": old["score"], "new_score": rec["score"]})
                if status_changed:
                    label = f"{old['status']}->{rec['status']}"
                    transitions[label] = transitions.get(label, 0) + 1
                if json.dumps(fair_to_notion_properties(rec), sort_keys=True) != notion_before:
                    rec["notion_dirty"] = True
                # an opportunity that stays one still shows its old score in the event description
                if status_changed or rec.get("calendar_stale") or (content_changed and rec["status"] == "opportunity"):
                    to_reconcile.append(rec)
            self._save(data)

            reconciled, calendar_failures = 0, []
            for rec in to_reconcile:
                try:
                    self._reconcile(rec)
                    rec.pop("calendar_stale", None)
                    reconciled += 1
                except Exception as exc:
                    rec["calendar_stale"] = True        # the next rescore retries this record
                    calendar_failures.append({"key": rec["key"], "error": http_error_text(exc)})
            if to_reconcile:
                self._save(data)

        out: dict[str, Any] = {
            "ok": True, "action": "rescored", "examined": examined, "changed": len(changed),
            "transitions": dict(sorted(transitions.items())), "changed_keys": changed,
            "calendar": {"reconciled": reconciled, "failed": len(calendar_failures)},
            "notion": self.sync(),
        }
        if calendar_failures:
            out["calendar"]["errors"] = calendar_failures[:5]
        return out

    # -- confirm / discard / result ------------------------------------------ #
    def confirm(self, key: str) -> dict[str, Any]:
        stamp = iso(self.now())
        with file_lock(self.paths.lock):
            data = self._load()
            rec = self._require(data, key)
            previous = rec["status"]
            if previous == "done":
                raise FairError("this fair already happened (status done); it cannot be confirmed again")
            rec.update(status="confirmed", confirmed_at=stamp, updated_at=stamp, notion_dirty=True)
            rec.pop("discard_reason", None)
            self._save(data)
            result = {"ok": True, "action": "confirmed", "previous_status": previous, "fair": compact(rec)}
            result["calendar"] = self._sync_calendar(rec, result)
            result["notion"] = self._notion_push(data, rec)
            if previous != "confirmed":
                result["journal"] = self._journal_log(self._journal_confirm_text(rec))
            return result

    def discard(self, key: str, reason: str | None = None, confirmed_ok: bool = False) -> dict[str, Any]:
        stamp = iso(self.now())
        with file_lock(self.paths.lock):
            data = self._load()
            rec = self._require(data, key)
            previous = rec["status"]
            if previous in CALENDAR_CONFIRMED_STATUSES and not confirmed_ok:
                what = "confirmed" if previous == "confirmed" else "already done (it is history)"
                raise FairError(f"this fair is {what}; discarding it needs --confirmed-ok, "
                                "and only when the owner explicitly asked for it in this conversation")
            rec.update(status="discarded", discarded_at=stamp, updated_at=stamp, discard_reason=reason,
                       notion_dirty=True)
            self._save(data)
            result = {"ok": True, "action": "discarded", "previous_status": previous, "fair": compact(rec)}
            try:
                result["calendar"] = self._reconcile(rec, delete_confirmed=previous in CALENDAR_CONFIRMED_STATUSES)
            except Exception as exc:
                result.update(ok=False, saved_in_registry=True,
                              error=f"registry updated but calendar cleanup failed: {http_error_text(exc)}")
                result["calendar"] = {"synced": False}
            result["notion"] = self._notion_push(data, rec)
            if previous != "discarded":
                result["journal"] = self._journal_log(self._journal_discard_text(rec, reason))
            return result

    def result(self, key: str, raw: Any) -> dict[str, Any]:
        """Record how a fair went: stored on the record, status -> done, mirrored to Notion, logged in the journal."""
        new_values = validate_result(raw)
        stamp = iso(self.now())
        with file_lock(self.paths.lock):
            data = self._load()
            rec = self._require(data, key)
            previous = rec["status"]
            if previous not in CALENDAR_CONFIRMED_STATUSES:
                raise FairError(f"results can only be recorded for a confirmed fair, and this one is {previous}; "
                                "confirm it first if the owner really took part")
            if rec["start_date"] > self.today().isoformat():
                raise FairError(f"this fair starts on {rec['start_date']}, which is still in the future: "
                                "results can only be recorded once it has started")
            merged = {**(rec.get("result") or {}), **new_values}
            if not any(merged.get(f) is not None for f in RESULT_NUMERIC_FIELDS):   # before the booth default
                raise ValidationError("at least one numeric field is required "
                                      f"({', '.join(RESULT_NUMERIC_FIELDS)})")
            if merged.get("booth_cost") is None and rec.get("booth_fee_usd") is not None:
                merged["booth_cost"] = rec["booth_fee_usd"]
            rec.update(result=merged, status="done", result_at=stamp, updated_at=stamp, notion_dirty=True)
            rec.setdefault("done_at", stamp)
            self._save(data)
            summary = result_summary(merged)
            out = {"ok": True, "action": "result_recorded", "previous_status": previous, "fair": compact(rec),
                   "result": merged, "summary": summary}
            out["calendar"] = self._sync_calendar(rec, out)
            out["notion"] = self._notion_push(data, rec)
            out["journal"] = self._journal_log(self._journal_result_text(rec, summary))
            return out

    def mark_asked(self, key: str) -> dict[str, Any]:
        """Record that the owner was asked for the results of this fair (limits follow-ups to RESULT_ASK_MAX)."""
        stamp = iso(self.now())
        with file_lock(self.paths.lock):
            data = self._load()
            rec = self._require(data, key)
            rec["result_ask_count"] = int(rec.get("result_ask_count") or 0) + 1
            rec["result_asked_at"] = stamp
            self._save(data)
        return {"ok": True, "key": key, "result_ask_count": rec["result_ask_count"], "result_asked_at": stamp}

    # -- reads -------------------------------------------------------------- #
    def get(self, key: str) -> dict[str, Any]:
        return {"ok": True, "fair": self._require(self._load(), key)}

    def _search(self, data: dict[str, Any], text: str) -> list[dict[str, Any]]:
        query = norm_text(text)
        q_tokens = set(query.split())
        found = []
        for rec in data["fairs"].values():
            haystack = norm_text(" ".join([rec["name"], rec["town"], *rec.get("aliases", [])]))
            coverage = len(q_tokens & set(haystack.split())) / len(q_tokens) if q_tokens else 0.0
            ratio = difflib.SequenceMatcher(None, query, norm_text(rec["name"])).ratio()
            contained = 1.0 if query and query in haystack else 0.0
            match = max(ratio, coverage * 0.95, contained)
            if match >= 0.5:
                found.append({**compact(rec), "match": round(match, 2)})
        found.sort(key=lambda r: (-r["match"], r["start_date"]))
        return found

    def find(self, text: str) -> dict[str, Any]:
        matches = self._search(self._load(), text)[:10]
        return {"ok": True, "query": text, "count": len(matches), "ambiguous": len(matches) > 1, "matches": matches}

    def town(self, name: str) -> dict[str, Any]:
        entry = self.towns.get(norm_town(name))
        if entry is None:
            return {"ok": True, "town": name, "in_list": False,
                    "message": "not in the radar list (neither within the 30-mile core zone nor a North Shore or "
                               "South Shore coastal town, or unknown)"}
        coast = entry.get("zone") == ZONE_COAST
        return {"ok": True, "town": entry["town"], "in_list": True, "income_tier": entry["income_tier"],
                "approx_miles": entry["approx_miles_from_framingham"],
                "zone": ZONE_COAST if coast else ZONE_CORE, "region": entry.get("region") if coast else None,
                "within_radius": coast or entry["approx_miles_from_framingham"] <= RADIUS_MILES}

    def list(self, statuses: list[str] | None = None, date_from: str | None = None, date_to: str | None = None,
             deadlines_within: int | None = None, sort: str = "date") -> dict[str, Any]:
        if sort not in LIST_SORTS:
            raise FairError(f"unknown sort: {sort}. Use {', '.join(LIST_SORTS)}")
        data = self._load()
        wanted = set(STATUSES) if statuses == ["all"] else set(statuses or DEFAULT_LIST_STATUSES)
        bad = wanted - set(STATUSES)
        if bad:
            raise FairError(f"unknown status: {', '.join(sorted(bad))}. Use {', '.join(STATUSES)} or all")
        lo = _parse_date(date_from, "--from") if date_from else None
        hi = _parse_date(date_to, "--to") if date_to else None
        today = self.today()
        rows = []
        for rec in data["fairs"].values():
            if rec["status"] not in wanted:
                continue
            last_day = rec.get("end_date") or rec["start_date"]
            if lo and last_day < lo:
                continue
            if hi and rec["start_date"] > hi:
                continue
            if deadlines_within is not None:
                deadline = rec.get("application_deadline")
                limit = (today + dt.timedelta(days=deadlines_within)).isoformat()
                if not deadline or deadline < today.isoformat() or deadline > limit:
                    continue
            row = compact(rec)
            if rec.get("result"):
                row["summary"] = result_summary(rec["result"])
            rows.append(row)
        if sort == "profit_per_hour":   # best first; fairs without a computable value go last
            rows.sort(key=lambda r: (r.get("summary", {}).get("profit_per_hour") is None,
                                     -(r.get("summary", {}).get("profit_per_hour") or 0), r["start_date"]))
        elif deadlines_within is not None:
            rows.sort(key=lambda r: (r["application_deadline"], r["start_date"]))
        else:
            rows.sort(key=lambda r: (r["start_date"], r["name"]))
        return {"ok": True, "count": len(rows), "fairs": rows}

    # -- ack ----------------------------------------------------------------- #
    def ack(self, discovery: bool = False) -> dict[str, Any]:
        stamp = iso(self.now())
        with file_lock(self.paths.lock):
            pending = read_json(self.paths.pending, {"sources": {}})
            sources = pending.get("sources", {})
            delivered = pending.get("delivered")
            cleared = list(sources) if delivered is None else [s for s in delivered if s in sources]
            for source_id in cleared:
                sources.pop(source_id, None)
            # a second ack must not wipe deferred sources; the town slice of an undelivered discovery stays
            slice_size = len(pending.get("discovery_towns") or [])
            new_pending: dict[str, Any] = {"sources": sources, "delivered": []}
            if not discovery and pending.get("discovery_towns"):
                new_pending["discovery_towns"] = pending["discovery_towns"]
            write_json(self.paths.pending, new_pending)

            state = read_json(self.paths.state, {"version": 1, "sources": {}})
            if discovery:
                state["last_discovery_at"] = stamp
                total = len(self.towns)
                cursor = int(state.get(STATE_ROTATION_CURSOR) or 0)
                state[STATE_ROTATION_CURSOR] = (cursor + slice_size) % total if total else 0
                write_json(self.paths.state, state)

            data = self._load()
            marked = 0
            for rec in data["fairs"].values():
                if rec["status"] in ("opportunity", "maybe") and rec.get("announced_at") is None:
                    rec["announced_at"] = stamp
                    marked += 1
            if marked:
                self._save(data)
        return {"ok": True, "cleared_sources": cleared, "still_pending": sorted(sources),
                "discovery_marked": discovery, "fairs_marked_announced": marked,
                "town_rotation_cursor": state.get(STATE_ROTATION_CURSOR, 0),
                "discovery_towns_delivered": slice_size if discovery else 0}

    # -- doctor -------------------------------------------------------------- #
    def doctor(self) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []

        def check(name: str, fn: Callable[[], str]) -> bool:
            try:
                checks.append({"check": name, "ok": True, "detail": fn()})
                return True
            except Exception as exc:
                checks.append({"check": name, "ok": False, "detail": http_error_text(exc) if hasattr(exc, "resp")
                               else str(exc)})
                return False

        def state_dir() -> str:
            self.paths.root.mkdir(parents=True, exist_ok=True)
            probe = self.paths.root / ".doctor-probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            return f"writable: {self.paths.root}"

        def towns() -> str:
            return f"{len(self.towns)} towns loaded"

        def sources() -> str:
            base = Path(self.cfg["skill_dir"]) / "references"
            srcs = read_json(base / "sources.json", None)
            queries = read_json(base / "search-queries.json", None)
            if not srcs or not queries:
                raise FairError(f"sources.json or search-queries.json missing/empty in {base}")
            return f"{len(srcs)} sources, {len(queries['queries'])} queries"

        def key_file() -> str:
            path = self.cfg.get("service_account_file")
            if not path or not os.path.isfile(path):
                raise FairError(f"key file not found: {path}")
            info = read_json(path, {})
            if info.get("type") != "service_account" or not info.get("client_email"):
                raise FairError("key file is not a service account JSON")
            return f"service account {info['client_email']} (share both calendars with it, 'Make changes to events')"

        def calendar_ids() -> str:
            missing = [f for f in ("calendar_opportunities_id", "calendar_confirmed_id") if not self.cfg.get(f)]
            if missing:
                raise FairError(f"missing in config: {', '.join(missing)}")
            return "both calendar ids set"

        def notion_check(fn: Callable[[], str]) -> Callable[[], str]:
            def run() -> str:
                try:
                    return fn()
                except NotionError as exc:
                    raise FairError(self._notion_error_text(exc)) from None
            return run

        def notion_token() -> str:
            path = self.cfg.get("notion_token_file")
            if not path or not os.path.isfile(path):
                raise FairError(f"Notion token file not found: {path} (one line with the integration token)")
            if not NotionClient.from_config(self.cfg):
                raise FairError(f"Notion token file is empty: {path}")
            return f"token file present: {path}"

        def notion_ids() -> str:
            missing = [k for k in NOTION_ID_KEYS if not self.cfg.get(k)]
            if missing:
                raise FairError(f"missing in config: {', '.join(missing)}")
            return "fairs, results and journal ids set"

        def data_source(field: str) -> str:
            info = self.notion.get_data_source(self.cfg[field])
            title = (info.get("title") or [{}])[0].get("plain_text") or info.get("id", "?")
            return f"readable: {title}"

        def journal_page() -> str:
            return f"readable: {self.notion.get_page(self.cfg['notion_journal_page_id']).get('id', '?')}"

        check("config", lambda: f"loaded {config_path()} (timezone {self.cfg['timezone']})")
        check("state_dir", state_dir)
        check("towns", towns)
        check("sources", sources)
        key_ok = check("service_account_file", key_file)
        ids_ok = check("calendar_ids", calendar_ids)
        if key_ok and ids_ok:
            for label, field in (("opportunities", "calendar_opportunities_id"), ("confirmed", "calendar_confirmed_id")):
                check(f"calendar_read_{label}",
                      lambda f=field: f"readable: {self.calendar.get_calendar(self.cfg[f]).get('summary', '?')}")

            def write_probe() -> str:
                opp = self.cfg["calendar_opportunities_id"]
                day = self.today() + dt.timedelta(days=1)
                body = {"summary": "stuscle-fairs doctor (temporary, safe to delete)",
                        "start": {"date": day.isoformat()}, "end": {"date": (day + dt.timedelta(days=1)).isoformat()},
                        "extendedProperties": {"private": {"fairKey": "doctor-probe", "kind": "doctor"}}}
                event = self.calendar.insert(opp, body)
                self.calendar.delete(opp, event["id"])
                return "inserted and deleted a throwaway event in the opportunities calendar"

            check("calendar_write_opportunities", write_probe)

        token_ok = check("notion_token_file", notion_token)
        notion_ids_ok = check("notion_ids", notion_ids)
        if token_ok and notion_ids_ok and self.notion is not None:
            check("notion_data_source_fairs", notion_check(lambda: data_source("notion_fairs_data_source_id")))
            check("notion_data_source_results", notion_check(lambda: data_source("notion_results_data_source_id")))
            check("notion_journal_page", notion_check(journal_page))
        return {"ok": all(c["ok"] for c in checks), "checks": checks}


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="stuscle_fairs.py", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    up = sub.add_parser("upsert", help="validate, score, store and calendar one fair")
    group = up.add_mutually_exclusive_group(required=True)
    group.add_argument("--json", help="fair as a JSON object")
    group.add_argument("--file", help="path to a JSON file with the fair, or - for stdin (safe with apostrophes)")

    batch = sub.add_parser("upsert-batch", help="upsert every fair of a JSON array file; one bad fair never stops the rest")
    batch.add_argument("--file", required=True, help="path to a JSON file holding an array of fairs")

    sub.add_parser("confirm", help="mark a fair as confirmed").add_argument("key")

    dis = sub.add_parser("discard", help="never suggest this fair again")
    dis.add_argument("key")
    dis.add_argument("--reason")
    dis.add_argument("--confirmed-ok", action="store_true", help="allow discarding a confirmed fair")

    res = sub.add_parser("result", help="record how a confirmed fair went (JSON on stdin) and mark it done")
    res.add_argument("key")
    res_group = res.add_mutually_exclusive_group(required=True)
    res_group.add_argument("--json", help="result as a JSON object")
    res_group.add_argument("--file", help="path to a JSON file with the result, or - for stdin")

    sub.add_parser("mark-asked", help="record that the owner was asked for this fair's results").add_argument("key")

    jr = sub.add_parser("journal", help="append an entry to the Notion journal page")
    jr.add_argument("--text", required=True)
    jr.add_argument("--date", help="YYYY-MM-DD (default: today)")

    sy = sub.add_parser("sync", help="push dirty records and queued journal entries to Notion")
    sy.add_argument("--all", action="store_true", help="push every mirrored record, not only the dirty ones")

    sub.add_parser("rescore", help="re-apply the current scoring to every opportunity, maybe and skip record, "
                                   "fix the calendar, then sync Notion")

    sub.add_parser("get").add_argument("key")
    sub.add_parser("find").add_argument("text")
    sub.add_parser("town", help="is this town in the radar list? tier and approximate miles").add_argument("name")

    ls = sub.add_parser("list")
    ls.add_argument("--status", help="comma separated: opportunity,maybe,skip,confirmed,done,discarded or all")
    ls.add_argument("--from", dest="date_from", help="YYYY-MM-DD")
    ls.add_argument("--to", dest="date_to", help="YYYY-MM-DD")
    ls.add_argument("--deadlines-within", type=int, metavar="DAYS",
                    help="only fairs whose application deadline falls in the next DAYS days, by deadline")
    ls.add_argument("--sort", choices=LIST_SORTS, default="date",
                    help="date (default) or profit_per_hour (best first, from the stored results)")

    ack = sub.add_parser("ack", help="clear delivered pending content after a run")
    ack.add_argument("--discovery", action="store_true",
                    help="also record that the weekly search ran and advance the town rotation by the delivered slice")

    sub.add_parser("doctor", help="check config, state dir, sources and calendar access")
    return parser


def read_json_arg(args: argparse.Namespace, what: str) -> Any:
    try:
        if args.json:
            text = args.json
        elif args.file == "-":
            text = sys.stdin.read()
        else:
            text = Path(args.file).read_text(encoding="utf-8")
        return json.loads(text)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"could not read {what} JSON: {exc}") from None


def upsert_batch(service: FairService, fairs: Any) -> dict[str, Any]:
    """Upsert each fair independently, so the agent never needs a shell loop (blocked in cron)."""
    if not isinstance(fairs, list):
        raise ValidationError("upsert-batch expects a JSON array of fairs")
    results: list[dict[str, Any]] = []
    for index, raw in enumerate(fairs):
        name = raw.get("name") if isinstance(raw, dict) else None
        try:
            out = service.upsert(raw)
        except FairError as exc:
            out = {"ok": False, "error": str(exc)}
        except Exception as exc:
            out = {"ok": False, "error": http_error_text(exc)}
        results.append({"index": index, "name": name, **out})
    failed = [r for r in results if not r.get("ok", True)]
    return {"ok": not failed, "count": len(results), "failed": len(failed), "results": results}


def run_command(args: argparse.Namespace, service: FairService) -> dict[str, Any]:
    if args.cmd == "upsert":
        return service.upsert(read_json_arg(args, "fair"))
    if args.cmd == "upsert-batch":
        args.json = None
        return upsert_batch(service, read_json_arg(args, "fairs"))
    if args.cmd == "result":
        return service.result(args.key, read_json_arg(args, "result"))
    if args.cmd == "mark-asked":
        return service.mark_asked(args.key)
    if args.cmd == "journal":
        return service.journal(args.text, args.date)
    if args.cmd == "sync":
        return service.sync(args.all)
    if args.cmd == "rescore":
        return service.rescore()
    if args.cmd == "confirm":
        return service.confirm(args.key)
    if args.cmd == "discard":
        return service.discard(args.key, args.reason, args.confirmed_ok)
    if args.cmd == "get":
        return service.get(args.key)
    if args.cmd == "find":
        return service.find(args.text)
    if args.cmd == "town":
        return service.town(args.name)
    if args.cmd == "list":
        statuses = [s.strip() for s in args.status.split(",") if s.strip()] if args.status else None
        return service.list(statuses, args.date_from, args.date_to, args.deadlines_within, args.sort)
    if args.cmd == "ack":
        return service.ack(args.discovery)
    if args.cmd == "doctor":
        return service.doctor()
    raise FairError(f"unknown command {args.cmd}")


def main(argv: list[str] | None = None) -> int:
    with contextlib.suppress(Exception):
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    args = build_parser().parse_args(argv)
    try:
        result = run_command(args, FairService(load_config()))
    except FairError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    except Exception as exc:  # last resort: still one JSON line, never a traceback with paths or tokens
        print(json.dumps({"ok": False, "error": http_error_text(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
