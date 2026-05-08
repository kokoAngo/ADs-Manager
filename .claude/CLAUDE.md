---
last_verified: 2026-04-24
type: code
status: active
stack: [bun, playwright, notion, launchd]
notion: https://www.notion.so/angojp/defb9f3bccc34ae487b441ef7a1c0754
---

# FNG26_入稿状況Notion管理

## Tasks — `~/mytask/` に一元管理

このプロジェクトのタスクは **`~/mytask/<today>.md`** に集約されています（2026-05-08 移行済み）。

- 今日のタスク: `~/mytask/YYYY-MM-DD.md`（今日の日付のファイル）
- アーカイブ: `~/mytask/archive/`
- このプロジェクトに紐づくタスクは `[FANGO] [/Volumes/AgentSSD/04_FANGO/FNG26_入稿状況Notion管理]` タグで識別
- **ローカルに `task.md` / `tasks.md` を新規作成しないこと**。新規タスクは today's md に直接追記する
- 完了したタスクの履歴は git log（このプロジェクト）か `~/mytask/archive/` を参照

## Mission
forrent.jp の掲載物件を Notion「広告管理/ファンテイズ」DB (`defb9f3bcc...`) に新着同期し、入稿状況の一元管理を実現する。SUUMO入稿ダッシュボード本体 (FNG26_AI入稿システム) から切り出した定常同期ジョブの独立プロジェクト。

## Definition of Done
- 8-22時の毎正時に forrent.jp → Notion 新着同期が安定稼働
- 新規 `貴社物件コード` のみ追加 (既存は触らない冪等動作)
- 失敗 or 新規追加ありの時のみ Slack 通知 (`#ex_fango`)
- JDS反響DBとのrelation backfillは本プロジェクトの責務外 (`FNG26_入稿<>JDS` が担当)

## Context Pointers
- Entity: `../.claude/CLAUDE.md`
- Code: `./code/forrent-sync/`
- Scripts: `./code/forrent-sync/scripts/forrent-to-notion.js`, `hourly-forrent-sync.sh`
- launchd: `~/Library/LaunchAgents/com.fango.forrent-sync.plist` (Label: `com.fango.forrent-sync`)
- 上流: `../FNG26_AI入稿システム/` (入稿本体、一部 skill コードを複製して独立運用)
- 下流: `../FNG26_入稿<>JDS/` (反響リレーション紐付け)
- Tasks: `~/mytask/` (中央タスク管理)

## Domain Knowledge
- **対象DB**: Notion「🔵 広告管理/ファンテイズ - forrent」 (`defb9f3bcc34ae487b441ef7a1c0754`)
- **接合キー**: `貴社物件コード` (title, `fng{REINS_ID}` 形式)
- **実行時間帯**: 8:00-22:00 毎正時 (`StartCalendarInterval` × 15時刻)
- **冪等性**: 既存 `kishaCode` はスキップ。重複混入した場合は先勝ち
- **2-tier 方式**:
  - Tier 1: forrent.jp 一覧ページで `bukkenCd` 取得
  - Tier 2: 未知の `bukkenCd` のみ詳細ページで `kishaCode` 取得
  - キャッシュ: `.cache/bukken-kisha-map.json` で `bukkenCd → kishaCode` を記録し Tier 2 呼出を削減
- **多重起動防止**: `/tmp/forrent-sync.lock` に PID 書込 (stale lock は自動上書き)

## Architecture
```
code/forrent-sync/
├── package.json            # 最小deps (playwright, @notionhq/client, dotenv)
├── .env.local              # NOTION_TOKEN, NOTION_NYUKO_DB_ID, SUUMO_LOGIN_ID/PASS, SLACK_WEBHOOK_URL
├── scripts/
│   ├── forrent-to-notion.js      # メインロジック
│   └── hourly-forrent-sync.sh    # launchd wrapper (Slack通知+mailbox report)
├── skills/
│   ├── forrent.js                # FANGO本体からコピー (forrent.jp ログイン/遷移)
│   └── forrent-reader.js         # 同上 (一覧/詳細パーサ)
└── .cache/
    └── bukken-kisha-map.json     # Tier1→Tier2 スキップ用
```

## Workflow
- **通常実行**: `cd code/forrent-sync && bun run scripts/forrent-to-notion.js`
- **dry-run**: `bun run scripts/forrent-to-notion.js --dry-run`
- **件数制限**: `bun run scripts/forrent-to-notion.js --limit=3`
- **ブラウザ可視化**: `HEADLESS=false bun run ...`
- **launchd 運用**:
  - 状態: `launchctl list | grep fango.forrent-sync`
  - 停止: `launchctl unload ~/Library/LaunchAgents/com.fango.forrent-sync.plist`
  - 再開: `launchctl load ~/Library/LaunchAgents/com.fango.forrent-sync.plist`
  - ログ: `/tmp/forrent-sync-hourly.log`

## Anti-patterns
- `skills/forrent.js` を本体 FANGO_AI入稿システム と同期取りに行く (独立運用前提、差分は個別管理)
- 既存 `kishaCode` を上書き更新する (新着のみ追加の冪等性を崩す)
- headless=true で CAPTCHA 誘発 (forrent.jp は headed 前提)
- JDS 反響との relation 書込 (本プロジェクト責務外、`FNG26_入稿<>JDS` に委譲)
