# FNG26_入稿状況Notion管理

forrent.jp の掲載物件を Notion「広告管理/ファンテイズ」DB に新着同期する独立ジョブ。

## 目的

FANGO の SUUMO 入稿フローでは、forrent.jp に掲載されている物件の入稿状況を Notion 側で一元管理する必要がある。本プロジェクトは `FNG26_AI入稿システム` から切り出した **forrent → Notion 同期の単機能ジョブ**。

- **同期元**: forrent.jp (掲載一覧 + 詳細ページ)
- **同期先**: Notion 広告管理DB (DB ID は環境変数で指定)
- **頻度**: 8-22時の毎正時 (launchd)
- **動作**: 新規 `貴社物件コード` のみ追加、既存は触らない

## Quick Start

```bash
cd code/forrent-sync
bun install
cp .env.example .env.local  # 環境変数を設定
bun run scripts/forrent-to-notion.js --dry-run
```

## 環境変数

`.env.local` に以下を設定:

| Key | Description |
|-----|-------------|
| `NOTION_TOKEN` | Notion Integration Token |
| `NOTION_NYUKO_DB_ID` | 同期先 Notion DB ID |
| `SUUMO_LOGIN_ID` | forrent.jp ログインID |
| `SUUMO_LOGIN_PASS` | forrent.jp パスワード |
| `SLACK_WEBHOOK_URL` | (任意) 通知用 Slack Webhook URL |
