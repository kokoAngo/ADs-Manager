#!/usr/bin/env node
/**
 * forrent-to-notion.js — forrent.jp → Notion「広告管理/ファンテイズ」DB 同期
 *
 * 新着物件のみ追加。既存「貴社物件コード」は触らない（掲載期間延長等は別途）。
 * launchd com.fango.forrent-sync が 8-22時の毎正時に呼び出す前提。
 *
 * Usage:
 *   bun run scripts/forrent-to-notion.js              # 通常実行 (headless)
 *   bun run scripts/forrent-to-notion.js --dry-run    # Notion書込スキップ
 *   bun run scripts/forrent-to-notion.js --limit=3    # Tier2対象を上位3件に
 *   HEADLESS=false bun run ...                        # ブラウザを可視化
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const { chromium } = require("playwright");
const { Client: NotionClient } = require("@notionhq/client");
const forrent = require("../skills/forrent");
const reader = require("../skills/forrent-reader");
const jds = require("../skills/jds-reader");

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const NYUKO_DB_ID = process.env.NOTION_NYUKO_DB_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// 掲載物件のみ DB (別 Integration、forrent 真値を独立した DB として保持し、おすすめ DB と比較)
const KEISAI_TOKEN = process.env.NOTION_KEISAI_TOKEN;
const KEISAI_DB_ID = process.env.NOTION_KEISAI_DB_ID;
const OSUSUME_DB_ID = process.env.NOTION_OSUSUME_DB_ID;
const keisaiNotion = KEISAI_TOKEN ? new NotionClient({ auth: KEISAI_TOKEN }) : null;

// ── Notion API throttle + 429 backoff retry ─────────────────
// Notion は ~3 req/s 制限。本スクリプトはバースト送信で 429 を自誘発し、
// しかも fetchExisting 等にリトライが無く一度 rate limit に入ると exit(1) で
// 全処理 (掲載物件のみ同期含む) が巻き添えで停止していた (2026-06-04 障害)。
// 対策: 全 Notion 呼び出しをこのラッパー経由にし、(1) token 種別ごとに最小間隔を
// 空けて自誘発を防ぎ、(2) 429/5xx/timeout を指数バックオフで再試行する。
const NOTION_MIN_INTERVAL_MS = 350;   // 直列化して ~3 req/s 以下に抑える
const NOTION_MAX_RETRIES = 6;         // 429/5xx 時の最大再試行回数
const NOTION_MAX_BACKOFF_MS = 30000;  // 指数バックオフの上限
// token 種別ごとに別レート枠 (default=NOTION_TOKEN, keisai=KEISAI_TOKEN)
const _notionLastCall = { default: 0, keisai: 0 };

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _notionThrottle(bucket) {
  const wait = NOTION_MIN_INTERVAL_MS - (Date.now() - (_notionLastCall[bucket] || 0));
  if (wait > 0) await _sleep(wait);
  _notionLastCall[bucket] = Date.now();
}

// 429 (rate_limited) / 5xx / 一時的ネットワーク障害を指数バックオフで再試行。
// Retry-After ヘッダがあれば優先し、無ければ 1→2→4→8…s (上限 30s) + jitter。
async function withNotionRetry(fn, { bucket = "default", label = "notion" } = {}) {
  let attempt = 0;
  for (;;) {
    await _notionThrottle(bucket);
    try {
      return await fn();
    } catch (err) {
      const code = err && err.code;
      const status = err && err.status;
      const retryable =
        code === "rate_limited" ||
        status === 429 ||
        (typeof status === "number" && status >= 500) ||
        code === "notionhq_client_request_timeout" ||
        code === "service_unavailable" ||
        code === "internal_server_error";
      if (!retryable || attempt >= NOTION_MAX_RETRIES) throw err;
      attempt++;
      let delayMs;
      const raRaw = err && err.headers &&
        (typeof err.headers.get === "function" ? err.headers.get("retry-after") : err.headers["retry-after"]);
      const raSec = raRaw != null ? parseFloat(raRaw) : NaN;
      if (Number.isFinite(raSec) && raSec > 0) {
        delayMs = raSec * 1000;
      } else {
        delayMs = Math.min(1000 * 2 ** (attempt - 1), NOTION_MAX_BACKOFF_MS);
      }
      delayMs += Math.floor(Math.random() * 250); // jitter
      console.error(`  [notion-retry ${attempt}/${NOTION_MAX_RETRIES}] ${label}: ${code || status} → ${Math.round(delayMs)}ms 待機`);
      await _sleep(delayMs);
    }
  }
}

const CACHE_DIR = path.join(__dirname, "..", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "bukken-kisha-map.json");
const LOCK_FILE = "/tmp/forrent-sync.lock";
const OBSIDIAN_LOG_DIR = "/Users/recika/Documents/Obsidian Vault/Fango/forrent-sync";

const MAX_LOGIN_RETRIES = 3;

// JST 時刻 helper (launchd の locale 非依存)
function jstNow() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}

// "<物件名> <部屋番号>号室" を name と room に分割 (失敗時は name 全文 + room 空)
function splitNameRoom(s) {
  if (!s) return { name: "", room: "" };
  // ケース 1: 末尾が「数字部屋号」 例: アーマックス大井町0805号室、ルーブル中板橋六番館301号室
  const m1 = s.match(/^(.+?)(\d[\w\-]*号室)$/);
  if (m1) return { name: m1[1].trim(), room: m1[2].trim() };
  // ケース 2: 末尾が「アルファベット 1 文字部屋号」 例: コーポＥ＆ＪB号室
  const m2 = s.match(/^(.+?)([A-Za-zＡ-Ｚａ-ｚ])号室$/);
  if (m2) return { name: m2[1].trim(), room: `${m2[2]}号室` };
  return { name: s.trim(), room: "" };
}

// 要取り下げ判定:
//   基準 = 3 日 + 反響数 × 2 日 (上限 7 日)
//   days > 基準 で要取り下げ
//   例: echo=0 → 3 日超 / echo=1 → 5 日超 / echo=2 → 7 日超 / echo≥3 → 7 日超 (cap)
// ── JDS 反響 echo 集計ヘルパー ──────────────────────────────
// 全角英数→半角・空白除去・末尾「号室」除去で物件名を正規化し、JDS「問合せ対象」と照合する
const z2h = (s) => (s || "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[　\s]/g, "");
const roomKey = (s) => z2h(s).replace(/号室?$/, "").replace(/^0+/, "").toLowerCase();

// 掲載物件 1 件の反響数を JDS 生反響から集計する (べき等)。
// roomKey 完全一致 かつ 反響日時 >= 掲載開始(created) のものを数える。
function countEcho(name, created, hankyo) {
  const rk = roomKey(name);
  if (!rk) return 0;
  const since = created ? new Date(created).getTime() : 0;
  return hankyo.filter(h => roomKey(h.name) === rk && (h.datetime ? new Date(h.datetime).getTime() : 0) >= since).length;
}

function isToRetire({ days, echo }) {
  if (days == null) return false;
  const threshold = Math.min(3 + 2 * (echo ?? 0), 7);
  return days > threshold;
}

// 掲載物件のみ DB ↔ おすすめ DB 比較
// 戻り値: { keisaiUpserted, keisaiArchived } — 掲載物件のみ DB の真値保持のみ (おすすめ DB は触らない)
async function syncKeisaiDbAndCompare(adActiveEnriched, dryRun = false) {
  if (!keisaiNotion || !KEISAI_DB_ID) return null;

  // 1) 掲載物件のみ DB の現状を取得 (kishaCode → { pageId, status })
  //    現状 Status を保持するのは sticky ロジック (一度「要取り下げ」化したら戻さない) のため。
  const existing = new Map();
  let cursor;
  do {
    const r = await withNotionRetry(() => keisaiNotion.databases.query({
      database_id: KEISAI_DB_ID,
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    }), { bucket: "keisai", label: "keisai.query" });
    for (const p of r.results) {
      const code = (p.properties["自社物件番号"]?.title || []).map(t => t.plain_text || "").join("").trim();
      if (code) {
        const status = p.properties["Status"]?.status?.name || null;
        existing.set(code, { pageId: p.id, status });
      }
    }
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);

  // 2) forrent.jp の adActive (= 真値) を新 DB に upsert
  //    Status: isToRetire 判定で 要取り下げ / 掲載指示済み に振り分け
  //    Sticky: 既存が「要取り下げ」なら戻さない (反響増 → 閾値延長 → 撤下解除を防止)
  const adCodes = new Set();
  const nowMs = Date.now();
  let keisaiUpserted = 0;
  for (const a of adActiveEnriched) {
    if (!a.code) continue; // code 未解決はスキップ
    adCodes.add(a.code);
    const days = a.created ? Math.floor((nowMs - new Date(a.created).getTime()) / 86400000) : null;
    const computedStatus = isToRetire({ days, echo: a.echo }) ? "要取り下げ" : "掲載指示済み";
    const cur = existing.get(a.code);
    // Sticky: 既存 Status が「要取り下げ」なら維持する (掲載指示済みへ戻さない)
    const statusName = (cur && cur.status === "要取り下げ") ? "要取り下げ" : computedStatus;
    const props = {
      "自社物件番号": { title: [{ text: { content: a.code } }] },
      "物件名": { rich_text: [{ text: { content: a.name || "" } }] },
      "Status": { status: { name: statusName } },
    };
    if (a.echo != null) props["反響数"] = { number: a.echo };
    if (dryRun) {
      const changed = !cur || cur.status !== statusName;
      if (statusName === "要取り下げ" || changed) {
        console.error(`  [keisai ${cur ? "update" : "create"}] ${a.code} ${a.name} echo=${a.echo} Status=${cur?.status ?? "(new)"}→${statusName}`);
      }
      keisaiUpserted++;
    } else {
      try {
        if (cur) {
          await withNotionRetry(() => keisaiNotion.pages.update({ page_id: cur.pageId, properties: props }), { bucket: "keisai", label: `keisai.update ${a.code}` });
        } else {
          await withNotionRetry(() => keisaiNotion.pages.create({ parent: { database_id: KEISAI_DB_ID }, properties: props }), { bucket: "keisai", label: `keisai.create ${a.code}` });
        }
        keisaiUpserted++;
      } catch (e) {
        console.error(`  keisai upsert failed ${a.code}: ${e.message}`);
      }
    }
  }

  // 3) 新 DB から「forrent に出てこなくなった」物件を archive
  let keisaiArchived = 0;
  for (const [code, info] of existing) {
    if (!adCodes.has(code)) {
      if (dryRun) {
        console.error(`  [keisai archive] ${code} (Status=${info.status})`);
        keisaiArchived++;
      } else {
        try {
          await withNotionRetry(() => keisaiNotion.pages.update({ page_id: info.pageId, archived: true }), { bucket: "keisai", label: `keisai.archive ${code}` });
          keisaiArchived++;
        } catch (e) {
          console.error(`  keisai archive failed ${code}: ${e.message}`);
        }
      }
    }
  }

  // おすすめ DB との Status 同期 (旧 Step4-6) は 2026-06-04 廃止。
  // 責務分離: おすすめ DB の Status 更新は PVMonitor / ADS の主管 (Fango CLAUDE.md)。
  // 本スクリプトは掲載物件のみ DB の真値保持 (反響数 + Status) に専念する。

  // 4) 同期完了時刻を DB タイトル末尾に刻む → staff が Notion を開くだけで
  //    「最後にいつ正常同期したか」を一目で確認できる (死活監視代わり)。
  //    ※ レコードの照合キーは「自社物件番号」property であり DB タイトルとは別物。
  //      ここを書き換えても upsert 照合には一切影響しない。
  if (!dryRun) {
    try {
      const syncedAt = new Date().toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      await withNotionRetry(() => keisaiNotion.databases.update({
        database_id: KEISAI_DB_ID,
        title: [{ type: "text", text: { content: `掲載物件のみ${process.env.COMPANY_SUFFIX || "-FT"}（最終同期 ${syncedAt}）` } }],
      }), { bucket: "keisai", label: "keisai.dbtitle" });
      console.error(`  DBタイトル同期時刻 更新: ${syncedAt}`);
    } catch (e) {
      console.error(`  DBタイトル同期時刻 更新失敗: ${e.message}`);
    }
  }

  return { keisaiUpserted, keisaiArchived };
}

// Obsidian Vault の日次 Note に実行ログを append する
function appendObsidianLog(summary, createdItems, adActiveItems) {
  const t = jstNow();
  fs.mkdirSync(OBSIDIAN_LOG_DIR, { recursive: true });
  const file = path.join(OBSIDIAN_LOG_DIR, `${t.ymd}.md`);
  const first = !fs.existsSync(file);

  const lines = [];
  if (first) lines.push(`# forrent-sync log — ${t.ymd}`, ``);

  const statusMark = summary.status === "success"
    ? "✅ success"
    : summary.status === "partial"
      ? `⚠ partial — errors: ${(summary.errors || []).length}`
      : `❌ ${summary.status || "error"}`;

  lines.push(`## ${t.hm} JST · ${statusMark}`, ``);
  lines.push(`- scanned: ${summary.scanned ?? 0}`);
  lines.push(`- known-skipped (cache): ${summary.knownSkipped ?? 0}`);
  lines.push(`- tier 2 evaluated: ${summary.tier2 ?? 0}`);
  lines.push(`- tier 2 skipped (既存): ${summary.tier2Skipped ?? 0}`);
  lines.push(`- **created: ${summary.created ?? 0}**`);
  lines.push(`- **updated: ${summary.updated ?? 0}**`);
  lines.push(`- **広告中 (現時点): ${summary.adActive ?? 0}件**`);
  if (adActiveItems && adActiveItems.length > 0) {
    const og = adActiveItems.filter(a => (a.code || "").toLowerCase().startsWith("og")).length;
    const fng = adActiveItems.filter(a => (a.code || "").toLowerCase().startsWith("fng")).length;
    const unknown = adActiveItems.length - og - fng;
    lines.push(`  - 内訳: og ${og}件 / fng ${fng}件${unknown > 0 ? ` / 未解決 ${unknown}件` : ""}`);
    const nowMs = Date.now();
    const retireCount = adActiveItems.filter(a => {
      const days = a.created ? Math.floor((nowMs - new Date(a.created).getTime()) / 86400000) : null;
      return isToRetire({ days, echo: a.echo });
    }).length;
    if (retireCount > 0) {
      lines.push(`- 🚨 **要取下候補 (3日+反響×2日 超、上限7日): ${retireCount}件**`);
    }
  }
  if (summary.keisai) {
    lines.push(`- 掲載物件のみ DB: upsert ${summary.keisai.keisaiUpserted}件 / archive ${summary.keisai.keisaiArchived}件`);
  }

  if (createdItems && createdItems.length > 0) {
    lines.push(``, `### 新規追加`, ``);
    lines.push(`| code | name | room | rent (万) | end | score |`);
    lines.push(`|---|---|---|---:|---|---:|`);
    for (const d of createdItems) {
      const cell = (v) => (v == null || v === "" ? "" : String(v).replace(/\|/g, "\\|"));
      lines.push(`| ${cell(d.kishaCode)} | ${cell(d.bukkenName)} | ${cell(d.roomNo)} | ${cell(d.rent)} | ${cell(d.endDate)} | ${cell(d.score)} |`);
    }
  } else {
    lines.push(``, `(新規なし)`);
  }

  if (summary.updateDetails && summary.updateDetails.length > 0) {
    lines.push(``, `### 既存物件の更新`, ``);
    lines.push(`| code | name | 更新内容 |`);
    lines.push(`|---|---|---|`);
    for (const u of summary.updateDetails) {
      const cell = (v) => (v == null || v === "" ? "" : String(v).replace(/\|/g, "\\|"));
      const desc = Object.entries(u.diffs)
        .map(([k, v]) => `${k}: ${v.from ?? "—"} → ${v.to}`)
        .join(", ");
      lines.push(`| ${cell(u.code)} | ${cell(u.name)} | ${cell(desc)} |`);
    }
  }

  if (adActiveItems && adActiveItems.length > 0) {
    const nowMs = Date.now();
    const computeDays = (created) => created ? Math.floor((nowMs - new Date(created).getTime()) / 86400000) : null;
    const withDays = adActiveItems.map(a => ({ ...a, days: computeDays(a.created) }));
    const toRetire = withDays.filter(a => isToRetire(a));

    lines.push(``, `### 現在広告中 (${adActiveItems.length}件)`, ``);
    lines.push(`| code | name | room | rent (万) | end | score | 反響 | 日数 |`);
    lines.push(`|---|---|---|---:|---|---:|---:|---:|`);
    const sorted = [...withDays].sort((a, b) => String(a.bukkenCd).localeCompare(String(b.bukkenCd)));
    const cell = (v) => (v == null || v === "" ? "" : String(v).replace(/\|/g, "\\|"));
    for (const a of sorted) {
      const { name, room } = splitNameRoom(a.name);
      const codeDisplay = (isToRetire(a) ? "🚨 " : "") + (a.code || "—");
      const daysDisplay = a.days != null ? String(a.days) : "";
      lines.push(`| ${cell(codeDisplay)} | ${cell(name)} | ${cell(room)} | ${cell(a.rent)} | ${cell(a.endDate)} | ${cell(a.nayoseScore)} | ${cell(a.echo)} | ${cell(daysDisplay)} |`);
    }

    if (toRetire.length > 0) {
      lines.push(``, `### 🚨 要取下候補 (3日+反響×2日 超、上限7日: ${toRetire.length}件)`, ``);
      lines.push(`| code | name | room | 掲載日数 | end | 反響 |`);
      lines.push(`|---|---|---|---:|---|---:|`);
      const retireSorted = [...toRetire].sort((a, b) => b.days - a.days);
      for (const a of retireSorted) {
        const { name, room } = splitNameRoom(a.name);
        lines.push(`| ${cell(a.code || "—")} | ${cell(name)} | ${cell(room)} | ${cell(a.days)} | ${cell(a.endDate)} | ${cell(a.echo)} |`);
      }
    }

    // kishaCode 未解決 (= a.code が null) 物件: staff が forrent.jp 詳細ページで
    //   貴社管理コード１ を埋める必要あり。Notion 同期から漏れている。
    const unresolved = adActiveItems.filter(a => !a.code);
    if (unresolved.length > 0) {
      lines.push(``, `### ⚠ kishaCode 未登録 — staff 対応依頼 (${unresolved.length}件)`, ``);
      lines.push(`forrent.jp 詳細ページの「貴社管理コード１※」が空または不完全のため Notion 同期から漏れています。`);
      lines.push(`forrent.jp 物件詳細 → 修正画面 → 貴社管理コード１ に正しいコード (例: og123 / fng100139xxx) を入力して保存してください。`);
      lines.push(``);
      lines.push(`| bukkenCd | name | room | rent (万) | end |`);
      lines.push(`|---|---|---|---:|---|`);
      for (const a of unresolved) {
        const { name, room } = splitNameRoom(a.name);
        lines.push(`| ${cell(a.bukkenCd)} | ${cell(name)} | ${cell(room)} | ${cell(a.rent)} | ${cell(a.endDate)} |`);
      }
    }
  }

  if (summary.errors && summary.errors.length > 0) {
    lines.push(``, `### ⚠ errors`, ``);
    for (const e of summary.errors) {
      const key = e.bukkenCd ? `bukkenCd=${e.bukkenCd}` : e.kishaCode ? `code=${e.kishaCode}` : "?";
      lines.push(`- ${key}: ${e.error}`);
    }
  }

  lines.push(``, `---`, ``);
  fs.appendFileSync(file, lines.join("\n"));
}

// ── Lock: manual/launchd 両方の多重起動防止 (O_EXCL で atomic) ──
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Lock exists — check owner liveness
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10); } catch {}
    if (pid && Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
        console.error(`lock held by pid=${pid}, exit`);
        process.exit(0);
      } catch {
        // stale — break and retry once
        try { fs.unlinkSync(LOCK_FILE); } catch {}
        return acquireLock();
      }
    } else {
      try { fs.unlinkSync(LOCK_FILE); } catch {}
      return acquireLock();
    }
  }
  const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
}

// ── Cache: bukkenCd → kishaCode ──────────────────────────
// 汚染エントリ判定: UI ラベル文字列「貴社管理コード...」が誤抽出されて
// 保存されていた過去 bug 残骸を取り除く。短すぎる値も無効扱い。
function isValidCachedCode(code) {
  if (!code || typeof code !== "string") return false;
  if (code.length < 3) return false;
  if (code.includes("貴社")) return false;
  if (code.includes("※")) return false;
  return true;
}
function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    const cleaned = {};
    let dropped = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (isValidCachedCode(v)) {
        cleaned[k] = v;
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      console.error(`  cache: 汚染エントリ ${dropped}件 除去 (UI ラベル文字列 / 短すぎる値)`);
    }
    return cleaned;
  } catch {
    return {};
  }
}
function saveCache(obj) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error(`cache save failed: ${err.message}`);
  }
}

// ── Notion helpers ────────────────────────────────────────
// 既存 page を 3 種で返す:
//   codes:      貴社物件コード Set → Pattern A 防止 (新規判定)
//   nameRoom:   "物件名__部屋番号" Set → Pattern B 防止
//   codeToPage: kishaCode → { pageId, end, rent, score } Map → 差分更新用
async function fetchExisting() {
  const codes = new Set();
  const nameRoom = new Set();
  const codeToPage = new Map();
  let cursor;
  do {
    const db = await withNotionRetry(() => notion.databases.query({
      database_id: NYUKO_DB_ID,
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    }), { bucket: "default", label: "nyuko.query" });
    for (const p of db.results) {
      const titleArr = p.properties["貴社物件コード"]?.title || [];
      const code = titleArr.map(t => t.plain_text || "").join("").trim();
      if (code) {
        codes.add(code);
        // 「貴社管理コード１※」のような過去の extract bug 残骸は update 対象外
        // (複数 page が同 code を共有 → update が誤った page に書き込まれる事故防止)
        if (!code.includes("貴社")) {
          // 反響数 (echo) は JDS 反響閲覧から集計するため、ここでは読まない (2026-06-04)
          codeToPage.set(code, {
            pageId: p.id,
            end: p.properties["end"]?.date?.start || null,
            rent: p.properties["賃料"]?.number ?? null,
            score: p.properties["score"]?.number ?? null,
            created: p.created_time,
          });
        }
      }

      const name = (p.properties["物件名"]?.rich_text || []).map(t => t.plain_text || "").join("").trim();
      const room = (p.properties["部屋番号"]?.rich_text || []).map(t => t.plain_text || "").join("").trim();
      if (name && room) nameRoom.add(`${name}__${room}`);
    }
    cursor = db.has_more ? db.next_cursor : undefined;
  } while (cursor);
  return { codes, nameRoom, codeToPage };
}

// Tier 1 と Notion 現在値を比較。差があれば diffs オブジェクト、なければ null。
function diffForUpdate(t1, cur) {
  const diffs = {};
  if (t1.endDate && t1.endDate !== cur.end) {
    diffs.end = { from: cur.end, to: t1.endDate };
  }
  if (t1.rent != null && !Number.isNaN(t1.rent) && t1.rent !== cur.rent) {
    diffs.rent = { from: cur.rent, to: t1.rent };
  }
  if (t1.nayoseScore != null && !Number.isNaN(t1.nayoseScore) && t1.nayoseScore !== cur.score) {
    diffs.score = { from: cur.score, to: t1.nayoseScore };
  }
  return Object.keys(diffs).length > 0 ? diffs : null;
}

// diffs → Notion API properties payload
function buildUpdateProps(diffs) {
  const props = {};
  if (diffs.end) props["end"] = { date: { start: diffs.end.to } };
  if (diffs.rent) props["賃料"] = { number: diffs.rent.to };
  if (diffs.score) props["score"] = { number: diffs.score.to };
  return props;
}

function buildNotionProps(data) {
  const props = {};
  const setText = (key, v) => {
    if (v != null && v !== "") props[key] = { rich_text: [{ text: { content: String(v) } }] };
  };
  const setNum = (key, v) => {
    if (v != null && !Number.isNaN(v)) props[key] = { number: v };
  };

  setText("物件名", data.bukkenName);
  setText("部屋番号", data.roomNo);
  setText("最寄駅", data.station);
  setText("間取り", data.layout);
  setNum("賃料", data.rent);
  setNum("面積", data.area);
  setNum("築年", data.buildYear);
  setNum("敷金（ヶ月）", data.shikikinMonths);
  setNum("礼金（ヶ月）", data.reikinMonths);
  setNum("score", data.score);

  if (data.endDate) {
    props["end"] = { date: { start: data.endDate } };
  }

  return props;
}

// ── Login with retry ──────────────────────────────────────
async function loginWithRetry(page) {
  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    try {
      const ok = await forrent.login(page, {
        id: process.env.SUUMO_LOGIN_ID,
        pass: process.env.SUUMO_LOGIN_PASS,
      });
      if (ok) return true;
      console.error(`Login attempt ${attempt}: redirected to wrong page`);
    } catch (err) {
      console.error(`Login attempt ${attempt}: ${err.message}`);
    }
    if (attempt < MAX_LOGIN_RETRIES) await page.waitForTimeout(3000);
  }
  return false;
}

// ── Report ────────────────────────────────────────────────
async function report(obj) {
  console.log(JSON.stringify(obj));

  if (!SLACK_WEBHOOK_URL) return;
  // 新規0件の成功通知は抑制（毎時鳴らさない）
  if (obj.status === "success" && (obj.created ?? 0) === 0) return;

  const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const lines = [`📊 forrent→広告管理 同期: ${ts}`];
  if (obj.status === "error") {
    lines.push(`❌ エラー: ${obj.error}`);
  } else {
    lines.push(`✅ 新規追加: ${obj.created}件 / スキャン: ${obj.scanned}件`);
    if (obj.errors?.length > 0) lines.push(`⚠ エラー: ${obj.errors.length}件`);
  }
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
  } catch (err) {
    console.error(`Slack notify failed: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────
async function run(opts) {
  if (!NYUKO_DB_ID) {
    await report({ agent: "forrent-sync", status: "error", error: "NOTION_NYUKO_DB_ID未設定" });
    process.exit(1);
  }
  acquireLock();

  console.error("=== Notion 既存貴社物件コード取得 ===");
  const { codes: existing, nameRoom: existingNameRoom, codeToPage } = await fetchExisting();
  console.error(`  既存 code: ${existing.size}件 / 既存 物件名+部屋: ${existingNameRoom.size}件`);

  // 既存 set が極端に小さい場合は schema 異常の可能性 — 安全弁
  if (existing.size === 0) {
    await report({ agent: "forrent-sync", status: "error", error: "fetchExisting returned 0 codes (schema check?)" });
    process.exit(1);
  }

  const cache = loadCache();
  console.error(`  cache (bukkenCd→kishaCode): ${Object.keys(cache).length}件`);

  console.error("\n=== forrent.jp ログイン ===");
  const headless = process.env.HEADLESS !== "false";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", async (d) => { await d.accept(); });

  const loginOk = await loginWithRetry(page);
  if (!loginOk) {
    await browser.close();
    await report({ agent: "forrent-sync", status: "error", error: "FORRENT_LOGIN_FAILED" });
    process.exit(1);
  }
  console.error("  ログイン成功");

  console.error("\n=== 一覧取得 (Tier 1) ===");
  let mainFrame = await reader.navigateToListPage(page);
  let listData = await reader.parseListPage(mainFrame);
  const allProperties = [...listData.properties];
  console.error(`  ページ1: ${listData.properties.length}件 (total: ${listData.total})`);

  while (allProperties.length < listData.total) {
    mainFrame = page.frame({ name: "main" });
    const hasNext = await reader.goToNextPage(page, mainFrame);
    if (!hasNext) break;
    mainFrame = page.frame({ name: "main" });
    const nextPage = await reader.parseListPage(mainFrame);
    allProperties.push(...nextPage.properties);
    console.error(`  ページ追加: +${nextPage.properties.length}件 (合計: ${allProperties.length})`);
  }

  console.error(`  Tier 1 合計: ${allProperties.length}件`);

  // cache bridge: bukkenCd 既知 & 対応 kishaCode が Notion 既存 → Tier2 不要 (差分あれば update へ)
  const unknownBukkens = [];
  const pendingUpdates = [];
  let knownSkipped = 0;
  for (const t1 of allProperties) {
    const cachedKisha = cache[t1.bukkenCd];
    if (cachedKisha && existing.has(cachedKisha)) {
      const cur = codeToPage.get(cachedKisha);
      const d = cur ? diffForUpdate(t1, cur) : null;
      if (d) {
        pendingUpdates.push({ pageId: cur.pageId, code: cachedKisha, name: t1.name, diffs: d });
      } else {
        knownSkipped++;
      }
      continue;
    }
    unknownBukkens.push(t1);
  }
  console.error(`  cache経由スキップ: ${knownSkipped}件 / 更新候補: ${pendingUpdates.length}件 / Tier2必要: ${unknownBukkens.length}件`);

  let targets = unknownBukkens;
  if (opts.limit) targets = targets.slice(0, opts.limit);

  const toCreate = [];
  const errors = [];
  let tier2Skipped = 0;

  console.error(`\n=== 詳細取得+新規判定 (Tier 2): ${targets.length}件 ===`);
  for (let i = 0; i < targets.length; i++) {
    const t1 = targets[i];
    console.error(`\n[${i + 1}/${targets.length}] bukkenCd=${t1.bukkenCd} ${t1.name}`);
    try {
      mainFrame = await reader.navigateToDetail(page, null, t1.bukkenCd);
      const t2 = await reader.extractPropertyDetail(page, mainFrame);

      const kishaCode = (t2.kishaCode || "").trim();
      if (!kishaCode) {
        console.error(`  -> WARN: kishaCode 抽出失敗 → skip (bukkenCd=${t1.bukkenCd})`);
        errors.push({ bukkenCd: t1.bukkenCd, error: "kishaCode extraction failed" });
        continue;
      }
      cache[t1.bukkenCd] = kishaCode;

      if (existing.has(kishaCode)) {
        const cur = codeToPage.get(kishaCode);
        const d = cur ? diffForUpdate(t1, cur) : null;
        if (d) {
          console.error(`  -> 既存 kishaCode=${kishaCode} → 差分あり、更新候補`);
          pendingUpdates.push({ pageId: cur.pageId, code: kishaCode, name: t1.name, diffs: d });
        } else {
          console.error(`  -> 既存 kishaCode=${kishaCode} → skip`);
          tier2Skipped++;
        }
        continue;
      }

      // Pattern B 防止: 同一物件 (name+room) が別 code で既登録なら skip
      const bukkenName = (t2.bukkenName || t1.name || "").trim();
      const roomNo = (t2.roomNo || "").trim();
      const nameRoomKey = bukkenName && roomNo ? `${bukkenName}__${roomNo}` : null;
      if (nameRoomKey && existingNameRoom.has(nameRoomKey)) {
        console.error(`  -> 既存 物件名+部屋="${nameRoomKey}" → skip (新code=${kishaCode})`);
        tier2Skipped++;
        continue;
      }

      // 同一ラン内の重複防止
      existing.add(kishaCode);
      if (nameRoomKey) existingNameRoom.add(nameRoomKey);

      const data = {
        kishaCode,
        bukkenName,
        roomNo,
        station: t1.station,
        rent: t1.rent,
        layout: t2.layout || t1.layout,
        area: t1.area,
        buildYear: t2.buildYear,
        shikikinMonths: t1.shikikinMonths,
        reikinMonths: t1.reikinMonths,
        score: t1.nayoseScore,
        endDate: t1.endDate,
      };
      toCreate.push(data);
      console.error(`  -> NEW: ${data.bukkenName} ${data.roomNo} | rent=${data.rent}万 end=${data.endDate} score=${data.score}`);

      await page.waitForTimeout(1000);
    } catch (err) {
      console.error(`  -> ERROR: ${err.message}`);
      errors.push({ bukkenCd: t1.bukkenCd, error: err.message });
    }
  }

  // ── JDS 反響取得 (echo の真値ソース) ───────────────────────
  // forrent ブラウザを閉じる前に、同一 browser の別 page で JDS にログインし反響を取得。
  let hankyoRaw = [];
  if (process.env.JDS_LOGIN_ID && process.env.JDS_HANKYO_URL) {
    try {
      console.error("\n=== JDS 反響取得 ===");
      const jdsPage = await context.newPage();
      jdsPage.on("dialog", async (d) => { await d.accept().catch(() => {}); });
      const jdsOk = await jds.loginJds(jdsPage, {
        id: process.env.JDS_LOGIN_ID,
        pass: process.env.JDS_LOGIN_PASS,
        url: process.env.JDS_HANKYO_URL,
      });
      if (jdsOk) {
        // 取得期間は広めにして countEcho の created>= で絞る (掲載長引き物件の取りこぼし防止)。
        // 注: JDS の期間 select は月・日のみ (年なし) → 30日程度なら月跨ぎ1回で安全。年跨ぎ(12月)は要注意。
        const days = parseInt(process.env.JDS_HANKYO_DAYS || "30", 10);
        const now = new Date();
        const from = new Date(now.getTime() - days * 86400000);
        hankyoRaw = await jds.fetchHankyo(jdsPage, {
          fromDate: { month: from.getMonth() + 1, day: from.getDate() },
          toDate: { month: now.getMonth() + 1, day: now.getDate() },
        });
        console.error(`  JDS 反響 ${hankyoRaw.length}件取得 (直近${days}日)`);
      } else {
        console.error("  JDS ログイン失敗 → echo は 0 になります");
      }
      await jdsPage.close();
    } catch (e) {
      console.error(`  JDS 反響取得失敗 (echo=0 続行): ${e.message}`);
    }
  } else {
    console.error("  JDS env 未設定 → echo は 0 になります");
  }

  await browser.close();
  saveCache(cache);

  // Create pages
  let created = 0;
  if (opts.dryRun) {
    console.error(`\n=== DRY RUN: ${toCreate.length}件 ===`);
    for (const d of toCreate) console.error(`  + ${d.kishaCode} ${d.bukkenName} ${d.roomNo}`);
  } else {
    console.error(`\n=== Notion 作成: ${toCreate.length}件 ===`);
    for (const d of toCreate) {
      try {
        const props = buildNotionProps(d);
        props["貴社物件コード"] = { title: [{ text: { content: d.kishaCode } }] };
        await withNotionRetry(() => notion.pages.create({
          parent: { database_id: NYUKO_DB_ID },
          properties: props,
        }), { bucket: "default", label: `nyuko.create ${d.kishaCode}` });
        created++;
      } catch (err) {
        console.error(`  create failed ${d.kishaCode}: ${err.message}`);
        errors.push({ kishaCode: d.kishaCode, error: err.message });
      }
    }
  }

  // ── Notion 既存物件の差分更新 ───────────────────────────
  let updated = 0;
  if (pendingUpdates.length > 0) {
    if (opts.dryRun) {
      console.error(`\n=== DRY RUN 更新候補: ${pendingUpdates.length}件 ===`);
      for (const u of pendingUpdates) {
        const summary = Object.entries(u.diffs)
          .map(([k, v]) => `${k}: ${v.from} → ${v.to}`).join(", ");
        console.error(`  ~ ${u.code} ${u.name} | ${summary}`);
      }
    } else {
      console.error(`\n=== Notion 更新: ${pendingUpdates.length}件 ===`);
      for (const u of pendingUpdates) {
        try {
          await withNotionRetry(() => notion.pages.update({
            page_id: u.pageId,
            properties: buildUpdateProps(u.diffs),
          }), { bucket: "default", label: `nyuko.update ${u.code}` });
          updated++;
          const summary = Object.entries(u.diffs)
            .map(([k, v]) => `${k}: ${v.from} → ${v.to}`).join(", ");
          console.error(`  ~ ${u.code} | ${summary}`);
        } catch (err) {
          console.error(`  update failed ${u.code}: ${err.message}`);
          errors.push({ kishaCode: u.code, error: `update failed: ${err.message}` });
        }
      }
    }
  }

  // 現在広告中 (forrent.jp Tier 1 で isPublished=true な物件) を抽出
  const adActive = allProperties.filter(t1 => t1.isPublished);
  const adActiveEnriched = adActive.map(t1 => {
    const cached = cache[t1.bukkenCd];
    const code = (cached && !cached.includes("貴社")) ? cached : null;
    const page = code ? codeToPage.get(code) : null;
    const created = page?.created ?? null;
    // echo は JDS 反響を物件名で照合・集計 (掲載開始以降のみ、べき等)
    return { ...t1, code, echo: countEcho(t1.name, created, hankyoRaw), created };
  });
  const echoHits = adActiveEnriched.filter(a => a.echo > 0);
  console.error(`=== echo>0: ${echoHits.length}件 ${echoHits.map(a => `${a.name}=${a.echo}`).join(", ")} ===`);

  const r = {
    agent: "forrent-sync",
    status: errors.length > 0 ? "partial" : "success",
    scanned: allProperties.length,
    knownSkipped,
    tier2: targets.length,
    tier2Skipped,
    created,
    updated,
    adActive: adActive.length,
    dryRun: !!opts.dryRun,
  };
  if (pendingUpdates.length > 0) {
    r.updateDetails = pendingUpdates.map(u => ({ code: u.code, name: u.name, diffs: u.diffs }));
  }
  if (errors.length > 0) r.errors = errors;

  // 掲載物件のみ DB upsert + おすすめ DB と矛盾検出
  // dry-run でも syncKeisai を呼ぶが、write は全てスキップして影響件数のみ予測表示 (CLAUDE.md Rule 1)
  try {
    const keisaiResult = await syncKeisaiDbAndCompare(adActiveEnriched, opts.dryRun);
    if (keisaiResult) {
      r.keisai = keisaiResult;
      console.error(`\n=== 掲載物件のみ DB${opts.dryRun ? " [DRY RUN 予測]" : ""}: upsert=${keisaiResult.keisaiUpserted}, archive=${keisaiResult.keisaiArchived} ===`);
    }
  } catch (e) {
    console.error(`keisai compare failed: ${e.message}`);
  }

  // Obsidian 日次 Note にログを追記 (dry-run 時はスキップ、書き込み失敗で pipeline を落とさない)
  if (!opts.dryRun) {
    try {
      appendObsidianLog(r, toCreate, adActiveEnriched);
    } catch (e) {
      console.error(`obsidian log failed: ${e.message}`);
    }
  }

  await report(r);
}

// CLI
const args = process.argv.slice(2);
const opts = {
  dryRun: args.includes("--dry-run"),
  limit: (() => {
    const a = args.find(x => x.startsWith("--limit="));
    return a ? parseInt(a.split("=")[1]) : 0;
  })(),
};

run(opts).catch(async (err) => {
  await report({
    agent: "forrent-sync",
    status: "error",
    error: err.message,
    stack: err.stack?.split("\n").slice(0, 3).join(" | "),
  });
  process.exit(1);
});
