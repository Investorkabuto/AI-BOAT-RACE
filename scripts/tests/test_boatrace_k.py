"""boatrace_text の K ファイル（競走成績）の解析のテスト。fixtures/k261104.lzh は 2026-11-04 の実物。

実行: python -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import boatrace_text as bt  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "k261104.lzh"
DATE = "2026-11-04"


def raw() -> bytes:
    return bt.unpack(FIXTURE.read_bytes())


def parse_edited(old: str, new: str, date: str = DATE) -> dict:
    """実ファイルの文字列を1か所置き換えて解析する（壊れ方ごとの挙動を確かめる）"""
    text = raw().decode("cp932")
    assert text.count(old) >= 1, f"置き換え元が見つかりません: {old!r}"
    return bt.parse_k(text.replace(old, new, 1).encode("cp932"), date)


class RealFile(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.res = bt.parse_k(raw(), DATE)
        cls.races = {(v["jcd"], r["rno"]): r for v in cls.res["venues"] for r in v["races"]}

    def test_counts(self) -> None:
        self.assertEqual(self.res["errors"], [])
        self.assertEqual(len(self.res["venues"]), 12)
        self.assertEqual(len(self.races), 144)
        self.assertEqual(len(self.res["sha256"]), 64)

    def test_venue_header(self) -> None:
        v = self.res["venues"][0]
        self.assertEqual((v["jcd"], v["name"], v["day"]), ("24", "大村", 6))

    def test_first_race_of_omura(self) -> None:
        r = self.races[("24", 1)]
        self.assertEqual((r["weather"], r["wind_dir"], r["wind_m"], r["wave_cm"], r["kimarite"]), ("曇り", "北", 1, 1, "逃げ"))
        self.assertEqual(
            r["rows"][0],
            {"rank": "1", "boat": 1, "toban": "4423", "motor_no": 53, "boat_no": 61, "tenji": 6.81, "course": 1, "st": 0.03, "time": 109.4},
        )
        # 完走しなかった艇（5・6着）にタイムは無い
        self.assertEqual([x["time"] for x in r["rows"][4:]], [None, None])
        self.assertEqual([x["boat"] for x in r["rows"]], [1, 3, 6, 2, 4, 5])  # 着順の並び
        self.assertEqual([x["course"] for x in r["rows"]], [1, 3, 6, 2, 4, 5])

    def test_payouts_use_app_combo_style(self) -> None:
        pay = {(p["bet_type"], p["combo"]): p for p in self.races[("24", 1)]["payouts"]}
        self.assertEqual(pay[("tansho", "1")]["payout"], 120)
        self.assertEqual(pay[("nirentan", "1-3")]["payout"], 300)
        self.assertEqual(pay[("nirenpuku", "1=3")]["payout"], 260)  # 順序のない券種は "="
        self.assertEqual(pay[("sanrenpuku", "1=3=6")]["payout"], 690)
        self.assertEqual(pay[("sanrentan", "1-3-6")], {"bet_type": "sanrentan", "combo": "1-3-6", "payout": 1060, "pop": 2})
        # 複勝は2艇、拡連複は3組（2行目以降は勝式の名前が無い）
        self.assertEqual(sorted((p["combo"], p["payout"]) for p in self.races[("24", 1)]["payouts"] if p["bet_type"] == "fukusho"), [("1", 110), ("3", 230)])
        self.assertEqual(sorted(p["combo"] for p in self.races[("24", 1)]["payouts"] if p["bet_type"] == "kakurenpuku"), ["1=3", "1=6", "3=6"])

    def test_marks_and_absence(self) -> None:
        flying = self.races[("17", 8)]["rows"][-1]  # 宮島8R: フライング
        self.assertEqual((flying["rank"], flying["boat"], flying["st"], flying["time"]), ("F", 4, 0.02, None))
        absent = self.races[("19", 10)]["rows"][-1]  # 下関10R: 欠場。展示・進入・STが無い
        self.assertEqual((absent["rank"], absent["tenji"], absent["course"], absent["st"], absent["time"]), ("K0", None, None, None, None))
        self.assertEqual(self.races[("22", 4)]["rows"][-1]["rank"], "S0")  # 失格

    def test_two_flyers(self) -> None:
        self.assertEqual([x["rank"] for x in self.races[("17", 10)]["rows"]], ["1", "2", "3", "4", "F", "F"])

    def test_wide_name_and_three_digit_boat_number(self) -> None:
        # 氏名が8桁を使い切る行と、ボート番号が3桁の行（桁位置が崩れないこと）
        rows = [x for r in self.races.values() for x in r["rows"]]
        self.assertTrue(any(x["boat_no"] and x["boat_no"] >= 100 for x in rows))
        self.assertTrue(all(len(x["toban"]) == 4 for x in rows))

    def test_url(self) -> None:
        self.assertEqual(bt.k_url("2026-11-04"), "https://www1.mbrace.or.jp/od2/K/202611/k261104.lzh")


class Edited(unittest.TestCase):
    def test_wrong_date_skips_every_venue_with_a_reason(self) -> None:
        r = bt.parse_k(raw(), "2026-11-05")
        self.assertEqual(r["venues"], [])
        self.assertEqual(len(r["errors"]), 12)
        self.assertIn("日付", r["errors"][0])

    def test_truncated_file_is_refused(self) -> None:
        text = raw().decode("cp932")
        with self.assertRaises(bt.ParseError):
            bt.parse_k(text[: len(text) // 2].encode("cp932"), DATE)

    def test_not_a_k_file_is_refused(self) -> None:
        with self.assertRaises(bt.ParseError):
            bt.parse_k(b"STARTB\r\nFINALB\r\n", DATE)

    def test_mismatch_between_finish_and_sanrentan_is_a_race_error(self) -> None:
        # 大村1R の3連単を、着順と合わない組番にする → そのレースだけ取り込まれず、理由が残る
        r = parse_edited("３連単   1-3-6     1060", "３連単   2-3-6     1060")
        self.assertTrue(any("24 1R" in e and "3連単" in e for e in r["errors"]), r["errors"])
        omura = next(v for v in r["venues"] if v["jcd"] == "24")
        self.assertEqual(sorted(x["rno"] for x in omura["races"]), list(range(2, 13)))

    def test_broken_row_is_a_race_error_not_a_crash(self) -> None:
        r = parse_edited("  01  1 4423 ", "  0X  1 4423 ")
        self.assertEqual(len(r["errors"]), 1)
        self.assertIn("24 1R", r["errors"][0])

    def test_garbled_time_is_rejected(self) -> None:
        r = parse_edited("     1.49.4", "     1.4x.4")
        self.assertTrue(any("レースタイム" in e for e in r["errors"]), r["errors"])


class Payouts(unittest.TestCase):
    def test_unsold_and_special_pay(self) -> None:
        # 実ファイルにある書き方（2026-09-30 / 2026-10-06 分）
        lines = [
            "        単勝        特払い   70          ",
            "        複勝     6         1830  1          120  ",
            "        ２連単   6-1      36920  人気    24 ",
            "        ２連複   1-6       4510  人気    10 ",
            "        拡連複   不成立",
            "",
            "",
            "        ３連単   不成立",
            "        ３連複   1-3-6    14610  人気    16 ",
        ]
        pay, unsold = bt.parse_k_payouts(lines)
        self.assertEqual(unsold, ["kakurenpuku", "sanrentan"])
        self.assertIn({"bet_type": "tansho", "combo": "*", "payout": 70, "pop": None}, pay)
        self.assertEqual([p["payout"] for p in pay if p["bet_type"] == "fukusho"], [1830, 120])
        self.assertIn({"bet_type": "sanrenpuku", "combo": "1=3=6", "payout": 14610, "pop": 16}, pay)

    def test_unknown_line_is_an_error(self) -> None:
        with self.assertRaises(bt.ParseError):
            bt.parse_k_payouts(["        ３連単   1-2-3  abc"])
        with self.assertRaises(bt.ParseError):
            bt.parse_k_payouts(["  何かの行"])

    def test_late_start_marks(self) -> None:
        self.assertEqual(bt.parse_k_row("  L0  4 4857 加　藤　　翔　馬  4   34  6.89   4   L1.14      .  . ")["st"], 1.14)
        row = bt.parse_k_row("  L1  2 5323 香　川　　陽　太 70   31  6.84   2   L .        .  . ")
        self.assertEqual((row["rank"], row["st"], row["course"]), ("L1", None, 2))


if __name__ == "__main__":
    unittest.main()
