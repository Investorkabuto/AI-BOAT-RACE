"""BOAT RACE オフィシャルウェブサイトから出走表（締切予定時刻）と公式結果を取得し、アプリに書き込む。

GitHub Actions から定期的に実行する（.github/workflows/boatrace.yml）。何度実行しても安全。

  schedule [--date YYYY-MM-DD]   その日の開催場と、各レースの締切予定時刻を PUT /internal/races に送り、
                                 各レースの選手の基本情報（枠番・登録番号・氏名・級別・支部・年齢）を PUT /internal/entrants に送る。
                                 選手は、まだ取り込んでいないレースだけ取得する（2回目の実行は取りこぼしの分だけ）
  results                        GET /internal/result-requests の各レース（精算待ちと、当日の締切後の全レース）の結果を取得し、POST /internal/results に送る
  results-all --date YYYY-MM-DD  その日の全レースのうち結果が未保存のものを取得して保存する（毎朝、前日分。公開・振り返り用）
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
    for cell in soup.select('td[class*="is-boatColor"]'):
        boat_text = nfkc(cell.get_text())
        if not re.fullmatch(r"[1-6]", boat_text):
            continue
        boat = int(boat_text)
        block = cell.find_parent("tbody") or cell.find_parent("tr")
        if block is None or boat in out:
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
    return [out[k] for k in sorted(out)]


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
    p.add_argument("command", choices=["schedule", "results", "results-all", "probe-schedule", "probe-result", "probe-entrants"])
    p.add_argument("--date", help="YYYY-MM-DD（省略時は今日）")
    p.add_argument("--race", help="レースID（probe-result 用）")
    a = p.parse_args()
    date = a.date or dt.datetime.now(JST).date().isoformat()

    if a.command == "probe-schedule":
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
            print(api("POST", "/internal/results", {"results": results[i:i + 50]}))


if __name__ == "__main__":
    main()
