"""公式HTMLの出走表ページの解析のテスト。fixtures/racelist_*.html は公式サイトの出走表ページの実物。

- racelist_20261109_11_08.html: びわこ8R（2026-11-09）。4号艇 芝田浩治のモーターは16号機・2連率 28.15・3連率 45.19

実行: python -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_boatrace as fb  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


class Racelist(unittest.TestCase):
    def setUp(self) -> None:
        self.entrants = fb.parse_entrants((FIXTURES / "racelist_20261109_11_08.html").read_text(encoding="utf-8"))

    def test_six_boats(self) -> None:
        self.assertEqual([e["boat"] for e in self.entrants], [1, 2, 3, 4, 5, 6])

    def test_motor_official_rates(self) -> None:
        motors = [(e.get("motor_no"), e.get("motor_2r"), e.get("motor_3r")) for e in self.entrants]
        self.assertEqual(
            motors,
            [(37, 40.94, 58.27), (71, 33.09, 51.47), (60, 18.80, 39.10), (16, 28.15, 45.19), (55, 30.83, 51.88), (22, 33.58, 51.49)],
        )

    def test_basic_fields_unchanged(self) -> None:
        e = self.entrants[0]
        self.assertEqual((e["toban"], e["grade"], e["age"]), ("4936", "A2", 30))

    def test_no_motor_column(self) -> None:
        # 見出しが無いページでは、モーターは省いて選手だけ返す
        html = (FIXTURES / "racelist_20261109_11_08.html").read_text(encoding="utf-8").replace("モーター", "M")
        ents = fb.parse_entrants(html)
        self.assertEqual(len(ents), 6)
        self.assertNotIn("motor_no", ents[0])


if __name__ == "__main__":
    unittest.main()
