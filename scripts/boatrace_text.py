"""公式テキストデータ（www1.mbrace.or.jp/od2）の取得と解析。

  B ファイル（番組表）: 前日の夕方から翌日分が出る。出走表（締切予定時刻つき）と基礎数値
                        （全国/当地の勝率・2連率、モーター/ボートの番号・2連率、今節成績）。
  K ファイル（競走成績）: その日の夜に出る。着順・展示タイム・進入コース・スタートタイミング・天候・風・波・決まり手・全券種の払戻金
                        （要件定義 v1.0 の系統3。桁位置は 2026-09〜11 の40日分・約4.1万行で確かめた。fixtures/k261104.lzh が実物）。

形式は LZH 圧縮・Shift_JIS（cp932）・桁固定のテキスト。桁位置は 2026-11-05 分の実ファイルで全選手行（864行）を調べて決めた
（scripts/tests/fixtures/b261105.lzh が実物）。
全角・半角が混ざるが、1文字を1桁と数える（デコード後の文字位置）。

解析できなかったレースは結果に入れず errors に理由を積む。呼び出し側は、解析できたレースだけを送り、errors をログに出す
（公式サイトの形式が変わったときに、壊れたデータを保存しないため）。
"""
from __future__ import annotations

import hashlib
import io
import re
import unicodedata
import urllib.error
import urllib.request

OD2 = "https://www1.mbrace.or.jp/od2"
USER_AGENT = "ai-boat-race-ingest/1.0 (+https://github.com/Investorkabuto/AI-BOAT-RACE)"

GRADES = ("A1", "A2", "B1", "B2")

# 選手行の項目と桁位置 [開始, 終了)。1行は 73 文字
#   '1 3874山本寛久50岡山52A2 6.68 44.90 5.92 45.83 59 39.74141 35.51 321 2412    10'
COLS = {
    "boat": (0, 1),
    "toban": (2, 6),
    "name": (6, 10),
    "age": (10, 12),
    "branch": (12, 14),
    "weight": (14, 16),
    "grade": (16, 18),
    "nat_win": (18, 23),
    "nat_2r": (23, 29),
    "loc_win": (29, 34),
    "loc_2r": (34, 40),
    "motor_no": (40, 43),
    "motor_2r": (43, 49),  # 100.00 のとき 6 桁を使い切る
    "boat_no": (49, 52),
    "boat_2r": (52, 58),
    "series": (59, 71),  # 今節成績: 1日2枠 × 最大6日（前日までの着順。当日の分は空白。6日目以降の節で12桁を使い切ることを 2026-11-02 の江戸川で確認）
    "next_rno": (71, 73),  # 公式の項目「早見」: 同じ日にもう1レース出走する場合のそのレース番号（空欄は1走だけ）
}
ROW_LEN = 73
SERIES_SLOTS_PER_DAY = 2
SERIES_DAYS = 6

_RACE_HEAD = re.compile(r"^\s*(\d{1,2})R\s+(.*?)\s+H(\d+)m\s+電話投票締切予定(\d{1,2}):(\d{2})\s*$")
_ROW_START = re.compile(r"^[1-6] \d{4}")
# 場のデータが無いときの定型文（B: 「更新は、いましばらくお待ちください」、K: 「全レース終了後に登録されます」。2024-11-04 の江戸川で確認）
_NO_DATA = re.compile(r"お待ちください|登録されます")


class ParseError(ValueError):
    pass


def nfkc(s: str) -> str:
    """全角英数・全角空白を半角にそろえ、空白をひとつにまとめる（出走表の取り込みと同じ正規化）"""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip()


# ------------------------------------------------------------------ 取得

def b_url(date: str) -> str:
    """date は YYYY-MM-DD。例 2026-11-05 → .../od2/B/202611/b261105.lzh"""
    y, m, d = date.split("-")
    return f"{OD2}/B/{y}{m}/b{y[2:]}{m}{d}.lzh"


def download(url: str, timeout: float = 30.0) -> bytes | None:
    """ファイルを取得する。まだ公開されていない（404）ときは None"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def unpack(lzh: bytes) -> bytes:
    """LZH から中身のテキスト（Shift_JIS のバイト列）を取り出す。中身は1ファイルの想定"""
    import lhafile  # 遅延 import: 解析だけのテストや probe では LZH の展開が要らない

    lz = lhafile.Lhafile(io.BytesIO(lzh))
    names = [i.filename for i in lz.infolist()]
    if len(names) != 1:
        raise ParseError(f"LZH の中身が1ファイルではありません: {names}")
    return lz.read(names[0])


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ------------------------------------------------------------------ B ファイル

def _num(s: str, lo: float, hi: float, what: str, digits: int | None = None) -> float | None:
    t = s.strip()
    if not t:
        return None
    try:
        v = float(t)
    except ValueError as e:
        raise ParseError(f"{what} が数値ではありません: {s!r}") from e
    if not lo <= v <= hi:
        raise ParseError(f"{what} が範囲外です: {v}")
    return round(v, digits) if digits is not None else v


def _int(s: str, lo: int, hi: int, what: str) -> int | None:
    t = s.strip()
    if not t:
        return None
    if not t.isdigit():
        raise ParseError(f"{what} が整数ではありません: {s!r}")
    v = int(t)
    if not lo <= v <= hi:
        raise ParseError(f"{what} が範囲外です: {v}")
    return v


def parse_series(cell: str, day: int | None) -> list[list[int | str]]:
    """今節成績（12桁）を日ごとの着順の並びにする。前日まで（day-1 日分）、1日2枠。

    着順は 1〜6 の整数。数字以外の記号（S, F）はそのまま文字で残す（意味は公式の凡例に従う）。
    出走しなかった日は空の並び。1日に1走だけなら先頭の枠に入る（2枠目だけに入る行は不正として拒否する）。
    """
    if len(cell) != SERIES_SLOTS_PER_DAY * SERIES_DAYS:
        raise ParseError(f"今節成績の桁数が違います: {cell!r}")
    days = [cell[i : i + SERIES_SLOTS_PER_DAY] for i in range(0, len(cell), SERIES_SLOTS_PER_DAY)]
    if day is not None:
        past = max(day - 1, 0)
        if "".join(days[past:]).strip():
            raise ParseError(f"第{day}日なのに、当日以降の枠に今節成績があります: {cell!r}")
        days = days[:past]
    out: list[list[int | str]] = []
    for d in days:
        if d[0] == " " and d[1] != " ":
            raise ParseError(f"今節成績の枠の詰め方が想定と違います: {cell!r}")
        out.append([int(c) if c in "123456" else c for c in d if c != " "])
    return out


def parse_racer(line: str, day: int | None) -> dict:
    if len(line) != ROW_LEN:
        raise ParseError(f"選手行が {ROW_LEN} 文字ではありません（{len(line)}）: {line!r}")
    f = {k: line[a:b] for k, (a, b) in COLS.items()}
    grade = f["grade"].strip()
    if grade not in GRADES:
        raise ParseError(f"級別が不正です: {grade!r}")
    toban = f["toban"]
    if not re.fullmatch(r"\d{4}", toban):
        raise ParseError(f"登録番号が不正です: {toban!r}")
    name = nfkc(f["name"])
    if not name:
        raise ParseError("氏名がありません")
    return {
        "boat": int(f["boat"]),
        "toban": toban,
        "name": name,
        "age": _int(f["age"], 15, 90, "年齢"),
        "branch": nfkc(f["branch"]) or None,
        "weight": _int(f["weight"], 30, 100, "体重"),
        "grade": grade,
        # 勝率は 0.00〜10.00。0.00 は「実績なし」の意味で入ることがある（新人や当地初出走など）
        "nat_win": _num(f["nat_win"], 0, 10, "全国勝率", 2),
        "nat_2r": _num(f["nat_2r"], 0, 100, "全国2連率", 2),
        "loc_win": _num(f["loc_win"], 0, 30, "当地勝率", 2),  # 出走数が少ないと 10 を超える（2023-11 に 12.00 を確認）
        "loc_2r": _num(f["loc_2r"], 0, 100, "当地2連率", 2),
        "motor_no": _int(f["motor_no"], 1, 999, "モーター番号"),
        "motor_2r": _num(f["motor_2r"], 0, 100, "モーター2連率", 2),
        "boat_no": _int(f["boat_no"], 1, 999, "ボート番号"),
        "boat_2r": _num(f["boat_2r"], 0, 100, "ボート2連率", 2),
        "series": parse_series(f["series"], day),
        "next_rno": _int(f["next_rno"], 1, 12, "早見（同日の次のレース番号）"),
    }


def parse_race_head(line: str) -> dict:
    m = _RACE_HEAD.match(unicodedata.normalize("NFKC", line))
    if not m:
        raise ParseError(f"レース見出しを解析できません: {line!r}")
    rno, name, dist, hh, mm = m.groups()
    if not (1 <= int(rno) <= 12 and int(hh) <= 29 and int(mm) <= 59):
        raise ParseError(f"レース番号か締切時刻が範囲外です: {line!r}")
    name = nfkc(name)
    fixed = "進入固定" in name
    name = nfkc(name.replace("進入固定", ""))
    return {"rno": int(rno), "race_name": name, "fixed_course": fixed, "distance": int(dist), "deadline": f"{int(hh):02d}:{mm}"}


def parse_b(data: bytes, date: str) -> dict:
    """B ファイル（バイト列）を解析する。date は YYYY-MM-DD（見出しの日付との照合用）。

    戻り値: {"date", "sha256", "venues": [{jcd, name, day, series_title, races: [{rno, race_name, fixed_course,
             distance, deadline, racers: [...]}]}], "errors": [理由, ...]}
    """
    text = data.decode("cp932")
    lines = text.split("\r\n") if "\r\n" in text else text.split("\n")
    if not lines or lines[0].strip() != "STARTB":
        raise ParseError("先頭が STARTB ではありません。Bファイルではない可能性があります")
    if not any(l.strip() == "FINALB" for l in lines[-5:]):
        raise ParseError("末尾が FINALB ではありません。ファイルが途中で切れている可能性があります")

    y, m, d = date.split("-")
    want_date = f"{y}年{int(m)}月{int(d)}日"
    venues: list[dict] = []
    errors: list[str] = []
    missing: list[str] = []
    i = 0
    while i < len(lines):
        mm = re.fullmatch(r"(\d\d)BBGN", lines[i].strip())
        if not mm:
            i += 1
            continue
        jcd = mm.group(1)
        end = next((k for k in range(i + 1, len(lines)) if lines[k].strip() == f"{jcd}BEND"), None)
        if end is None:
            errors.append(f"{jcd}: BEND がありません")
            break
        block = lines[i + 1 : end]
        i = end + 1
        if any(_NO_DATA.search(l) for l in block):  # 公式のアーカイブに、この場のデータが入っていない（本文が定型文だけ）
            missing.append(jcd)
            continue

        # 場の見出し: 第N日、日付、節の名前
        norm = [unicodedata.normalize("NFKC", l) for l in block]
        day_m = next((re.search(r"第\s*(\d+)\s*日", l) for l in norm[:3] if re.search(r"第\s*(\d+)\s*日", l)), None)
        date_line = next((l for l in norm[:12] if re.search(r"\d{4}年\s*\d+月\s*\d+日", l)), "")
        got_date = re.sub(r"\s+", "", re.search(r"\d{4}年\s*\d+月\s*\d+日", date_line).group(0)) if date_line else ""
        if got_date != want_date:
            errors.append(f"{jcd}: 日付が {want_date} ではありません（{got_date or '不明'}）。この場は取り込みません")
            continue
        day = int(day_m.group(1)) if day_m else None
        title_idx = next((k for k, l in enumerate(norm[:12]) if "番組表" in l), None)
        title = ""
        if title_idx is not None:
            # 番組表の見出しの次にある、日付行（第N日 …年…月…日）でも注意書き（－内容については…－）でもない最初の行が節の名前
            title = next(
                (nfkc(l) for l in norm[title_idx + 1 : 12] if l.strip() and not re.search(r"第\s*\d+\s*日|\d{4}年|^\s*-", l)),
                "",
            )
        name_m = re.match(r"ボートレース(.+?)\s{2,}\d+月", norm[0]) if norm else None
        venue_name = re.sub(r"\s+", "", name_m.group(1)) if name_m else ""

        races: list[dict] = []
        k = 0
        while k < len(block):
            if "電話投票締切予定" not in block[k]:
                k += 1
                continue
            head_line = block[k].strip()
            try:
                head = parse_race_head(block[k])
                racers: list[dict] = []
                k += 1
                while k < len(block) and block[k].strip():
                    if _ROW_START.match(block[k]):
                        racers.append(parse_racer(block[k], day))
                    k += 1
                boats = [r["boat"] for r in racers]
                if not racers or len(set(boats)) != len(boats):
                    raise ParseError(f"枠番が不正です: {boats}")
                if len(racers) < 5:
                    raise ParseError(f"選手が {len(racers)} 人しかいません")
                races.append({**head, "racers": racers})
            except ParseError as e:
                errors.append(f"{jcd} {nfkc(head_line)[:20]}: {e}")
        rnos = [r["rno"] for r in races]
        if len(set(rnos)) != len(rnos):
            errors.append(f"{jcd}: レース番号が重複しています: {rnos}")
            continue
        venues.append({"jcd": jcd, "name": venue_name, "day": day, "series_title": title, "races": races})
    return {"date": date, "sha256": sha256_hex(data), "venues": venues, "errors": errors, "missing": missing}


# ------------------------------------------------------------------ K ファイル（競走成績）

def k_url(date: str) -> str:
    """date は YYYY-MM-DD。例 2026-11-04 → .../od2/K/202611/k261104.lzh（その日の夜に出る）"""
    y, m, d = date.split("-")
    return f"{OD2}/K/{y}{m}/k{y[2:]}{m}{d}.lzh"


# 払戻金の見出しの勝式 → アプリの券種
K_BET_TYPES = {
    "単勝": "tansho",
    "複勝": "fukusho",
    "2連単": "nirentan",
    "2連複": "nirenpuku",
    "拡連複": "kakurenpuku",
    "3連単": "sanrentan",
    "3連複": "sanrenpuku",
}
# 順序のない券種は、アプリの組番の書き方（"1=3"）にそろえる
_UNORDERED = {"nirenpuku", "kakurenpuku", "sanrenpuku"}

# 結果の行の項目と桁位置 [開始, 終了)。2026-09〜11 の40日分・約4.1万行で全行を確かめた
#   '  01  1 4423 坂　口　　貴　彦 53   61  6.81   1    0.03     1.49.4'
K_COLS = {
    "rank": (2, 4),  # 01〜06=着順。F=フライング、L0/L1=出遅れ、K0/K1=欠場、S0/S1/S2=失格
    "boat": (6, 7),
    "toban": (8, 12),
    "name": (13, 21),
    "motor_no": (22, 24),
    "boat_no": (24, 29),
    "tenji": (29, 35),  # 展示タイム。欠場は "K ."
    "course": (35, 40),  # 進入コース。欠場は空
    "st": (40, 47),  # スタートタイミング。フライングは "F0.02"、出遅れは "L1.14" か "L ."、欠場は "K ."
    "time": (47, 60),  # レースタイム "1.49.4"（分.秒.十分の一秒）。完走しなかった艇は ".  ."
}

_K_RACE_HEAD = re.compile(r"^(\d{1,2})R\s+(?:(.*?)\s+)?H(\d+)m\s+(\S+)\s+風\s+(?:(\S+)\s+)?(\d+)m\s+波\s+(\d+)cm")
_K_ROW_START = re.compile(r"^  (?:\d\d|[SFKL]\d?)\s+[1-6] \d{4} ")
_K_PAIR = re.compile(r"(\d(?:-\d){1,2})\s+(\d+)\s+人気\s+(\d+)")


def _k_float(s: str, what: str) -> float | None:
    """展示タイム・スタートタイミング。数字が取れなければ None（F/L/K の記号は先頭に付くだけ）"""
    t = s.strip()
    m = re.fullmatch(r"[FLK]?\s*(\d?\.\d{2})", t)
    if m:
        return round(float(m.group(1)), 2)
    if re.fullmatch(r"[FLK]?\s*\.?", t):
        return None
    raise ParseError(f"{what} を解析できません: {s!r}")


def parse_k_row(line: str) -> dict:
    f = {k: line[a:b] for k, (a, b) in K_COLS.items()}
    rank = f["rank"].strip()
    if re.fullmatch(r"0[1-6]", rank):
        rank = str(int(rank))
    elif not re.fullmatch(r"[SFKL]\d?", rank):
        raise ParseError(f"着順の欄が不正です: {rank!r}")
    if not (f["boat"] in "123456" and re.fullmatch(r"\d{4}", f["toban"])):
        raise ParseError(f"枠番か登録番号が不正です: {line!r}")
    tm = f["time"].strip()
    time_s = None
    if re.search(r"\d", tm):
        t = re.fullmatch(r"(\d)\.(\d\d)\.(\d)", tm)
        if not t:
            raise ParseError(f"レースタイムを解析できません: {tm!r}")
        time_s = round(int(t.group(1)) * 60 + int(t.group(2)) + int(t.group(3)) / 10, 1)
    course = f["course"].strip()
    if course and course not in "123456":
        raise ParseError(f"進入コースが不正です: {course!r}")
    return {
        "rank": rank,
        "boat": int(f["boat"]),
        "toban": f["toban"],
        "motor_no": _int(f["motor_no"], 1, 999, "モーター番号"),
        "boat_no": _int(f["boat_no"], 1, 999, "ボート番号"),
        "tenji": _k_float(f["tenji"], "展示タイム"),
        "course": int(course) if course else None,
        "st": _k_float(f["st"], "スタートタイミング"),
        "time": time_s,
    }


def parse_k_payouts(lines: list[str]) -> tuple[list[dict], list[str]]:
    """レースごとの払戻金の欄。戻り値は (払戻金の一覧, 不成立の券種)。

    払戻金は {bet_type, combo, payout, pop}。pop は人気順（単勝・複勝には無い）。特払いの組番は "*"。
    """
    payouts: list[dict] = []
    unsold: list[str] = []
    cur: str | None = None
    for raw in lines:
        s = nfkc(raw)
        if not s:
            continue
        m = re.match(r"^(単勝|複勝|2連単|2連複|拡連複|3連単|3連複)\s*(.*)$", s)
        if m:
            cur = K_BET_TYPES[m.group(1)]
            rest = m.group(2)
        elif cur is not None:
            rest = s  # 拡連複は3行に分かれる（2行目以降は勝式の名前が無い）
        else:
            raise ParseError(f"払戻金の行を解析できません: {s!r}")
        if rest == "不成立":
            unsold.append(cur)
            continue
        sp = re.fullmatch(r"特払い\s+(\d+)(?:\s+人気\s+\d+)?", rest)
        if sp:
            payouts.append({"bet_type": cur, "combo": "*", "payout": int(sp.group(1)), "pop": None})
            continue
        if cur in ("tansho", "fukusho"):
            pairs = re.findall(r"(\d)\s+(\d+)", rest)
            if not pairs or " ".join(f"{a} {b}" for a, b in pairs) != rest:
                raise ParseError(f"{m.group(1) if m else cur} の払戻金を解析できません: {rest!r}")
            payouts += [{"bet_type": cur, "combo": a, "payout": int(b), "pop": None} for a, b in pairs]
            continue
        pm = _K_PAIR.fullmatch(rest)
        if not pm:
            raise ParseError(f"払戻金を解析できません: {s!r}")
        combo, pay, pop = pm.groups()
        if cur in _UNORDERED:
            combo = combo.replace("-", "=")
        payouts.append({"bet_type": cur, "combo": combo, "payout": int(pay), "pop": int(pop)})
    return payouts, unsold


def parse_k_race(block: list[str], head: re.Match, kimarite: str) -> dict:
    rno, _name, _dist, weather, wind_dir, wind_m, wave = head.groups()
    i = next((k for k, l in enumerate(block) if re.match(r"^-{20,}\s*$", l)), None)
    if i is None:
        raise ParseError("着順の表の区切り線がありません")
    rows: list[dict] = []
    k = i + 1
    while k < len(block) and block[k].strip():
        if not _K_ROW_START.match(block[k]):
            raise ParseError(f"着順の行を解析できません: {block[k]!r}")
        rows.append(parse_k_row(block[k]))
        k += 1
    boats = [r["boat"] for r in rows]
    if not 4 <= len(rows) <= 6 or len(set(boats)) != len(boats):
        raise ParseError(f"艇の並びが不正です: {boats}")
    if not any(r["rank"] == "1" for r in rows):
        raise ParseError("1着の艇がいません")
    payouts, unsold = parse_k_payouts(block[k:])
    if not payouts:
        raise ParseError("払戻金がありません")
    # 着順と3連単の組番が食い違えば、解析か列の読み違い（同着は組番が複数になるので照合しない）
    order = [r["rank"] for r in rows]
    top3 = [r["boat"] for r in rows if r["rank"] in ("1", "2", "3")]
    if len(top3) == 3 and len({r["rank"] for r in rows if r["rank"] in "123"}) == 3:
        by_rank = {r["rank"]: r["boat"] for r in rows}
        want = "-".join(str(by_rank[x]) for x in ("1", "2", "3"))
        for p in payouts:
            if p["bet_type"] == "sanrentan" and p["combo"] not in ("*", want):
                raise ParseError(f"着順 {order} と3連単の組番 {p['combo']} が合いません")
    return {
        "rno": int(rno),
        "weather": nfkc(weather),
        "wind_dir": nfkc(wind_dir) if wind_dir else None,
        "wind_m": int(wind_m),
        "wave_cm": int(wave),
        "kimarite": kimarite or None,
        "rows": rows,
        "payouts": payouts,
        "unsold": unsold,
    }


def parse_k(data: bytes, date: str) -> dict:
    """K ファイル（バイト列）を解析する。date は YYYY-MM-DD（見出しの日付との照合用）。

    戻り値: {"date", "sha256", "venues": [{jcd, name, day, cancelled: [中止のレース番号], races: [{rno, weather, wind_dir, wind_m, wave_cm,
             kimarite, rows: [...], payouts: [...], unsold: [...]}]}], "errors": [理由, ...], "missing": [データの無い場のコード]}
    解析できなかったレースは races に入れず errors に理由を積む（B ファイルと同じ方針）。
    """
    text = data.decode("cp932")
    lines = text.split("\r\n") if "\r\n" in text else text.split("\n")
    if not lines or lines[0].strip() != "STARTK":
        raise ParseError("先頭が STARTK ではありません。Kファイルではない可能性があります")
    if not any(l.strip() == "FINALK" for l in lines[-5:]):
        raise ParseError("末尾が FINALK ではありません。ファイルが途中で切れている可能性があります")

    y, m, d = date.split("-")
    venues: list[dict] = []
    errors: list[str] = []
    missing: list[str] = []
    i = 0
    while i < len(lines):
        mm = re.fullmatch(r"(\d\d)KBGN", lines[i].strip())
        if not mm:
            i += 1
            continue
        jcd = mm.group(1)
        end = next((k for k in range(i + 1, len(lines)) if lines[k].strip() == f"{jcd}KEND"), None)
        if end is None:
            errors.append(f"{jcd}: KEND がありません")
            break
        block = lines[i + 1 : end]
        i = end + 1
        if any(_NO_DATA.search(l) for l in block):
            missing.append(jcd)
            continue

        norm = [unicodedata.normalize("NFKC", l) for l in block]
        date_m = next((re.search(r"(\d{4})/\s*(\d+)/\s*(\d+)", l) for l in norm[:12] if re.search(r"(\d{4})/\s*(\d+)/\s*(\d+)", l)), None)
        got = f"{date_m.group(1)}-{int(date_m.group(2)):02d}-{int(date_m.group(3)):02d}" if date_m else ""
        if got != date:
            errors.append(f"{jcd}: 日付が {date} ではありません（{got or '不明'}）。この場は取り込みません")
            continue
        day_m = next((re.search(r"第\s*(\d+)\s*日", l) for l in norm[:12] if re.search(r"第\s*(\d+)\s*日", l)), None)
        name_m = re.match(r"(.+?)\s*\[成績\]", norm[0]) if norm else None

        # 払戻金の一覧に「7R 中 止」と出るレースは中止（成績の表は無い）
        cancelled = sorted({int(m.group(1)) for l in norm for m in [re.match(r"^\s*(\d{1,2})R\s+中\s*止", l)] if m})

        # レースごとの区切り: 見出し行（「1R … H1800m 曇り 風 北 1m 波 1cm」）から次の見出しまで
        heads = [(k, _K_RACE_HEAD.match(nfkc(l))) for k, l in enumerate(block)]
        heads = [(k, h) for k, h in heads if h]
        races: list[dict] = []
        for n, (k, head) in enumerate(heads):
            stop = heads[n + 1][0] if n + 1 < len(heads) else len(block)
            # 「レース不成立」（例: 2026-09-14 浜名湖6R、6艇中5艇がフライング）は中止と同じ扱い（舟券は全額返還。着順の欄は "00"）
            if any("レース不成立" in l for l in block[k + 1 : stop]):
                cancelled = sorted(set(cancelled) | {int(head.group(1))})
                continue
            try:
                after = nfkc(block[k + 1]) if k + 1 < len(block) else ""
                km = re.search(r"レースタイム\s*(\S*)", after)
                races.append(parse_k_race(block[k + 1 : stop], head, km.group(1) if km else ""))
            except ParseError as e:
                errors.append(f"{jcd} {head.group(1)}R: {e}")
        rnos = [r["rno"] for r in races]
        if len(set(rnos)) != len(rnos):
            errors.append(f"{jcd}: レース番号が重複しています: {rnos}")
            continue
        venues.append({"jcd": jcd, "name": re.sub(r"\s+", "", name_m.group(1)) if name_m else "", "day": int(day_m.group(1)) if day_m else None, "races": races, "cancelled": cancelled})
    return {"date": date, "sha256": sha256_hex(data), "venues": venues, "errors": errors, "missing": missing}
