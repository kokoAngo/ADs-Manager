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

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const NYUKO_DB_ID = process.env.NOTION_NYUKO_DB_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const CACHE_DIR = path.join(__dirname, "..", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "bukken-kisha-map.json");
const LOCK_FILE = "/tmp/forrent-sync.lock";

const MAX_LOGIN_RETRIES = 3;

// ── Lock: manual/launchd 両方の多重起動防止 ──────────────
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
    if (pid && Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
        console.error(`lock held by pid=${pid}, exit`);
        process.exit(0);
      } catch {
        // stale lock — overwrite below
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
}

// ── Cache: bukkenCd → kishaCode ──────────────────────────
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
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
async function fetchExistingKishaCodes() {
  const set = new Set();
  let cursor;
  do {
    const db = await notion.databases.query({
      database_id: NYUKO_DB_ID,
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const p of db.results) {
      const code = p.properties["貴社物件コード"]?.title?.[0]?.plain_text || "";
      if (code) set.add(code);
    }
    cursor = db.has_more ? db.next_cursor : undefined;
  } while (cursor);
  return set;
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
  const existing = await fetchExistingKishaCodes();
  console.error(`  既存: ${existing.size}件`);

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

  // cache bridge: bukkenCd 既知 & 対応 kishaCode が Notion 既存 → Tier2 不要
  const unknownBukkens = [];
  let knownSkipped = 0;
  for (const t1 of allProperties) {
    const cachedKisha = cache[t1.bukkenCd];
    if (cachedKisha && existing.has(cachedKisha)) {
      knownSkipped++;
      continue;
    }
    unknownBukkens.push(t1);
  }
  console.error(`  cache経由スキップ: ${knownSkipped}件 / Tier2必要: ${unknownBukkens.length}件`);

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

      const kishaCode = t2.kishaCode || t1.bukkenCd;
      cache[t1.bukkenCd] = kishaCode;

      if (existing.has(kishaCode)) {
        console.error(`  -> 既存 kishaCode=${kishaCode} → skip`);
        tier2Skipped++;
        continue;
      }
      // 同一ラン内の重複防止 (forrent側で同じkishaCodeが複数bukkenCdに跨がるケース)
      existing.add(kishaCode);

      const data = {
        kishaCode,
        bukkenName: t2.bukkenName || t1.name,
        roomNo: t2.roomNo,
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
        await notion.pages.create({
          parent: { database_id: NYUKO_DB_ID },
          properties: props,
        });
        created++;
      } catch (err) {
        console.error(`  create failed ${d.kishaCode}: ${err.message}`);
        errors.push({ kishaCode: d.kishaCode, error: err.message });
      }
    }
  }

  const r = {
    agent: "forrent-sync",
    status: errors.length > 0 ? "partial" : "success",
    scanned: allProperties.length,
    knownSkipped,
    tier2: targets.length,
    tier2Skipped,
    created,
    dryRun: !!opts.dryRun,
  };
  if (errors.length > 0) r.errors = errors;

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
