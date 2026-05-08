# FNG26_入稿状況Notion管理

forrent.jp の掲載物件を Notion「広告管理/ファンテイズ」DB に新着同期する独立ジョブ。

## 目的

FANGO の SUUMO 入稿フローでは、forrent.jp に掲載されている物件の入稿状況を Notion 側で一元管理する必要がある。本プロジェクトは `FNG26_AI入稿システム` から切り出した **forrent → Notion 同期の単機能ジョブ**。

- **同期元**: forrent.jp (掲載一覧 + 詳細ページ)
- **同期先**: Notion「🔵 広告管理/ファンテイズ - forrent」 ([`defb9f3bcc...`](https://www.notion.so/angojp/defb9f3bccc34ae487b441ef7a1c0754))
- **頻度**: 8-22時の毎正時 (launchd)
- **動作**: 新規 `貴社物件コード` のみ追加、既存は触らない

## Quick Start

```bash
cd code/forrent-sync
bun install
bun run scripts/forrent-to-notion.js --dry-run
```

詳細は `.claude/CLAUDE.md` 参照。

## 関連プロジェクト

| Project | 役割 |
|---------|------|
| `FNG26_AI入稿システム` | 入稿本体 (REINS → forrent.jp 入稿) |
| `FNG26_入稿<>JDS` | JDS反響 → 広告管理DB relation 紐付け (10分毎) |
| **FNG26_入稿状況Notion管理** (本プロジェクト) | forrent.jp → 広告管理DB 新着同期 (毎正時) |
