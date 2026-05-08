#!/bin/bash
# hourly-forrent-sync.sh — forrent.jp → Notion「広告管理/ファンテイズ」DB 毎時同期
# launchd com.fango.forrent-sync から 8:00-22:00 の毎正時に呼び出される。
# 新規物件のみ追加 (既存kishaCodeは触らない)。
#
# 所属プロジェクト: FNG26_入稿状況Notion管理 (2026-04-24 に FNG26_AI入稿システム から分離)
# 注: JDS反響DBとのrelation backfillは別プロジェクト FNG26_入稿<>JDS の責務。
# lamplighter の fango-jds-linker.js (com.fango.jds-linker, 10分毎) が担当する。

set -euo pipefail
source ~/Scripts/lib/slack-notify.sh

HOUR=$(date '+%-H')
PROJECT_DIR="/Volumes/AgentSSD/04_FANGO/FNG26_入稿状況Notion管理/code/forrent-sync"
BUN="/Users/kentohonda/.bun/bin/bun"
LOG_FILE="/tmp/forrent-sync-hourly.log"
# 多重起動防止のロックは forrent-to-notion.js 側で取得する (/tmp/forrent-sync.lock)

# Rotate log (keep last run only)
: > "$LOG_FILE"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >&2
}

cd "$PROJECT_DIR"

# --- forrent → Notion 新規追加 ---
log "INFO: Starting forrent-to-notion.js"
forrent_output=""
forrent_rc=0
if forrent_output=$("$BUN" run scripts/forrent-to-notion.js 2>>"$LOG_FILE"); then
  log "INFO: forrent-to-notion.js completed"
else
  forrent_rc=$?
  log "ERROR: forrent-to-notion.js failed rc=$forrent_rc"
fi

# --- Extract metrics from JSON output ---
forrent_created=0
forrent_summary=""
if [ -n "$forrent_output" ]; then
  forrent_created=$(echo "$forrent_output" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('created', 0))
except:
    print(0)
" 2>/dev/null || echo 0)
  forrent_summary=$(echo "$forrent_output" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    parts = []
    if 'created' in d: parts.append(f\"created: {d['created']}\")
    if 'scanned' in d: parts.append(f\"scanned: {d['scanned']}\")
    if 'knownSkipped' in d: parts.append(f\"cache_skip: {d['knownSkipped']}\")
    if 'tier2' in d: parts.append(f\"tier2: {d['tier2']}\")
    if 'errors' in d: parts.append(f\"errors: {len(d['errors'])}\")
    print(', '.join(parts) if parts else json.dumps(d, ensure_ascii=False)[:200])
except:
    print(sys.stdin.read()[:200] if hasattr(sys.stdin, 'read') else '')
" 2>/dev/null || echo "$forrent_output" | head -c 200)
fi

# --- 通知: 失敗 or 新規追加ありの時のみSlack、mailboxは常に ---
details="• forrent-to-notion: ${forrent_summary:-OK}"

if [ $forrent_rc -ne 0 ]; then
  error_tail=$(tail -20 "$LOG_FILE" 2>/dev/null || echo "No log available")
  slack_error "🕯️${HOUR}時、ForRent Sync 失敗" "\`\`\`${error_tail:0:500}\`\`\`"
  report_result "forrent-sync" "error" "ForRent hourly sync failed (forrent=$forrent_rc). $details" "${error_tail:0:500}"
elif [ "$forrent_created" -gt 0 ]; then
  slack_success "🕯️${HOUR}時、ForRent Sync 新規${forrent_created}件追加" "$details"
  report_result "forrent-sync" "success" "ForRent hourly sync: new=$forrent_created. $details"
else
  # 新規0件は Slack 抑制、mailbox のみ記録
  report_result "forrent-sync" "success" "ForRent hourly sync: no new. $details"
fi

log "INFO: hourly-forrent-sync.sh finished (forrent=$forrent_rc, created=$forrent_created)"
exit $forrent_rc
