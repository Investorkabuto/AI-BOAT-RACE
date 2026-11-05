"""boatrace_text の解析のテスト。fixtures/b261105.lzh は 2026-11-05 の番組表（Bファイル）の実物。

実行: python -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import boatrace_text as bt  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "b261105.lzh"
DATE = "2026-11-05"


def raw() -> bytes:
    return bt.unpack(FIXTURE.read_bytes())


def parse_edited(old: str, new: str, date: str = DATE) -> dict:
    """実ファイルの文字列を1か所置き換えて解析する（壊れ方ごとの挙動を確かめる）"""
    text = raw().decode("cp932")
    assert text.count(old) >= 1, f"置き換え元が見つかりません: {old!r}"
    return bt.parse_b(text.replace(old, new, 1).encode("cp932"), date)


class RealFile(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = raw()
        cls.res = bt.parse_b(cls.data, DATE)
        cls.venues = {v["jcd"]: v for v in cls.res["venues"]}

    def test_counts(self) -> None:
        self.assertEqual(self.res["errors"], [])
        self.assertEqual(len(self.res["venues"]), 12)
        races = [r for v in self.res["venues"] for r in v["races"]]
        self.assertEqual(len(races), 144)
        self.assertEqual(sum(len(r["racers"]) for r in races), 864)
        self.assertTrue(all([x["boat"] for x in r["racers"]] == [1, 2, 3, 4, 5, 6] for r in races))

    def test_hash_is_of_the_unpacked_text(self) -> None:
        self.assertEqual(self.res["sha256"], bt.sha256_hex(self.data))
        self.assertTrue(self.res["sha256"].startswith("70aec610d35ca4c5"))

    def test_venue_header(self) -> None:
        fukuoka = self.venues["22"]
        self.assertEqual((fukuoka["name"], fukuoka["day"], fukuoka["series_title"]), ("福岡", 5, "ばんえい十勝杯"))
        # 節の名前に「年」を含んでも日付行と取り違えない
        self.assertEqual(self.venues["21"]["series_title"], "BTSオラレ日南開設15周年記念")
        self.assertEqual(self.venues["12"]["day"], 1)
        self.assertEqual(self.venues["09"]["day"], 6)

    def test_race_header(self) -> None:
        r1 = self.venues["22"]["races"][0]
        self.assertEqual(
            {k: r1[k] for k in ("rno", "race_name", "fixed_course", "distance", "deadline")},
            {"rno": 1, "race_name": "カタメン1一", "fixed_course": False, "distance": 1800, "deadline": "10:45"},
        )

    def test_fixed_course_is_a_flag_not_part_of_the_name(self) -> None:
        races = [r for v in self.res["venues"] for r in v["races"]]
        self.assertEqual(sum(r["fixed_course"] for r in races), 3)
        self.assertFalse(any("進入固定" in r["race_name"] for r in races))
        self.assertIn("サンライズY", [r["race_name"] for r in races if r["fixed_course"]])

    def test_first_racer_every_field(self) -> None:
        self.assertEqual(
            self.venues["22"]["races"][0]["racers"][0],
            {
                "boat": 1, "toban": "3874", "name": "山本寛久", "age": 50, "branch": "岡山", "weight": 52, "grade": "A2",
                "nat_win": 6.68, "nat_2r": 44.9, "loc_win": 5.92, "loc_2r": 45.83,
                "motor_no": 59, "motor_2r": 39.74, "boat_no": 141, "boat_2r": 35.51,
                "series": [[3, 2], [1], [2, 4], [1, 2]], "next_rno": 10,
            },
        )

    def test_name_with_a_space_and_series_marks(self) -> None:
        racers = self.venues["22"]["races"][0]["racers"]
        self.assertEqual(racers[1]["name"], "澤 大介")  # 全角空白は半角ひとつ（出走表の取り込みと同じ）
        self.assertEqual(racers[2]["series"], [[6], [6, "S"], [4, 5], [6]])  # S は記号のまま
        self.assertEqual(racers[3]["series"], [[], [], [], []])  # 出走のない節

    def test_series_length_follows_the_series_day(self) -> None:
        for v in self.res["venues"]:
            for r in v["races"]:
                for x in r["racers"]:
                    self.assertEqual(len(x["series"]), v["day"] - 1)

    def test_no_result_is_zero_not_missing(self) -> None:
        # 勝率 0.00 は「実績なし」。欠損（None）にはしない
        r = self.venues["22"]["races"][0]["racers"][5]
        self.assertEqual((r["nat_win"], r["nat_2r"], r["loc_win"], r["loc_2r"]), (0.0, 0.0, 0.0, 0.0))


class EdgeCases(unittest.TestCase):
    def test_motor_rate_100(self) -> None:
        # 100.00 は 6 桁を使い切る（桁をずらさず読めること）
        res = parse_edited(" 59 39.74141 35.51", " 59100.00141 35.51")
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["venues"][0]["races"][0]["racers"][0]["motor_2r"], 100.0)
        self.assertEqual(res["venues"][0]["races"][0]["racers"][0]["boat_no"], 141)

    def test_bad_grade_drops_only_that_race(self) -> None:
        res = parse_edited("52A2 6.68", "52Z9 6.68")
        self.assertEqual(len(res["errors"]), 1)
        self.assertIn("級別", res["errors"][0])
        self.assertEqual(sum(len(v["races"]) for v in res["venues"]), 143)

    def test_rate_out_of_range_drops_the_race(self) -> None:
        res = parse_edited(" 6.68 44.90", "16.68 44.90")
        self.assertEqual(len(res["errors"]), 1)
        self.assertIn("範囲外", res["errors"][0])

    def test_wrong_date_skips_the_venue_with_a_reason(self) -> None:
        res = bt.parse_b(raw(), "2026-11-06")
        self.assertEqual(res["venues"], [])
        self.assertEqual(len(res["errors"]), 12)
        self.assertIn("日付", res["errors"][0])

    def test_series_in_a_future_slot_is_rejected(self) -> None:
        # 第5日なのに当日の枠（67〜68桁目）に成績がある
        res = parse_edited("321 2412    10", "321 24123   10")
        self.assertEqual(len(res["errors"]), 1)
        self.assertIn("今節成績", res["errors"][0])

    def test_truncated_file_is_refused(self) -> None:
        text = raw().decode("cp932")
        with self.assertRaises(bt.ParseError):
            bt.parse_b(text[: len(text) // 2].encode("cp932"), DATE)

    def test_not_a_b_file_is_refused(self) -> None:
        with self.assertRaises(bt.ParseError):
            bt.parse_b("hello\r\n".encode("cp932"), DATE)

    def test_url(self) -> None:
        self.assertEqual(bt.b_url("2026-11-05"), "https://www1.mbrace.or.jp/od2/B/202611/b261105.lzh")


class Series(unittest.TestCase):
    def test_days_and_marks(self) -> None:
        self.assertEqual(bt.parse_series("321 24    ", 4), [[3, 2], [1], [2, 4]])  # 第4日: 前の3日分
        self.assertEqual(bt.parse_series("321S      ", 3), [[3, 2], [1, "S"]])  # 第3日: 前の2日分。数字以外はそのまま
        self.assertEqual(bt.parse_series("          ", 1), [])
        self.assertEqual(bt.parse_series("  1       ", 3), [[], [1]])  # 出走のない日は空の並び

    def test_second_slot_only_is_rejected(self) -> None:
        with self.assertRaises(bt.ParseError):
            bt.parse_series(" 3        ", 2)


if __name__ == "__main__":
    unittest.main()
