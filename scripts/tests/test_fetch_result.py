"""公式HTMLの結果ページの解析のテスト。fixtures/result_*.html は公式サイトの結果ページの実物。

- result_20261107_02_07.html: 戸田7R。単勝だけ成立、ほかの券種は「不成立」、着順の表なし、返還艇 1・2・3・5
- result_20261107_03_02.html: 江戸川2R。単勝と2連単だけ成立、着順は2艇（6→4）、返還艇 1・2・3・5

実行: python -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_boatrace as fb  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def parse(name: str) -> dict | None:
    return fb.parse_result((FIXTURES / name).read_text(encoding="utf-8"))


class UnsoldBetTypes(unittest.TestCase):
    def test_only_tansho_established(self) -> None:
        r = parse("result_20261107_02_07.html")
        self.assertIsNotNone(r)
        self.assertEqual(r["status"], "official")
        self.assertEqual(r["finish"], [])
        self.assertEqual(r["refunded_boats"], [1, 2, 3, 5])
        self.assertEqual(r["payouts"], [{"bet_type": "tansho", "combo": "6", "payout": 130}])
        self.assertEqual(sorted(r["unsold"]), sorted(["sanrentan", "sanrenpuku", "nirentan", "nirenpuku", "kakurenpuku", "fukusho"]))

    def test_two_finishers(self) -> None:
        r = parse("result_20261107_03_02.html")
        self.assertIsNotNone(r)
        self.assertEqual(r["status"], "official")
        self.assertEqual(r["finish"], [[6], [4]])
        self.assertEqual(r["refunded_boats"], [1, 2, 3, 5])
        self.assertIn({"bet_type": "nirentan", "combo": "6-4", "payout": 300}, r["payouts"])
        self.assertIn({"bet_type": "tansho", "combo": "6", "payout": 180}, r["payouts"])
        self.assertEqual(len(r["payouts"]), 2)
        self.assertNotIn("nirentan", r["unsold"])
        self.assertIn("sanrentan", r["unsold"])
        self.assertIn("nirenpuku", r["unsold"])


if __name__ == "__main__":
    unittest.main()
