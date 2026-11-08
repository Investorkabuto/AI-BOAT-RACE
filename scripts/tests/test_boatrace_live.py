"""boatrace_live の解析のテスト。fixtures の *_20261108_19_11.html は 2026-11-08 下関11R の公式ページの実物（締切時オッズ）。

確定払戻（3連単 1-2-5 ¥3,520・3連複 1=2=5 ¥1,410・2連単 1-2 ¥280・2連複 1=2 ¥190）と、締切時オッズが一致することで並びを確かめる。
実行: python -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import boatrace_live as L  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def page(name: str) -> str:
    return (FIX / f"{name}_20261108_19_11.html").read_text(encoding="utf-8")


class Odds(unittest.TestCase):
    def test_3t(self):
        o = L.parse_odds3t(page("odds3t"))
        self.assertEqual(len(o), 120)
        self.assertEqual(o["1-2-5"], 35.2)
        self.assertEqual(o["1-2-3"], 9.1)
        self.assertEqual(o["2-1-3"], 76.8)

    def test_3f(self):
        o = L.parse_odds3f(page("odds3f"))
        self.assertEqual(len(o), 20)
        self.assertEqual(o["1=2=5"], 14.1)
        self.assertTrue(all(k.count("=") == 2 for k in o))

    def test_2tf(self):
        tan, fuku = L.parse_odds2tf(page("odds2tf"))
        self.assertEqual((len(tan), len(fuku)), (30, 15))
        self.assertEqual(tan["1-2"], 2.8)
        self.assertEqual(fuku["1=2"], 1.9)

    def test_as_of(self):
        self.assertEqual(L.odds_updated_at(page("odds3t")), "締切時")

    def test_broken(self):
        self.assertIsNone(L.parse_odds3t("<html></html>"))
        self.assertIsNone(L.parse_odds2tf(page("odds3f")))


class Beforeinfo(unittest.TestCase):
    def test_parse(self):
        b = L.parse_beforeinfo(page("beforeinfo"))
        self.assertEqual([x["boat"] for x in b["boats"]], [1, 2, 3, 4, 5, 6])
        self.assertEqual(b["boats"][0]["exhibit_time"], 6.79)
        self.assertEqual(b["boats"][0]["tilt"], -0.5)
        self.assertEqual(b["boats"][0]["weight"], 52.0)
        self.assertEqual(b["start_exhibition"][0], {"course": 1, "boat": 1, "st": ".13"})
        self.assertEqual(len(b["start_exhibition"]), 6)
        self.assertEqual(b["weather"]["wind_m"], 1.0)
        self.assertEqual(b["weather"]["wave_cm"], 1.0)
        self.assertEqual(b["weather"]["weather"], "曇り")

    def test_before_exhibition(self):
        html = page("beforeinfo")
        for t in ["6.79", "6.76", "6.75", "6.78", "6.77"]:
            html = html.replace(f">{t}<", "><")
        self.assertIsNone(L.parse_beforeinfo(html))


class Schedule(unittest.TestCase):
    def race(self, focus: bool):
        return {"race_id": "20261109-19-11", "deadline_s": 10_000, "focus": focus}

    def test_t30_for_all_races(self):
        self.assertEqual(L.due_tasks(self.race(False), 10_000 - 29 * 60, set(), 0), ["t30"])
        self.assertEqual(L.due_tasks(self.race(True), 10_000 - 29 * 60, set(), 0), ["t30"])

    def test_t10_t7_only_for_focus(self):
        self.assertEqual(L.due_tasks(self.race(False), 10_000 - 9 * 60, set(), 0), ["beforeinfo"])
        self.assertEqual(L.due_tasks(self.race(True), 10_000 - 9 * 60, set(), 0), ["beforeinfo", "t10"])
        self.assertEqual(L.due_tasks(self.race(True), 10_000 - 6 * 60, {("20261109-19-11", "beforeinfo")}, 0), ["t7"])

    def test_done_and_retry(self):
        r = self.race(True)
        self.assertEqual(L.due_tasks(r, 10_000 - 9 * 60, {(r["race_id"], "t10")}, 10_000 - 9 * 60 - 30), [])
        self.assertEqual(L.due_tasks(r, 10_000 - 4 * 60, set(), 0), [])


if __name__ == "__main__":
    unittest.main()
