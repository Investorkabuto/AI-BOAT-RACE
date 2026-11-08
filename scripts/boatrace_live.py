"""締切前の直前情報とオッズを公式サイトから取得し、アプリに送る（要件定義 決定64、2026-11-09 管理者決定）。

  python scripts/boatrace_live.py run [--until HH:MM]   その日のレースを追いかけ、締切の前に取得して PUT /internal/live に送る
  python scripts/boatrace_live.py probe --race ID        接続確認: 1レース分を取得・解析して表示するだけ（アプリには書き込まない）

取得の時刻（各レースの締切予定時刻から）:
  - 直前情報（beforeinfo）: 15分前から。展示タイムがまだ出ていなければ2分おきに取り直し、6分前であきらめる
  - オッズ（3連単 odds3t だけ。2026-11-09 管理者決定）: 10分前（slot "t10"）と7分前（slot "t7"）の2回。
    3連複・2連単/2連複の解析（parse_odds3f・parse_odds2tf）は、取得を広げるときのために残してある

公式サイトの応答は1ページ10秒ほどかかるので、取得は並列（WORKERS 本）で行い、リクエストの開始は全体で MIN_GAP 秒以上あける。
自分が何者か分かる User-Agent を付ける（ブラウザのふりはしない）。
GitHub Actions（.github/workflows/live.yml）から、アプリの定時処理の起動（jobs/fetch-dispatch.ts）で1日3回、約5時間ずつ動かす。

環境変数: API_BASE_URL, INGEST_TOKEN（probe では不要）
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from bs4 import BeautifulSoup

BASE = "https://www.boatrace.jp/owpc/pc/race"
USER_AGENT = "ai-boat-race-ingest/1.0 (+https://github.com/Investorkabuto/AI-BOAT-RACE)"
JST = dt.timezone(dt.timedelta(hours=9))
TIMEOUT = float(os.environ.get("BOATRACE_TIMEOUT", "30"))
DEBUG = os.environ.get("BOATRACE_DEBUG") == "1"
# 並列の本数と、リクエストの開始の最小間隔（秒）。公式サイトへの負荷を抑える
WORKERS = 4
MIN_GAP = 1.0
# 取得の時刻（締切予定時刻の何秒前か）
BEFOREINFO_FROM = 15 * 60
BEFOREINFO_UNTIL = 6 * 60
BEFOREINFO_RETRY = 2 * 60
ODDS_SLOTS = {"t10": (10 * 60, 8 * 60), "t7": (7 * 60, 5 * 60)}  # slot: (この秒数前から, この秒数前まで)
# レース一覧を読み直す間隔（秒）。締切の変更・中止を拾う
REFRESH_RACES = 5 * 60
TICK = 10


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s).strip()


def num(s: str) -> float | None:
    s = nfkc(s).replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


# ---- 解析（ページごと。HTML だけを受け取る純粋な関数。scripts/tests/test_boatrace_live.py） ----


def _odds_tables(html: str) -> list[list[tuple[int, list[str], str]]]:
    """オッズの表ごとに、(行内の位置 g, オッズの前の艇番のセル, オッズの文字列) の列を返す。

    公式のオッズ表は行優先で、1着（または組の小さい艇）の6列が横に並ぶ。各列は「2着の艇（rowspan で縦に続く）・3着の艇・オッズ」
    または「相手の艇・オッズ」のセルの並び。行の中の何番目のオッズかが列（g）になる
    """
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for table in soup.select("table"):
        if not table.select("td.oddsPoint"):
            continue
        items = []
        for tr in table.select("tbody tr"):
            g, buf = 0, []
            for td in tr.find_all("td", recursive=False):
                if "oddsPoint" in (td.get("class") or []):
                    items.append((g, buf, td.get_text(strip=True)))
                    g, buf = g + 1, []
                else:
                    t = nfkc(td.get_text(strip=True))
                    if re.fullmatch(r"[1-6]", t):
                        buf.append(t)
        out.append(items)
    return out


def parse_odds3t(html: str) -> dict[str, float | None] | None:
    """3連単のオッズ（"1-2-3" → 9.1）。120組そろわなければ None"""
    tables = _odds_tables(html)
    if not tables:
        return None
    second: dict[int, str] = {}
    out: dict[str, float | None] = {}
    for g, buf, v in tables[0]:
        if len(buf) == 2:
            second[g] = buf[0]
        if not buf or g not in second:
            return None
        combo = f"{g + 1}-{second[g]}-{buf[-1]}"
        out[combo] = num(v)
    return out if len(out) == 120 and all(len(set(k.split("-"))) == 3 for k in out) else None


def parse_odds3f(html: str) -> dict[str, float | None] | None:
    """3連複のオッズ（"1=2=3" → 4.4）。20組そろわなければ None"""
    tables = _odds_tables(html)
    if not tables:
        return None
    second: dict[int, str] = {}
    out: dict[str, float | None] = {}
    for g, buf, v in tables[0]:
        if len(buf) == 2:
            second[g] = buf[0]
        if not buf or g not in second:
            return None
        boats = sorted({g + 1, int(second[g]), int(buf[-1])})
        if len(boats) != 3:
            return None
        out["=".join(map(str, boats))] = num(v)
    return out if len(out) == 20 else None


def parse_odds2tf(html: str) -> tuple[dict[str, float | None], dict[str, float | None]] | None:
    """2連単（"1-2"）と2連複（"1=2"）のオッズ。前の表が2連単（30組）、後の表が2連複（15組）"""
    tables = _odds_tables(html)
    if len(tables) < 2:
        return None
    tan: dict[str, float | None] = {}
    for g, buf, v in tables[0]:
        if not buf or buf[-1] == str(g + 1):
            return None
        tan[f"{g + 1}-{buf[-1]}"] = num(v)
    fuku: dict[str, float | None] = {}
    for g, buf, v in tables[1]:
        if not buf:
            return None
        boats = sorted({g + 1, int(buf[-1])})
        if len(boats) != 2:
            return None
        fuku["=".join(map(str, boats))] = num(v)
    return (tan, fuku) if len(tan) == 30 and len(fuku) == 15 else None


def odds_updated_at(html: str) -> str | None:
    """ページに出ているオッズの時点（"締切時" または "HH:MM"）。見つからなければ None"""
    text = BeautifulSoup(html, "html.parser").get_text("\n", strip=True)
    if "締切時オッズ" in text:
        return "締切時"
    m = re.search(r"(?:オッズ更新時間|更新時間)\D{0,6}(\d{1,2}:\d{2})", text)
    return m.group(1) if m else None


def parse_beforeinfo(html: str) -> dict | None:
    """直前情報。展示タイムがどの艇もまだ出ていなければ None（展示の前）。

    boats: 枠ごとの体重・調整重量・展示タイム・チルト・プロペラ・部品交換
    start_exhibition: スタート展示の進入（course 順に、枠 boat と ST）
    weather: 水面気象（時点の表記・天候・気温・風速・風向の番号・水温・波高）
    """
    soup = BeautifulSoup(html, "html.parser")
    boats = []
    main = next((t for t in soup.select("table") if "展示" in (t.select_one("thead").get_text() if t.select_one("thead") else "")), None)
    if main is None:
        return None
    for tbody in main.select("tbody"):
        rows = tbody.find_all("tr", recursive=False)
        if not rows:
            continue
        tds = rows[0].find_all("td", recursive=False)
        if len(tds) < 8:
            continue
        boat = nfkc(tds[0].get_text(strip=True))
        if not re.fullmatch(r"[1-6]", boat):
            continue
        weight = re.sub(r"kg$", "", nfkc(tds[3].get_text(strip=True)))
        adjust = None
        if len(rows) > 2:
            first = rows[2].find("td")
            adjust = num(first.get_text(strip=True)) if first is not None else None
        parts = [nfkc(x) for x in tds[7].get_text("\n", strip=True).split("\n") if nfkc(x)]
        boats.append({
            "boat": int(boat),
            "weight": num(weight),
            "adjust_weight": adjust,
            "exhibit_time": num(tds[4].get_text(strip=True)),
            "tilt": num(tds[5].get_text(strip=True)),
            "propeller": nfkc(tds[6].get_text(strip=True)) or None,
            "parts": parts,
        })
    if len(boats) != 6 or all(b["exhibit_time"] is None for b in boats):
        return None
    start = []
    st_table = next((t for t in soup.select("table") if "スタート展示" in t.get_text()), None)
    if st_table is not None:
        for course, div in enumerate(st_table.select(".table1_boatImage1"), start=1):
            n = div.select_one(".table1_boatImage1Number")
            t = div.select_one(".table1_boatImage1Time")
            if n is None:
                continue
            b = nfkc(n.get_text(strip=True))
            if re.fullmatch(r"[1-6]", b):
                start.append({"course": course, "boat": int(b), "st": nfkc(t.get_text(strip=True)) if t is not None else None})
    weather = None
    w = soup.select_one(".weather1")
    if w is not None:
        def unit(cls: str) -> str:
            el = w.select_one(f".weather1_bodyUnit.{cls}")
            return nfkc(el.get_text(" ", strip=True)) if el is not None else ""

        def value(cls: str) -> float | None:
            m = re.search(r"-?\d+(?:\.\d+)?", unit(cls))
            return float(m.group(0)) if m else None

        title = w.select_one(".weather1_title")
        wind_dir = w.select_one(".weather1_bodyUnit.is-windDirection .weather1_bodyUnitImage")
        m = re.search(r"is-wind(\d+)", " ".join(wind_dir.get("class") or [])) if wind_dir is not None else None
        weather = {
            "as_of": nfkc(title.get_text(strip=True)).replace("水面気象情報", "").strip() if title is not None else None,
            "weather": unit("is-weather") or None,
            "temperature": value("is-direction"),
            "wind_m": value("is-wind"),
            "wind_dir": int(m.group(1)) if m else None,
            "water_temperature": value("is-waterTemperature"),
            "wave_cm": value("is-wave"),
        }
    return {"boats": boats, "start_exhibition": start, "weather": weather}


# ---- 取得 ----

_gap_lock = threading.Lock()
_last_start = [0.0]


def get_html(page: str, race_id: str) -> str:
    """公式サイトのページ。リクエストの開始は全体で MIN_GAP 秒以上あける"""
    date, jcd, rno = race_id.split("-")
    url = f"{BASE}/{page}?rno={int(rno)}&jcd={jcd}&hd={date}"
    with _gap_lock:
        wait = _last_start[0] + MIN_GAP - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_start[0] = time.monotonic()
    started = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        body = r.read().decode("utf-8", "replace")
    if DEBUG:
        print(f"GET {url} {len(body)}B {time.monotonic() - started:.1f}s", file=sys.stderr, flush=True)
    return body


def api(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        os.environ["API_BASE_URL"].rstrip("/") + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {os.environ.get('INGEST_TOKEN', '')}", "Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"API error {e.code} on {method} {path}: {e.read(300).decode('utf-8', 'replace')}") from e


def fetch_odds(race_id: str) -> dict | None:
    """3連単のオッズ（1ページ）。解析できなければ None"""
    h = get_html("odds3t", race_id)
    v = parse_odds3t(h)
    if v is None:
        return None
    return {"sanrentan": v, "as_of": odds_updated_at(h)}


def now_iso() -> str:
    return dt.datetime.now(JST).isoformat(timespec="seconds")


def send(race_id: str, kind: str, slot: str | None, data: dict) -> None:
    api("PUT", "/internal/live", {"race_id": race_id, "kind": kind, "slot": slot, "fetched_at": now_iso(), "data": data})


def load_races(date: str) -> list[dict]:
    """その日の受付中のレース（race_id と締切の epoch 秒）"""
    r = api("GET", f"/internal/live-targets?date={date}")
    return r.get("races", [])


def run(until: dt.datetime) -> None:
    date = dt.datetime.now(JST).strftime("%Y-%m-%d")
    done: set[tuple[str, str]] = set()  # (race_id, "beforeinfo" | "t10" | "t7")
    busy: set[tuple[str, str]] = set()
    tried: dict[str, float] = {}  # 直前情報を最後に試した時刻
    lock = threading.Lock()
    races: list[dict] = []
    loaded = 0.0
    errors = 0

    def job(race_id: str, task: str) -> None:
        nonlocal errors
        try:
            if task == "beforeinfo":
                data = parse_beforeinfo(get_html("beforeinfo", race_id))
                if data is None:
                    return  # 展示の前。あとで取り直す
                send(race_id, "beforeinfo", None, data)
            else:
                data = fetch_odds(race_id)
                if data is None:
                    print(f"odds not parsed: {race_id} {task}", file=sys.stderr, flush=True)
                    return
                send(race_id, "odds", task, data)
            with lock:
                done.add((race_id, task))
            print(f"{now_iso()} {race_id} {task} ok", flush=True)
        except Exception as e:  # 1レースの失敗で全体を止めない
            with lock:
                errors += 1
            print(f"{now_iso()} {race_id} {task} error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        finally:
            with lock:
                busy.discard((race_id, task))

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        while dt.datetime.now(JST) < until:
            t = time.time()
            if t - loaded >= REFRESH_RACES:
                try:
                    races = load_races(date)
                    loaded = t
                except Exception as e:
                    print(f"load races error: {e}", file=sys.stderr, flush=True)
            for r in races:
                rid, left = r["race_id"], r["deadline_s"] - t
                todo = []
                if BEFOREINFO_UNTIL < left <= BEFOREINFO_FROM and (rid, "beforeinfo") not in done and t - tried.get(rid, 0) >= BEFOREINFO_RETRY:
                    todo.append("beforeinfo")
                    tried[rid] = t
                for slot, (start, end) in ODDS_SLOTS.items():
                    if end < left <= start and (rid, slot) not in done:
                        todo.append(slot)
                for task in todo:
                    with lock:
                        if (rid, task) in busy:
                            continue
                        busy.add((rid, task))
                    pool.submit(job, rid, task)
            if loaded and not races:
                break  # 受付中のレースがもう無い（今日の最終レースの締切を過ぎた）
            time.sleep(TICK)
    print(f"done: {len(done)} fetched, {errors} errors", flush=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["run", "probe"])
    p.add_argument("--until", default="23:40", help="この時刻（日本時間 HH:MM）で終える")
    p.add_argument("--race", default="")
    a = p.parse_args()
    if a.command == "probe":
        if not a.race:
            raise SystemExit("--race が必要です（例 20261108-19-11）")
        print(json.dumps({"beforeinfo": parse_beforeinfo(get_html("beforeinfo", a.race)), "odds": fetch_odds(a.race)}, ensure_ascii=False, indent=1))
        return
    h, m = map(int, a.until.split(":"))
    now = dt.datetime.now(JST)
    until = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if until <= now:
        print("until は過ぎています。何もしません")
        return
    run(until)


if __name__ == "__main__":
    main()
