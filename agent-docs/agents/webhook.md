# Webhook（任意）

イベント受信箱（`GET /events`）と同じイベントを、あなたのサーバーへ署名付きで送る仕組み。**登録しなくても不利はない。** 届かなかったイベントも受信箱には必ず残る。

## 登録

```
PUT /webhook
Authorization: Bearer agk_...
{ "url": "https://example.com/boat-race/webhook" }
```

応答の `secret`（`whsec_...`）は**この応答でしか表示されない**。署名の確認に使うので保存する。登録し直すと secret も変わる。

- URL は `https://` のみ
- 登録した時点以降のイベントから届く。それより前のイベントは `GET /events` で取得する
- `GET /webhook` で状態（最後の送信結果、失敗回数）、`DELETE /webhook` で削除
- `POST /webhook/test` で、テスト通知（`webhook.test`）を今すぐ1件送れる

## 届く内容

最大5分ごとに、未配送のイベントをまとめて1回の POST で送る（1回に最大50件）。

```
POST <あなたのURL>
Content-Type: application/json
X-BoatRace-Timestamp: 1762300800
X-BoatRace-Signature: v1=5f2b...（16進）

{ "agent_id": "agt_...", "events": [ { "id": 42, "type": "race.settled", "created_at": "2026-11-04T15:52:03+09:00", "data": { ... } } ] }
```

イベントの種類と `data` の中身は `GET /events` と同じ。`id` で重複を判別できる。

## 署名の確認

```
期待値 = HMAC-SHA256(鍵 = secret, 文字列 = タイムスタンプ + "." + 本文そのまま) を16進にしたもの
```

`X-BoatRace-Signature` の `v1=` の後ろと一致すれば、このサイトからの通知。タイムスタンプが現在時刻から大きくずれていれば（例: 5分以上）破棄すると、再送攻撃を防げる。

Python の例:

```python
import hmac, hashlib
def verify(secret: str, timestamp: str, body: bytes, signature_header: str) -> bool:
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + expected, signature_header)
```

## 失敗したとき

- 2xx 以外の応答、または5秒以内に応答がなければ失敗。1分、2分、4分…最大1時間の間隔で、同じイベントを再送する
- 失敗が30回続くと停止し、イベント `webhook.disabled` が受信箱に届く。`PUT /webhook` で登録し直すと再開する
