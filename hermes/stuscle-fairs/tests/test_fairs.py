"""Offline tests for the craft-fair radar (stdlib unittest, no network, no Google libraries).

Run from the repo root:  python -m unittest discover -s hermes/stuscle-fairs/tests
"""
import datetime as dt
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import stuscle_fairs as core  # noqa: E402

_spec = importlib.util.spec_from_file_location("fairs_precheck", ROOT / "scripts" / "fairs-precheck.py")
pre = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pre)

TOWNS = core.load_towns(ROOT)
TZ = dt.timezone(dt.timedelta(hours=-4))
NOW = dt.datetime(2026, 10, 9, 10, 0, tzinfo=TZ)


# --------------------------------------------------------------------------- #
# Test doubles
# --------------------------------------------------------------------------- #
class FakeCalendar:
    """In-memory stand-in for core.GoogleCalendar."""

    def __init__(self):
        self.cals = {}
        self.counter = 0
        self.fail = False

    def _cal(self, cal_id):
        return self.cals.setdefault(cal_id, {})

    def _check(self):
        if self.fail:
            raise RuntimeError("calendar exploded")

    def get_calendar(self, cal_id):
        return {"summary": cal_id}

    def find(self, cal_id, key):
        self._check()
        return [e for e in self._cal(cal_id).values()
                if e.get("extendedProperties", {}).get("private", {}).get("fairKey") == key]

    def insert(self, cal_id, body):
        self._check()
        self.counter += 1
        event = {**json.loads(json.dumps(body)), "id": f"ev{self.counter}"}
        self._cal(cal_id)[event["id"]] = event
        return event

    def patch(self, cal_id, event_id, body):
        self._check()
        event = self._cal(cal_id)[event_id]

        def merge(dst, src):
            for k, v in src.items():
                if v is None:
                    dst.pop(k, None)
                elif isinstance(v, dict) and isinstance(dst.get(k), dict):
                    merge(dst[k], v)
                else:
                    dst[k] = json.loads(json.dumps(v))
        merge(event, body)
        return event

    def delete(self, cal_id, event_id):
        self._check()
        del self._cal(cal_id)[event_id]

    def move(self, cal_id, event_id, destination):
        self._check()
        event = self._cal(cal_id).pop(event_id)
        self._cal(destination)[event_id] = event
        return event

    def events(self, cal_id):
        return list(self._cal(cal_id).values())


def make_service(tmp, calendar=None, notion=None, **cfg_over):
    cfg = {**core.CONFIG_DEFAULTS, "state_dir": str(tmp), "skill_dir": str(ROOT),
           "calendar_opportunities_id": "opp", "calendar_confirmed_id": "conf",
           "notion_token_file": str(tmp / "no-notion-token"), **cfg_over}
    return core.FairService(cfg, towns=TOWNS, calendar=calendar or FakeCalendar(), now_fn=lambda: NOW, notion=notion)


def fair(**overrides):
    base = {"name": "Weston Artisan Craft Fair", "town": "Weston", "start_date": "2026-11-14",
            "event_type": "craft", "recurrence": "annual", "booth_fee_usd": 50, "juried": True}
    base.update(overrides)
    return base


def page(*lines, filler=12):
    """Fake listing HTML with enough text to pass the minimum-length guard."""
    pad = "".join(f"<li>Navigation filler entry number {i} for the site menu</li>" for i in range(filler))
    return f"<html><body><ul>{pad}</ul>" + "".join(f"<p>{line}</p>" for line in lines) + "</body></html>"


class TmpDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="fairs-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)


# --------------------------------------------------------------------------- #
# HTML -> text and the volatility filter
# --------------------------------------------------------------------------- #
class HtmlToTextTest(unittest.TestCase):
    def test_drops_script_style_noscript_svg_and_comments(self):
        raw = ("<html><head><style>.a{color:red}</style><script>var x='<p>nope</p>';</script></head><body>"
               "<!-- hidden comment --><noscript>enable js please</noscript>"
               "<svg><text>icon label</text></svg><p>Real fair listing</p></body></html>")
        self.assertEqual(pre.html_to_text(raw), "Real fair listing")

    def test_block_tags_become_lines_and_inline_tags_do_not(self):
        raw = "<div>First <b>bold</b> part</div><ul><li>Item one</li><li>Item two</li></ul>Line<br>after break"
        self.assertEqual(pre.html_to_text(raw).splitlines(),
                         ["First bold part", "Item one", "Item two", "Line", "after break"])

    def test_unescape_whitespace_and_short_lines(self):
        raw = "<p>Arts &amp; Crafts \n\n  Fair   2026</p><p>ab</p><p>&nbsp;</p><p>OK!</p>"
        self.assertEqual(pre.html_to_text(raw).splitlines(), ["Arts & Crafts Fair 2026", "OK!"])


class VolatileFilterTest(unittest.TestCase):
    def test_patch_title_with_todays_date_disappears_whatever_the_day(self):
        monday = "Natick Events Calendar for Monday, October 12, 2026 | Patch"
        friday = "Natick Events Calendar for Friday, October 9, 2026 | Patch"
        self.assertEqual(pre.strip_volatile(monday), "")
        self.assertEqual(pre.strip_volatile(friday), "")

    def test_pumpkin_patch_event_is_not_mistaken_for_a_patch_title(self):
        line = "Pumpkin Patch Craft Fair on Sat, Oct 17"
        self.assertEqual(pre.strip_volatile(line), line)

    def test_relative_countdowns_are_removed_but_absolute_dates_stay(self):
        before = "Wellesley Marketplace 2026 Sat, Nov 21, 2026 In 7 days"
        after = "Wellesley Marketplace 2026 Sat, Nov 21, 2026 In 6 days"
        self.assertEqual(pre.strip_volatile(before), "Wellesley Marketplace 2026 Sat, Nov 21, 2026")
        self.assertEqual(pre.strip_volatile(before), pre.strip_volatile(after))

    def test_relative_words(self):
        for noisy in ("Newton Harvest Fair Happening now", "Newton Harvest Fair Today", "Newton Harvest Fair Tomorrow",
                      "Newton Harvest Fair This weekend", "Newton Harvest Fair posted 3 hours ago",
                      "Newton Harvest Fair Today, October 9"):
            self.assertEqual(pre.strip_volatile(noisy), "Newton Harvest Fair", noisy)

    def test_updated_and_copyright_and_counters(self):
        self.assertEqual(pre.strip_volatile("Updated 3 days ago"), "")
        self.assertEqual(pre.strip_volatile("Status: Updated 5/2026"), "")
        self.assertEqual(pre.strip_volatile("© 2026 Meet Me at the Fair"), "Meet Me at the Fair")
        self.assertEqual(pre.strip_volatile("Copyright 2026 FestivalNet. All rights reserved"),
                         "FestivalNet. All rights reserved")
        self.assertEqual(pre.strip_volatile("Holly Fair 1,204 views 12 likes"), "Holly Fair")
        self.assertEqual(pre.strip_volatile("Holly Fair views: 85"), "Holly Fair")

    def test_event_dates_and_names_are_untouched(self):
        for line in ("Framingham Rotary Holiday Craft Fair", "Sat, Dec 12, 2026 Keefe Regional Technical School",
                     "April 22 - 25, 2027", "# of Exhibitors 118 Juried: no"):
            self.assertEqual(pre.strip_volatile(line), line)

    def test_whole_pipeline_is_stable_across_days(self):
        day1 = page("Wellesley Marketplace 2026 In 7 days", "Updated 1 hour ago", "Patch events for Friday, October 9, 2026 | Patch")
        day2 = page("Wellesley Marketplace 2026 In 6 days", "Updated 5 hours ago", "Patch events for Saturday, October 10, 2026 | Patch")
        self.assertEqual(pre.normalize_html(day1), pre.normalize_html(day2))


# --------------------------------------------------------------------------- #
# Diff, caps, pending, discovery
# --------------------------------------------------------------------------- #
class DiffAndCapsTest(unittest.TestCase):
    def test_added_lines_only(self):
        old = "alpha\nbeta\ngamma"
        new = "alpha\nbeta changed\ngamma\ndelta"
        self.assertEqual(pre.added_lines(old, new), ["beta changed", "delta"])

    def test_removed_and_moved_lines_are_not_reported(self):
        old = "alpha\nbeta\ngamma\ndelta"
        self.assertEqual(pre.added_lines(old, "delta\nalpha\ngamma"), [])

    def test_cap_lines_reports_dropped_chars(self):
        kept, dropped = pre.cap_lines(["a" * 40, "b" * 40, "c" * 40], 100)
        self.assertEqual(kept, ["a" * 40, "b" * 40])
        self.assertEqual(dropped, 41)

    def test_single_huge_line_keeps_its_head(self):
        kept, dropped = pre.cap_lines(["x" * 500], 100)
        self.assertEqual((len(kept[0]), dropped), (100, 400))

    def test_per_source_cap_is_6000(self):
        lines = [f"Fair number {i:04d} " + "x" * 80 for i in range(200)]
        entry = pre.merge_pending(None, lines, "t0", bootstrap=True)
        self.assertLessEqual(sum(len(line) + 1 for line in entry["lines"]), pre.PER_SOURCE_CAP)
        self.assertGreater(entry["truncated_chars"], 0)

    def test_merge_pending_dedupes_and_keeps_earliest(self):
        entry = pre.merge_pending(None, ["one one", "two two"], "t0", bootstrap=False)
        entry = pre.merge_pending(entry, ["two two", "three three"], "t1", bootstrap=False)
        self.assertEqual(entry["lines"], ["one one", "two two", "three three"])
        self.assertEqual(entry["first_seen"], "t0")


class DiscoveryDueTest(unittest.TestCase):
    def test_due_when_missing_or_old_not_when_recent(self):
        self.assertTrue(pre.discovery_due({}, NOW, 6.5))
        self.assertTrue(pre.discovery_due({"last_discovery_at": core.iso(NOW - dt.timedelta(days=7))}, NOW, 6.5))
        self.assertFalse(pre.discovery_due({"last_discovery_at": core.iso(NOW - dt.timedelta(days=6))}, NOW, 6.5))
        self.assertTrue(pre.discovery_due({"last_discovery_at": "garbage"}, NOW, 6.5))


# --------------------------------------------------------------------------- #
# Precheck end to end (fake fetch)
# --------------------------------------------------------------------------- #
class PrecheckRunTest(TmpDirCase):
    def setUp(self):
        super().setUp()
        self.cfg = {**core.CONFIG_DEFAULTS, "state_dir": str(self.tmp), "skill_dir": str(ROOT)}
        self.sources = [{"id": "s1", "name": "Source One", "url": "https://one.example/"},
                        {"id": "s2", "name": "Source Two", "url": "https://two.example/"}]
        self.queries = ["query alpha", "query beta"]
        self.pages = {}
        self.service = core.FairService(self.cfg, towns=TOWNS, calendar=FakeCalendar(), now_fn=lambda: NOW, notion=None)

    def fetch(self, url):
        value = self.pages[url]
        if isinstance(value, Exception):
            raise value
        return value

    def run_once(self, now=NOW, dry_run=False, sources=None):
        return pre.run_precheck(self.cfg, sources or self.sources, self.queries, fetch=self.fetch, now=now,
                                dry_run=dry_run, sleep=lambda s: None)[0]

    def settle(self):
        """What a successful agent run does at its end."""
        self.service.ack(discovery=True)

    def test_bootstrap_reports_whole_page_and_ends_with_wake_line(self):
        self.pages = {"https://one.example/": page("Newton Harvest Fair Oct 17-18, 2026"),
                      "https://two.example/": page("Wellesley Marketplace Nov 21, 2026")}
        out = self.run_once()
        self.assertTrue(out.rstrip().endswith('{"wakeAgent": true}'))
        self.assertIn("### Source One (s1) — https://one.example/", out)
        self.assertIn("Newton Harvest Fair Oct 17-18, 2026", out)
        self.assertIn("Weekly search: YES", out)
        self.assertIn("query alpha", out)
        self.assertTrue((self.tmp / "pages" / "s1.txt").exists())

    def test_nothing_new_means_silence(self):
        self.pages = {"https://one.example/": page("Newton Harvest Fair In 7 days"),
                      "https://two.example/": page("Wellesley Marketplace In 7 days")}
        self.run_once()
        self.settle()
        self.pages = {"https://one.example/": page("Newton Harvest Fair In 6 days"),
                      "https://two.example/": page("Wellesley Marketplace In 6 days")}
        self.assertEqual(self.run_once(), '{"wakeAgent": false}')

    def test_only_added_lines_are_reported_afterwards(self):
        self.pages = {"https://one.example/": page("Old fair listing"), "https://two.example/": page("Another old listing")}
        self.run_once()
        self.settle()
        self.pages["https://one.example/"] = page("Old fair listing", "Brand new Sherborn Holiday Market")
        out = self.run_once()
        self.assertIn("Brand new Sherborn Holiday Market", out)
        self.assertNotIn("Old fair listing", out)
        self.assertNotIn("Source Two", out)
        self.assertIn("Weekly search: NO", out)

    def test_pending_survives_a_crash_and_ack_clears_it(self):
        self.pages = {"https://one.example/": page("First listing"), "https://two.example/": page("Second listing")}
        self.run_once()                       # agent "crashes": no ack
        again = self.run_once()
        self.assertIn("First listing", again)  # re-delivered although the page itself did not change
        self.service.ack()
        self.assertEqual(json.loads((self.tmp / "pending.json").read_text())["sources"], {})
        self.service.ack(discovery=True)
        self.assertEqual(self.run_once(), '{"wakeAgent": false}')

    def test_failed_fetch_keeps_stored_page_and_tracks_failures(self):
        self.pages = {"https://one.example/": page("Stable listing"), "https://two.example/": page("Other listing")}
        self.run_once()
        self.settle()
        stored = (self.tmp / "pages" / "s1.txt").read_text()
        self.pages["https://one.example/"] = RuntimeError("connection reset")
        self.assertEqual(self.run_once(), '{"wakeAgent": false}')
        self.assertEqual((self.tmp / "pages" / "s1.txt").read_text(), stored)
        self.assertEqual(json.loads((self.tmp / "state.json").read_text())["sources"]["s1"]["consecutive_failures"], 1)

    def test_third_consecutive_failure_wakes_the_agent_once(self):
        self.pages = {"https://one.example/": page("Stable listing"), "https://two.example/": page("Other listing")}
        self.run_once()
        self.settle()
        self.pages["https://one.example/"] = RuntimeError("HTTP 503")
        self.assertEqual(self.run_once(), '{"wakeAgent": false}')
        self.assertEqual(self.run_once(), '{"wakeAgent": false}')
        third = self.run_once()
        self.assertIn("## Failing sources", third)
        self.assertIn("Source One (s1): 3 falhas seguidas", third)
        self.assertTrue(third.rstrip().endswith('{"wakeAgent": true}'))
        self.assertEqual(self.run_once(), '{"wakeAgent": false}')  # already known, no repeated wake-ups

    def test_error_or_challenge_page_counts_as_failure(self):
        self.pages = {"https://one.example/": "<html><body><p>Checking your browser</p></body></html>",
                      "https://two.example/": page("Other listing")}
        self.run_once()
        state = json.loads((self.tmp / "state.json").read_text())
        self.assertEqual(state["sources"]["s1"]["consecutive_failures"], 1)
        self.assertFalse((self.tmp / "pages" / "s1.txt").exists())

    def test_total_report_cap_defers_whole_sources_and_nothing_is_lost(self):
        sources = [{"id": f"s{i}", "name": f"Source {i}", "url": f"https://h{i}.example/"} for i in range(10)]
        self.pages = {s["url"]: page(*[f"S{i} listing line {n:03d} " + "y" * 90 for n in range(70)])
                      for i, s in enumerate(sources)}
        out = self.run_once(sources=sources)
        self.assertLessEqual(len(out), pre.TOTAL_CAP)
        self.assertIn("[truncated", out)
        delivered = json.loads((self.tmp / "pending.json").read_text())["delivered"]
        self.assertLess(len(delivered), 10)
        self.service.ack()
        left = json.loads((self.tmp / "pending.json").read_text())["sources"]
        self.assertEqual(len(left) + len(delivered), 10)
        self.assertTrue(set(left).isdisjoint(delivered))
        self.assertIn("listing line", self.run_once(sources=sources))  # deferred sources come back next run

    def test_dry_run_writes_nothing(self):
        self.pages = {"https://one.example/": page("Listing"), "https://two.example/": page("Listing two")}
        out = self.run_once(dry_run=True)
        self.assertIn('"wakeAgent": true', out)
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_reset_wipes_fetch_state_but_never_the_registry(self):
        self.pages = {"https://one.example/": page("Listing"), "https://two.example/": page("Listing two")}
        self.run_once()
        self.service.upsert(fair())
        pre.reset_state(self.cfg)
        names = {p.name for p in self.tmp.iterdir()}
        self.assertNotIn("state.json", names)
        self.assertNotIn("pages", names)
        self.assertIn("fairs.json", names)

    def test_wake_false_is_the_only_output_when_idle(self):
        self.pages = {"https://one.example/": page("Same"), "https://two.example/": page("Same two")}
        self.run_once()
        self.settle()
        out = self.run_once()
        self.assertEqual(out.strip().splitlines(), ['{"wakeAgent": false}'])


# --------------------------------------------------------------------------- #
# Validation and scoring
# --------------------------------------------------------------------------- #
class ValidationTest(unittest.TestCase):
    today = dt.date(2026, 10, 9)

    def check(self, **overrides):
        return core.validate_fair(fair(**overrides), self.today)

    def test_rejects_past_events(self):
        with self.assertRaisesRegex(core.ValidationError, "past"):
            self.check(start_date="2026-10-08")
        with self.assertRaisesRegex(core.ValidationError, "past"):
            self.check(start_date="2026-10-01", end_date="2026-10-05")

    def test_today_is_still_valid(self):
        self.assertEqual(self.check(start_date="2026-10-09")["start_date"], "2026-10-09")

    def test_strictness(self):
        for bad in ({"start_date": "11/14/2026"}, {"start_date": "2026-02-30"}, {"event_type": "bazaar"},
                    {"recurrence": "yearly"}, {"booth_fee_usd": "$50"}, {"booth_fee_usd": -5}, {"vendor_count": 12.5},
                    {"juried": "yes"}, {"start_time": "9am"}, {"event_url": "ftp://x"}, {"end_date": "2026-11-01"},
                    {"surprise": 1}, {"name": "  "}):
            with self.assertRaises(core.ValidationError, msg=str(bad)):
                self.check(**bad)

    def test_required_fields(self):
        for field in ("name", "town", "start_date"):
            raw = fair()
            del raw[field]
            with self.assertRaises(core.ValidationError):
                core.validate_fair(raw, self.today)

    def test_end_time_must_follow_start_time_on_single_day(self):
        with self.assertRaises(core.ValidationError):
            self.check(start_time="14:00", end_time="10:00")


class ScoringTest(unittest.TestCase):
    def score(self, **overrides):
        base = {"name": "X", "town": "Weston", "start_date": "2026-11-14", "event_type": "craft",
                "recurrence": "annual", "booth_fee_usd": None, "vendor_count": None, "juried": None}
        base.update(overrides)
        return core.score_fair(base, TOWNS)

    def test_craft_fair_in_weston_50_juried_is_an_opportunity(self):
        r = self.score(booth_fee_usd=50, juried=True)
        self.assertEqual(r["breakdown"], {"event_type": 30, "town": 25, "recurrence": 15, "booth_fee": 20,
                                          "competition": 10, "distance": 0})
        self.assertEqual((r["total"], r["decision"], r["flags"]), (100, "opportunity", []))

    def test_weekly_farmers_market_in_framingham_is_skipped(self):
        r = self.score(town="Framingham", event_type="farmers", recurrence="weekly")
        self.assertEqual((r["total"], r["decision"]), (23, "skip"))

    def test_300_dollar_juried_holiday_show_in_wellesley_is_an_exception(self):
        r = self.score(town="Wellesley", event_type="holiday", booth_fee_usd=300, juried=True)
        self.assertEqual((r["total"], r["decision"]), (80, "opportunity"))
        self.assertIn("excecao", r["flags"])

    def test_expensive_show_without_a_near_perfect_rest_is_only_a_maybe(self):
        tier_b = next(t["town"] for t in TOWNS.values()
                      if t["income_tier"] == "B" and t["approx_miles_from_framingham"] <= core.RADIUS_MILES)
        r = self.score(town=tier_b, event_type="craft", booth_fee_usd=500, juried=True)
        self.assertEqual((r["total"], r["decision"]), (72, "maybe"))
        self.assertNotIn("excecao", r["flags"])

    def test_maybe_band(self):
        r = self.score(town="Framingham", event_type="mixed", recurrence="monthly")
        self.assertEqual((r["total"], r["decision"]), (43, "maybe"))

    def test_threshold_edges(self):
        self.assertEqual([core.decide(n) for n in (39, 40, 54, 55)], ["skip", "maybe", "maybe", "opportunity"])

    def test_fee_boundaries(self):
        points = {fee: self.score(booth_fee_usd=fee)["breakdown"]["booth_fee"] for fee in (0, 75, 76, 150, 151, None)}
        self.assertEqual(points, {0: 20, 75: 20, 76: 8, 150: 8, 151: 0, None: 5})

    def test_competition_precedence_and_ranges(self):
        pts = lambda **kw: self.score(**kw)["breakdown"]["competition"]  # noqa: E731
        self.assertEqual(pts(juried=True, vendor_count=10), 10)
        self.assertEqual((pts(vendor_count=40), pts(vendor_count=41), pts(vendor_count=100), pts(vendor_count=101)),
                         (7, 5, 5, 2))
        self.assertEqual(pts(juried=False), 5)

    def test_far_town_gets_penalty_and_exception_flag(self):
        far = next(t for t in TOWNS.values() if t["approx_miles_from_framingham"] > core.RADIUS_MILES)
        r = self.score(town=far["town"], booth_fee_usd=40, juried=True)
        self.assertEqual(r["breakdown"]["distance"], core.DISTANCE_PENALTY)
        if r["decision"] == "opportunity":
            self.assertIn("excecao", r["flags"])

    def test_unknown_town_has_no_penalty_but_a_flag(self):
        r = self.score(town="Atlantis", booth_fee_usd=40)
        self.assertEqual((r["breakdown"]["town"], r["breakdown"]["distance"]), (8, 0))
        self.assertIn("distancia_desconhecida", r["flags"])
        self.assertEqual(r["income_tier"], "unknown")

    def test_town_match_ignores_case_state_and_prefix(self):
        for spelling in ("weston", "WESTON, MA", "Town of Weston", "Weston Massachusetts"):
            self.assertEqual(self.score(town=spelling)["income_tier"], "A", spelling)


class KeyTest(unittest.TestCase):
    def test_key_ignores_year_ordinal_article_and_town_in_name(self):
        keys = {core.make_key(n, "Framingham", "2026-12-12") for n in
                ("Framingham Rotary Holiday Craft Fair", "The 45th Annual Rotary Holiday Craft Fair 2026",
                 "Rotary Holiday Craft Fair")}
        self.assertEqual(len(keys), 1)

    def test_key_changes_with_year_and_town(self):
        a = core.make_key("Holly Fair", "Natick", "2026-12-05")
        self.assertNotEqual(a, core.make_key("Holly Fair", "Natick", "2027-12-04"))
        self.assertNotEqual(a, core.make_key("Holly Fair", "Needham", "2026-12-05"))


# --------------------------------------------------------------------------- #
# Registry + calendar
# --------------------------------------------------------------------------- #
class RegistryTest(TmpDirCase):
    def setUp(self):
        super().setUp()
        self.cal = FakeCalendar()
        self.svc = make_service(self.tmp, self.cal)

    def fairs(self):
        return json.loads((self.tmp / "fairs.json").read_text())["fairs"]

    def test_opportunity_creates_one_all_day_event_with_exclusive_end(self):
        r = self.svc.upsert(fair(end_date="2026-11-15"))
        self.assertEqual((r["ok"], r["action"], r["fair"]["status"]), (True, "created", "opportunity"))
        (event,) = self.cal.events("opp")
        self.assertEqual(event["summary"], "🎪 Weston Artisan Craft Fair — Weston")
        self.assertEqual((event["start"], event["end"]), ({"date": "2026-11-14"}, {"date": "2026-11-16"}))
        self.assertEqual(event["extendedProperties"]["private"], {"fairKey": r["fair"]["key"], "kind": "fair"})
        self.assertIn("Score: 100/100", event["description"])
        self.assertIn(f"Chave: {r['fair']['key']}", event["description"])

    def test_timed_event_only_when_both_times_are_known(self):
        self.svc.upsert(fair(start_time="09:00", end_time="15:00"))
        (event,) = self.cal.events("opp")
        self.assertEqual(event["start"], {"dateTime": "2026-11-14T09:00:00", "timeZone": "America/New_York"})
        self.assertEqual(event["end"]["dateTime"], "2026-11-14T15:00:00")
        self.svc.upsert(fair(name="Half Timed Fair", start_time="09:00"))
        halves = [e for e in self.cal.events("opp") if "Half Timed" in e["summary"]]
        self.assertEqual(halves[0]["start"], {"date": "2026-11-14"})

    def test_exception_prefix_and_deadline_event(self):
        r = self.svc.upsert(fair(name="Pricey Holiday Show", town="Wellesley", event_type="holiday",
                                 booth_fee_usd=300, application_deadline="2026-10-30",
                                 application_url="https://apply.example/x"))
        self.assertIn("excecao", r["fair"]["flags"])
        summaries = sorted(e["summary"] for e in self.cal.events("opp"))
        self.assertEqual(summaries, ["⏰ Inscrição: Pricey Holiday Show", "⚠️ 🎪 Pricey Holiday Show — Wellesley"])
        deadline = next(e for e in self.cal.events("opp") if e["summary"].startswith("⏰"))
        self.assertEqual(deadline["start"], {"date": "2026-10-30"})
        self.assertEqual(deadline["extendedProperties"]["private"]["kind"], "deadline")

    def test_past_deadline_gets_no_deadline_event(self):
        self.svc.upsert(fair(application_deadline="2026-10-01"))
        self.assertEqual(len(self.cal.events("opp")), 1)

    def test_upsert_is_idempotent(self):
        first = self.svc.upsert(fair(application_deadline="2026-11-01"))
        second = self.svc.upsert(fair(application_deadline="2026-11-01"))
        self.assertEqual((first["action"], second["action"]), ("created", "unchanged"))
        self.assertEqual(len(self.cal.events("opp")), 2)
        self.assertEqual(len(self.fairs()), 1)

    def test_idempotent_even_if_registry_lost_event_ids(self):
        self.svc.upsert(fair())
        (self.tmp / "fairs.json").unlink()
        self.svc.upsert(fair())
        self.assertEqual(len(self.cal.events("opp")), 1)

    def test_maybe_and_skip_stay_out_of_the_calendar(self):
        maybe = self.svc.upsert(fair(name="Mid Fair", town="Framingham", event_type="mixed", recurrence="monthly",
                                     booth_fee_usd=None, juried=None))
        skip = self.svc.upsert(fair(name="Weekly Market", town="Framingham", event_type="farmers",
                                    recurrence="weekly", booth_fee_usd=None, juried=None))
        self.assertEqual((maybe["fair"]["status"], skip["fair"]["status"]), ("maybe", "skip"))
        self.assertEqual(self.cal.events("opp"), [])
        self.assertEqual(len(self.fairs()), 2)

    def test_status_follows_new_facts_and_calendar_follows_status(self):
        base = dict(name="Mid Fair", town="Framingham", event_type="mixed", recurrence="annual", juried=None, booth_fee_usd=60)
        self.assertEqual(self.svc.upsert(fair(**base))["fair"]["status"], "opportunity")  # 18+8+15+20+5 = 66
        down = self.svc.upsert(fair(**{**base, "booth_fee_usd": 400, "vendor_count": 300}))
        self.assertEqual(down["fair"]["status"], "maybe")
        self.assertEqual(self.cal.events("opp"), [])
        up = self.svc.upsert(fair(**{**base, "booth_fee_usd": 40, "vendor_count": 20}))
        self.assertEqual(up["fair"]["status"], "opportunity")
        self.assertEqual(len(self.cal.events("opp")), 1)

    def test_none_never_erases_known_facts(self):
        self.svc.upsert(fair(booth_fee_usd=60, vendor_count=30))
        r = self.svc.upsert(fair(booth_fee_usd=None, vendor_count=None))
        self.assertEqual(r["fair"]["booth_fee_usd"], 60)
        self.assertEqual(r["fair"]["vendor_count"], 30)

    def test_rejects_past_event_without_touching_anything(self):
        with self.assertRaises(core.ValidationError):
            self.svc.upsert(fair(start_date="2026-10-01"))
        self.assertFalse((self.tmp / "fairs.json").exists())
        self.assertEqual(self.cal.events("opp"), [])

    def test_same_fair_on_two_sources_is_one_record(self):
        a = self.svc.upsert(fair(name="Framingham Rotary Holiday Craft Fair", town="Framingham",
                                 start_date="2026-12-12", source_id="festivalnet-ma-craft-2"))
        b = self.svc.upsert(fair(name="Rotary Holiday Craft Fair 2026", town="Framingham",
                                 start_date="2026-12-12", source_id="meetmeatthefair-metrowest"))
        self.assertEqual(a["fair"]["key"], b["fair"]["key"])
        self.assertEqual(len(self.fairs()), 1)
        self.assertEqual(sorted(self.fairs()[a["fair"]["key"]]["sources"]),
                         ["festivalnet-ma-craft-2", "meetmeatthefair-metrowest"])

    def test_near_duplicate_with_different_wording_is_merged(self):
        a = self.svc.upsert(fair(name="Needham High School Artisan Craft Fair", town="Needham", start_date="2026-10-24"))
        b = self.svc.upsert(fair(name="Needham High School Artisan Craft Fair and Bake Sale", town="Needham",
                                 start_date="2026-10-24"))
        self.assertEqual(a["fair"]["key"], b["fair"]["key"])
        self.assertEqual(len(self.fairs()), 1)
        self.assertEqual(len(self.cal.events("opp")), 1)

    def test_similar_names_on_different_dates_stay_separate(self):
        self.svc.upsert(fair(name="Holly Fair", start_date="2026-11-14"))
        self.svc.upsert(fair(name="Holly Fair", start_date="2026-12-05"))
        self.assertEqual(len(self.fairs()), 2)

    def test_small_date_correction_updates_the_same_record(self):
        a = self.svc.upsert(fair(start_date="2026-11-14"))
        b = self.svc.upsert(fair(start_date="2026-11-15"))
        self.assertEqual(a["fair"]["key"], b["fair"]["key"])
        self.assertEqual(self.fairs()[a["fair"]["key"]]["start_date"], "2026-11-15")
        self.assertEqual(len(self.cal.events("opp")), 1)
        self.assertEqual(self.cal.events("opp")[0]["start"], {"date": "2026-11-15"})

    def test_same_annual_fair_next_year_is_a_new_key(self):
        a = self.svc.upsert(fair(start_date="2026-11-14"))
        b = self.svc.upsert(fair(start_date="2027-11-13"))
        self.assertNotEqual(a["fair"]["key"], b["fair"]["key"])

    # -- announce / ack -------------------------------------------------- #
    def test_announce_until_ack_marks_it(self):
        self.assertTrue(self.svc.upsert(fair())["announce"])
        self.assertTrue(self.svc.upsert(fair())["announce"])  # crashed run: still unannounced
        ack = self.svc.ack(discovery=True)
        self.assertEqual(ack["fairs_marked_announced"], 1)
        self.assertFalse(self.svc.upsert(fair())["announce"])
        state = json.loads((self.tmp / "state.json").read_text())
        self.assertEqual(state["last_discovery_at"], core.iso(NOW))

    # -- confirm ---------------------------------------------------------- #
    def test_confirm_moves_event_and_removes_deadline(self):
        r = self.svc.upsert(fair(application_deadline="2026-11-01"))
        key = r["fair"]["key"]
        original = next(e["id"] for e in self.cal.events("opp") if e["extendedProperties"]["private"]["kind"] == "fair")
        out = self.svc.confirm(key)
        self.assertEqual((out["ok"], out["fair"]["status"], out["calendar"]["fair_event"]), (True, "confirmed", "moved"))
        self.assertEqual(self.cal.events("opp"), [])
        (event,) = self.cal.events("conf")
        self.assertEqual(event["id"], original)
        self.assertIn("CONFIRMADA", event["description"])
        self.assertEqual(self.svc.confirm(key)["calendar"]["fair_event"], "updated")  # idempotent
        self.assertEqual(len(self.cal.events("conf")), 1)

    def test_confirm_falls_back_to_recreate_when_move_is_refused(self):
        key = self.svc.upsert(fair())["fair"]["key"]

        def refuse(*_args):
            raise RuntimeError("HttpError 403: move not allowed")
        self.cal.move = refuse
        out = self.svc.confirm(key)
        self.assertEqual((out["ok"], out["calendar"]["fair_event"]), (True, "recreated"))
        self.assertEqual(self.cal.events("opp"), [])
        self.assertEqual(len(self.cal.events("conf")), 1)

    def test_confirm_a_maybe_creates_the_event_in_the_confirmed_calendar(self):
        key = self.svc.upsert(fair(name="Mid Fair", town="Framingham", event_type="mixed", recurrence="monthly",
                                   booth_fee_usd=None, juried=None))["fair"]["key"]
        self.assertEqual(self.cal.events("opp"), [])
        self.svc.confirm(key)
        self.assertEqual(len(self.cal.events("conf")), 1)

    def test_confirm_unknown_key_suggests_similar(self):
        key = self.svc.upsert(fair())["fair"]["key"]
        with self.assertRaisesRegex(core.FairError, "Similar keys"):
            self.svc.confirm(key[:-3])

    def test_upsert_on_confirmed_fills_gaps_but_keeps_status_and_values(self):
        key = self.svc.upsert(fair(booth_fee_usd=60))["fair"]["key"]
        self.svc.confirm(key)
        r = self.svc.upsert(fair(booth_fee_usd=999, application_deadline="2026-11-05", vendor_count=25))
        self.assertEqual(r["fair"]["status"], "confirmed")
        self.assertEqual(r["fair"]["booth_fee_usd"], 60)
        self.assertEqual(r["fair"]["application_deadline"], "2026-11-05")
        self.assertEqual(len(self.cal.events("conf")), 1)
        self.assertEqual(self.cal.events("opp"), [])
        self.assertIn("Expositores: 25", self.cal.events("conf")[0]["description"])

    # -- discard ---------------------------------------------------------- #
    def test_discard_removes_events_and_blocks_future_suggestions(self):
        key = self.svc.upsert(fair(application_deadline="2026-11-01"))["fair"]["key"]
        out = self.svc.discard(key, reason="longe demais")
        self.assertEqual(out["fair"]["status"], "discarded")
        self.assertEqual(self.cal.events("opp"), [])
        again = self.svc.upsert(fair(booth_fee_usd=1))
        self.assertEqual((again["action"], again["announce"], again["fair"]["status"]),
                         ("ignored_discarded", False, "discarded"))
        self.assertEqual(self.cal.events("opp"), [])
        self.assertEqual(self.fairs()[key]["discard_reason"], "longe demais")
        self.assertEqual(self.fairs()[key]["booth_fee_usd"], 50)

    def test_confirmed_fair_is_protected_from_discard(self):
        key = self.svc.upsert(fair())["fair"]["key"]
        self.svc.confirm(key)
        with self.assertRaisesRegex(core.FairError, "--confirmed-ok"):
            self.svc.discard(key)
        self.assertEqual(self.fairs()[key]["status"], "confirmed")
        self.assertEqual(len(self.cal.events("conf")), 1)

    def test_explicit_override_discards_a_confirmed_fair_and_its_event(self):
        key = self.svc.upsert(fair())["fair"]["key"]
        self.svc.confirm(key)
        out = self.svc.discard(key, confirmed_ok=True)
        self.assertEqual(out["fair"]["status"], "discarded")
        self.assertEqual(self.cal.events("conf"), [])

    # -- reads ------------------------------------------------------------ #
    def test_find_list_and_deadline_view(self):
        self.svc.upsert(fair(name="Weston Artisan Craft Fair", start_date="2026-11-14", application_deadline="2026-10-20"))
        self.svc.upsert(fair(name="Wellesley Marketplace", town="Wellesley", start_date="2026-11-21", event_type="holiday",
                             application_deadline="2026-12-30"))
        self.svc.upsert(fair(name="Sherborn Holiday Market", town="Sherborn", start_date="2026-12-12", event_type="holiday"))
        self.svc.upsert(fair(name="Weekly Market", town="Framingham", start_date="2026-10-17", event_type="farmers",
                             recurrence="weekly", booth_fee_usd=None, juried=None))

        found = self.svc.find("wellesly marketplace")
        self.assertEqual(found["matches"][0]["name"], "Wellesley Marketplace")
        self.assertEqual(self.svc.find("weston")["matches"][0]["town"], "Weston")
        self.assertTrue(self.svc.find("holiday")["ambiguous"] or self.svc.find("holiday")["count"] >= 1)

        default = self.svc.list()
        self.assertEqual([f["start_date"] for f in default["fairs"]], ["2026-11-14", "2026-11-21", "2026-12-12"])
        self.assertEqual(self.svc.list(["all"])["count"], 4)
        december = self.svc.list(date_from="2026-12-01", date_to="2026-12-31")
        self.assertEqual([f["name"] for f in december["fairs"]], ["Sherborn Holiday Market"])
        soon = self.svc.list(deadlines_within=21)
        self.assertEqual([f["name"] for f in soon["fairs"]], ["Weston Artisan Craft Fair"])
        with self.assertRaises(core.FairError):
            self.svc.list(["nonsense"])

    def test_town_lookup(self):
        known = self.svc.town("weston, MA")
        self.assertEqual((known["in_list"], known["income_tier"], known["within_radius"]), (True, "A", True))
        self.assertFalse(self.svc.town("Provincetown")["in_list"])

    def test_get_returns_full_record(self):
        key = self.svc.upsert(fair(notes="bom publico"))["fair"]["key"]
        rec = self.svc.get(key)["fair"]
        self.assertEqual((rec["notes"], rec["score"]), ("bom publico", 100))

    # -- failures --------------------------------------------------------- #
    def test_calendar_failure_is_reported_but_the_registry_keeps_the_fair(self):
        self.cal.fail = True
        r = self.svc.upsert(fair())
        self.assertFalse(r["ok"])
        self.assertTrue(r["saved_in_registry"])
        self.assertEqual(len(self.fairs()), 1)
        self.cal.fail = False
        retry = self.svc.upsert(fair())
        self.assertTrue(retry["ok"])
        self.assertEqual(len(self.cal.events("opp")), 1)

    def test_doctor_with_fake_calendar(self):
        self.svc.cfg["service_account_file"] = str(self.tmp / "missing.json")
        out = self.svc.doctor()
        names = {c["check"]: c["ok"] for c in out["checks"]}
        self.assertTrue(names["towns"] and names["sources"] and names["state_dir"])
        self.assertFalse(names["service_account_file"])
        self.assertFalse(out["ok"])
        self.assertNotIn("private_key", json.dumps(out))


class CliTest(TmpDirCase):
    def test_error_output_is_json_and_exit_code_one(self):
        import contextlib
        import io
        import os
        cfg_path = self.tmp / "config.json"
        cfg_path.write_text(json.dumps({"state_dir": str(self.tmp / "state"), "skill_dir": str(ROOT),
                                         "notion_token_file": str(self.tmp / "none")}))
        os.environ["STUSCLE_FAIRS_CONFIG"] = str(cfg_path)
        self.addCleanup(os.environ.pop, "STUSCLE_FAIRS_CONFIG", None)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = core.main(["upsert", "--json", '{"name": "x"}'])
        self.assertEqual(code, 1)
        payload = json.loads(buf.getvalue())
        self.assertFalse(payload["ok"])
        self.assertIn("town is required", payload["error"])

    def test_upsert_can_read_json_from_stdin_so_apostrophes_survive(self):
        import io
        from unittest import mock
        seen = {}

        class Stub:
            def upsert(self, raw):
                seen.update(raw)
                return {"ok": True}

        args = core.build_parser().parse_args(["upsert", "--file", "-"])
        with mock.patch("sys.stdin", io.StringIO("{\"name\": \"King Richard's Faire\"}")):
            core.run_command(args, Stub())
        self.assertEqual(seen["name"], "King Richard's Faire")

    def test_upsert_batch_reads_a_file_and_keeps_going_after_a_bad_fair(self):
        seen = []

        class Stub:
            def upsert(self, raw):
                if raw.get("name") == "bad":
                    raise core.ValidationError("town is required")
                seen.append(raw["name"])
                return {"ok": True, "action": "created"}

        path = self.tmp / "batch.json"
        path.write_text(json.dumps([{"name": "A"}, {"name": "bad"}, {"name": "King Richard's Faire"}]),
                        encoding="utf-8")
        args = core.build_parser().parse_args(["upsert-batch", "--file", str(path)])
        out = core.run_command(args, Stub())
        self.assertEqual(seen, ["A", "King Richard's Faire"])
        self.assertEqual((out["ok"], out["count"], out["failed"]), (False, 3, 1))
        self.assertEqual(out["results"][1]["error"], "town is required")

    def test_upsert_batch_rejects_a_non_array(self):
        path = self.tmp / "batch.json"
        path.write_text('{"name": "A"}', encoding="utf-8")
        args = core.build_parser().parse_args(["upsert-batch", "--file", str(path)])
        with self.assertRaisesRegex(core.ValidationError, "JSON array"):
            core.run_command(args, object())

    def test_read_only_commands_work_without_google_config(self):
        import contextlib
        import io
        import os
        cfg_path = self.tmp / "config.json"
        cfg_path.write_text(json.dumps({"state_dir": str(self.tmp / "state"), "skill_dir": str(ROOT),
                                         "notion_token_file": str(self.tmp / "none")}))
        os.environ["STUSCLE_FAIRS_CONFIG"] = str(cfg_path)
        self.addCleanup(os.environ.pop, "STUSCLE_FAIRS_CONFIG", None)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = core.main(["list"])
        self.assertEqual((code, json.loads(buf.getvalue())["count"]), (0, 0))


# --------------------------------------------------------------------------- #
# Notion / results / journal / follow-up test doubles
# --------------------------------------------------------------------------- #
FAIRS_DS, RESULTS_DS, JOURNAL_PAGE = "ds-fairs", "ds-results", "page-journal"
LATER = dt.datetime(2026, 11, 15, 10, 0, tzinfo=TZ)        # the day after the Weston fair
NOTION_CFG = {"notion_fairs_data_source_id": FAIRS_DS, "notion_results_data_source_id": RESULTS_DS,
              "notion_journal_page_id": JOURNAL_PAGE}


class FakeNotion:
    """In-memory stand-in for core.NotionClient."""

    def __init__(self):
        self.pages = {}            # page id -> {"ds": data source id, "properties": {...}}
        self.children = []         # (page id, [blocks]) in call order
        self.calls = []
        self.counter = 0
        self.fail = None           # an exception instance raised by every call while set
        self.missing = set()       # ids that answer 404 on get_*

    def _enter(self, what):
        self.calls.append(what)
        if self.fail:
            raise self.fail

    def create_page(self, data_source_id, properties):
        self._enter("create")
        self.counter += 1
        page_id = f"pg{self.counter}"
        self.pages[page_id] = {"ds": data_source_id, "properties": json.loads(json.dumps(properties))}
        return {"id": page_id}

    def update_page(self, page_id, properties):
        self._enter("update")
        self.pages[page_id]["properties"].update(json.loads(json.dumps(properties)))
        return {"id": page_id}

    def query_data_source(self, data_source_id, filter_):
        self._enter("query")
        wanted = filter_["rich_text"]["equals"]
        return [{"id": pid} for pid, page in self.pages.items() if page["ds"] == data_source_id
                and "".join(t["text"]["content"] for t in page["properties"]["Chave"]["rich_text"]) == wanted]

    def append_children(self, page_id, children):
        self._enter("append")
        self.children.append((page_id, children))
        return {}

    def get_data_source(self, data_source_id):
        self._enter("get_data_source")
        if data_source_id in self.missing:
            raise core.NotionError("Notion HTTP 404: object_not_found", 404)
        return {"id": data_source_id, "title": [{"plain_text": f"title of {data_source_id}"}]}

    def get_page(self, page_id):
        self._enter("get_page")
        if page_id in self.missing:
            raise core.NotionError("Notion HTTP 404: object_not_found", 404)
        return {"id": page_id}

    def pages_in(self, ds):
        return {pid: p["properties"] for pid, p in self.pages.items() if p["ds"] == ds}

    def blocks(self):
        return [b for _page, blocks in self.children for b in blocks]

    def texts(self):
        return [b[b["type"]]["rich_text"][0]["text"]["content"] for b in self.blocks()]


def notion_service(tmp, notion, calendar=None, **cfg_over):
    return make_service(tmp, calendar, notion, **{**NOTION_CFG, **cfg_over})


def plain(prop):
    """Text of a rich_text/title property as stored by FakeNotion."""
    return "".join(t["text"]["content"] for t in prop.get("rich_text", prop.get("title", [])))


# --------------------------------------------------------------------------- #
# New fair fields: contacts, days, price per day
# --------------------------------------------------------------------------- #
class ContactAndDaysTest(TmpDirCase):
    today = dt.date(2026, 10, 9)

    def test_contact_email_is_validated_and_other_is_free_text_up_to_300(self):
        ok = core.validate_fair(fair(contact_email=" Org@Example.com ", contact_other="IG @weston_fair, 508-555-0100"),
                                self.today)
        self.assertEqual((ok["contact_email"], ok["contact_other"]), ("Org@Example.com", "IG @weston_fair, 508-555-0100"))
        self.assertIsNone(core.validate_fair(fair(contact_email=None), self.today)["contact_email"])
        for bad in ({"contact_email": "not-an-email"}, {"contact_email": "a@b"}, {"contact_email": "a b@c.com"},
                    {"contact_email": 5}, {"contact_other": "x" * 301}, {"contact_other": 7}):
            with self.assertRaises(core.ValidationError, msg=str(bad)):
                core.validate_fair(fair(**bad), self.today)

    def test_days_and_price_per_day_only_for_multi_day_fairs(self):
        svc = make_service(self.tmp)
        three = svc.upsert(fair(end_date="2026-11-16", booth_fee_usd=150, contact_email="org@weston.org",
                                contact_other="https://apply.example/form"))["fair"]
        self.assertEqual((three["days"], three["price_per_day"]), (3, 50.0))
        one = svc.upsert(fair(name="One Day Fair", booth_fee_usd=80))["fair"]
        self.assertEqual((one["days"], one["price_per_day"]), (1, None))
        no_fee = svc.upsert(fair(name="Free Info Fair", end_date="2026-11-15", booth_fee_usd=None))["fair"]
        self.assertEqual((no_fee["days"], no_fee["price_per_day"]), (2, None))

    def test_calendar_description_shows_contacts_days_and_price_per_day(self):
        cal = FakeCalendar()
        svc = make_service(self.tmp, cal)
        svc.upsert(fair(end_date="2026-11-16", booth_fee_usd=150, contact_email="org@weston.org",
                        contact_other="IG @weston_fair"))
        (event,) = cal.events("opp")
        for line in ("Dias: 3", "Preço por dia: US$ 50", "E-mail de contato: org@weston.org", "Outro contato: IG @weston_fair"):
            self.assertIn(line, event["description"])
        svc.upsert(fair(name="One Day Fair", booth_fee_usd=80))
        single = next(e for e in cal.events("opp") if "One Day" in e["summary"])
        self.assertIn("Dias: 1", single["description"])
        self.assertNotIn("Preço por dia", single["description"])
        self.assertNotIn("E-mail de contato", single["description"])

    def test_adding_a_contact_counts_as_an_update_and_none_never_erases_it(self):
        svc = make_service(self.tmp)
        self.assertEqual(svc.upsert(fair())["action"], "created")
        self.assertEqual(svc.upsert(fair(contact_email="org@weston.org"))["action"], "updated")
        again = svc.upsert(fair(contact_email=None))
        self.assertEqual((again["action"], again["fair"]["contact_email"]), ("unchanged", "org@weston.org"))


# --------------------------------------------------------------------------- #
# Notion: pure mapping
# --------------------------------------------------------------------------- #
class NotionMappingTest(TmpDirCase):
    def record(self, **overrides):
        svc = make_service(self.tmp)
        svc.upsert(fair(**overrides))
        return next(iter(json.loads((self.tmp / "fairs.json").read_text())["fairs"].values()))

    def test_every_property_is_mapped_with_the_exact_names_and_values(self):
        rec = self.record(end_date="2026-11-15", booth_fee_usd=100, vendor_count=35, juried=True,
                          application_deadline="2026-10-30", application_url="https://apply.example/x",
                          event_url="https://event.example/y", contact_email="org@weston.org",
                          contact_other="IG @weston_fair", source_id="festivalnet-ma-craft-2", notes="boa feira")
        props = core.fair_to_notion_properties(rec)
        self.assertEqual(set(props), {
            "Feira", "Status", "Data", "Cidade", "Nível da cidade", "Distância (mi)", "Tipo", "Recorrência",
            "Booth (US$)", "Dias", "E-mail de contato", "Outro contato", "Prazo de inscrição", "Inscrição", "Link de inscrição",
            "Link do evento", "Juried", "Expositores", "Nota", "Alertas", "Fonte", "Observações", "Chave"})
        self.assertEqual(plain(props["Feira"]), "Weston Artisan Craft Fair")
        self.assertEqual(props["Status"], {"select": {"name": "Oportunidade"}})
        self.assertEqual(props["Data"], {"date": {"start": "2026-11-14", "end": "2026-11-15"}})
        self.assertEqual(plain(props["Cidade"]), "Weston")
        self.assertEqual(props["Nível da cidade"], {"select": {"name": "A"}})
        self.assertEqual(props["Tipo"], {"select": {"name": "Craft"}})
        self.assertEqual(props["Recorrência"], {"select": {"name": "Anual"}})
        self.assertEqual((props["Booth (US$)"], props["Dias"]), ({"number": 100}, {"number": 2}))
        self.assertEqual(props["E-mail de contato"], {"email": "org@weston.org"})
        self.assertEqual(props["Prazo de inscrição"], {"date": {"start": "2026-10-30", "end": None}})
        self.assertEqual(props["Link de inscrição"], {"url": "https://apply.example/x"})
        self.assertEqual(props["Juried"], {"select": {"name": "Sim"}})
        self.assertEqual((props["Expositores"], props["Nota"]), ({"number": 35}, {"number": rec["score"]}))
        self.assertEqual(plain(props["Fonte"]), "festivalnet-ma-craft-2")
        self.assertEqual(plain(props["Chave"]), rec["key"])

    def test_formula_columns_are_never_written(self):
        rec = self.record(end_date="2026-11-16", booth_fee_usd=150)
        names = set(core.fair_to_notion_properties(rec))
        rec["result"] = {"revenue": 100, "hours_total": 5}
        names |= set(core.result_to_notion_properties(rec, "pg1"))
        self.assertEqual(names & set(core.NOTION_FORMULA_PROPERTIES), set())

    def test_null_values_clear_their_properties(self):
        rec = self.record(booth_fee_usd=None, juried=None, town="Atlantis")
        props = core.fair_to_notion_properties(rec)
        self.assertEqual(props["E-mail de contato"], {"email": None})
        self.assertEqual((props["Link de inscrição"], props["Link do evento"]), ({"url": None}, {"url": None}))
        self.assertEqual((props["Booth (US$)"], props["Expositores"], props["Distância (mi)"]),
                         ({"number": None}, {"number": None}, {"number": None}))
        self.assertEqual(props["Prazo de inscrição"], {"date": None})
        self.assertEqual((props["Outro contato"], props["Observações"], props["Fonte"]),
                         ({"rich_text": []}, {"rich_text": []}, {"rich_text": []}))
        self.assertEqual(props["Juried"], {"select": {"name": "?"}})
        self.assertEqual(props["Nível da cidade"], {"select": {"name": "?"}})
        self.assertEqual(props["Alertas"], {"multi_select": [{"name": "Distância desconhecida"}, {"name": "Taxa desconhecida"}]})
        self.assertEqual(props["Inscrição"], {"select": {"name": "?"}})
        self.assertEqual(props["Data"], {"date": {"start": "2026-11-14", "end": None}})

    def test_value_maps(self):
        rec = self.record()
        for status, label in {"opportunity": "Oportunidade", "maybe": "Talvez", "confirmed": "Confirmada",
                              "done": "Realizada", "discarded": "Descartada", "skip": "Abaixo da nota"}.items():
            self.assertEqual(core.fair_to_notion_properties({**rec, "status": status})["Status"]["select"]["name"], label)
        for kind, label in {"craft": "Craft", "holiday": "Holiday", "artisan": "Artesanal", "mixed": "Misto",
                            "festival": "Festival", "farmers": "Farmers"}.items():
            self.assertEqual(core.fair_to_notion_properties({**rec, "event_type": kind})["Tipo"]["select"]["name"], label)
        for rec_kind, label in {"one_off": "Única", "annual": "Anual", "seasonal": "Sazonal", "monthly": "Mensal",
                                "weekly": "Semanal", "unknown": "?"}.items():
            self.assertEqual(core.fair_to_notion_properties({**rec, "recurrence": rec_kind})["Recorrência"]["select"]["name"],
                             label)
        self.assertEqual(core.fair_to_notion_properties({**rec, "juried": False})["Juried"]["select"]["name"], "Não")
        flags = core.fair_to_notion_properties({**rec, "flags": ["excecao", "distancia_desconhecida"]})["Alertas"]
        self.assertEqual([f["name"] for f in flags["multi_select"]], ["Exceção", "Distância desconhecida"])

    def test_result_properties(self):
        rec = self.record(end_date="2026-11-15")
        rec["result"] = {"revenue": 500, "sales_count": 20, "booth_cost": 50, "hours_total": 10, "weather": "Sol",
                         "would_return": "maybe", "best_sellers": "chaveiros", "notes": "bom dia"}
        props = core.result_to_notion_properties(rec, "fair-page")
        self.assertEqual(plain(props["Participação"]), "Weston Artisan Craft Fair — 14/11/2026")
        self.assertEqual(props["Feira"], {"relation": [{"id": "fair-page"}]})
        self.assertEqual(props["Data"], {"date": {"start": "2026-11-14", "end": "2026-11-15"}})
        self.assertEqual((props["Receita bruta"], props["Vendas (nº)"], props["Custo do booth"], props["Horas totais"]),
                         ({"number": 500}, {"number": 20}, {"number": 50}, {"number": 10}))
        self.assertEqual((props["Outros custos"], props["Encomendas"]), ({"number": None}, {"number": None}))
        self.assertEqual((props["Clima"], props["Voltaria?"]), ({"select": {"name": "Sol"}}, {"select": {"name": "Talvez"}}))
        self.assertEqual((plain(props["Mais vendidos"]), plain(props["Notas"]), plain(props["Objeções de preço"])),
                         ("chaveiros", "bom dia", ""))
        self.assertEqual(plain(props["Chave"]), rec["key"])
        self.assertEqual(core.result_to_notion_properties(rec, None)["Feira"], {"relation": []})


# --------------------------------------------------------------------------- #
# Notion REST client (fake session, fake clock: no network, no real sleeping)
# --------------------------------------------------------------------------- #
class FakeResponse:
    def __init__(self, status, body=None, headers=None):
        self.status_code, self.body, self.headers = status, body, headers or {}

    def json(self):
        if self.body is None:
            raise ValueError("no body")
        return self.body


class FakeSession:
    def __init__(self, *responses):
        self.responses, self.requests = list(responses), []

    def request(self, method, url, headers=None, json=None, timeout=None):
        self.requests.append({"method": method, "url": url, "headers": headers, "json": json})
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


class FakeClock:
    def __init__(self):
        self.t, self.sleeps = 100.0, []

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.t += seconds


class NotionClientTest(unittest.TestCase):
    def client(self, *responses, token="secret-token-123"):
        self.session, self.clock = FakeSession(*responses), FakeClock()
        return core.NotionClient(token, session=self.session, sleep=self.clock.sleep, clock=self.clock.now)

    def test_endpoints_headers_and_parent_shape(self):
        c = self.client(*[FakeResponse(200, {"id": "x", "results": []})] * 5)
        c.create_page("ds1", {"Feira": {}})
        c.update_page("pg1", {"Status": {}})
        c.query_data_source("ds1", {"property": "Chave"})
        c.append_children("pg2", [{"type": "paragraph"}])
        c.get_page("pg3")
        create, update, query, append, get = self.session.requests
        self.assertEqual((create["method"], create["url"]), ("POST", "https://api.notion.com/v1/pages"))
        self.assertEqual(create["json"]["parent"], {"type": "data_source_id", "data_source_id": "ds1"})
        self.assertEqual((update["method"], update["url"]), ("PATCH", "https://api.notion.com/v1/pages/pg1"))
        self.assertEqual((query["method"], query["url"]), ("POST", "https://api.notion.com/v1/data_sources/ds1/query"))
        self.assertEqual((append["method"], append["url"]), ("PATCH", "https://api.notion.com/v1/blocks/pg2/children"))
        self.assertEqual((get["method"], get["url"]), ("GET", "https://api.notion.com/v1/pages/pg3"))
        self.assertEqual(create["headers"]["Notion-Version"], "2025-09-03")
        self.assertEqual(create["headers"]["Authorization"], "Bearer secret-token-123")

    def test_never_more_than_three_requests_per_second(self):
        c = self.client(*[FakeResponse(200, {})] * 4)
        for _ in range(4):
            c.get_page("p")
        self.assertEqual(len(self.clock.sleeps), 3)
        self.assertTrue(all(s >= 0.33 for s in self.clock.sleeps))
        self.assertGreaterEqual(self.clock.t - 100.0, 3 * 0.33)

    def test_retries_once_on_429_honoring_retry_after(self):
        c = self.client(FakeResponse(429, {}, {"Retry-After": "2"}), FakeResponse(200, {"id": "ok"}))
        self.assertEqual(c.get_page("p"), {"id": "ok"})
        self.assertEqual(len(self.session.requests), 2)
        self.assertIn(2.0, self.clock.sleeps)

    def test_retries_once_on_5xx_then_gives_up(self):
        c = self.client(FakeResponse(503, {}), FakeResponse(500, {"message": "still down"}))
        with self.assertRaisesRegex(core.NotionError, "HTTP 500: still down") as ctx:
            c.get_page("p")
        self.assertEqual((ctx.exception.status, len(self.session.requests)), (500, 2))

    def test_4xx_is_not_retried_and_the_token_never_leaks(self):
        c = self.client(FakeResponse(404, {"message": "no page for secret-token-123"}))
        with self.assertRaises(core.NotionError) as ctx:
            c.get_page("p")
        self.assertEqual((ctx.exception.status, len(self.session.requests)), (404, 1))
        self.assertNotIn("secret-token-123", str(ctx.exception))

    def test_network_errors_become_notion_errors_without_details(self):
        c = self.client(ConnectionError("dns failed for secret-token-123"))
        with self.assertRaises(core.NotionError) as ctx:
            c.get_page("p")
        self.assertNotIn("secret-token-123", str(ctx.exception))

    def test_from_config_reads_the_first_line_and_is_none_when_missing_or_empty(self):
        tmp = Path(tempfile.mkdtemp(prefix="fairs-token-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        token = tmp / "notion-token"
        self.assertIsNone(core.NotionClient.from_config({"notion_token_file": str(token)}))
        token.write_text("\n", encoding="utf-8")
        self.assertIsNone(core.NotionClient.from_config({"notion_token_file": str(token)}))
        token.write_text("ntn_abc\n", encoding="utf-8")
        self.assertEqual(core.NotionClient.from_config({"notion_token_file": str(token)})._token, "ntn_abc")


# --------------------------------------------------------------------------- #
# Notion mirror inside the service
# --------------------------------------------------------------------------- #
class NotionSyncTest(TmpDirCase):
    def setUp(self):
        super().setUp()
        self.cal = FakeCalendar()
        self.notion = FakeNotion()
        self.svc = notion_service(self.tmp, self.notion, self.cal)

    def fairs(self):
        return json.loads((self.tmp / "fairs.json").read_text())["fairs"]

    def test_upsert_creates_one_page_and_remembers_it(self):
        r = self.svc.upsert(fair())
        page_id = r["notion"]["page_id"]
        self.assertEqual((r["notion"]["enabled"], r["notion"]["synced"], r["notion"]["error"]), (True, True, None))
        self.assertEqual(set(self.notion.pages_in(FAIRS_DS)), {page_id})
        rec = self.fairs()[r["fair"]["key"]]
        self.assertEqual((rec["notion_page_id"], rec["notion_dirty"]), (page_id, False))
        self.assertEqual(self.notion.pages[page_id]["properties"]["Status"], {"select": {"name": "Oportunidade"}})

    def test_unchanged_upsert_makes_no_notion_calls(self):
        self.svc.upsert(fair())
        before = len(self.notion.calls)
        r = self.svc.upsert(fair())
        self.assertEqual((r["action"], r["notion"]["synced"]), ("unchanged", True))
        self.assertEqual(len(self.notion.calls), before)

    def test_changed_upsert_updates_the_same_page(self):
        first = self.svc.upsert(fair())
        self.svc.upsert(fair(booth_fee_usd=60, contact_email="org@weston.org"))
        self.assertEqual(len(self.notion.pages_in(FAIRS_DS)), 1)
        props = self.notion.pages[first["notion"]["page_id"]]["properties"]
        self.assertEqual((props["Booth (US$)"], props["E-mail de contato"]), ({"number": 60}, {"email": "org@weston.org"}))

    def test_notes_only_change_is_mirrored_too(self):
        r = self.svc.upsert(fair())
        self.svc.upsert(fair(notes="nota nova"))
        self.assertEqual(plain(self.notion.pages[r["notion"]["page_id"]]["properties"]["Observações"]), "nota nova")

    def test_skip_is_never_created(self):
        r = self.svc.upsert(fair(name="Weekly Market", town="Framingham", event_type="farmers", recurrence="weekly",
                                 booth_fee_usd=None, juried=None))
        self.assertEqual(r["fair"]["status"], "skip")
        self.assertEqual((r["notion"]["synced"], r["notion"]["page_id"]), (True, None))
        self.assertEqual(self.notion.pages, {})
        self.assertFalse(self.fairs()[r["fair"]["key"]]["notion_dirty"])

    def test_skip_that_already_has_a_page_is_updated(self):
        base = dict(name="Mid Fair", town="Framingham", event_type="mixed", recurrence="annual", juried=None,
                    booth_fee_usd=60)
        up = self.svc.upsert(fair(**base))
        self.assertEqual(up["fair"]["status"], "opportunity")
        down = self.svc.upsert(fair(**{**base, "event_type": "farmers", "recurrence": "weekly", "booth_fee_usd": 400,
                                       "vendor_count": 300}))
        self.assertEqual(down["fair"]["status"], "skip")
        self.assertEqual(self.notion.pages[up["notion"]["page_id"]]["properties"]["Status"],
                         {"select": {"name": "Abaixo da nota"}})
        self.assertEqual(len(self.notion.pages), 1)

    def test_create_is_idempotent_when_the_page_id_was_lost(self):
        r = self.svc.upsert(fair())
        data = json.loads((self.tmp / "fairs.json").read_text())
        del data["fairs"][r["fair"]["key"]]["notion_page_id"]
        (self.tmp / "fairs.json").write_text(json.dumps(data))
        again = self.svc.upsert(fair(booth_fee_usd=70))
        self.assertEqual(len(self.notion.pages_in(FAIRS_DS)), 1)
        self.assertEqual(again["notion"]["page_id"], r["notion"]["page_id"])
        self.assertEqual(self.notion.calls.count("create"), 1)

    def test_notion_failure_keeps_ok_true_the_calendar_and_leaves_the_record_dirty(self):
        self.notion.fail = core.NotionError("Notion HTTP 500: boom", 500)
        r = self.svc.upsert(fair())
        self.assertTrue(r["ok"])
        self.assertEqual((r["notion"]["synced"], r["notion"]["page_id"]), (False, None))
        self.assertIn("boom", r["notion"]["error"])
        self.assertEqual(len(self.cal.events("opp")), 1)
        self.assertTrue(self.fairs()[r["fair"]["key"]]["notion_dirty"])

    def test_sync_flushes_dirty_records_and_leaves_clean_ones_alone(self):
        self.notion.fail = core.NotionError("Notion HTTP 500: boom", 500)
        key = self.svc.upsert(fair())["fair"]["key"]
        self.notion.fail = None
        out = self.svc.sync()
        self.assertEqual((out["ok"], out["records_synced"], out["records_failed"]), (True, 1, 0))
        self.assertFalse(self.fairs()[key]["notion_dirty"])
        self.assertEqual(len(self.notion.pages_in(FAIRS_DS)), 1)
        calls = len(self.notion.calls)
        self.assertEqual(self.svc.sync()["records_synced"], 0)
        self.assertEqual(len(self.notion.calls), calls)
        self.assertEqual(self.svc.sync(everything=True)["records_synced"], 1)   # --all forces mirrored records
        self.assertGreater(len(self.notion.calls), calls)

    def test_sync_stops_after_an_authorization_error(self):
        self.notion.fail = core.NotionError("Notion HTTP 401: unauthorized", 401)
        self.svc.upsert(fair())
        self.svc.upsert(fair(name="Wellesley Marketplace", town="Wellesley", event_type="holiday"))
        calls = len(self.notion.calls)
        out = self.svc.sync()
        self.assertEqual((out["records_failed"], len(self.notion.calls) - calls), (1, 1))
        self.assertIn("aborted", out)

    def test_403_and_404_errors_carry_the_sharing_hint(self):
        self.notion.fail = core.NotionError("Notion HTTP 404: object_not_found", 404)
        r = self.svc.upsert(fair())
        self.assertIn("Connections", r["notion"]["error"])
        self.assertIn("'Hermes'", r["notion"]["error"])

    def test_disabled_without_token_or_ids(self):
        off = make_service(self.tmp / "off", None, None)          # no token file, fake not injected
        self.assertEqual(off.upsert(fair())["notion"], {"enabled": False})
        self.assertEqual(off.sync(), {"ok": True, "notion": {"enabled": False}})
        no_ids = notion_service(self.tmp / "noids", self.notion, notion_journal_page_id=None)
        self.assertEqual(no_ids.upsert(fair())["notion"], {"enabled": False})
        rec = next(iter(json.loads((self.tmp / "off" / "fairs.json").read_text())["fairs"].values()))
        self.assertTrue(rec["notion_dirty"])                       # stays dirty so a later sync catches up

    def test_confirm_and_discard_update_the_status_and_write_the_journal(self):
        key = self.svc.upsert(fair())["fair"]["key"]
        page_id = self.fairs()[key]["notion_page_id"]
        out = self.svc.confirm(key)
        self.assertTrue(out["notion"]["synced"])
        self.assertEqual(self.notion.pages[page_id]["properties"]["Status"], {"select": {"name": "Confirmada"}})
        self.assertEqual(self.notion.texts(), ["09/10/2026", "Confirmamos a Weston Artisan Craft Fair em Weston, 14/11/2026. Booth US$ 50."])
        self.svc.confirm(key)                                      # repeating it writes no second entry
        self.assertEqual(len(self.notion.texts()), 2)
        self.svc.discard(key, reason="longe demais", confirmed_ok=True)
        self.assertEqual(self.notion.pages[page_id]["properties"]["Status"], {"select": {"name": "Descartada"}})
        self.assertEqual(self.notion.texts()[-1], "Descartamos a Weston Artisan Craft Fair (Weston, 14/11/2026): longe demais.")

    def test_discard_without_reason_and_confirm_without_fee_use_the_fallback_wording(self):
        key = self.svc.upsert(fair(booth_fee_usd=None))["fair"]["key"]
        self.svc.confirm(key)
        self.assertIn("Taxa do booth não informada.", self.notion.texts()[-1])
        self.svc.discard(key, confirmed_ok=True)
        self.assertIn("sem motivo informado.", self.notion.texts()[-1])

    def test_multi_day_fairs_show_both_dates_in_the_journal(self):
        key = self.svc.upsert(fair(end_date="2026-11-15"))["fair"]["key"]
        self.svc.confirm(key)
        self.assertIn("14/11/2026 a 15/11/2026", self.notion.texts()[-1])

    def test_doctor_checks_token_ids_data_sources_and_journal_page(self):
        (self.tmp / "token").write_text("ntn_secret\n", encoding="utf-8")
        self.svc.cfg["notion_token_file"] = str(self.tmp / "token")
        self.svc.cfg["service_account_file"] = str(self.tmp / "missing.json")
        out = self.svc.doctor()
        names = {c["check"]: c for c in out["checks"]}
        for name in ("notion_token_file", "notion_ids", "notion_data_source_fairs", "notion_data_source_results",
                     "notion_journal_page"):
            self.assertTrue(names[name]["ok"], name)
        self.notion.missing = {RESULTS_DS, JOURNAL_PAGE}
        names = {c["check"]: c for c in self.svc.doctor()["checks"]}
        self.assertTrue(names["notion_data_source_fairs"]["ok"])
        self.assertFalse(names["notion_data_source_results"]["ok"])
        self.assertIn("share the hub page", names["notion_journal_page"]["detail"])
        self.assertNotIn("ntn_secret", json.dumps(out))

    def test_doctor_reports_a_missing_token_file(self):
        names = {c["check"]: c for c in self.svc.doctor()["checks"]}
        self.assertFalse(names["notion_token_file"]["ok"])
        self.assertNotIn("notion_data_source_fairs", names)


# --------------------------------------------------------------------------- #
# Results after a fair
# --------------------------------------------------------------------------- #
class ResultTest(TmpDirCase):
    RESULT = {"revenue": 500, "sales_count": 20, "other_costs": 25, "cogs": 100, "payment_fees": 25,
              "hours_total": 10, "hours_open": 6, "weather": "Sol", "would_return": "yes",
              "best_sellers": "chaveiros", "notes": "bom publico"}

    def setUp(self):
        super().setUp()
        self.cal, self.notion = FakeCalendar(), FakeNotion()
        self.svc = notion_service(self.tmp, self.notion, self.cal)
        self.key = self.svc.upsert(fair())["fair"]["key"]
        self.svc.confirm(self.key)

    def rec(self):
        return json.loads((self.tmp / "fairs.json").read_text())["fairs"][self.key]

    def happened(self):
        self.svc._now_fn = lambda: LATER

    def test_validation(self):
        for bad in ({"surprise": 1}, {"revenue": -1}, {"revenue": "500"}, {"revenue": True}, {"sales_count": float("inf")},
                    {"revenue": 1, "weather": "Neve"}, {"revenue": 1, "would_return": "sim"},
                    {"revenue": 1, "notes": "x" * 1001}, {"revenue": 1, "notes": 5}):
            with self.assertRaises(core.ValidationError, msg=str(bad)):
                core.validate_result(bad)
        with self.assertRaises(core.ValidationError):
            core.validate_result([1])
        self.assertEqual(core.validate_result({"revenue": 10, "orders": None, "notes": None}), {"revenue": 10})

    def test_needs_at_least_one_numeric_field(self):
        self.happened()
        with self.assertRaisesRegex(core.ValidationError, "numeric"):
            self.svc.result(self.key, {"notes": "so texto"})
        self.assertEqual(self.rec()["status"], "confirmed")

    def test_refused_before_the_fair_and_for_unconfirmed_fairs(self):
        with self.assertRaisesRegex(core.FairError, "future"):
            self.svc.result(self.key, {"revenue": 10})
        other = self.svc.upsert(fair(name="Wellesley Marketplace", town="Wellesley", event_type="holiday",
                                     start_date="2026-10-10"))["fair"]["key"]
        self.svc._now_fn = lambda: dt.datetime(2026, 10, 11, 10, 0, tzinfo=TZ)
        with self.assertRaisesRegex(core.FairError, "confirmed fair, and this one is opportunity"):
            self.svc.result(other, {"revenue": 10})
        self.svc.discard(other)
        with self.assertRaisesRegex(core.FairError, "discarded"):
            self.svc.result(other, {"revenue": 10})

    def test_allowed_on_the_first_day_of_the_fair(self):
        self.svc._now_fn = lambda: dt.datetime(2026, 11, 14, 18, 0, tzinfo=TZ)
        self.assertTrue(self.svc.result(self.key, {"revenue": 10})["ok"])

    def test_records_the_result_marks_done_and_computes_the_summary(self):
        self.happened()
        out = self.svc.result(self.key, self.RESULT)
        self.assertEqual((out["ok"], out["action"], out["fair"]["status"]), (True, "result_recorded", "done"))
        self.assertEqual(out["result"]["booth_cost"], 50)                # defaults to the fair's booth fee
        self.assertEqual(out["summary"], {"total_costs": 200, "profit": 300, "profit_per_hour": 30.0,
                                          "revenue_per_open_hour": 83.33, "avg_ticket": 25.0})
        rec = self.rec()
        self.assertEqual((rec["status"], rec["result"]["revenue"]), ("done", 500))

    def test_summary_is_null_when_inputs_are_missing(self):
        self.assertEqual(core.result_summary({}), {"total_costs": None, "profit": None, "profit_per_hour": None,
                                                   "revenue_per_open_hour": None, "avg_ticket": None})
        only_revenue = core.result_summary({"revenue": 90})
        self.assertEqual((only_revenue["profit"], only_revenue["avg_ticket"]), (None, None))
        no_hours = core.result_summary({"revenue": 90, "booth_cost": 40, "hours_total": 0, "sales_count": 3})
        self.assertEqual((no_hours["profit"], no_hours["profit_per_hour"], no_hours["avg_ticket"]), (50, None, 30.0))
        self.assertEqual(core.result_summary({"booth_cost": 40})["total_costs"], 40)

    def test_calling_again_merges_and_nulls_keep_the_stored_value(self):
        self.happened()
        self.svc.result(self.key, {"revenue": 500, "hours_total": 10, "notes": "primeira"})
        out = self.svc.result(self.key, {"revenue": None, "hours_total": 8, "other_costs": 20, "notes": None})
        self.assertEqual((out["result"]["revenue"], out["result"]["hours_total"], out["result"]["other_costs"],
                          out["result"]["notes"]), (500, 8, 20, "primeira"))
        self.assertEqual(out["summary"]["profit"], 430)
        self.assertEqual(self.svc.result(self.key, {"notes": "so texto agora"})["result"]["notes"], "so texto agora")

    def test_explicit_booth_cost_beats_the_fee_default(self):
        self.happened()
        self.assertEqual(self.svc.result(self.key, {"revenue": 100, "booth_cost": 35})["result"]["booth_cost"], 35)

    def test_calendar_event_stays_in_the_confirmed_calendar_with_a_check_mark(self):
        self.happened()
        self.svc.result(self.key, {"revenue": 100})
        self.assertEqual(self.cal.events("opp"), [])
        (event,) = self.cal.events("conf")
        self.assertEqual(event["summary"], "✅ 🎪 Weston Artisan Craft Fair — Weston")
        self.assertIn("REALIZADA", event["description"])

    def test_notion_gets_one_result_page_related_to_the_fair_page(self):
        self.happened()
        out = self.svc.result(self.key, self.RESULT)
        fair_page = self.rec()["notion_page_id"]
        (result_page_id,) = self.notion.pages_in(RESULTS_DS)
        self.assertEqual((out["notion"]["synced"], out["notion"]["result_page_id"]), (True, result_page_id))
        props = self.notion.pages[result_page_id]["properties"]
        self.assertEqual(props["Feira"], {"relation": [{"id": fair_page}]})
        self.assertEqual((props["Receita bruta"], props["Custo do booth"]), ({"number": 500}, {"number": 50}))
        self.assertEqual(self.notion.pages[fair_page]["properties"]["Status"], {"select": {"name": "Realizada"}})
        self.assertEqual(set(props) & set(core.NOTION_FORMULA_PROPERTIES), set())
        self.assertEqual(self.rec()["notion_result_page_id"], result_page_id)
        self.svc.result(self.key, {"revenue": 600})                    # second call updates, never duplicates
        self.assertEqual(len(self.notion.pages_in(RESULTS_DS)), 1)
        self.assertEqual(self.notion.pages[result_page_id]["properties"]["Receita bruta"], {"number": 600})

    def test_result_page_is_found_by_key_when_its_id_was_lost(self):
        self.happened()
        self.svc.result(self.key, {"revenue": 100})
        data = json.loads((self.tmp / "fairs.json").read_text())
        del data["fairs"][self.key]["notion_result_page_id"]
        (self.tmp / "fairs.json").write_text(json.dumps(data))
        self.svc.result(self.key, {"revenue": 150})
        self.assertEqual(len(self.notion.pages_in(RESULTS_DS)), 1)

    def test_notion_failure_does_not_fail_the_result_and_sync_catches_up(self):
        self.happened()
        self.notion.fail = core.NotionError("Notion HTTP 500: boom", 500)
        out = self.svc.result(self.key, {"revenue": 100})
        self.assertTrue(out["ok"])
        self.assertFalse(out["notion"]["synced"])
        self.assertEqual(self.rec()["status"], "done")
        self.assertTrue(self.rec()["notion_dirty"])
        self.notion.fail = None
        self.svc.sync()
        self.assertEqual(len(self.notion.pages_in(RESULTS_DS)), 1)
        self.assertFalse(self.rec()["notion_dirty"])

    def test_journal_entry_uses_only_the_numbers_available(self):
        self.happened()
        self.svc.result(self.key, self.RESULT)
        self.assertEqual(self.notion.texts()[-1],
                         "Weston Artisan Craft Fair: receita US$ 500, lucro US$ 300, US$ 30 por hora de trabalho.")
        text = self.svc._journal_result_text({"name": "X", "result": {"revenue": 80}}, core.result_summary({"revenue": 80}))
        self.assertEqual(text, "X: receita US$ 80.")
        self.assertEqual(self.svc._journal_result_text({"name": "X", "result": {"orders": 2}}, core.result_summary({})),
                         "X: resultado registrado.")

    def test_done_fairs_are_protected_from_discard_and_cannot_be_confirmed_again(self):
        self.happened()
        self.svc.result(self.key, {"revenue": 100})
        with self.assertRaisesRegex(core.FairError, "--confirmed-ok"):
            self.svc.discard(self.key)
        with self.assertRaisesRegex(core.FairError, "already happened"):
            self.svc.confirm(self.key)
        self.assertEqual(self.rec()["status"], "done")
        self.assertEqual(len(self.cal.events("conf")), 1)
        out = self.svc.discard(self.key, confirmed_ok=True)
        self.assertEqual(out["fair"]["status"], "discarded")
        self.assertEqual(self.cal.events("conf"), [])

    def test_done_fair_ignores_later_upserts_status_but_still_fills_gaps(self):
        self.happened()
        self.svc.result(self.key, {"revenue": 100})
        self.svc._now_fn = lambda: NOW
        again = self.svc.upsert(fair(contact_email="org@weston.org", booth_fee_usd=999))
        self.assertEqual((again["fair"]["status"], again["fair"]["booth_fee_usd"]), ("done", 50))
        self.assertEqual(again["fair"]["contact_email"], "org@weston.org")

    def test_cli_reads_the_result_from_stdin(self):
        import io
        from unittest import mock
        seen = {}

        class Stub:
            def result(self, key, raw):
                seen.update(key=key, raw=raw)
                return {"ok": True}

        args = core.build_parser().parse_args(["result", "some-key", "--file", "-"])
        with mock.patch("sys.stdin", io.StringIO('{"revenue": 12.5, "notes": "King Richard\'s"}')):
            core.run_command(args, Stub())
        self.assertEqual(seen, {"key": "some-key", "raw": {"revenue": 12.5, "notes": "King Richard's"}})

    def test_list_status_done_sorted_by_profit_per_hour(self):
        self.happened()
        self.svc.result(self.key, self.RESULT)                          # profit 300 / 10 h = 30 per hour
        self.svc._now_fn = lambda: NOW
        fast = self.svc.upsert(fair(name="Wellesley Holiday Show", town="Wellesley", event_type="holiday",
                                    start_date="2026-11-10", booth_fee_usd=40))["fair"]["key"]
        slow = self.svc.upsert(fair(name="Natick Craft Day", town="Natick", start_date="2026-11-12",
                                    booth_fee_usd=40))["fair"]["key"]
        bare = self.svc.upsert(fair(name="Needham Craft Day", town="Needham", start_date="2026-11-13",
                                    booth_fee_usd=40))["fair"]["key"]
        for k in (fast, slow, bare):
            self.svc.confirm(k)
        self.svc._now_fn = lambda: LATER
        self.svc.result(fast, {"revenue": 440, "hours_total": 8})       # (440 - 40) / 8 = 50 per hour
        self.svc.result(slow, {"revenue": 100, "hours_total": 5})       # (100 - 40) / 5 = 12 per hour
        self.svc.result(bare, {"revenue": 100})                         # no hours: not computable, goes last
        out = self.svc.list(["done"], sort="profit_per_hour")
        self.assertEqual([f["key"] for f in out["fairs"]], [fast, self.key, slow, bare])
        self.assertEqual([f["summary"]["profit_per_hour"] for f in out["fairs"]], [50.0, 30.0, 12.0, None])
        self.assertEqual(self.svc.list(["done"])["fairs"][0]["start_date"], "2026-11-10")   # default: by date
        with self.assertRaises(core.FairError):
            self.svc.list(["done"], sort="luck")


# --------------------------------------------------------------------------- #
# Journal
# --------------------------------------------------------------------------- #
class JournalTest(TmpDirCase):
    def setUp(self):
        super().setUp()
        self.notion = FakeNotion()
        self.svc = notion_service(self.tmp, self.notion)

    def test_heading_is_written_only_when_the_date_changes(self):
        self.svc.journal("Primeira entrada.", "2026-10-09")
        self.svc.journal("Segunda entrada, mesmo dia.", "2026-10-09")
        self.svc.journal("Outro dia.", "2026-10-10")
        self.svc.journal("Voltou para o dia anterior.", "2026-10-09")
        kinds = [(b["type"], b[b["type"]]["rich_text"][0]["text"]["content"]) for b in self.notion.blocks()]
        self.assertEqual(kinds, [
            ("heading_3", "09/10/2026"), ("paragraph", "Primeira entrada."), ("paragraph", "Segunda entrada, mesmo dia."),
            ("heading_3", "10/10/2026"), ("paragraph", "Outro dia."),
            ("heading_3", "09/10/2026"), ("paragraph", "Voltou para o dia anterior.")])
        self.assertEqual({page for page, _ in self.notion.children}, {JOURNAL_PAGE})
        state = json.loads((self.tmp / "state.json").read_text())
        self.assertEqual(state["last_journal_date"], "2026-10-09")

    def test_default_date_is_today(self):
        self.svc.journal("Sem data.")
        self.assertEqual(self.notion.texts()[0], "09/10/2026")

    def test_long_text_is_split_in_chunks_of_at_most_2000_characters(self):
        self.svc.journal(("palavra " * 700).strip())
        paragraphs = [t for t in self.notion.texts()[1:]]
        self.assertGreater(len(paragraphs), 1)
        self.assertTrue(all(len(p) <= 2000 for p in paragraphs))
        self.assertEqual(" ".join(paragraphs).split(), ["palavra"] * 700)
        self.assertEqual(core.chunk_text("x" * 4500), ["x" * 2000, "x" * 2000, "x" * 500])

    def test_validation_and_disabled_notion(self):
        with self.assertRaises(core.ValidationError):
            self.svc.journal("   ")
        with self.assertRaises(core.ValidationError):
            self.svc.journal("texto", "09/10/2026")
        off = make_service(self.tmp / "off")
        with self.assertRaisesRegex(core.FairError, "not configured"):
            off.journal("texto")

    def test_failed_entries_are_queued_in_order_and_flushed_by_the_next_write_or_sync(self):
        self.notion.fail = core.NotionError("Notion HTTP 500: boom", 500)
        out = self.svc.journal("Primeira.", "2026-10-09")
        self.assertTrue(out["ok"])
        self.assertEqual((out["journal"]["written"], out["journal"]["pending"]), (0, 1))
        self.assertIn("boom", out["journal"]["error"])
        self.svc.journal("Segunda.", "2026-10-09")
        queue = json.loads((self.tmp / "journal_pending.json").read_text())["entries"]
        self.assertEqual([e["text"] for e in queue], ["Primeira.", "Segunda."])
        self.notion.fail = None
        flushed = self.svc.sync()
        self.assertEqual((flushed["journal"]["written"], flushed["journal"]["pending"]), (2, 0))
        self.assertEqual(self.notion.texts(), ["09/10/2026", "Primeira.", "Segunda."])
        self.assertEqual(json.loads((self.tmp / "journal_pending.json").read_text())["entries"], [])

    def test_new_entry_waits_behind_an_older_queued_one(self):
        self.notion.fail = core.NotionError("Notion HTTP 500: boom", 500)
        self.svc.journal("Antiga.", "2026-10-08")
        self.notion.fail = None
        self.svc.journal("Nova.", "2026-10-09")
        self.assertEqual(self.notion.texts(), ["08/10/2026", "Antiga.", "09/10/2026", "Nova."])


# --------------------------------------------------------------------------- #
# Ask for the results after each fair
# --------------------------------------------------------------------------- #
class FollowupTest(TmpDirCase):
    def setUp(self):
        super().setUp()
        self.svc = make_service(self.tmp)
        self.cfg = self.svc.cfg
        self.key = self.svc.upsert(fair())["fair"]["key"]
        self.svc.confirm(self.key)
        self.today = dt.datetime(2026, 11, 16, 9, 0, tzinfo=TZ)           # two days after the fair
        self.svc._now_fn = lambda: self.today

    def registry(self):
        return json.loads((self.tmp / "fairs.json").read_text())

    def patch(self, **fields):
        data = self.registry()
        data["fairs"][self.key].update(fields)
        (self.tmp / "fairs.json").write_text(json.dumps(data))

    def due(self):
        return [f["key"] for f in pre.select_result_followups(self.registry(), self.today)]

    def test_never_asked_is_selected(self):
        self.assertEqual(self.due(), [self.key])
        (item,) = pre.select_result_followups(self.registry(), self.today)
        self.assertEqual((item["name"], item["town"], item["date"]), ("Weston Artisan Craft Fair", "Weston", "2026-11-14"))

    def test_asked_eight_days_ago_once_is_selected_again(self):
        self.patch(result_ask_count=1, result_asked_at=core.iso(self.today - dt.timedelta(days=8)))
        self.assertEqual(self.due(), [self.key])

    def test_asked_twice_is_never_selected_again(self):
        self.patch(result_ask_count=2, result_asked_at=core.iso(self.today - dt.timedelta(days=30)))
        self.assertEqual(self.due(), [])

    def test_asked_two_days_ago_waits(self):
        self.patch(result_ask_count=1, result_asked_at=core.iso(self.today - dt.timedelta(days=2)))
        self.assertEqual(self.due(), [])

    def test_not_selected_when_not_over_not_confirmed_or_already_done(self):
        self.patch(end_date="2026-11-16")                                # last day is today: not over yet
        self.assertEqual(self.due(), [])
        self.patch(end_date="2026-11-15")
        self.assertEqual(self.due(), [self.key])
        self.patch(result={"revenue": 1})
        self.assertEqual(self.due(), [])
        self.patch(result=None, status="opportunity")
        self.assertEqual(self.due(), [])
        self.patch(status="discarded")
        self.assertEqual(self.due(), [])

    def test_mark_asked_counts_and_stamps(self):
        first = self.svc.mark_asked(self.key)
        self.assertEqual((first["result_ask_count"], first["result_asked_at"]), (1, core.iso(self.today)))
        self.assertEqual(self.svc.mark_asked(self.key)["result_ask_count"], 2)
        self.assertEqual(self.registry()["fairs"][self.key]["result_ask_count"], 2)
        with self.assertRaises(core.FairError):
            self.svc.mark_asked("nope-2026")

    def test_followup_alone_wakes_the_agent_and_the_section_lists_the_fair(self):
        sources = [{"id": "s1", "name": "Source One", "url": "https://one.example/"}]
        listing = page("Stable listing")
        run = lambda: pre.run_precheck(self.cfg, sources, ["q"], fetch=lambda url: listing, now=self.today,  # noqa: E731
                                       sleep=lambda s: None)[0]
        run()
        self.svc.ack(discovery=True)                                      # quiet baseline: nothing else is pending
        out = run()
        self.assertTrue(out.rstrip().endswith('{"wakeAgent": true}'))
        self.assertIn("## Past fairs without results", out)
        self.assertIn(f"- {self.key} | Weston Artisan Craft Fair | Weston | 2026-11-14", out)
        self.assertNotIn("## Sources with new content", out)
        self.assertIn("Weekly search: NO", out)
        self.svc.mark_asked(self.key)                                     # asked now: silence until a week passes
        self.assertEqual(run(), '{"wakeAgent": false}')

    def test_followup_is_reported_in_a_dry_run_without_writing_anything(self):
        sources = [{"id": "s1", "name": "Source One", "url": "https://one.example/"}]
        out = pre.run_precheck(self.cfg, sources, ["q"], fetch=lambda url: page("Listing"), now=self.today,
                               dry_run=True, sleep=lambda s: None)[0]
        self.assertIn("## Past fairs without results", out)
        self.assertEqual(self.registry()["fairs"][self.key].get("result_ask_count"), None)


# --------------------------------------------------------------------------- #
# Scoring v2: unknown fee, long seasons, application status
# --------------------------------------------------------------------------- #
def town_of(tier, within_radius=True):
    return next(t["town"] for t in TOWNS.values() if t["income_tier"] == tier
                and (t["approx_miles_from_framingham"] <= core.RADIUS_MILES) == within_radius)


class ScoringV2Test(unittest.TestCase):
    def score(self, **overrides):
        base = {"name": "X", "town": town_of("A"), "start_date": "2026-11-14", "end_date": None, "event_type": "craft",
                "recurrence": "annual", "booth_fee_usd": None, "vendor_count": None, "juried": None}
        base.update(overrides)
        return core.score_fair(base, TOWNS)

    def test_unknown_fee_earns_5_for_one_day_and_0_for_longer(self):
        one = self.score()
        two = self.score(end_date="2026-11-15")
        self.assertEqual((one["breakdown"]["booth_fee"], two["breakdown"]["booth_fee"]), (5, 0))
        self.assertIn("taxa_desconhecida", one["flags"])
        self.assertIn("taxa_desconhecida", two["flags"])
        self.assertNotIn("taxa_desconhecida", self.score(booth_fee_usd=50)["flags"])

    def test_two_day_juried_craft_show_in_tier_b_with_unknown_fee_is_only_a_maybe(self):
        r = self.score(town=town_of("B"), end_date="2026-11-15", juried=True)
        self.assertEqual((r["total"], r["decision"]), (72, "maybe"))
        self.assertIn("taxa_desconhecida", r["flags"])
        self.assertNotIn("excecao", r["flags"])

    def test_three_day_juried_craft_show_in_tier_c_with_unknown_fee_is_a_maybe(self):
        r = self.score(town=town_of("C"), end_date="2026-11-16", juried=True)
        self.assertEqual((r["total"], r["decision"]), (63, "maybe"))

    def test_one_day_craft_fair_in_tier_a_with_unknown_fee_still_makes_the_calendar(self):
        r = self.score()
        self.assertEqual((r["total"], r["decision"]), (80, "opportunity"))
        self.assertEqual(r["flags"], ["taxa_desconhecida"])

    def test_two_day_annual_event_in_tier_a_with_unknown_fee_needs_the_full_exception_score(self):
        r = self.score(end_date="2026-11-15")
        self.assertEqual((r["total"], r["decision"]), (75, "opportunity"))
        self.assertEqual(r["flags"], ["taxa_desconhecida"])
        festival = self.score(end_date="2026-11-15", event_type="festival")   # 18 instead of 30 points: 63
        self.assertEqual((festival["total"], festival["decision"]), (63, "maybe"))

    def test_long_season_is_capped_at_maybe(self):
        r = self.score(event_type="holiday", start_date="2026-11-14", end_date="2027-01-04", booth_fee_usd=50, juried=True)
        self.assertEqual(core.fair_days({"start_date": "2026-11-14", "end_date": "2027-01-04"}), 52)
        self.assertGreaterEqual(r["total"], core.OPPORTUNITY_MIN_SCORE)
        self.assertEqual(r["decision"], "maybe")
        self.assertIn("temporada_longa", r["flags"])

    def test_season_threshold_is_more_than_14_days(self):
        fourteen = self.score(start_date="2026-11-14", end_date="2026-11-27", booth_fee_usd=50)
        fifteen = self.score(start_date="2026-11-14", end_date="2026-11-28", booth_fee_usd=50)
        self.assertEqual((fourteen["decision"], "temporada_longa" in fourteen["flags"]), ("opportunity", False))
        self.assertEqual((fifteen["decision"], "temporada_longa" in fifteen["flags"]), ("maybe", True))

    def test_closed_applications_cap_at_maybe(self):
        r = self.score(booth_fee_usd=50, application_status="closed")
        self.assertEqual((r["total"], r["decision"]), (95, "maybe"))
        self.assertIn("inscricao_encerrada", r["flags"])
        self.assertNotIn("excecao", r["flags"])

    def test_waitlist_caps_at_maybe(self):
        r = self.score(booth_fee_usd=50, application_status="waitlist")
        self.assertEqual(r["decision"], "maybe")
        self.assertIn("lista_de_espera", r["flags"])

    def test_open_and_unknown_status_change_nothing(self):
        for status in ("open", "unknown", None):
            r = self.score(booth_fee_usd=50, application_status=status)
            self.assertEqual((r["decision"], r["flags"]), ("opportunity", []), status)

    def test_caps_never_raise_a_decision(self):
        self.assertEqual([core.cap_decision(d, "maybe") for d in ("skip", "maybe", "opportunity")],
                         ["skip", "maybe", "maybe"])
        r = self.score(event_type="farmers", recurrence="weekly", town=town_of("C"), application_status="closed")
        self.assertEqual(r["decision"], "skip")

    def test_known_expensive_fee_keeps_the_excecao_flag(self):
        r = self.score(booth_fee_usd=300, juried=True, town="Wellesley", event_type="holiday")
        self.assertEqual((r["decision"], r["flags"]), ("opportunity", ["excecao"]))


class ApplicationStatusFieldTest(TmpDirCase):
    today = dt.date(2026, 10, 9)

    def test_validation(self):
        for status in core.APPLICATION_STATUSES:
            self.assertEqual(core.validate_fair(fair(application_status=status), self.today)["application_status"], status)
        self.assertIsNone(core.validate_fair(fair(application_status=None), self.today)["application_status"])
        for bad in ("Open", "full", 1, True):
            with self.assertRaises(core.ValidationError, msg=str(bad)):
                core.validate_fair(fair(application_status=bad), self.today)

    def test_defaults_to_unknown_and_flows_to_compact_calendar_and_notion(self):
        cal = FakeCalendar()
        svc = make_service(self.tmp, cal)
        first = svc.upsert(fair())["fair"]
        self.assertEqual(first["application_status"], "unknown")
        self.assertIn("Inscrição: não informada", cal.events("opp")[0]["description"])
        r = svc.upsert(fair(application_status="open", application_url="https://apply.example/x"))
        self.assertEqual((r["action"], r["fair"]["application_status"]), ("updated", "open"))
        description = cal.events("opp")[0]["description"]
        self.assertIn("Inscrição: aberta", description)
        self.assertIn("Link de inscrição: https://apply.example/x", description)
        rec = next(iter(json.loads((self.tmp / "fairs.json").read_text())["fairs"].values()))
        self.assertEqual(core.fair_to_notion_properties(rec)["Inscrição"], {"select": {"name": "Aberta"}})

    def test_unknown_or_null_never_erases_a_known_status(self):
        svc = make_service(self.tmp)
        svc.upsert(fair(application_status="waitlist"))
        for value in ("unknown", None):
            self.assertEqual(svc.upsert(fair(application_status=value))["fair"]["application_status"], "waitlist")

    def test_closed_status_moves_the_fair_out_of_the_calendar_and_back(self):
        cal = FakeCalendar()
        svc = make_service(self.tmp, cal)
        self.assertEqual(svc.upsert(fair())["fair"]["status"], "opportunity")
        closed = svc.upsert(fair(application_status="closed"))
        self.assertEqual((closed["fair"]["status"], closed["fair"]["flags"]), ("maybe", ["inscricao_encerrada"]))
        self.assertEqual(cal.events("opp"), [])
        reopened = svc.upsert(fair(application_status="open"))
        self.assertEqual(reopened["fair"]["status"], "opportunity")
        self.assertEqual(len(cal.events("opp")), 1)

    def test_confirmed_fair_fills_a_missing_status_but_keeps_a_known_one(self):
        svc = make_service(self.tmp)
        key = svc.upsert(fair())["fair"]["key"]
        svc.confirm(key)
        self.assertEqual(svc.upsert(fair(application_status="open"))["fair"]["application_status"], "open")
        self.assertEqual(svc.upsert(fair(application_status="closed"))["fair"]["application_status"], "open")
        self.assertEqual(svc.upsert(fair(application_status="closed"))["fair"]["status"], "confirmed")

    def test_new_notion_alert_names_and_status_values(self):
        svc = make_service(self.tmp)
        svc.upsert(fair())
        rec = next(iter(json.loads((self.tmp / "fairs.json").read_text())["fairs"].values()))
        flags = ["taxa_desconhecida", "temporada_longa", "inscricao_encerrada", "lista_de_espera"]
        alerts = core.fair_to_notion_properties({**rec, "flags": flags})["Alertas"]["multi_select"]
        self.assertEqual([a["name"] for a in alerts],
                         ["Taxa desconhecida", "Temporada longa", "Inscrição encerrada", "Lista de espera"])
        for status, label in {"open": "Aberta", "waitlist": "Lista de espera", "closed": "Encerrada", "unknown": "?"}.items():
            props = core.fair_to_notion_properties({**rec, "application_status": status})
            self.assertEqual(props["Inscrição"], {"select": {"name": label}})
        legacy = {k: v for k, v in rec.items() if k != "application_status"}
        self.assertEqual(core.fair_to_notion_properties(legacy)["Inscrição"], {"select": {"name": "?"}})


# --------------------------------------------------------------------------- #
# rescore
# --------------------------------------------------------------------------- #
class RescoreTest(TmpDirCase):
    def setUp(self):
        super().setUp()
        self.cal = FakeCalendar()
        self.notion = FakeNotion()
        self.svc = notion_service(self.tmp, self.notion, self.cal)

    def fairs(self):
        return json.loads((self.tmp / "fairs.json").read_text())["fairs"]

    def edit(self, key, **fields):
        """Simulate a record scored under older rules by rewriting stored facts without rescoring."""
        data = json.loads((self.tmp / "fairs.json").read_text())
        data["fairs"][key].update(fields)
        (self.tmp / "fairs.json").write_text(json.dumps(data), encoding="utf-8")

    def test_opportunity_that_no_longer_qualifies_loses_its_calendar_events_and_syncs_notion(self):
        key = self.svc.upsert(fair(application_deadline="2026-11-01"))["fair"]["key"]
        self.svc.ack()
        announced = self.fairs()[key]["announced_at"]
        self.assertEqual(len(self.cal.events("opp")), 2)
        self.edit(key, application_status="closed")
        out = self.svc.rescore()
        self.assertEqual((out["ok"], out["examined"], out["changed"]), (True, 1, 1))
        self.assertEqual(out["transitions"], {"opportunity->maybe": 1})
        self.assertEqual(out["changed_keys"], [{"key": key, "old_status": "opportunity", "new_status": "maybe",
                                                "old_score": 100, "new_score": 100}])
        self.assertEqual(out["calendar"], {"reconciled": 1, "failed": 0})
        self.assertEqual(self.cal.events("opp"), [])
        rec = self.fairs()[key]
        self.assertEqual((rec["status"], rec["flags"], rec["announced_at"]), ("maybe", ["inscricao_encerrada"], announced))
        self.assertEqual(out["notion"]["records_synced"], 1)
        props = self.notion.pages[rec["notion_page_id"]]["properties"]
        self.assertEqual(props["Status"], {"select": {"name": "Talvez"}})
        self.assertEqual(props["Inscrição"], {"select": {"name": "Encerrada"}})
        self.assertEqual(props["Alertas"], {"multi_select": [{"name": "Inscrição encerrada"}]})
        self.assertFalse(rec["notion_dirty"])

    def test_maybe_that_now_qualifies_gets_calendar_events_and_stays_unannounced(self):
        key = self.svc.upsert(fair(name="Mid Fair", town="Framingham", event_type="mixed", recurrence="annual",
                                   booth_fee_usd=400, vendor_count=300))["fair"]["key"]
        self.assertEqual(self.fairs()[key]["status"], "maybe")
        self.assertEqual(self.cal.events("opp"), [])
        self.edit(key, booth_fee_usd=40, vendor_count=20, application_deadline="2026-11-01")
        out = self.svc.rescore()
        self.assertEqual(out["transitions"], {"maybe->opportunity": 1})
        self.assertEqual(len(self.cal.events("opp")), 2)       # fair + deadline reminder
        self.assertIsNone(self.fairs()[key]["announced_at"])

    def test_transitions_are_counted_per_kind(self):
        keys = [self.svc.upsert(fair(name=f"Pricey Show {n}", town="Wellesley", event_type="holiday", booth_fee_usd=300,
                                     juried=True, start_date=f"2026-11-{14 + n}"))["fair"]["key"] for n in range(3)]
        weekly = self.svc.upsert(fair(name="Weekly Market", town="Framingham", event_type="farmers", recurrence="weekly",
                                      booth_fee_usd=None))["fair"]["key"]
        self.edit(weekly, event_type="craft", recurrence="annual", booth_fee_usd=70, juried=True)
        for key in keys:
            self.edit(key, application_status="waitlist")
        out = self.svc.rescore()
        self.assertEqual(out["transitions"], {"opportunity->maybe": 3, "skip->opportunity": 1})
        self.assertEqual((out["changed"], out["examined"]), (4, 4))

    def test_nothing_changed_is_a_no_op(self):
        self.svc.upsert(fair())
        calls = len(self.notion.calls)
        out = self.svc.rescore()
        self.assertEqual((out["changed"], out["transitions"], out["changed_keys"]), (0, {}, []))
        self.assertEqual(out["calendar"], {"reconciled": 0, "failed": 0})
        self.assertEqual(len(self.notion.calls), calls)

    def test_score_change_without_status_change_refreshes_the_event_description(self):
        key = self.svc.upsert(fair(booth_fee_usd=70))["fair"]["key"]
        self.edit(key, score=90)
        out = self.svc.rescore()
        self.assertEqual(out["transitions"], {})
        self.assertEqual(out["changed_keys"][0]["old_score"], 90)
        self.assertIn(f"Score: {out['changed_keys'][0]['new_score']}/100", self.cal.events("opp")[0]["description"])

    def test_confirmed_done_and_discarded_are_never_touched(self):
        confirmed = self.svc.upsert(fair())["fair"]["key"]
        self.svc.confirm(confirmed)
        discarded = self.svc.upsert(fair(name="Rejected Fair"))["fair"]["key"]
        self.svc.discard(discarded, reason="longe")
        done = self.svc.upsert(fair(name="Past Fair", start_date="2026-10-20"))["fair"]["key"]
        self.svc.confirm(done)
        self.edit(done, status="done")
        for key in (confirmed, discarded, done):
            self.edit(key, application_status="closed")
        before = dict(self.fairs())
        out = self.svc.rescore()
        self.assertEqual((out["examined"], out["changed"]), (0, 0))
        self.assertEqual(self.fairs(), before)
        self.assertEqual(len(self.cal.events("conf")), 2)

    def test_one_calendar_failure_does_not_stop_the_others_and_is_retried_next_time(self):
        bad = self.svc.upsert(fair(name="Bad Calendar Fair"))["fair"]["key"]
        good = self.svc.upsert(fair(name="Sunset Makers Market", start_date="2026-11-21"))["fair"]["key"]
        self.edit(bad, application_status="closed")
        self.edit(good, application_status="closed")
        real_find = self.cal.find

        def find(cal_id, key):
            if key == bad:
                raise RuntimeError("calendar exploded")
            return real_find(cal_id, key)
        self.cal.find = find
        out = self.svc.rescore()
        self.assertEqual(out["transitions"], {"opportunity->maybe": 2})
        self.assertEqual((out["calendar"]["reconciled"], out["calendar"]["failed"]), (1, 1))
        self.assertEqual(out["calendar"]["errors"][0]["key"], bad)
        self.assertTrue(self.fairs()[bad]["calendar_stale"])
        self.assertEqual([e["summary"] for e in self.cal.events("opp")], ["🎪 Bad Calendar Fair — Weston"])
        self.assertEqual(self.fairs()[bad]["status"], "maybe")        # registry already has the new status
        self.cal.find = real_find
        again = self.svc.rescore()
        self.assertEqual((again["changed"], again["calendar"]), (0, {"reconciled": 1, "failed": 0}))
        self.assertEqual(self.cal.events("opp"), [])
        self.assertNotIn("calendar_stale", self.fairs()[bad])

    def test_notion_failure_is_reported_and_leaves_records_dirty(self):
        key = self.svc.upsert(fair())["fair"]["key"]
        self.edit(key, application_status="closed")
        self.notion.fail = core.NotionError("Notion HTTP 500: boom", 500)
        out = self.svc.rescore()
        self.assertEqual((out["ok"], out["notion"]["records_failed"]), (True, 1))
        self.assertTrue(self.fairs()[key]["notion_dirty"])
        self.assertEqual(self.fairs()[key]["status"], "maybe")

    def test_cli_wiring(self):
        args = core.build_parser().parse_args(["rescore"])
        seen = []

        class Stub:
            def rescore(self):
                seen.append(True)
                return {"ok": True}
        self.assertEqual(core.run_command(args, Stub()), {"ok": True})
        self.assertEqual(seen, [True])


if __name__ == "__main__":
    unittest.main()
