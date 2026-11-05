"""BOAT RACE オフィシャルウェブサイトから出走表（締切予定時刻）と公式結果を取得し、アプリに書き込む。

GitHub Actions から定期的に実行する（.github/workflows/boatrace.yml）。何度実行しても安全。

  schedule [--date YYYY-MM-DD]   その日の開催場と、各レースの締切予定時刻を PUT /internal/races に送り、
                                 各レースの選手の基本情報（枠番・登録番号・氏名・級別・支部・年齢）を PUT /internal/entrants に送る。
                                 選手は、まだ取り込んでいないレースだけ取得する（2回目の実行は取りこぼしの分だけ）
  results                        GET /internal/result-requests の各レース（精算待ちと、当日の締切後の全レース）の結果を取得し、POST /internal/results に送る
  results-all --date YYYY-MM-DD  その日の全レースのうち結果が未保存のものを取得して保存する（毎朝、前日分。公開・振り返り用）
  cards [--date YYYY-MM-DD]      番組表（公式テキストデータ B）を取得し、出走表（締切予定時刻つき）と基礎数値を PUT /internal/cards に送る。
                                 前日の夕方から翌日分が出るので、前日の夕方と当日朝に実行する。ファイルのハッシュが前回と同じなら何もしない
                                 （--force で送り直す）。解析できなかったレースは送らず、最後に失敗（終了コード1）で知らせる
  probe-cards --date ...         接続確認: 取得・解析した番組表を表示するだけ（アプリには書き込まない）
  probe-schedule --date ...      接続確認: 取得・解析した出走表を表示するだけ（アプリには書き込まない）
  probe-entrants --race ID       接続確認: 取得・解析した選手の基本情報を表示するだけ（例 20261103-12-07）
  probe-result --race ID         接続確認: 取得・解析した結果を表示するだけ（例 20261103-12-07）

環境変数: API_BASE_URL, INGEST_TOKEN（probe-* では不要）

注意: ページの構造（HTML）は公式サイトの都合で変わりうる。解析できなかったレースは送らずにログへ出し、
アプリ側は精算を保留する（requirements.md 2.1-4）。構造が変わったら probe-* で確認して直す。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

from bs4 import BeautifulSoup

import boatrace_text as bt

BASE = "https://www.boatrace.jp/owpc/pc/race"
USER_AGENT = "ai-boat-race-ingest/1.0 (+https://github.com/Investorkabuto/AI-BOAT-RACE)"
JST = dt.timezone(dt.timedelta(hours=9))
# 公式サイトへの負荷を抑えるため、リクエストの間隔をあける（秒）
INTERVAL = 1.0
TIMEOUT = float(os.environ.get("BOATRACE_TIMEOUT", "30"))
# BOATRACE_DEBUG=1 で、各リクエストのURL・状態・所要時間を標準エラーに出す
DEBUG = os.environ.get("BOATRACE_DEBUG") == "1"

BET_TYPE_BY_JA = {
    "3連単": "sanrentan",
    "3連複": "sanrenpuku",
    "2連単": "nirentan",
    "2連複": "nirenpuku",
    "拡連複": "kakurenpuku",
    "単勝": "tansho",
    "複勝": "fukusho",
}
# 着順の欄にこの記号がある艇は、その艇を含む舟券が返還になる（欠場、フライング、出遅れ）
REFUND_MARKS = {"欠", "K", "K0", "K1", "F", "L", "L0", "L1"}


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s).strip()


def get_html(path: str, **params: str) -> str:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{BASE}/{path}?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "ja"})
    time.sleep(INTERVAL)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read().decode("utf-8", "replace")
            if DEBUG:
                print(f"GET {url} -> {r.status} {len(body)}B {time.monotonic() - started:.1f}s", file=sys.stderr, flush=True)
            return body
    except Exception as e:
        if DEBUG:
            print(f"GET {url} -> {type(e).__name__}: {e} {time.monotonic() - started:.1f}s", file=sys.stderr, flush=True)
        raise


def api(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        os.environ["API_BASE_URL"].rstrip("/") + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['INGEST_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read(500).decode("utf-8", "replace")
        raise SystemExit(f"API error {e.code} on {method} {path}: {detail}") from e


# ------------------------------------------------------------------ 出走表

def venues_of_day(hd: str) -> list[str]:
    """その日に開催がある場コード（index ページの各場へのリンクから拾う）"""
    html = get_html("index", hd=hd)
    return sorted(set(re.findall(r"jcd=(\d{2})(?:&amp;|&)hd=" + hd, html)))


def parse_deadlines(html: str) -> list[str]:
    """出走表ページの「締切予定時刻」の行から、1R〜12Rの締切（HH:MM）を取り出す"""
    soup = BeautifulSoup(html, "html.parser")
    for cell in soup.find_all(["td", "th"]):
        if "締切予定時刻" in cell.get_text():
            row = cell.find_parent("tr")
            if row is None:
                continue
            times = [nfkc(td.get_text()) for td in row.find_all("td")]
            times = [t for t in times if re.fullmatch(r"\d{1,2}:\d{2}", t)]
            if times:
                return times
    return []


GRADES = {"A1", "A2", "B1", "B2"}


def parse_entrants(html: str) -> list[dict]:
    """出走表ページから、選手の基本情報（枠番・登録番号・氏名・級別・支部・年齢）を取り出す。

    要件定義 §6（2026-11-04 管理者決定 A）により、モーター・ボート・展示・成績などは取らない。
    1艇分は、枠番のセル（class に is-boatColor1〜6）を含む tbody（または tr）。その中の
    選手プロフィールへのリンク（toban=登録番号）、「4444 / A1」の形の登録番号と級別、
    「東京/東京 34歳/52.0kg」の形の支部と年齢を拾う。解析できなければ空のリストを返す。
    """
    soup = BeautifulSoup(html, "html.parser")
    out: dict[int, dict] = {}
    # 1艇分は1つの tbody。その最初のセルが枠番（class に is-boatColor1〜6）。
    # tbody の中には今節の成績などにも is-boatColor のセルがあるので、最初のセルだけを枠番として見る
    for block in soup.find_all("tbody"):
        cell = block.find("td")
        if cell is None or not any("is-boatColor" in c for c in (cell.get("class") or [])):
            continue
        boat_text = nfkc(cell.get_text())
        if not re.fullmatch(r"[1-6]", boat_text):
            continue
        boat = int(boat_text)
        if boat in out:
            continue
        link = block.find("a", href=re.compile(r"toban=\d{4}"))
        m = re.search(r"toban=(\d{4})", link["href"]) if link else None
        text = nfkc(block.get_text(" "))
        if not m:
            m = re.search(r"\b(\d{4})\s*/\s*(?:A1|A2|B1|B2)\b", text)
        if not m:
            continue
        toban = m.group(1)
        # 氏名: 文字のあるプロフィールへのリンク（写真のリンクは文字が無い）。無ければ太字の欄
        name = ""
        for a in block.find_all("a", href=re.compile(r"toban=\d{4}")):
            t = re.sub(r"\s+", " ", nfkc(a.get_text(" ")))
            if t and not t.isdigit():
                name = t
                break
        if not name:
            big = block.select_one('[class*="is-fs18"]')
            name = re.sub(r"\s+", " ", nfkc(big.get_text(" "))) if big else ""
        if not name:
            continue
        g = re.search(rf"{toban}\s*/\s*(A1|A2|B1|B2)\b", text) or re.search(r"\b(A1|A2|B1|B2)\b", text)
        b = re.search(r"([^\s/\d]{1,4})\s*/\s*[^\s/\d]{1,4}\s*(\d{2})\s*歳", text)
        age = re.search(r"(\d{2})\s*歳", text)
        out[boat] = {
            "boat": boat,
            "toban": toban,
            "name": name[:40],
            "grade": g.group(1) if g else None,
            "branch": b.group(1) if b else None,
            "age": int(age.group(1)) if age else None,
        }
    result = [out[k] for k in sorted(out)]
    if len({e["toban"] for e in result}) != len(result):
        return []  # 同じ選手が2つの枠にいるのは解析の誤り。送らない
    return result


def racelist(hd: str, jcd: str, rno: int) -> str:
    return get_html("racelist", rno=str(rno), jcd=jcd, hd=hd)


def schedule_of_day(date: str) -> tuple[list[dict], list[dict]]:
    """その日の全レースの締切と、各場の1Rの選手（締切の取得で同じページを読むので、ついでに拾う）"""
    hd = date.replace("-", "")
    races: list[dict] = []
    entrants: list[dict] = []
    for jcd in venues_of_day(hd):
        html = racelist(hd, jcd, 1)
        deadlines = parse_deadlines(html)
        if not deadlines:
            print(f"warn: {date} jcd={jcd}: 締切予定時刻を解析できませんでした", file=sys.stderr)
            continue
        races += [{"jcd": jcd, "rno": i + 1, "deadline": t} for i, t in enumerate(deadlines)]
        ent = parse_entrants(html)
        if ent:
            entrants.append({"jcd": jcd, "rno": 1, "entrants": ent})
        else:
            print(f"warn: {date} jcd={jcd} 1R: 選手を解析できませんでした", file=sys.stderr)
    return races, entrants


def send_entrants(date: str, entrants: list[dict]) -> None:
    for i in range(0, len(entrants), 50):
        print(api("PUT", "/internal/entrants", {"race_date": date, "races": entrants[i:i + 50]}))


# ------------------------------------------------------------------ 番組表（公式テキストデータ B）

# 1回の送信に含めるレース数（アプリは D1 の batch を100文までに区切るので、1レース3文 × 33）
CARDS_PER_REQUEST = 33


def load_cards(date: str) -> dict | None:
    """その日の番組表（B）を取得して解析する。まだ公開されていなければ None"""
    lzh = bt.download(bt.b_url(date), timeout=TIMEOUT)
    if lzh is None:
        return None
    return bt.parse_b(bt.unpack(lzh), date)


def cards_payload(parsed: dict) -> list[dict]:
    """解析結果を、アプリに送るレースの一覧にする（場ごとの入れ子を平らにする）"""
    return [
        {
            "jcd": v["jcd"],
            "rno": r["rno"],
            "race_name": r["race_name"],
            "deadline": r["deadline"],
            "fixed_course": r["fixed_course"],
            "distance": r["distance"],
            "racers": r["racers"],
            "day": v["day"],
            "series_title": v["series_title"],
        }
        for v in parsed["venues"]
        for r in v["races"]
    ]


def send_cards(date: str, parsed: dict, force: bool) -> bool:
    """番組表をアプリに送る。すべて保存できたら True（ハッシュを記録する）"""
    sha = parsed["sha256"]
    if not force and api("GET", f"/internal/card-state?date={date}").get("sha256") == sha:
        print(f"{date}: 番組表は前回と同じです（{sha[:12]}）。何もしません")
        return True
    races = cards_payload(parsed)
    ok = not parsed["errors"]
    created = saved = 0
    for i in range(0, len(races), CARDS_PER_REQUEST):
        res = api("PUT", "/internal/cards", {"race_date": date, "races": races[i : i + CARDS_PER_REQUEST]})
        created += res["created_races"]
        saved += res["saved"]
        for s in res["skipped"]:
            print(f"warn: サーバーが受け付けませんでした: {s}", file=sys.stderr)
            ok = False
    print(f"{date}: 番組表 {len(races)} レース（新しく作ったレース {created}、保存・更新 {saved}）")
    if ok:  # 解析の失敗やサーバーの拒否があれば記録しない（次の実行で取り直す）
        api("PUT", "/internal/card-state", {"race_date": date, "sha256": sha})
    return ok


# ------------------------------------------------------------------ 競走成績（公式テキストデータ K）

# 1回の送信に含めるレース数（アプリは D1 の batch を100文までに区切るので、1レース2文 × 49。余裕を見て48）
RECORDS_PER_REQUEST = 48


def load_records(date: str) -> dict | None:
    """その日の競走成績（K）を取得して解析する。まだ公開されていなければ None"""
    lzh = bt.download(bt.k_url(date), timeout=TIMEOUT)
    if lzh is None:
        return None
    return bt.parse_k(bt.unpack(lzh), date)


def records_payload(parsed: dict) -> list[dict]:
    return [{"jcd": v["jcd"], **r} for v in parsed["venues"] for r in v["races"]]


def send_records(date: str, parsed: dict, force: bool) -> bool:
    """競走成績をアプリに送る。すべて保存できたら True（ハッシュを記録する）"""
    sha = parsed["sha256"]
    if not force and api("GET", f"/internal/record-state?date={date}").get("sha256") == sha:
        print(f"{date}: 競走成績は前回と同じです（{sha[:12]}）。何もしません")
        return True
    races = records_payload(parsed)
    ok = not parsed["errors"]
    saved = 0
    for i in range(0, len(races), RECORDS_PER_REQUEST):
        res = api("PUT", "/internal/records", {"race_date": date, "races": races[i : i + RECORDS_PER_REQUEST]})
        saved += res["saved"]
        for s in res["skipped"]:
            print(f"warn: サーバーが受け付けませんでした: {s}", file=sys.stderr)
            ok = False
    print(f"{date}: 競走成績 {len(races)} レース（保存・更新 {saved}）")
    if ok:  # 解析の失敗やサーバーの拒否があれば記録しない（次の実行で取り直す）
        api("PUT", "/internal/record-state", {"race_date": date, "sha256": sha})
    return ok


# ------------------------------------------------------------------ 過去分（B と K からレースを作る）

# 1回の送信に含めるレース数（1レース最大5文。アプリは D1 の batch を99文ずつ流すので、19レースで1回に収まる）
HISTORY_PER_REQUEST = 19
# 過去分は、この日数より前だけ（前日分は当日の取得の流れに任せる。アプリの HISTORY_MIN_AGE_DAYS と同じ）
HISTORY_MIN_AGE_DAYS = 2
# さかのぼる日数の既定（2026-11-05 管理者決定: まず1年分。D1 の容量を見て延ばす。--floor で変えられる）
HISTORY_DEFAULT_DAYS = 365
# 公式サイトへの負荷を抑えるため、ファイルの取得の間に空ける秒数
HISTORY_INTERVAL = 1.0


def result_from_k(race: dict) -> dict:
    """K の1レースを、公式HTMLの結果と同じ形（POST /internal/results の1件）にする"""
    finish: dict[int, list[int]] = {}
    for r in race["rows"]:
        if r["rank"].isdigit():
            finish.setdefault(int(r["rank"]), []).append(r["boat"])
    start = []
    for r in sorted((r for r in race["rows"] if r["course"]), key=lambda r: r["course"]):
        mark = r["rank"][0] if r["rank"][0] in "FL" else ""
        st = f"{mark}{r['st']:.2f}" if r["st"] is not None else (mark or None)
        start.append({"course": r["course"], "boat": r["boat"], "st": st})
    return {
        "status": "official",
        "finish": [sorted(v) for _, v in sorted(finish.items())],
        # 欠場・フライング・出遅れの艇を含む舟券は返還。失格（S）は返還しない（2026-11-05 運営AIの確認、公式の規定どおり）
        "refunded_boats": sorted(r["boat"] for r in race["rows"] if r["rank"][0] in "FLK"),
        "payouts": [{"bet_type": p["bet_type"], "combo": p["combo"], "payout": p["payout"]} for p in race["payouts"]],
        "start": start,
    }


CANCELLED_RESULT = {"status": "cancelled", "finish": [], "refunded_boats": [], "payouts": []}


def history_payload(b: dict, k: dict | None) -> tuple[list[dict], list[str]]:
    """B（番組表）と K（競走成績）の解析結果から、過去分として送るレースの一覧を作る。戻り値は (レース, 注意)

    レースの元は B（締切がある）。K の成績・結果をレースごとに添える。K に「中止」と出るレースは中止として送る。
    B に無いレースは締切が分からないので送らない（注意に積む）。
    """
    notes: list[str] = []
    kr = {(v["jcd"], r["rno"]): r for v in (k or {}).get("venues", []) for r in v["races"]}
    kc = {(v["jcd"], n) for v in (k or {}).get("venues", []) for n in v.get("cancelled", [])}
    out: list[dict] = []
    seen = set()
    for v in b["venues"]:
        for r in v["races"]:
            key = (v["jcd"], r["rno"])
            seen.add(key)
            item = {
                "jcd": v["jcd"], "rno": r["rno"], "race_name": r["race_name"], "deadline": r["deadline"],
                "card": {"fixed_course": r["fixed_course"], "distance": r["distance"], "racers": r["racers"], "day": v["day"], "series_title": v["series_title"]},
            }
            if key in kr:
                item["record"] = kr[key]
                item["result"] = result_from_k(kr[key])
            elif key in kc:
                item["result"] = CANCELLED_RESULT
            elif k is not None and v["jcd"] not in k.get("missing", []):
                notes.append(f"{v['jcd']} {r['rno']}R: K に成績がありません")
            out.append(item)
    for key in sorted(set(kr) - seen):
        notes.append(f"{key[0]} {key[1]}R: B に無いので締切が分からず、取り込みません")
    return out, notes


def import_history_day(date: str) -> str | None:
    """過去の1日分を取り込む。取り込めたら要約の文字列、ファイルがまだ無いなどで取り込めなければ None"""
    lzh_b = bt.download(bt.b_url(date), timeout=TIMEOUT)
    time.sleep(HISTORY_INTERVAL)
    lzh_k = bt.download(bt.k_url(date), timeout=TIMEOUT)
    time.sleep(HISTORY_INTERVAL)
    if lzh_b is None:
        print(f"warn: {date}: 番組表（B）がありません（{bt.b_url(date)}）", file=sys.stderr)
        return None
    b = bt.parse_b(bt.unpack(lzh_b), date)
    k = bt.parse_k(bt.unpack(lzh_k), date) if lzh_k is not None else None
    races, notes = history_payload(b, k)
    errors = b["errors"] + (k["errors"] if k else ["K がありません"])
    created: dict[str, int] = {}
    skipped: list[str] = []
    for i in range(0, len(races), HISTORY_PER_REQUEST):
        res = api("PUT", "/internal/history", {"race_date": date, "races": races[i : i + HISTORY_PER_REQUEST]})
        for key, n in res["created"].items():
            created[key] = created.get(key, 0) + n
        skipped += res["skipped"]
    for m in errors + notes + skipped:
        print(f"warn: {date}: {m}", file=sys.stderr)
    missing = sorted(set(b.get("missing", [])) | set((k or {}).get("missing", [])))
    summary = (
        f"races={len(races)} " + " ".join(f"new_{k}={v}" for k, v in created.items())
        + (f" errors={len(errors)}" if errors else "") + (f" notes={len(notes)}" if notes else "") + (f" skipped={len(skipped)}" if skipped else "")
        + (f" missing_venues={','.join(missing)}" if missing else "")
    )
    print(f"{date}: {summary}")
    if k is None:
        return None  # K が無い日は、後でもう一度取りに行く（記録しない）
    return summary


def run_history(floor: str, max_days: int, budget_s: float) -> None:
    """直近（今日の HISTORY_MIN_AGE_DAYS 日前）から floor まで、取り込み済みでない日を新しい順に取り込む"""
    started = time.monotonic()
    newest = (dt.datetime.now(JST).date() - dt.timedelta(days=HISTORY_MIN_AGE_DAYS)).isoformat()
    done = {x["date"] for x in api("GET", f"/internal/history-done?from={floor}&to={newest}")["done"]}
    day = dt.date.fromisoformat(newest)
    stop = dt.date.fromisoformat(floor)
    n = 0
    while day >= stop and n < max_days and time.monotonic() - started < budget_s:
        d = day.isoformat()
        day -= dt.timedelta(days=1)
        if d in done:
            continue
        summary = import_history_day(d)
        n += 1
        if summary is not None:
            api("PUT", "/internal/history-state", {"race_date": d, "note": summary})
    remaining = sum(1 for i in range((dt.date.fromisoformat(newest) - stop).days + 1) if (stop + dt.timedelta(days=i)).isoformat() not in done) - n
    print(f"history: {n} 日分を処理しました（{floor} まで、残り約 {max(remaining, 0)} 日）")


# ------------------------------------------------------------------ 結果

def parse_combo(cell) -> str | None:
    """組番のセル。艇番の span と区切り（- または =）を順に連結する。特払いは "*" """
    text = nfkc(cell.get_text(" "))
    if "特払" in text:
        return "*"
    parts = [nfkc(s.get_text()) for s in cell.find_all("span") if any("numberSet1_" in c for c in (s.get("class") or []))]
    combo = "".join(p for p in parts if p)
    if re.fullmatch(r"[1-6](?:[-=][1-6]){0,2}", combo):
        return combo
    # span が無い構造への保険: テキストから拾う
    m = re.search(r"[1-6](?:\s*[-=]\s*[1-6]){0,2}", text)
    return re.sub(r"\s+", "", m.group(0)) if m else None


def parse_start(soup) -> list[dict] | None:
    """結果ページの「スタート情報」から、進入コース順の艇番とスタートタイミングを取り出す。

    表は上から1コース、2コース…の順に並び、各行に艇番（class に table1_boatImage1Number）と
    タイミング（table1_boatImage1Time。「.15」「F.01」、1着艇には決まり手も続く）がある。解析できなければ None
    """
    for table in soup.find_all("table"):
        head = table.find("thead")
        if head is None or "スタート情報" not in head.get_text():
            continue
        out: list[dict] = []
        for tr in (table.find("tbody") or table).find_all("tr"):
            num = tr.select_one('[class*="boatImage1Number"]')
            boat_text = nfkc(num.get_text()) if num else ""
            if not re.fullmatch(r"[1-6]", boat_text):
                m = re.match(r"\s*([1-6])\b", nfkc(tr.get_text(" ")))
                boat_text = m.group(1) if m else ""
            if not boat_text:
                continue
            tm = tr.select_one('[class*="boatImage1Time"]')
            t = nfkc(tm.get_text(" ") if tm else tr.get_text(" "))
            st = re.search(r"([FL]?\s*\d?\.\d{2})|\bL\b", t)
            out.append({"course": len(out) + 1, "boat": int(boat_text), "st": re.sub(r"\s+", "", st.group(0)) if st else None})
        boats = [x["boat"] for x in out]
        if 1 <= len(out) <= 6 and len(set(boats)) == len(boats):
            return out
        return None
    return None


def parse_result(html: str) -> dict | None:
    """結果ページを解析する。結果がまだ無ければ None。中止なら status=cancelled"""
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ")

    # 払戻金: 「勝式」列に券種名があるセルで現在の券種を切り替え、各行の組番と払戻金を拾う（拡連複・複勝は複数行）
    payouts: list[dict] = []
    for table in soup.find_all("table"):
        head = table.find("thead")
        if head is None or "勝式" not in head.get_text() or "払戻金" not in head.get_text():
            continue
        current = None
        for tr in table.find_all("tr"):
            cells = tr.find_all("td")
            if not cells:
                continue
            first = nfkc(cells[0].get_text())
            if first in BET_TYPE_BY_JA:
                current = BET_TYPE_BY_JA[first]
                cells = cells[1:]
            if current is None or not cells:
                continue
            m = re.search(r"¥\s*([\d,]+)", nfkc(tr.get_text(" ")).replace("￥", "¥"))
            combo = parse_combo(cells[0])
            if m and combo:
                payouts.append({"bet_type": current, "combo": combo, "payout": int(m.group(1).replace(",", ""))})

    # 着順: 「着」「枠」の列がある表。同じ着順の数字が続けば同着
    finish: list[list[int]] = []
    refunded: set[int] = set()
    last_place = None
    for table in soup.find_all("table"):
        head = table.find("thead")
        if head is None:
            continue
        heads = [nfkc(th.get_text()) for th in head.find_all("th")]
        if not heads or heads[0] != "着" or "枠" not in heads:
            continue
        for tr in table.find_all("tr"):
            cells = [nfkc(td.get_text()) for td in tr.find_all("td")]
            if len(cells) < 2 or not cells[1].isdigit():
                continue
            place, boat = cells[0], int(cells[1])
            if place.isdigit():
                if place == last_place and finish:
                    finish[-1].append(boat)
                else:
                    finish.append([boat])
                last_place = place
            elif place.upper() in REFUND_MARKS:
                refunded.add(boat)
        break

    if not payouts:
        if re.search(r"レース中止|中止となりました|不成立", text):
            return {"status": "cancelled", "finish": [], "refunded_boats": [], "payouts": []}
        return None
    # レース直後は、払戻金が先に載り、着順の表がまだ空（または途中）のことがある。そろうまで「まだ無い」扱いにして次の取得に回す
    if not finish_complete(finish, payouts):
        return None
    out = {"status": "official", "finish": finish, "refunded_boats": sorted(refunded), "payouts": payouts}
    start = parse_start(soup)
    if start:
        out["start"] = start
    return out


def finish_complete(finish: list[list[int]], payouts: list[dict]) -> bool:
    """着順が払戻金と矛盾なくそろっているか。1〜3着がそろい、同着がなければ3連単・2連単の組番と一致すること"""
    if len(finish) < 2 or sum(len(x) for x in finish) < 3:
        return False
    if any(len(x) > 1 for x in finish[:3]):
        return True  # 同着は払戻の組番が複数になるので、照合しない
    order = [x[0] for x in finish]
    for p in payouts:
        if p["combo"] == "*":
            continue
        if p["bet_type"] == "sanrentan" and len(order) >= 3 and p["combo"] != "-".join(map(str, order[:3])):
            return False
        if p["bet_type"] == "nirentan" and p["combo"] != "-".join(map(str, order[:2])):
            return False
    return True


def fetch_result(race_id: str) -> dict | None:
    m = re.fullmatch(r"(\d{8})-(\d{2})-(\d{2})", race_id)
    if not m:
        raise SystemExit(f"invalid race id: {race_id}")
    hd, jcd, rno = m.groups()
    return parse_result(get_html("raceresult", rno=str(int(rno)), jcd=jcd, hd=hd))


# ------------------------------------------------------------------ 実行

def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["schedule", "cards", "records", "history", "results", "results-all", "probe-cards", "probe-records", "probe-schedule", "probe-result", "probe-entrants"])
    p.add_argument("--date", help="YYYY-MM-DD（省略時は今日）")
    p.add_argument("--race", help="レースID（probe-result 用）")
    p.add_argument("--force", action="store_true", help="cards / records: 前回と同じ内容でも送り直す")
    p.add_argument("--floor", help="history: どこまでさかのぼるか（YYYY-MM-DD。省略時は1年前）")
    p.add_argument("--max-days", type=int, default=60, help="history: 1回で取り込む日数の上限")
    p.add_argument("--budget-min", type=float, default=40, help="history: 1回の実行の時間の上限（分）")
    a = p.parse_args()
    date = a.date or dt.datetime.now(JST).date().isoformat()

    if a.command in ("cards", "probe-cards"):
        parsed = load_cards(date)
        if parsed is None:
            print(f"{date}: 番組表（B）はまだ公開されていません（{bt.b_url(date)}）")
            return
        races = cards_payload(parsed)
        for e in parsed["errors"]:
            print(f"warn: {e}", file=sys.stderr)
        if a.command == "probe-cards":
            print(f"{date}: 場 {len(parsed['venues'])}、レース {len(races)}、選手 {sum(len(r['racers']) for r in races)}、解析の失敗 {len(parsed['errors'])}、sha256 {parsed['sha256'][:16]}")
            for v in parsed["venues"]:
                print(f"  {v['jcd']} {v['name']} 第{v['day']}日 {v['series_title']} ({len(v['races'])}R)")
            if races:
                print(json.dumps(races[0], ensure_ascii=False, indent=1))
            return
        if not races:
            raise SystemExit(f"{date}: 解析できたレースがありません。形式が変わった可能性があります")
        # 解析できたレースは送る。失敗があれば最後に終了コード1で知らせる（Actions の失敗通知で気づけるように）
        if not send_cards(date, parsed, a.force):
            raise SystemExit(f"{date}: 番組表の一部を取り込めませんでした（上の warn を参照）")
    elif a.command == "history":
        if a.date:  # 1日分だけ（手動の確認用）
            summary = import_history_day(a.date)
            if summary is not None:
                api("PUT", "/internal/history-state", {"race_date": a.date, "note": summary})
            return
        today = dt.datetime.now(JST).date()
        floor = a.floor or (today - dt.timedelta(days=HISTORY_DEFAULT_DAYS)).isoformat()
        run_history(floor, a.max_days, a.budget_min * 60)
    elif a.command in ("records", "probe-records"):
        parsed = load_records(date)
        if parsed is None:
            print(f"{date}: 競走成績（K）はまだ公開されていません（{bt.k_url(date)}）")
            return
        races = records_payload(parsed)
        for e in parsed["errors"]:
            print(f"warn: {e}", file=sys.stderr)
        if a.command == "probe-records":
            print(f"{date}: 場 {len(parsed['venues'])}、レース {len(races)}、解析の失敗 {len(parsed['errors'])}、sha256 {parsed['sha256'][:16]}")
            for v in parsed["venues"]:
                print(f"  {v['jcd']} {v['name']} 第{v['day']}日 ({len(v['races'])}R)")
            if races:
                print(json.dumps(races[0], ensure_ascii=False, indent=1))
            return
        if not races:
            raise SystemExit(f"{date}: 解析できたレースがありません。形式が変わった可能性があります")
        if not send_records(date, parsed, a.force):
            raise SystemExit(f"{date}: 競走成績の一部を取り込めませんでした（上の warn を参照）")
    elif a.command == "probe-schedule":
        races, entrants = schedule_of_day(date)
        print(json.dumps({"races": races, "entrants_1R": entrants}, ensure_ascii=False, indent=1))
    elif a.command == "probe-result":
        print(json.dumps(fetch_result(a.race), ensure_ascii=False, indent=1))
    elif a.command == "probe-entrants":
        m = re.fullmatch(r"(\d{8})-(\d{2})-(\d{2})", a.race or "")
        if not m:
            raise SystemExit("probe-entrants には --race（例 20261103-12-07）が必要です")
        print(json.dumps(parse_entrants(racelist(m.group(1), m.group(2), int(m.group(3)))), ensure_ascii=False, indent=1))
    elif a.command == "schedule":
        races, entrants = schedule_of_day(date)
        print(f"{date}: {len(races)} races")
        if not races:
            return
        print(api("PUT", "/internal/races", {"race_date": date, "races": races}))
        if entrants:
            send_entrants(date, entrants)
        # 2R以降は、まだ選手が無い受付中のレースだけ取得する（公式サイトへの負荷を抑える。2回目の実行は取りこぼしの分だけ）
        hd = date.replace("-", "")
        todo = api("GET", f"/internal/entrant-requests?date={date}")["requests"]
        print(f"entrants: {len(todo)} races to fetch")
        got: list[dict] = []
        for r in todo:
            try:
                ent = parse_entrants(racelist(hd, r["jcd"], r["rno"]))
            except Exception as e:  # 1レースの失敗で全体を止めない
                print(f"warn: {r['id']}: {e}", file=sys.stderr)
                continue
            if not ent:
                print(f"warn: {r['id']}: 選手を解析できませんでした", file=sys.stderr)
                continue
            got.append({"jcd": r["jcd"], "rno": r["rno"], "entrants": ent})
            if len(got) >= 50:
                send_entrants(date, got)
                got = []
        if got:
            send_entrants(date, got)
    else:
        if a.command == "results-all":
            if not a.date:
                raise SystemExit("results-all には --date が必要です")
            requests = api("GET", f"/internal/result-requests?all=1&date={a.date}")["requests"]
        else:
            requests = api("GET", "/internal/result-requests")["requests"]
        results = []
        for r in requests:
            try:
                res = fetch_result(r["id"])
            except Exception as e:  # 1レースの失敗で全体を止めない
                print(f"warn: {r['id']}: {e}", file=sys.stderr)
                continue
            if res is None:
                print(f"{r['id']}: 結果はまだありません")
                continue
            results.append({"race_id": r["id"], **res})
        print(f"results: {len(results)} / {len(requests)}")
        for i in range(0, len(results), 50):
            res = api("POST", "/internal/results", {"results": results[i:i + 50]})
            for rej in res.pop("rejected", []):  # 1レースの不正な結果で全体を止めない（サーバーはそのレースだけ保存しない）
                print(f"warn: {rej.get('race_id')}: サーバーが受け付けませんでした（{rej.get('reason')}）。次の取得で取り直します", file=sys.stderr)
            print(res)


if __name__ == "__main__":
    main()
