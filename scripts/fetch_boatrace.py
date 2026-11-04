"""BOAT RACE オフィシャルウェブサイトから出走表（締切予定時刻）と公式結果を取得し、アプリに書き込む。

GitHub Actions から定期的に実行する（.github/workflows/boatrace.yml）。何度実行しても安全。

  schedule [--date YYYY-MM-DD]   その日の開催場と、各レースの締切予定時刻を PUT /internal/races に送る
  results                        GET /internal/result-requests の各レースの結果を取得し、POST /internal/results に送る
  probe-schedule --date ...      接続確認: 取得・解析した出走表を表示するだけ（アプリには書き込まない）
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


def schedule_of_day(date: str) -> list[dict]:
    hd = date.replace("-", "")
    races: list[dict] = []
    for jcd in venues_of_day(hd):
        deadlines = parse_deadlines(get_html("racelist", rno="1", jcd=jcd, hd=hd))
        if not deadlines:
            print(f"warn: {date} jcd={jcd}: 締切予定時刻を解析できませんでした", file=sys.stderr)
            continue
        races += [{"jcd": jcd, "rno": i + 1, "deadline": t} for i, t in enumerate(deadlines)]
    return races


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
    return {"status": "official", "finish": finish, "refunded_boats": sorted(refunded), "payouts": payouts}


def fetch_result(race_id: str) -> dict | None:
    m = re.fullmatch(r"(\d{8})-(\d{2})-(\d{2})", race_id)
    if not m:
        raise SystemExit(f"invalid race id: {race_id}")
    hd, jcd, rno = m.groups()
    return parse_result(get_html("raceresult", rno=str(int(rno)), jcd=jcd, hd=hd))


# ------------------------------------------------------------------ 実行

def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["schedule", "results", "probe-schedule", "probe-result"])
    p.add_argument("--date", help="YYYY-MM-DD（省略時は今日）")
    p.add_argument("--race", help="レースID（probe-result 用）")
    a = p.parse_args()
    date = a.date or dt.datetime.now(JST).date().isoformat()

    if a.command == "probe-schedule":
        print(json.dumps(schedule_of_day(date), ensure_ascii=False, indent=1))
    elif a.command == "probe-result":
        print(json.dumps(fetch_result(a.race), ensure_ascii=False, indent=1))
    elif a.command == "schedule":
        races = schedule_of_day(date)
        print(f"{date}: {len(races)} races")
        if races:
            print(api("PUT", "/internal/races", {"race_date": date, "races": races}))
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
        if results:
            print(api("POST", "/internal/results", {"results": results}))


if __name__ == "__main__":
    main()
