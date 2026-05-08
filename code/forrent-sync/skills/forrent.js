/**
 * forrent.jp (SUUMO入稿) Skill — v3
 *
 * form-structure.json (891 fields) から取得した実データに基づく
 * 完全に決定論的なフィールドマッピング。推測ベースのセレクタは廃止。
 *
 * フォーム構造（入力順序）:
 * 1. 棟情報: 物件名, 階建, 部屋番号, 物件種別, 構造, 築年月
 * 2. 所在地: 都道府県→市郡区→町村(cascade)→字丁(cascade)→番地
 * 3. 会社間流通チェックボックス OFF
 * 4. 交通: らくらく交通入力 (id=rakurakuKotsu)
 * 5. お金: 賃料(万+千), 管理費(万+円), 敷金(ヶ月/万), 礼金(ヶ月/万)
 * 6. 間取り: 部屋数 + タイプ(select) + 面積(整数+小数)
 * 7. テキスト: bukkenCatch, netCatch, netFreeMemo, freeMemo
 * 8. 画像: 外観(gaikan), パース(perth), 室内(shitsunai), 写真1-3, 追加画像1-8
 */

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

// ── URLs & Selectors ──

const FORRENT_URLS = {
  login: "https://www.fn.forrent.jp/fn/",
};

const FORRENT_SELECTORS = {
  login: {
    idInput: 'input[type="text"]',
    passInput: 'input[type="password"]',
    submitBtn: 'input[type="image"]',
  },
  navi: {
    menuNewProperty: "#menu_2",
  },
};

// ── REINS → forrent.jp 値マッピング ──

// Struts form name prefix (HTML上のリテラル文字列)
const S = "${bukkenInputForm.";

// 物件種別 code
// REINSは "タウン" / "戸建" 等の短縮形を返すことがあるため略称も許容する。
// どれにもマッチしない場合のフォールバックは下の resolvePropertyTypeCode() で。
const PROPERTY_TYPE_CODE = {
  マンション: "01", アパート: "02", "一戸建て": "11", "一戸建": "11", 戸建: "11",
  "テラス・タウンハウス": "16", テラスハウス: "16", タウンハウス: "16", タウン: "16", テラス: "16",
  その他: "99",
};

// REINSの物件種目 → forrent物件種別コード。dict miss 時は部分一致でフォールバック。
function resolvePropertyTypeCode(shumoku) {
  if (!shumoku) return null;
  const key = String(shumoku).trim();
  const exact = PROPERTY_TYPE_CODE[key];
  if (exact) return exact;
  if (/タウン|テラス/.test(key)) return "16";
  if (/マンション|ＭＳ/i.test(key)) return "01";
  if (/アパート/.test(key)) return "02";
  if (/戸建|一戸/.test(key)) return "11";
  return null;
}

// 構造 code
const STRUCTURE_CODE = {
  RC: "01", ＲＣ: "01", 鉄筋コンクリート: "01", "鉄筋コン": "01",
  SRC: "02", ＳＲＣ: "02", 鉄骨鉄筋コンクリート: "02", "鉄骨鉄筋": "02",
  PC: "03", "プレコン": "03",
  HPC: "04", "鉄骨プレ": "04",
  W: "05", 木造: "05",
  S: "06", Ｓ: "06", 鉄骨: "06",
  LS: "07", 軽量鉄骨: "07",
  ALC: "08", "気泡コン": "08",
  CB: "09", ブロック: "09",
  その他: "99",
};

// 間取りタイプ code
const MADORI_TYPE_CODE = {
  ワンルーム: "01", K: "02", Ｋ: "02", DK: "03", ＤＫ: "03",
  SDK: "04", LDK: "05", ＬＤＫ: "05", SLDK: "06",
  LK: "07", SK: "08", SLK: "09",
};

// ── 周辺環境カテゴリコード（単一ソース） ──
const SHUHEN_CATEGORY_CODES = {
  "060201": "ショッピングセンター",
  "060202": "スーパー",
  "060203": "コンビニ",
  "060204": "ドラッグストア",
  "060207": "学校",
  "060210": "病院",
  "060211": "郵便局",
  "060218": "飲食店",
};

// ══════════════════════════════════════════════════════════
//  LOW-LEVEL HELPERS
// ══════════════════════════════════════════════════════════

/** fill input/textarea by ID */
async function fillById(f, id, value, label) {
  if (!value && value !== 0) return false;
  try {
    await f.fill(`#${id}`, String(value));
    console.log(`[forrent] + ${label}: "${value}"`);
    await f.waitForTimeout(200);
    return true;
  } catch (e) {
    console.log(`[forrent] x ${label}: ${e.message.slice(0, 60)}`);
    return false;
  }
}

/** fill input by Struts name attribute (handles ${} escaping via evaluate) */
async function fillByName(f, name, value, label) {
  if (!value && value !== 0) return false;
  try {
    const ok = await f.evaluate(({ n, v }) => {
      const el = document.querySelector(`[name="${n}"]`);
      if (!el) return false;
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      return true;
    }, { n: name, v: String(value) });
    console.log(`[forrent] ${ok ? "+" : "x"} ${label}: "${value}"`);
    return ok;
  } catch (e) {
    console.log(`[forrent] x ${label}: ${e.message.slice(0, 60)}`);
    return false;
  }
}

/** select option by value code, using Struts name attribute */
async function selectByName(f, name, code, label) {
  if (!code) return false;
  try {
    const ok = await f.evaluate(({ n, c }) => {
      const el = document.querySelector(`select[name="${n}"]`);
      if (!el) return false;
      const opt = Array.from(el.options).find(o => o.value === c);
      if (!opt) return false;
      el.value = c;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { n: name, c: code });
    console.log(`[forrent] ${ok ? "+" : "x"} ${label}: code=${code}`);
    return ok;
  } catch (e) {
    console.log(`[forrent] x ${label}: ${e.message.slice(0, 60)}`);
    return false;
  }
}

/** select option by ID — tries value first, then label partial match */
async function selectById(f, id, text, label) {
  if (!text) return false;
  try {
    // 1. 完全一致（label）
    await f.selectOption(`#${id}`, { label: text });
    console.log(`[forrent] + ${label}: "${text}"`);
    await f.waitForTimeout(500);
    return true;
  } catch {
    // 2. 部分一致
    try {
      const val = await f.evaluate(({ elId, txt }) => {
        const el = document.getElementById(elId);
        if (!el) return null;
        const opts = Array.from(el.options);
        const m = opts.find(o => o.text.trim() === txt) ||
                  opts.find(o => o.text.includes(txt)) ||
                  opts.find(o => txt.includes(o.text.replace(/（.*）/, "").trim()));
        return m?.value ?? null;
      }, { elId: id, txt: text });
      if (val) {
        await f.selectOption(`#${id}`, val);
        console.log(`[forrent] + ${label}: "${text}" (partial match)`);
        await f.waitForTimeout(500);
        return true;
      }
    } catch {}
    console.log(`[forrent] x ${label}: "${text}" not found`);
    return false;
  }
}

/** set checkbox by ID */
async function setCheckbox(f, id, checked, label) {
  try {
    const current = await f.$eval(`#${id}`, el => el.checked);
    if (current !== checked) {
      await f.click(`#${id}`);
      console.log(`[forrent] + ${label}: ${checked ? "ON" : "OFF"}`);
      await f.waitForTimeout(200);
    }
    return true;
  } catch (e) {
    console.log(`[forrent] x ${label}: ${e.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Radio button をインデックス（0始まり）で選択する。
 * forrent.jp のradio value値は推測不可能なため、index指定が最も確実。
 */
async function selectRadioByIndex(f, fieldName, index) {
  return f.evaluate(({ fieldName, index }) => {
    const selector = `input[type="radio"][name="\${bukkenInputForm.${fieldName}}"]`;
    const radios = document.querySelectorAll(selector);
    if (radios.length > index) {
      radios[index].checked = true;
      radios[index].dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, { fieldName, index });
}

/** wait for cascade select to populate (options > 1) */
async function waitForCascade(f, selectId, timeoutMs = 5000) {
  try {
    await f.waitForFunction(
      (id) => {
        const el = document.getElementById(id);
        return el && el.options.length > 1;
      },
      selectId,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    console.log(`[forrent] x cascade ${selectId}: timeout`);
    return false;
  }
}

// ══════════════════════════════════════════════════════════
//  LOGIN & NAVIGATION
// ══════════════════════════════════════════════════════════

async function login(page, credentials) {
  await page.goto(FORRENT_URLS.login, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForTimeout(3000);
  await page.fill(FORRENT_SELECTORS.login.idInput, credentials.id);
  await page.waitForTimeout(300);
  await page.fill(FORRENT_SELECTORS.login.passInput, credentials.pass);
  await page.waitForTimeout(300);
  await page.click(FORRENT_SELECTORS.login.submitBtn);
  await page.waitForTimeout(8000);
  return page.url().includes("main_r.action");
}

async function navigateToNewProperty(page, { deleteDraft = true } = {}) {
  const naviFrame = page.frame({ name: "navi" });
  if (!naviFrame) throw new Error("Navi frame not found");
  await naviFrame.click(FORRENT_SELECTORS.navi.menuNewProperty);
  await page.waitForTimeout(5000);
  const mainFrame = page.frame({ name: "main" });
  if (!mainFrame) throw new Error("Main frame not found");

  // ドラフト復元ダイアログが出ている場合
  const hasDraft = await mainFrame.evaluate(() => {
    const btn = document.getElementById("deleteDraftButton");
    if (btn && btn.offsetParent !== null) return true;
    return false;
  });
  if (hasDraft) {
    if (deleteDraft) {
      console.log("[forrent] ドラフト検出 → 削除して新規物件登録");
      await mainFrame.click("#deleteDraftButton");
      await page.waitForTimeout(2000);
      const yesBtn = await mainFrame.$("#yesDeleteDraftButton");
      if (yesBtn) {
        await yesBtn.click();
        await page.waitForTimeout(3000);
      }
    } else {
      console.log("[forrent] ドラフト検出 → 保持（deleteDraft=false）");
    }
  }

  return { mainFrame, title: await mainFrame.title() };
}

// ══════════════════════════════════════════════════════════
//  MAIN FORM FILL — 決定論的フィールドマッピング
// ══════════════════════════════════════════════════════════

async function fillPropertyForm(mainFrame, reinsData, initialCostData = null) {
  const filled = {};
  const errors = [];
  const ok = (name, result) => {
    if (result) filled[name] = true;
    else errors.push(name);
  };

  console.log("[forrent] === FORM FILL START ===");

  // ═══ 1. 棟情報 ═══

  // 物件名 — id="bukkenNm", max=35
  ok("物件名", await fillById(mainFrame, "bukkenNm", reinsData.建物名, "物件名"));

  // 地上階建 — id="kai", max=2
  const floors = norm(reinsData.地上階層)?.match(/(\d+)/)?.[1];
  if (floors) ok("地上階建", await fillById(mainFrame, "kai", floors, "地上階建"));

  // 地下階建 — id="chikaInput", max=1
  const bFloors = norm(reinsData.地下階層)?.match(/(\d+)/)?.[1];
  if (bFloors) ok("地下階建", await fillById(mainFrame, "chikaInput", bFloors, "地下階建"));

  // 階部分 — id="kaibubun", max=5
  // 優先順位: 1) 所在階が有効な数字, 2) 部屋番号から推定（901→9, 1201→12）, 3) 部屋番号1-2桁の場合
  let floor = null;
  const rawFloor = norm(reinsData.所在階 || "");
  if (/^\d+$/.test(rawFloor)) {
    floor = rawFloor;
  } else if (reinsData.部屋番号) {
    const digits = norm(reinsData.部屋番号).replace(/\D/g, "");
    if (digits.length >= 3) {
      floor = String(parseInt(digits.slice(0, -2), 10)); // 901→9, 1201→12
    } else if (digits.length === 1 || digits.length === 2) {
      // 小規模物件: 部屋番号が1-2桁 → 地上階建が2-3階なら部屋番号の先頭桁を階に
      const totalFloors = parseInt(norm(reinsData.地上階層 || "")?.match(/(\d+)/)?.[1] || "0", 10);
      if (totalFloors > 0 && totalFloors <= 5 && parseInt(digits[0], 10) <= totalFloors) {
        floor = digits[0]; // "4"→4階, "201"→already handled above
      }
    }
  }
  if (floor) ok("階部分", await fillById(mainFrame, "kaibubun", floor, "階部分"));

  // 号室 — id="heyaNoInput", max=10, 半角英数記号のみ
  // 念のため入力直前にも全角→半角正規化 + 最終チェック（REINS側と二重防御）
  if (reinsData.部屋番号) {
    const raw = String(reinsData.部屋番号).trim();
    const normalized = raw
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[\u3000\s]+/g, "")
      .trim();
    if (/^[\x21-\x7E]{1,10}$/.test(normalized)) {
      ok("号室", await fillById(mainFrame, "heyaNoInput", normalized, "号室"));
    } else {
      console.log(`[forrent] 号室スキップ: "${raw}" は半角10桁以内を満たさない`);
    }
  }

  // 物件種別 — select name="${bukkenInputForm.bukkenShuCd}"
  //   マンション(01), アパート(02), 一戸建て(11), テラス・タウンハウス(16), その他(99)
  //   木造/軽量鉄骨の場合は物件種目がマンションでもアパート(02)に強制変更
  //   必須フィールドのため、マッピングに失敗した場合は "その他"(99) でフォールバック。
  if (reinsData.物件種目) {
    let code = resolvePropertyTypeCode(norm(reinsData.物件種目));
    const struct = norm(reinsData.建物構造 || "");
    if (code === "01" && /木造|軽量鉄骨|LS/.test(struct)) {
      code = "02"; // マンション+木造/軽量鉄骨 → アパート
    }
    if (!code) {
      console.log(`[forrent] 物件種別マッピング失敗: "${reinsData.物件種目}" → その他(99) でフォールバック`);
      code = "99";
    }
    ok("物件種別", await selectByName(mainFrame, `${S}bukkenShuCd}`, code, "物件種別"));
  }

  // 構造 — select name="${bukkenInputForm.kozoShuCd}"
  //   鉄筋コン(01)..その他(99)  ※必須フィールド — マッチしない場合はその他(99)で埋める
  {
    let structCode = "99"; // fallback: その他
    if (reinsData.建物構造) {
      const structNorm = norm(reinsData.建物構造).replace(/造$/, "");
      const matched = STRUCTURE_CODE[structNorm];
      if (matched) {
        structCode = matched;
      } else {
        console.log(`[forrent] ! 構造: "${structNorm}" → マッチなし → その他(99)にフォールバック`);
      }
    } else {
      console.log("[forrent] ! 構造: REINS未取得 → その他(99)にフォールバック");
    }
    ok("構造", await selectByName(mainFrame, `${S}kozoShuCd}`, structCode, "構造"));
  }

  // 築年 — id="Wareki2Seireki1", max=4 (西暦)
  const chikuNorm = norm(reinsData.築年月);
  const yearM = chikuNorm?.match(/(\d{4})年/);
  if (yearM) {
    ok("築年", await fillById(mainFrame, "Wareki2Seireki1", yearM[1], "築年"));
  } else {
    // 築年月が不明の場合は必須フィールドなのでフォールバック（1990年1月）
    console.log("[forrent] ! 築年月が不明 → 1990年1月をフォールバック");
    await fillById(mainFrame, "Wareki2Seireki1", "1990", "築年(FB)");
    ok("築年", true);
  }

  // 築月 — name="${bukkenInputForm.chikuGetsu}", no id, max=2
  // 月がない場合（"1974年（昭和49年）"等）は1月をデフォルト
  const monthM = chikuNorm?.match(/(\d{1,2})月/);
  const chikuMonth = monthM ? monthM[1] : "1";
  ok("築月", await fillByName(mainFrame, `${S}chikuGetsu}`, chikuMonth, "築月"));

  // 新築/中古/未入居（入居区分） — shinchikuKbnCd: 1=新築, 2=中古, 3=未入居
  // 必須フィールド（バリデーション「入居区分を選択してください」を回避）
  {
    let shinchikuIdx = 0; // default: 中古 (value=2, index=0=#shinchikuKbnCd1)
    if (yearM) {
      const builtYear = parseInt(yearM[1], 10);
      const currentYear = new Date().getFullYear();
      if (currentYear - builtYear <= 1) {
        // 築1年以内 → 新築
        shinchikuIdx = 1; // value=1, index=1=#shinchikuKbnCd2
      }
    }
    // 現況が「空室」で入居時期が「即時」で築年月が新しい → 未入居の可能性
    // ただし安全策として中古/新築の2択に限定
    ok("入居区分", await selectRadioByIndex(mainFrame, "shinchikuKbnCd", shinchikuIdx));
    if (filled["入居区分"]) console.log(`[forrent] + 入居区分: ${shinchikuIdx === 0 ? "中古" : "新築"}`);
  }

  // ═══ 2. 所在地 ═══

  // 都道府県 — id="todofukenList" (default=東京都)
  if (reinsData.都道府県名) {
    ok("都道府県", await selectById(mainFrame, "todofukenList", reinsData.都道府県名, "都道府県"));
    await mainFrame.waitForTimeout(1500);
  }

  // 市郡区 — id="shigunkuList" (cascade from 都道府県)
  if (reinsData.所在地名１) {
    ok("市郡区", await selectById(mainFrame, "shigunkuList", reinsData.所在地名１, "市郡区"));
    // 町村リストの読み込みを待つ
    await waitForCascade(mainFrame, "chosonList", 5000);
  }

  // 町村 — id="chosonList" (cascade from 市郡区)
  // REINS 所在地名２ は "神田神保町１丁目" のように丁目付きの場合がある
  // → chosonList には "神田神保町" のみなので、丁目部分を分離して aza 選択に使う
  let azaFromTown = null; // 所在地名２から抽出した丁目番号（半角）
  if (reinsData.所在地名２) {
    const townInput = norm(reinsData.所在地名２);
    const townSplit = townInput.match(/^(.+?)(\d+)丁目$/);
    if (townSplit) {
      // "神田神保町1丁目" → town="神田神保町", aza="1"
      ok("町村", await selectById(mainFrame, "chosonList", townSplit[1], "町村"));
      azaFromTown = townSplit[2]; // "1"
    } else {
      ok("町村", await selectById(mainFrame, "chosonList", townInput, "町村"));
    }
    // 字丁リストの読み込みを待つ
    await waitForCascade(mainFrame, "azaList", 5000);
  }

  // 字丁 — id="azaList" (cascade from 町村)
  // forrent.jp azaList の選択肢テキストは全角数字のみ: "１","２","３"
  // 丁目情報は 所在地名２ or 所在地名３ のどちらかに含まれる
  {
    const addr3 = norm(reinsData.所在地名３ || "");
    const azaFromAddr3 = addr3.match(/^(\d+)丁目/)?.[1] || null;
    const azaDigit = azaFromTown || azaFromAddr3;

    if (azaDigit) {
      // 半角→全角数字変換 (e.g. "1" → "１")
      const fullwidth = azaDigit.replace(/\d/g, c =>
        String.fromCharCode(c.charCodeAt(0) + 0xFEE0)
      );
      const azaOk = await selectById(mainFrame, "azaList", fullwidth, "字丁");
      ok("字丁", azaOk);
      await mainFrame.waitForTimeout(1000);
      // 残りを番地へ
      const rest = azaFromTown
        ? addr3  // 丁目は所在地名２にあった → 所在地名３は全て番地
        : addr3.replace(/^\d+丁目/, "").trim();
      if (rest) ok("番地", await fillById(mainFrame, "banchiNm", rest, "番地"));
    } else {
      // 丁目なし（一番町、二番町 等）→ azaListの最初の有効オプションを選択
      const azaSelected = await mainFrame.evaluate(() => {
        const el = document.getElementById("azaList");
        if (!el) return false;
        const opts = Array.from(el.options).filter(o => o.value && o.value !== "");
        if (opts.length > 0) {
          el.value = opts[0].value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return opts[0].text;
        }
        return false;
      });
      if (azaSelected) {
        ok("字丁", true);
        console.log(`[forrent] + 字丁(auto): "${azaSelected}"`);
        await mainFrame.waitForTimeout(1000);
      }
      if (addr3) ok("番地", await fillById(mainFrame, "banchiNm", addr3, "番地"));
    }

    // 番地が未設定の場合（新築等で番地未確定）→ ハイフンをデフォルト設定
    const banchiVal = await mainFrame.evaluate(() => document.getElementById("banchiNm")?.value || "");
    if (!banchiVal.trim()) {
      ok("番地", await fillById(mainFrame, "banchiNm", "-", "番地(デフォルト)"));
    }
  }

  // ═══ 3. 会社間流通チェックボックス OFF ═══
  // id="bukkenNmDispFlg"   — 物件名を公開
  // id="heyaNoDispFlg"     — 部屋番号を公開
  // id="shosaiJushoDispFlg1" — 詳細住所を公開
  await setCheckbox(mainFrame, "bukkenNmDispFlg", false, "会社間流通:物件名");
  await setCheckbox(mainFrame, "heyaNoDispFlg", false, "会社間流通:部屋番号");
  await setCheckbox(mainFrame, "shosaiJushoDispFlg1", false, "会社間流通:詳細住所");

  // ═══ 4. お金 ═══
  await fillMoneyFields(mainFrame, reinsData, ok);

  // ═══ 5. 間取り ═══

  // 間取りタイプ — select name="${bukkenInputForm.madoriTypeKbnCd}"
  //   ワンルーム(01), K(02), DK(03), SDK(04), LDK(05), SLDK(06), LK(07), SK(08), SLK(09)
  const madoriCode = reinsData.間取タイプ ? MADORI_TYPE_CODE[norm(reinsData.間取タイプ)] : null;
  if (madoriCode) ok("間取りタイプ", await selectByName(mainFrame, `${S}madoriTypeKbnCd}`, madoriCode, "間取りタイプ"));

  // 部屋数 — id="heyaCntInput", max=2
  // ワンルーム(01)の場合、部屋数は入力不可（バリデーションエラーになる）
  if (madoriCode !== "01") {
    const rooms = norm(reinsData.間取部屋数)?.match(/(\d+)/)?.[1];
    if (rooms) ok("部屋数", await fillById(mainFrame, "heyaCntInput", rooms, "部屋数"));
  }

  // 面積 — id="mensekiIntegerInput"(max=3) + id="mensekiDecimalInput"(max=2)
  const areaStr = norm(reinsData.使用部分面積)?.replace(/㎡|m2/gi, "");
  if (areaStr) {
    const parts = areaStr.split(".");
    ok("面積(整数)", await fillById(mainFrame, "mensekiIntegerInput", parts[0], "面積(整数)"));
    ok("面積(小数)", await fillById(mainFrame, "mensekiDecimalInput", parts[1] || "00", "面積(小数)"));
  }

  // ═══ 6. 入居時期（状況区分） ═══
  // nyukyoKbnCd1(即=1), nyukyoKbnCd2(相談=2), nyukyoKbnCd3(年月指定=3)
  // evaluate で直接設定 + onclick ハンドラ発火（frame内 click() が不安定なため）
  {
    const nyukyo = norm(reinsData.入居時期 || "");
    let nyukyoId = "nyukyoKbnCd2"; // default: 相談
    if (/即/.test(nyukyo)) {
      nyukyoId = "nyukyoKbnCd1";
    } else {
      const ymMatch = nyukyo.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
      if (ymMatch) {
        nyukyoId = "nyukyoKbnCd3";
        await mainFrame.waitForTimeout(300);
        await fillByName(mainFrame, `${S}nyukyoNen}`, ymMatch[1], "入居年");
        await fillByName(mainFrame, `${S}nyukyoTsuki}`, ymMatch[2], "入居月");
      }
    }
    const nyukyoResult = await mainFrame.evaluate((id) => {
      const radio = document.getElementById(id);
      if (!radio) return false;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      // Fire onclick handler directly (doVisible etc.)
      if (radio.onclick) radio.onclick();
      else if (radio.getAttribute("onclick")) {
        try { new Function(radio.getAttribute("onclick")).call(radio); } catch {}
      }
      return true;
    }, nyukyoId);
    ok("入居時期", nyukyoResult);
    if (nyukyoResult) console.log(`[forrent] + 入居時期: ${nyukyoId} (${nyukyo || "相談"})`);
    else console.log(`[forrent] x 入居時期: ${nyukyoId} 設定失敗`);
    await mainFrame.waitForTimeout(300);
  }

  // ═══ 7. 取引態様 ═══
  // 修正点6: 常に仲介先物(4)を選択
  try {
    await mainFrame.selectOption("#torihikiTaiyoKbnCd", "4");
    console.log("[forrent] + 取引態様: code=4 (仲介先物)");
    filled["取引態様"] = true;
  } catch (e) {
    console.log(`[forrent] x 取引態様: ${e.message.slice(0, 60)}`);
    errors.push("取引態様");
  }

  // ═══ 8. ★マーク（客付可） ═══
  // hoshiFlg1=あり(1), hoshiFlg2=なし(0) — 必須選択
  ok("★マーク", await mainFrame.evaluate(() => {
    const el = document.getElementById("hoshiFlg1");
    if (el) {
      el.checked = true;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }));
  if (filled["★マーク"]) console.log("[forrent] + ★マーク: あり");

  // ═══ 9. 地図表示 ═══
  // mapHyojiFlg — ネットの地図上で物件を表示する
  await setCheckbox(mainFrame, "mapHyojiFlg", true, "地図表示");
  filled["地図表示"] = true;

  // ═══ 10. 条件radioボタン ═══
  // 各条件のデフォルト: 可(1)/不可(2)/相談(3) — REINSデータがなければ「相談(3)」or「可(1)」
  await fillConditionRadios(mainFrame, reinsData, ok);

  // ═══ 11. 仲介手数料 ═══
  // chukaiTesuryoFlg: index 0=あり — 仲介先物なので常にあり
  ok("仲介手数料", await selectRadioByIndex(mainFrame, "chukaiTesuryoFlg", 0));

  // ═══ 12. 管理形態 ═══
  // kanriKeitaiKbnCd: index 3 = 指定なし（41pt実績値）
  ok("管理形態", await selectRadioByIndex(mainFrame, "kanriKeitaiKbnCd", 3));

  // ═══ 13. 省エネルギー ═══
  // energyKbnCd: index 0 = 対象外（41pt実績値）
  ok("省エネ", await selectRadioByIndex(mainFrame, "energyKbnCd", 0));

  // ═══ 14. 定期借家 + 契約期間（修正点1） ═══
  // 常に契約期間を設定する（定期借家/普通借家共通）
  {
    const isTeiki = reinsData.備考3 && /定期借家|定借/.test(norm(reinsData.備考3));

    // 契約期間パース: REINS「契約期間」フィールド or 備考3
    let contractNen = "2"; // デフォルト: 2年
    const contractRaw = norm(reinsData.契約期間 || "");
    const nenMatch = contractRaw.match(/(\d+)\s*年/);
    const monthMatch = contractRaw.match(/(\d+)\s*(?:ヶ?月|月)/);
    if (nenMatch) {
      contractNen = nenMatch[1];
    } else if (monthMatch) {
      contractNen = String(Math.ceil(parseInt(monthMatch[1]) / 12));
    }
    // 備考3からの年数で上書き
    if (isTeiki) {
      const biko3 = norm(reinsData.備考3 || "");
      const bikoNen = biko3.match(/定期借家\D*(\d+)年/);
      if (bikoNen) contractNen = bikoNen[1];
      ok("定期借家", await selectRadioByIndex(mainFrame, "teikiShakuyaFlg", 0));
    }

    // 契約期間: 年/月指定 + 年数を常に設定
    await selectRadioByIndex(mainFrame, "teikiShakuyaKbnCd", 1);
    await fillByName(mainFrame, `${S}teikiShakuyaNen}`, contractNen, "契約年数");
    ok("契約期間", true);
    console.log(`[forrent] + 契約期間: ${contractNen}年 ${isTeiki ? "(定期借家)" : "(普通借家)"}`);
  }

  // ═══ 15. 保証人代行 ═══
  // hoshoninDaikoKbnCd: index 1 (value="2") = 必加入（先方指定ルール）
  // Options: index 0 = 任意加入, index 1 = 必加入
  ok("保証人代行", await selectRadioByIndex(mainFrame, "hoshoninDaikoKbnCd", 1));

  // ═══ 16. BB(ブロードバンド)対応 ═══
  // bbCpyKbnCd: index 1 = 2番目の選択肢（41pt実績値）
  ok("BB対応", await selectRadioByIndex(mainFrame, "bbCpyKbnCd", 1));

  // ═══ 17. その他費用 ═══
  // etcHiyoFlg + etcHiyo1(万) + etcHiyo2(百) — 初期費用（鍵交換代、消毒、クリーニング等）
  // Priority: 物確 structured data > REINS biko regex > default 2万
  try {
    await setCheckbox(mainFrame, "etcHiyoFlg", true, "その他費用");
    let totalYen = 0;
    const foundItems = [];
    let source = "";

    // (A) 物確 structured data — sum of 鍵交換代 + 消毒代 + クリーニング代 + サポート代 + 事務手数料
    if (initialCostData) {
      const costKeys = ["鍵交換代", "消毒代", "クリーニング代", "サポート代", "事務手数料"];
      for (const key of costKeys) {
        if (initialCostData[key] && initialCostData[key] > 0) {
          totalYen += initialCostData[key];
          foundItems.push(`${key}${initialCostData[key]}円`);
        }
      }
      if (totalYen > 0) source = "bukaku";
    }

    // (B) REINS biko regex fallback
    if (totalYen === 0) {
      const allBiko = norm([reinsData.その他一時金, reinsData.備考1, reinsData.備考2, reinsData.備考3,
        reinsData.条件フリー].filter(Boolean).join(" "));
      const costPatterns = [
        /鍵交換[代費]?\D*([\d,.]+)\s*円/g,
        /(?:室内)?消毒[代費]?\D*([\d,.]+)\s*円/g,
        /クリーニング[代費]?\D*([\d,.]+)\s*円/g,
        /(?:室内)?清掃[代費]?\D*([\d,.]+)\s*円/g,
        /抗菌[代費]?\D*([\d,.]+)\s*円/g,
        /害虫駆除[代費]?\D*([\d,.]+)\s*円/g,
        /(?:安心|入居|24時間)サポート[代費]?\D*([\d,.]+)\s*円/g,
        /事務手数料\D*([\d,.]+)\s*円/g,
        /書類作成[代費]?\D*([\d,.]+)\s*円/g,
      ];
      for (const pat of costPatterns) {
        let m;
        while ((m = pat.exec(allBiko)) !== null) {
          const yen = parseInt(m[1].replace(/[,\.]/g, ""), 10);
          if (yen > 0 && yen < 500000) {
            totalYen += yen;
            foundItems.push(`${m[0].replace(/\D*([\d,.]+)\s*円/, '')}${yen}円`);
          }
        }
      }
      if (totalYen === 0) {
        const genericMatch = allBiko.match(/(?:初期費用|その他[一費]?[時金]?)\D*([\d,.]+)\s*円/);
        if (genericMatch) {
          totalYen = parseInt(genericMatch[1].replace(/[,\.]/g, ""), 10);
          foundItems.push(`初期費用${totalYen}円`);
        }
      }
      if (totalYen > 0) source = "REINS";
    }

    if (totalYen > 0) {
      const man = Math.floor(totalYen / 10000);
      const sen = Math.round((totalYen % 10000) / 100);
      await fillByName(mainFrame, `${S}etcHiyo1}`, String(man), "その他費用(万)");
      if (sen > 0) await fillByName(mainFrame, `${S}etcHiyo2}`, String(sen).padStart(2, "0"), "その他費用(百)");
      console.log(`[forrent] + その他費用: ${totalYen}円 [${source}] (${foundItems.join(', ')})`);
    } else {
      // (C) Default: 2万円
      console.log("[forrent] ? その他費用: 物確/REINS初期費用データなし → デフォルト2万円");
      await fillByName(mainFrame, `${S}etcHiyo1}`, "2", "その他費用(万)");
    }
    filled["その他費用"] = true;
  } catch (e) {
    console.log(`[forrent] x その他費用: ${e.message.slice(0, 60)}`);
  }

  // ═══ 18. 損保（火災保険） ═══
  // sonpoFlg checkbox → wait for dependent fields → fill amount/years
  // 物確: use initialCostData.火災保険 actual amount if available
  try {
    await setCheckbox(mainFrame, "sonpoFlg", true, "損保");
    await mainFrame.waitForTimeout(500);
    // Determine fire insurance amount: 物確 actual > default 2万
    const kasaiMan = initialCostData?.["火災保険"]
      ? String(Math.max(1, Math.round(initialCostData["火災保険"] / 10000)))
      : "2";
    const sonpoOk = await mainFrame.evaluate(({ S, kasaiMan }) => {
      const out = [];
      const k1 = document.querySelector(`[name="${S}sonpoKingaku1}"]`) || document.getElementById("sonpoKingaku1");
      if (k1) { k1.value = kasaiMan; k1.dispatchEvent(new Event("change", { bubbles: true })); out.push("金額"); }
      const cnt = document.querySelector(`[name="${S}sonpoKeiyakuCnt}"]`) || document.getElementById("sonpoKeiyakuCnt");
      if (cnt) { cnt.value = "2"; cnt.dispatchEvent(new Event("change", { bubbles: true })); out.push("年数"); }
      return out;
    }, { S, kasaiMan });
    const kasaiSource = initialCostData?.["火災保険"] ? `物確 ${initialCostData["火災保険"]}円` : "デフォルト2万";
    console.log(`[forrent] + 損保: ${sonpoOk.join(", ")} 設定完了 [${kasaiSource}]`);
    filled["損保"] = true;
  } catch (e) {
    console.log(`[forrent] x 損保: ${e.message.slice(0, 60)}`);
  }

  // ═══ 19. 保証人代行会社区分 ═══
  // hoshoninDaikoKaishaKbnCd: "2" (その他) + 固定テキスト（先方指定ルール）
  try {
    await selectByName(mainFrame, `${S}hoshoninDaikoKaishaKbnCd}`, "2", "保証人代行会社");
    await mainFrame.waitForTimeout(300);
    await fillByName(mainFrame, `${S}hoshoninDaikoShosai}`, "詳細お問い合わせください", "保証会社名");
    console.log("[forrent] + 保証人代行: その他 / 詳細お問い合わせください");
    filled["保証人代行会社"] = true;
  } catch (e) {
    console.log(`[forrent] x 保証人代行会社: ${e.message.slice(0, 60)}`);
  }

  // ═══ 20. 設備環境区分 ═══
  // setsubiKankyoKbnCd / setsubiKankyoKbnCd2: "9" = 指定なし
  try {
    await selectByName(mainFrame, `${S}setsubiKankyoKbnCd}`, "9", "設備環境区分1");
    await selectByName(mainFrame, `${S}setsubiKankyoKbnCd2}`, "9", "設備環境区分2");
    filled["設備環境区分"] = true;
  } catch (e) {
    console.log(`[forrent] x 設備環境区分: ${e.message.slice(0, 60)}`);
  }

  // ═══ 20.5. 駐車場状況区分 ═══
  // chushajoJokyoKbnCd: 1=空あり, 2=空なし, 3=近隣あり
  {
    const parking = norm(reinsData.駐車場 || reinsData.備考3 || "");
    let parkingIdx = 1; // default: 空なし(2) → index 1
    if (/駐車場\s*あり|駐車場\s*有|駐車場.*空|敷地内.*駐|[Pp]arking/i.test(parking)) {
      parkingIdx = 0; // 空あり(1) → index 0
    } else if (/近隣.*駐|駐車場.*近/i.test(parking)) {
      parkingIdx = 2; // 近隣あり(3) → index 2
    }
    ok("駐車場状況", await selectRadioByIndex(mainFrame, "chushajoJokyoKbnCd", parkingIdx));
  }

  // ═══ 21. 元付業者（修正点7-10） ═══
  try {
    // 修正点7: 元付会社名（30文字制限）
    if (reinsData.商号) {
      const gyoshaNm = reinsData.商号.slice(0, 30);
      await fillByName(mainFrame, `${S}mototsukeGyoshaNm}`, gyoshaNm, "元付業者名");
      filled["元付業者名"] = true;
    }
    // 修正点8: 元付担当者名（不明ならハイフン）
    await fillByName(mainFrame, `${S}mototsukeTantoNm}`, "-", "元付担当者名");
    filled["元付担当者名"] = true;
    // 修正点9: 元付電話番号
    const tel = (reinsData.代表電話番号 || "").replace(/[-\s]/g, "");
    if (tel) {
      await fillByName(mainFrame, `${S}mototsukeTelNo}`, tel, "元付電話番号");
      filled["元付電話番号"] = true;
    }
    // 修正点10: 元付確認日 = 入稿当日
    const today = new Date();
    const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;
    await fillByName(mainFrame, `${S}mototsukeKakuninDate}`, dateStr, "元付確認日");
    filled["元付確認日"] = true;
  } catch (e) {
    console.log(`[forrent] x 元付業者: ${e.message.slice(0, 60)}`);
  }

  // ═══ 22. 貴社物件コード（修正点11） ═══
  {
    const reinsId = reinsData.物件番号 || "";
    const kishaCode = `fng${reinsId}`;
    await fillByName(mainFrame, `${S}kishaBukkenCd1}`, kishaCode, "貴社物件コード");
    filled["貴社物件コード"] = true;
  }

  // ═══ 22. 開口向き（バルコニー方向） ═══
  // kaikomukiKbnCd: 8択ラジオ (0=北,1=北東,2=東,3=南東,4=南,5=南西,6=西,7=北西)
  {
    const dir = norm(reinsData.バルコニー方向 || "");
    const DIR_MAP = {
      "北": 0, "北東": 1, "東": 2, "南東": 3, "東南": 3,
      "南": 4, "南西": 5, "西南": 5, "西": 6, "北西": 7, "西北": 7,
    };
    const idx = DIR_MAP[dir];
    if (idx !== undefined) {
      ok("開口向き", await selectRadioByIndex(mainFrame, "kaikomukiKbnCd", idx));
    }
  }

  // ═══ 23. 物件名特記フラグ ═══
  // bukkenNmTokkiFlg: checkbox — 名寄せスコア対象の可能性あり
  await setCheckbox(mainFrame, "bukkenNmTokkiFlg", true, "物件名特記");
  filled["物件名特記"] = true;

  // ═══ 24. ネット掲載 ═══
  // shijiIsize: 1=掲載, 3=保留
  try {
    await mainFrame.selectOption("#shijiIsize", "3");
    console.log("[forrent] + ネット掲載: 保留(3)");
    filled["ネット掲載"] = true;
  } catch (e) {
    console.log(`[forrent] x ネット掲載: ${e.message.slice(0, 60)}`);
  }

  // ═══ 24.5. スマピク掲載 ═══
  // DOM search for SmaPic checkbox (ID/name varies)
  try {
    const smapicChecked = await mainFrame.evaluate(() => {
      // Search by known patterns: sumapiku, smapiku, smapic, スマピク
      const candidates = [
        document.getElementById("sumapikuFlg"),
        document.getElementById("smapikuFlg"),
        document.querySelector('[name*="sumapiku"]'),
        document.querySelector('[name*="smapiku"]'),
        document.querySelector('[id*="sumapiku"]'),
        document.querySelector('[id*="smapiku"]'),
      ].filter(Boolean);
      // Also search by label text
      if (candidates.length === 0) {
        const labels = document.querySelectorAll("label");
        for (const label of labels) {
          if (label.textContent.includes("スマピク")) {
            const forId = label.getAttribute("for");
            if (forId) {
              const el = document.getElementById(forId);
              if (el) candidates.push(el);
            }
            const cb = label.querySelector('input[type="checkbox"]');
            if (cb) candidates.push(cb);
          }
        }
      }
      if (candidates.length > 0) {
        const cb = candidates[0];
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { found: true, id: cb.id || cb.name || "unknown" };
      }
      return { found: false };
    });
    if (smapicChecked.found) {
      console.log(`[forrent] + スマピク掲載: ON (${smapicChecked.id})`);
      filled["スマピク掲載"] = true;
    } else {
      console.log("[forrent] ? スマピク掲載: checkbox not found in DOM");
    }
  } catch (e) {
    console.log(`[forrent] x スマピク掲載: ${e.message.slice(0, 60)}`);
  }

  // ═══ 25. 見学予約（修正点3） ═══
  // kengakuYoyaku: checkbox — ネット掲載=掲載(1)の場合は常にチェック
  await setCheckbox(mainFrame, "kengakuYoyaku", true, "見学予約");
  filled["見学予約"] = true;

  // ═══ 26. 店舗案内ピックアップ（修正点4） ═══
  await setCheckbox(mainFrame, "tenpiku", true, "店舗案内ピックアップ");
  filled["店舗案内ピックアップ"] = true;

  // ═══ 27. 得意なエリア枠（修正点5） ═══
  await setCheckbox(mainFrame, "tokueri", true, "得意なエリア枠");
  filled["得意なエリア枠"] = true;

  console.log("[forrent] === FORM FILL END ===");
  console.log(`[forrent] OK: ${Object.keys(filled).length}, NG: ${errors.length}`);
  if (errors.length > 0) console.log(`[forrent] ERRORS: ${errors.join(", ")}`);

  return { filled, errors };
}

// ── お金フィールド ──
async function fillMoneyFields(f, data, ok) {
  // ── 賃料: chinryo1(万) + chinryo2(千) ──
  // REINS: "7.0万円" → chinryo1="7", chinryo2="0"
  // REINS: "10.5万円" → chinryo1="10", chinryo2="5"
  const rentM = norm(data.賃料)?.match(/([\d.]+)万/);
  if (rentM) {
    const man = parseFloat(rentM[1]);
    const c1 = Math.floor(man);
    const c2 = Math.round((man - c1) * 10); // 千の位
    ok("賃料(万)", await fillByName(f, `${S}chinryo1}`, String(c1), "賃料(万)"));
    ok("賃料(千)", await fillByName(f, `${S}chinryo2}`, String(c2), "賃料(千)"));
  }

  // ── 管理費/共益費: kanrihi1(万) + kanrihi2(円) ──
  // REINS: "5,000円" → kanrihi1="", kanrihi2="5000"
  // 共益費 or 管理費 のどちらかに金額がある
  const mgmtRaw = norm(data.共益費) || "";
  const mgmtRaw2 = norm(data.管理費) || "";
  const mgmtM = mgmtRaw.match(/([\d,]+)円/) || mgmtRaw2.match(/([\d,]+)円/);
  if (mgmtM) {
    const yen = parseInt(mgmtM[1].replace(/,/g, ""));
    const man = Math.floor(yen / 10000);
    const rem = yen % 10000;
    if (man > 0) ok("管理費(万)", await fillByName(f, `${S}kanrihi1}`, String(man), "管理費(万)"));
    ok("管理費(円)", await fillByName(f, `${S}kanrihi2}`, String(rem), "管理費(円)"));
  } else if (/なし|ー|^0$/.test(mgmtRaw) || /なし|ー|^0$/.test(mgmtRaw2)) {
    await setCheckbox(f, "kanrihiFlg", false, "管理費フラグ");
  } else {
    // REINSに管理費/共益費データなし → フラグOFF（「なし」扱い）
    console.log("[forrent] ? 管理費/共益費: データなし → フラグOFF");
    await setCheckbox(f, "kanrihiFlg", false, "管理費フラグ");
  }

  // ── 敷金: shikikin1 + shikikin2 + shikikinKbnCd(ヶ月=1/万円=2) ──
  await fillDeposit(f, data.敷金, {
    flgId: "shikikinFlg",
    n1: `${S}shikikin1}`, n2: `${S}shikikin2}`,
    monthId: "shikikinKbnCd1", yenId: "shikikinKbnCd2",
    label: "敷金",
  }, ok);

  // ── 礼金: reikin1 + reikin2 + reikinKbnCd(ヶ月=1/万円=2) ──
  await fillDeposit(f, data.礼金, {
    flgId: "reikinFlg",
    n1: `${S}reikin1}`, n2: `${S}reikin2}`,
    monthId: "reikinKbnCd1", yenId: "reikinKbnCd2",
    label: "礼金",
  }, ok);
}

/** 敷金/礼金: "1ヶ月" or "10万円" or "50,000円" or "なし" */
async function fillDeposit(f, raw, cfg, ok) {
  if (!raw) {
    await setCheckbox(f, cfg.flgId, false, `${cfg.label}フラグ`);
    return;
  }
  const s = raw.trim();
  if (s === "ー" || s === "0" || /^なし$/i.test(s) || s === "") {
    await setCheckbox(f, cfg.flgId, false, `${cfg.label}フラグ`);
    return;
  }
  // "1ヶ月", "2ヶ月", "1.5ヶ月", "1か月", "1カ月" pattern
  // Form has two fields: n1 (integer) + n2 (decimal) — e.g. "1.5" → n1="1", n2="5"
  const monthM = s.match(/(\d+\.?\d*)(?:ヶ|か|カ)?月/);
  if (monthM) {
    await f.click(`#${cfg.monthId}`).catch(() => {});
    await f.waitForTimeout(200);
    const v = parseFloat(monthM[1]);
    const intPart = Math.floor(v);
    const decPart = Math.round((v - intPart) * 10);
    ok(`${cfg.label}(整数)`, await fillByName(f, cfg.n1, String(intPart), `${cfg.label}(ヶ月・整数)`));
    if (decPart > 0) ok(`${cfg.label}(小数)`, await fillByName(f, cfg.n2, String(decPart), `${cfg.label}(ヶ月・小数)`));
    return;
  }
  // "10万円", "10.5万円" pattern
  const manM = s.match(/([\d.]+)万/);
  if (manM) {
    await f.click(`#${cfg.yenId}`).catch(() => {});
    await f.waitForTimeout(200);
    const v = parseFloat(manM[1]);
    ok(`${cfg.label}(万)`, await fillByName(f, cfg.n1, String(Math.floor(v)), `${cfg.label}(万)`));
    const sen = Math.round((v - Math.floor(v)) * 10);
    if (sen > 0) ok(`${cfg.label}(千)`, await fillByName(f, cfg.n2, String(sen), `${cfg.label}(千)`));
    return;
  }
  // "50,000円", "100000円" — convert to 万 unit
  const yenM = s.match(/([\d,]+)\s*円/);
  if (yenM) {
    const yen = parseInt(yenM[1].replace(/,/g, ""), 10);
    if (yen > 0) {
      await f.click(`#${cfg.yenId}`).catch(() => {});
      await f.waitForTimeout(200);
      const man = Math.floor(yen / 10000);
      const sen = Math.round((yen % 10000) / 1000);
      ok(`${cfg.label}(万)`, await fillByName(f, cfg.n1, String(man), `${cfg.label}(万)`));
      if (sen > 0) ok(`${cfg.label}(千)`, await fillByName(f, cfg.n2, String(sen), `${cfg.label}(千)`));
      return;
    }
  }
  // Pure number — treat as months (split integer/decimal)
  const numM = s.match(/^(\d+\.?\d*)$/);
  if (numM) {
    await f.click(`#${cfg.monthId}`).catch(() => {});
    await f.waitForTimeout(200);
    const v = parseFloat(numM[1]);
    const intPart = Math.floor(v);
    const decPart = Math.round((v - intPart) * 10);
    ok(`${cfg.label}(整数)`, await fillByName(f, cfg.n1, String(intPart), `${cfg.label}(ヶ月・整数)`));
    if (decPart > 0) ok(`${cfg.label}(小数)`, await fillByName(f, cfg.n2, String(decPart), `${cfg.label}(ヶ月・小数)`));
    return;
  }
  // Unrecognized format (e.g. "保証金") — flag OFF
  console.log(`[forrent] ? ${cfg.label}: unknown format "${raw}" → フラグOFF`);
  await setCheckbox(f, cfg.flgId, false, `${cfg.label}フラグ`);
}

// ── 条件radioボタン一括設定 ──
// 入居条件 (法人/学生/性別/単身/二人/子ども/ペット/楽器/事務所/ルームシェア)
// REINSデータから判別できる場合はそちらを優先、不明なら「相談(3)」or「可(1)」
async function fillConditionRadios(mainFrame, reinsData, ok) {
  // 各条件: [radioName, defaultIndex, label]
  // 41pt実績: 全て index 0（可/不問）がデフォルト
  // ペット・楽器・事務所・ルームシェア: index 0=不可(2択の場合)
  const conditions = [
    ["hojinKbnCd", 0, "法人入居"],      // idx0=可, 1=不可, 2=相談
    ["gakuseiKbnCd", 0, "学生"],         // idx0=可, 1=不可, 2=相談
    ["seibetsuKbnCd", 0, "男女"],        // idx0=不問, 1=男性のみ, 2=女性のみ
    ["tanshinKbnCd", 0, "単身"],         // idx0=可, 1=不可, 2=相談
    ["futariKbnCd", 0, "二人入居"],      // idx0=可, 1=不可
    ["kodomoKbnCd", 0, "子ども"],        // idx0=可, 1=不可, 2=相談
    ["petKbnCd", 0, "ペット"],           // idx0=不可(2択), REINSでペット可なら変更
    ["gakkiKbnCd", 0, "楽器"],           // idx0=不可(2択)
    ["jimushoRiyoKbnCd", 0, "事務所利用"],// idx0=不可(2択)
    ["roomShareKbnCd", 0, "ルームシェア"],// idx0=不可(2択)
  ];

  // REINSデータから条件を推測（index override）
  const overrides = {};
  const setsubi = norm(reinsData.設備 || "");
  const joukenFree = norm(reinsData.条件フリー || "");
  const biko = norm(reinsData.備考3 || "");
  const setsubiFree = norm(reinsData.設備フリー || "");
  const combined = [setsubi, joukenFree, biko, setsubiFree].join(" ");

  // Detect pet/instrument/office/roomshare from REINS data
  // 3-choice radio: idx0=不可, idx1=可, idx2=相談
  // ペット飼育可能な場合でも「相談」(idx=2)を設定（先方運用統一）
  if (/ペット可|ペット相談|ペットOK|ペット飼育可|小型犬|猫/.test(combined)) {
    overrides["petKbnCd"] = 2; // 相談
  }
  if (/楽器可|楽器相談|楽器OK|ピアノ可/.test(combined)) {
    overrides["gakkiKbnCd"] = 1; // 可
  }
  if (/事務所可|事務所利用可|SOHO|事務所相談/.test(combined)) {
    overrides["jimushoRiyoKbnCd"] = 1; // 可
  }
  if (/ルームシェア可|ルームシェア相談/.test(combined)) {
    overrides["roomShareKbnCd"] = 1; // 可
  }

  let filledCount = 0;
  for (const [name, defaultIdx, label] of conditions) {
    const idx = overrides[name] ?? defaultIdx;
    const result = await selectRadioByIndex(mainFrame, name, idx);
    if (result) filledCount++;
  }
  ok("入居条件", filledCount > 0);
  console.log(`[forrent] + 入居条件: ${filledCount}/${conditions.length}項目設定`);
}

// ══════════════════════════════════════════════════════════
//  交通 直接入力 — evaluate() で DOM を直接操作
//  (らくらくポップアップはonclickがフォームPOSTしてフレーム離脱を起こすため使わない)
// ══════════════════════════════════════════════════════════

/**
 * 地図修正 + らくらく交通入力 による交通設定
 *
 * フロー:
 * 1. chizuShuseiボタンをクリック → ポップアップで自動ジオコーディング
 * 2. 座標を tmpIdoFull/tmpKeidoFull から idoFull/keidoFull にコピー
 * 3. rakurakuKotsuボタンをクリック → ポップアップで最寄り駅を自動選択
 *
 * 注意: rakurakuKotsuのonclickはフォームPOSTを含むため、
 *       ポップアップハンドリングが必要
 */
async function fillTransportViaMap(page, mainFrame, transportArray) {
  const filled = [];
  const errors = [];

  console.log("[forrent] === TRANSPORT VIA MAP ===");

  // ═══ Step 1: 地図修正ボタンクリック → registryXY()で登録 ═══
  try {
    console.log("[forrent] Step 1: 地図修正（chizuShusei）");

    const popupPromise = page.context().waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await mainFrame.evaluate(() => {
      const btn = document.getElementById("chizuShusei");
      if (btn) btn.click();
    });

    const mapPopup = await popupPromise;
    if (mapPopup) {
      console.log(`[forrent] 地図ポップアップ検出: ${mapPopup.url()}`);
      await mapPopup.waitForLoadState("networkidle").catch(() => {});
      await mapPopup.waitForTimeout(3000);

      // 「登録」ボタン = <IMG onclick="registryXY();"> をクリック
      // registryXY()はポップアップを自動で閉じるので、evaluate後にpage closedエラーが出る可能性あり
      const registered = await mapPopup.evaluate(() => {
        const imgs = [...document.querySelectorAll("img[onclick*='registryXY']")];
        if (imgs.length > 0) { imgs[0].click(); return "onclick"; }
        if (typeof window.registryXY === "function") { window.registryXY(); return "direct"; }
        return null;
      }).catch((e) => {
        // ポップアップが閉じた場合のエラーは無視（registryXY成功の証拠）
        if (e.message.includes("closed") || e.message.includes("detach")) return "closed-ok";
        return null;
      });

      console.log(`[forrent] 地図ポップアップ: 登録結果=${registered}`);
      // ポップアップが閉じるのを少し待つ
      await mainFrame.waitForTimeout(2000);
      if (!mapPopup.isClosed()) await mapPopup.close().catch(() => {});
    }

    // 座標の確認（registryXY()がparentに反映したはず）
    const coordResult = await mainFrame.evaluate(() => {
      const ido = document.getElementById("idoFull")?.value || "";
      const keido = document.getElementById("keidoFull")?.value || "";
      const tmpIdo = document.getElementById("tmpIdoFull")?.value || "";
      const tmpKeido = document.getElementById("tmpKeidoFull")?.value || "";
      // registryXY()がidoFull/keidoFullを設定しなかった場合、手動コピー
      if (!ido && tmpIdo) {
        document.getElementById("idoFull").value = tmpIdo;
        document.getElementById("keidoFull").value = tmpKeido;
        const flg = document.getElementById("idokeidoNoDisp");
        if (flg) flg.value = "0";
        return { ido: tmpIdo, keido: tmpKeido, source: "manual-copy" };
      }
      return ido ? { ido, keido, source: "registryXY" } : null;
    });

    if (coordResult) {
      console.log(`[forrent] 座標セット: ido=${coordResult.ido}, keido=${coordResult.keido} (${coordResult.source})`);
    } else {
      console.log("[forrent] 座標取得失敗 → フォールバック");
      return fillTransportCascade(mainFrame, transportArray);
    }

  } catch (e) {
    console.log(`[forrent] 地図修正エラー: ${e.message.slice(0, 100)}`);
    return fillTransportCascade(mainFrame, transportArray);
  }

  // ═══ Step 2: らくらく交通入力 ═══
  try {
    console.log("[forrent] Step 2: らくらく交通入力（rakurakuKotsu）");

    // ボタン存在確認 + onclick内容をログ
    const btnInfo = await mainFrame.evaluate(() => {
      const btn = document.getElementById("rakurakuKotsu");
      if (!btn) return { exists: false };
      return {
        exists: true,
        disabled: btn.disabled,
        display: getComputedStyle(btn).display,
        onclick: btn.getAttribute("onclick") || btn.onclick?.toString()?.slice(0, 200) || "",
        tagName: btn.tagName,
      };
    });
    console.log(`[forrent] rakurakuKotsu: ${JSON.stringify(btnInfo)}`);

    if (!btnInfo.exists) {
      console.log("[forrent] rakurakuKotsuボタンが存在しない → フォールバック");
      return fillTransportCascade(mainFrame, transportArray);
    }

    // ボタンがdisabledの場合: 強制有効化 + openRakurakuKotsu() を直接呼び出し
    if (btnInfo.disabled) {
      console.log("[forrent] rakurakuKotsu disabled → 強制有効化して直接呼び出し");
      await mainFrame.evaluate(() => {
        const btn = document.getElementById("rakurakuKotsu");
        if (btn) btn.disabled = false;
      });
      await mainFrame.waitForTimeout(500);
    }

    // popup検出: context-level + page-level 両方で捕捉
    const transportPopupPromise = Promise.race([
      page.waitForEvent("popup", { timeout: 15000 }).catch(() => null),
      page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null),
    ]);

    // onclick関数を直接呼び出し（disabled状態でもclickイベント不発火のため）
    await mainFrame.evaluate(() => {
      if (typeof openRakurakuKotsu === "function") {
        const flg = document.getElementById("rakurakuKotsuCacheFlg")?.value || "";
        openRakurakuKotsu(flg, "COM1R02161.action", "COM1R02167.action");
      } else {
        const btn = document.getElementById("rakurakuKotsu");
        if (btn) btn.click();
      }
    });

    const transportPopup = await transportPopupPromise;
    if (transportPopup) {
      console.log(`[forrent] 交通ポップアップ検出: ${transportPopup.url()}`);
      await transportPopup.waitForLoadState("networkidle").catch(() => {});
      await transportPopup.waitForTimeout(3000);

      // Dynamically assign radio buttons: detect available candidates and fill 3 slots
      // Radio ID format: koutu_{slot}-{candidate} (slot: 1-3, candidate: 1-4)
      const radioResult = await transportPopup.evaluate(() => {
        const results = [];
        // First detect how many candidates exist
        let maxCandidate = 0;
        for (let c = 1; c <= 4; c++) {
          const r = document.getElementById(`koutu_1-${c}`);
          if (r) maxCandidate = c;
        }
        // Assign slots: prefer diagonal (1-1, 2-2, 3-3) but fallback if fewer candidates
        const assignments = [];
        if (maxCandidate >= 3) {
          assignments.push([1, 1], [2, 2], [3, 3]);
        } else if (maxCandidate === 2) {
          // Only 2 candidates: slot1=cand1, slot2=cand2, slot3=cand1 (repeat)
          assignments.push([1, 1], [2, 2], [3, 1]);
        } else if (maxCandidate === 1) {
          assignments.push([1, 1], [2, 1], [3, 1]);
        }
        for (const [slot, cand] of assignments) {
          const radio = document.getElementById(`koutu_${slot}-${cand}`);
          if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event("change", { bubbles: true }));
            radio.dispatchEvent(new Event("click", { bubbles: true }));
            results.push(`交通${slot}=候補${cand}`);
          }
        }
        return results;
      });
      console.log(`[forrent] ラジオ選択: ${radioResult.join(", ")}`);

      // hidden fieldsから候補データを読み取り
      const candidates = await transportPopup.evaluate(() => {
        const out = [];
        for (let i = 1; i <= 4; i++) {
          const ensenNm = document.getElementById(`ensenNm${i}`)?.value || "";
          const ensenCd = document.getElementById(`ensenCd${i}`)?.value || "";
          const ekiNm = document.getElementById(`ekiNm${i}`)?.value || "";
          const ekiCd = document.getElementById(`ekiCd${i}`)?.value || "";
          const fun = document.getElementById(`tohofun${i}`)?.value || "";
          if (ensenNm) out.push({ idx: i, ensenNm, ensenCd, ekiNm, ekiCd, fun });
        }
        return out;
      });
      for (const c of candidates) {
        console.log(`[forrent] 候補${c.idx}: ${c.ensenNm}/${c.ekiNm} 徒歩${c.fun}分 (cd:${c.ensenCd}/${c.ekiCd})`);
      }

      // 「登録」ボタンクリック: <IMG id="registButton">
      // クリック後にポップアップが閉じる可能性あり
      await transportPopup.waitForTimeout(1000);
      const registClicked = await transportPopup.evaluate(() => {
        const btn = document.getElementById("registButton");
        if (btn) { btn.click(); return true; }
        const imgs = [...document.querySelectorAll("img")];
        const regImg = imgs.find(i => i.src?.includes("toroku"));
        if (regImg) { regImg.click(); return true; }
        return false;
      }).catch((e) => {
        if (e.message.includes("closed") || e.message.includes("detach")) return true;
        return false;
      });

      console.log(`[forrent] 交通ポップアップ: 登録=${registClicked}`);
      // parent frameの更新を待つ
      await mainFrame.waitForTimeout(3000);
      if (!transportPopup.isClosed()) await transportPopup.close().catch(() => {});

      // mainFrameの交通フィールドが設定されたか確認
      await mainFrame.waitForTimeout(1000);
      const transportResult = await mainFrame.evaluate(() => {
        const out = [];
        const ids = [
          { disp: "pkgEnsenNmDisp", cd: "pkgEnsenCd", ekiDisp: "pkgEkiNmDisp", ekiCd: "pkgEkiCd", fun: "tohofun" },
          { disp: "pkgEnsenNmDisp2", cd: "pkgEnsenCd2", ekiDisp: "pkgEkiNmDisp2", ekiCd: "pkgEkiCd2", fun: "tohofun2" },
          { disp: "pkgEnsenNmDisp3", cd: "pkgEnsenCd3", ekiDisp: "pkgEkiNmDisp3", ekiCd: "pkgEkiCd3", fun: "tohofun3" },
        ];
        for (const slot of ids) {
          const ensen = document.getElementById(slot.disp)?.value || "";
          const ensenCd = document.getElementById(slot.cd)?.value || "";
          const eki = document.getElementById(slot.ekiDisp)?.value || "";
          const ekiCd = document.getElementById(slot.ekiCd)?.value || "";
          const fun = document.getElementById(slot.fun)?.value || "";
          out.push({ ensen, ensenCd, eki, ekiCd, fun });
        }
        return out;
      });

      for (const t of transportResult) {
        if (t.ensen || t.eki || t.ensenCd) {
          filled.push(`${t.ensen} ${t.eki} 徒歩${t.fun}分 (cd:${t.ensenCd}/${t.ekiCd})`);
          console.log(`[forrent] transport: ${t.ensen} ${t.eki} 徒歩${t.fun}分 code=${t.ensenCd}/${t.ekiCd}`);
        }
      }

      if (filled.length === 0) {
        console.log("[forrent] らくらく交通入力 結果なし → フォールバック");
        return fillTransportCascade(mainFrame, transportArray);
      }

    } else {
      console.log("[forrent] 交通ポップアップなし → フォールバック");
      return fillTransportCascade(mainFrame, transportArray);
    }

  } catch (e) {
    console.log(`[forrent] らくらく交通入力エラー: ${e.message.slice(0, 100)}`);
    return fillTransportCascade(mainFrame, transportArray);
  }

  console.log(`[forrent] transport via map: ${filled.length} filled, ${errors.length} errors`);
  return { filled, errors };
}

// cascade select フォールバック: 沿線select→駅select→徒歩分数を正しくコード設定
async function fillTransportCascade(mainFrame, transportArray) {
  const filled = [];
  const errors = [];
  if (!transportArray?.length) return { filled, errors };

  // forrent.jpの交通フィールド構造を自動検出
  const formInfo = await mainFrame.evaluate(() => {
    const info = {};
    // cascade select 方式 (select要素)
    const ensenSel1 = document.querySelector('select[name*="ensenCd1"], select[name*="ensenCd"][name$="1"]');
    info.hasCascadeSelects = !!ensenSel1;
    if (ensenSel1) {
      info.ensenSelName = ensenSel1.name;
      info.ensenOptCount = ensenSel1.options.length;
    }
    // hidden field 方式 (pkgEnsenCd)
    const pkgEnsen = document.getElementById("pkgEnsenCd");
    info.hasHiddenFields = !!pkgEnsen;
    // display field 方式
    const pkgDisp = document.getElementById("pkgEnsenNmDisp");
    info.hasDisplayFields = !!pkgDisp;
    return info;
  });
  console.log(`[forrent] transport form info: ${JSON.stringify(formInfo)}`);

  for (let i = 0; i < Math.min(transportArray.length, 3); i++) {
    const t = transportArray[i];
    const ensen = norm(t.沿線 || "");
    const eki = norm(t.駅 || "");
    const walk = String(parseInt(t.徒歩) || 0);
    if (!ensen || !eki) continue;

    const suffix = i === 0 ? "" : String(i + 1);
    const idx1 = i + 1; // 1-based for name attributes

    try {
      // === Method 1: cascade select (最も確実) ===
      const ensenOk = await mainFrame.evaluate(({ ensen, idx }) => {
        // Try multiple naming patterns for ensen select
        const patterns = [
          `select[name*="ensenCd${idx}"]`,
          `select[name*="ensenCd"][name$="${idx}"]`,
          `select[name$="kotsuInputForm[${idx - 1}].ensenCd"]`,
          `select[name*="kotsuInputForm"][name*="[${idx - 1}]"][name*="ensenCd"]`,
        ];
        let sel = null;
        for (const p of patterns) {
          sel = document.querySelector(p);
          if (sel && sel.options.length > 1) break;
        }
        if (!sel) return { ok: false, reason: "select not found" };

        // Partial match on option text
        const options = [...sel.options];
        const match = options.find(o => o.text === ensen)
          || options.find(o => o.text.includes(ensen))
          || options.find(o => ensen.includes(o.text.replace(/（.*）/, "").trim()));
        if (!match) return { ok: false, reason: `no match for "${ensen}" in ${options.length} options` };

        sel.value = match.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, code: match.value, text: match.text };
      }, { ensen, idx: idx1 });

      if (ensenOk.ok) {
        console.log(`[forrent] transport(cascade) ${idx1}: 沿線=${ensenOk.text} code=${ensenOk.code}`);

        // Wait for station cascade to load
        await mainFrame.waitForTimeout(2500);

        // Select station
        const ekiOk = await mainFrame.evaluate(({ eki, idx }) => {
          const patterns = [
            `select[name*="ekiCd${idx}"]`,
            `select[name*="ekiCd"][name$="${idx}"]`,
            `select[name$="kotsuInputForm[${idx - 1}].ekiCd"]`,
            `select[name*="kotsuInputForm"][name*="[${idx - 1}]"][name*="ekiCd"]`,
          ];
          let sel = null;
          for (const p of patterns) {
            sel = document.querySelector(p);
            if (sel && sel.options.length > 1) break;
          }
          if (!sel) return { ok: false, reason: "select not found" };

          const options = [...sel.options];
          const match = options.find(o => o.text === eki)
            || options.find(o => o.text.includes(eki))
            || options.find(o => eki.includes(o.text.replace(/（.*）/, "").trim()));
          if (!match) return { ok: false, reason: `no match for "${eki}" in ${options.length} options`, available: options.slice(0, 10).map(o => o.text) };

          sel.value = match.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, code: match.value, text: match.text };
        }, { eki, idx: idx1 });

        if (ekiOk.ok) {
          console.log(`[forrent] transport(cascade) ${idx1}: 駅=${ekiOk.text} code=${ekiOk.code}`);
        } else {
          console.log(`[forrent] transport(cascade) ${idx1}: 駅失敗: ${ekiOk.reason}`);
          errors.push(`交通${idx1} 駅: ${ekiOk.reason}`);
        }

        // 徒歩分数
        await mainFrame.evaluate(({ idx, walk }) => {
          const patterns = [
            `input[name*="tohoFun${idx}"]`,
            `input[name*="kotsuInputForm"][name*="[${idx - 1}]"][name*="tohoFun"]`,
          ];
          for (const p of patterns) {
            const el = document.querySelector(p);
            if (el) {
              el.value = walk;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return;
            }
          }
          // fallback: tohofun by ID
          const funEl = document.getElementById(idx === 1 ? "tohofun" : `tohofun${idx}`);
          if (funEl) {
            funEl.value = walk;
            funEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }, { idx: idx1, walk });

        // 徒歩ラジオボタン
        await mainFrame.evaluate(({ idx }) => {
          const radioId = idx === 1 ? "toho" : `toho${idx}`;
          const radioEl = document.getElementById(radioId);
          if (radioEl) {
            radioEl.checked = true;
            radioEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, { idx: idx1 });

        filled.push(`交通${idx1}: ${eki}駅 徒歩${walk}分 (cascade)`);
        await mainFrame.waitForTimeout(500);
        continue; // cascade success, skip to next
      }

      // === Method 2: hidden field + display field (ポップアップ互換) ===
      console.log(`[forrent] transport(cascade) ${idx1}: 沿線select失敗(${ensenOk.reason}) → hidden field方式`);
      const hiddenResult = await mainFrame.evaluate(({ suffix, ensen, eki, walk }) => {
        const out = [];
        const fire = (el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        // Display fields
        const dispEnsen = document.getElementById(`pkgEnsenNmDisp${suffix}`);
        if (dispEnsen) { dispEnsen.value = ensen; fire(dispEnsen); }
        const nmEnsen = document.getElementById(`pkgEnsenNm${suffix}`);
        if (nmEnsen) { nmEnsen.value = ensen; }
        const dispEki = document.getElementById(`pkgEkiNmDisp${suffix}`);
        if (dispEki) { dispEki.value = eki; fire(dispEki); }
        const nmEki = document.getElementById(`pkgEkiNm${suffix}`);
        if (nmEki) { nmEki.value = eki; }
        // Radio
        const radioId = suffix === "" ? "toho" : `toho${suffix}`;
        const radio = document.getElementById(radioId);
        if (radio) { radio.checked = true; fire(radio); }
        // Minutes
        const funId = suffix === "" ? "tohofun" : `tohofun${suffix}`;
        const funEl = document.getElementById(funId);
        if (funEl && walk !== "0") { funEl.value = walk; fire(funEl); }
        out.push(`display=${!!dispEnsen}, hidden=${!!nmEnsen}`);
        return out;
      }, { suffix, ensen, eki, walk });

      filled.push(`交通${idx1}: ${eki}駅 徒歩${walk}分 (hidden)`);
      console.log(`[forrent] transport(hidden) ${idx1}: ${hiddenResult.join(", ")}`);

    } catch (e) {
      errors.push(`交通${idx1}: ${e.message.slice(0, 80)}`);
      console.log(`[forrent] transport(cascade) ${idx1}: error: ${e.message.slice(0, 100)}`);
    }
  }

  console.log(`[forrent] transport(cascade): ${filled.length} filled, ${errors.length} errors`);
  return { filled, errors };
}

// 旧ポップアップ版（互換性のため残す）
async function fillTransportRakuraku(mainFrame, transportArray) {
  return fillTransportCascade(mainFrame, transportArray);
}

// ══════════════════════════════════════════════════════════
//  テキスト入力
// ══════════════════════════════════════════════════════════

async function fillTexts(mainFrame, catchCopy, freeComment, reinsData, initialCostData = null) {
  const errors = [];

  // テキストを制限内にtruncate（フリーコメント=100文字、キャッチ=30文字）
  const truncCatch = (catchCopy || "").slice(0, 30);
  const truncComment = (freeComment || "").slice(0, 100);

  // REINS備考情報から特記事項テキストを構築（全備考+フリースペース+一時金を結合して漏れ防止）
  // forrent.jpの備考欄は半角カナ・半角英数字・記号が禁止 → 全角変換
  const bikoRaw = reinsData
    ? [reinsData.備考1, reinsData.備考2, reinsData.備考3,
       reinsData.条件フリー, reinsData.設備フリー, reinsData.その他一時金].filter(Boolean).join(" ")
    : "";
  const biko = toFullWidth(bikoRaw).slice(0, 200);

  // Build cost item descriptions for etcHiyoShosai
  const costItems = [];
  if (initialCostData) {
    const costMap = { "鍵交換代": "鍵交換代", "消毒代": "消毒代", "クリーニング代": "クリーニング代",
      "サポート代": "サポート代", "事務手数料": "事務手数料" };
    for (const [key, label] of Object.entries(costMap)) {
      if (initialCostData[key] && initialCostData[key] > 0) {
        costItems.push(`${label}${initialCostData[key].toLocaleString()}円`);
      }
    }
  }

  // Fixed text for net-facing fields (staff request)
  const NET_CATCH = "お電話番号記載のお客様限定【仲介手数料割引キャンペーン中】";
  const NET_FREE_MEMO = "お急ぎやご質問の方はファンテイズ03-6403-9323大木まで！現地お待ち合わせでご紹介できます！(他社掲載物件まとめて内見可能)家賃交渉、初期費用の相談などお気軽にご相談下さい！";

  // evaluate() で直接 DOM 操作（フレーム状態に左右されにくい）
  try {
    const result = await mainFrame.evaluate(({ catchCopy, freeComment, biko, netCatch, netFreeMemo, costItems }) => {
      const out = [];
      const fields = [
        { id: "bukkenCatch", val: catchCopy },
        { id: "netCatch", val: netCatch },
        { id: "netFreeMemo", val: netFreeMemo },
        { id: "freeMemo", val: freeComment },
      ];
      // 特記事項 — REINS備考があれば設定
      if (biko) {
        fields.push({ id: "tokkiJiko", val: biko });
        fields.push({ id: "tokkiEtcMemo", val: biko });
      }

      for (const f of fields) {
        const el = document.getElementById(f.id);
        if (el) {
          el.value = f.val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          out.push(f.id);
        } else {
          out.push(`!${f.id}`);
        }
      }
      // name属性でしかアクセスできないtextarea（IDなし）
      // etcHiyoShosai: etcHiyoFlg=ON時に必須
      // hoshoninDaikoShosai: 保証人代行会社の詳細
      const nameFields = [];
      // Extract initial cost-related text from biko or 物確 structured data
      let etcText = '鍵交換代・その他初期費用';
      if (costItems && costItems.length > 0) {
        // 物確 structured: list each item with amount
        etcText = costItems.join('、');
      } else if (biko) {
        const costKeywords = ['鍵交換', '消毒', 'クリーニング', '保険', '損保', '火災', '初期費用',
          '鍵代', '消臭', '室内清掃', '安心サポート', '入居サポート', '24時間サポート',
          '抗菌', '害虫駆除', '仲介手数料', '事務手数料', '書類作成', '契約事務',
          'サポート代', 'サポート費', '保証料', '更新料', '更新事務'];
        const sentences = biko.split(/[、。\n]+/).map(s => s.trim()).filter(Boolean);
        const costParts = sentences.filter(s => costKeywords.some(k => s.includes(k)));
        if (costParts.length > 0) {
          etcText = costParts.join('、');
        }
      }
      nameFields.push({ name: '${bukkenInputForm.etcHiyoShosai}', val: etcText.slice(0, 200), label: 'etcHiyoShosai' });
      // hoshoninDaikoShosai is now set in fillFormFields (section 19)
      for (const nf of nameFields) {
        const el = document.querySelector('[name="' + nf.name + '"]');
        if (el) {
          el.value = nf.val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          out.push(nf.label);
        } else {
          out.push('!' + nf.label);
        }
      }
      return out;
    }, { catchCopy: truncCatch, freeComment: truncComment, biko, netCatch: NET_CATCH, netFreeMemo: NET_FREE_MEMO, costItems });

    const ok = result.filter(r => !r.startsWith("!"));
    const ng = result.filter(r => r.startsWith("!")).map(r => r.slice(1));
    for (const id of ng) errors.push(`${id}: element not found`);
    console.log(`[forrent] texts: ${ok.length} filled (${ok.join(", ")}), ${ng.length} missing`);
  } catch (e) {
    errors.push(`texts: ${e.message.slice(0, 80)}`);
  }

  return errors;
}

// ══════════════════════════════════════════════════════════
//  画像アップロード
// ══════════════════════════════════════════════════════════

/**
 * forrent.jp 画像スロット構造:
 *
 * 固定スロット:
 *   - 外観:   file_up_gaikan   (+ gaikanMemo)
 *   - パース: file_up_perth    (+ perthMemo)
 *   - 室内:   file_up_shitsunai (+ shitsunaiShashinCategory + shitsunaiMemo)
 *   - 地図:   file_up_map
 *   - 周辺環境: file_up_shuhenkankyo
 *
 * 可変スロット:
 *   - 写真1-3:     file_up_shashin{1-3}    (+ shashin{N}Category + shashin{N}Memo)
 *   - 追加画像1-8: file_up_tsuikaGazo{1-8} (+ tsuikaGazo{N}Category + tsuikaGazo{N}Memo(id=tsuikaGazo{N}))
 *
 * 周辺環境6スロット:
 *   - file_up_shuhenKankyo{1-6} (+ categoryCd + shuhenKankyoNm + kyori)
 */

/**
 * ファイル入力ヘルパー — name属性 + 可視性 + 親の可視性で正しい要素を特定
 * (forrent.jpはフォーム内でfile input が最大8回重複するため、
 *  表示中セクション内の要素を確実に特定する必要がある)
 */
async function setFileInput(frame, inputName, filePath) {
  // Step 1: 全候補を評価し、最も適切な要素のインデックスを取得
  const info = await frame.evaluate((name) => {
    const all = [...document.querySelectorAll(`input[type="file"][name="${name}"]`)];
    if (!all.length) return { total: 0, bestIdx: -1 };

    const candidates = all.map((el, i) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const parentStyle = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
      return {
        idx: i,
        visible: style.display !== "none" && style.visibility !== "hidden",
        parentVisible: parentStyle ? parentStyle.display !== "none" : true,
        hasSize: rect.width > 0 && rect.height > 0,
        inViewport: rect.top >= 0 && rect.top < document.documentElement.scrollHeight,
      };
    });

    // 優先順位: visible + parentVisible + hasSize
    const best = candidates.find(c => c.visible && c.parentVisible && c.hasSize)
      || candidates.find(c => c.visible && c.parentVisible)
      || candidates.find(c => c.visible)
      || candidates[0];

    return { total: all.length, bestIdx: best?.idx ?? -1, candidates };
  }, inputName);

  if (info.total === 0 || info.bestIdx === -1) {
    console.log(`[forrent] x file: ${inputName} not found (0 elements)`);
    return false;
  }

  // Step 2: 特定のインデックスの要素にファイルをセット
  const handle = await frame.evaluateHandle(({ name, idx }) => {
    return document.querySelectorAll(`input[type="file"][name="${name}"]`)[idx];
  }, { name: inputName, idx: info.bestIdx });

  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return false;
  }

  await el.setInputFiles(filePath);

  // Step 3: 検証 — ファイルがセットされたか確認
  const verified = await frame.evaluate(({ name, idx }) => {
    const el = document.querySelectorAll(`input[type="file"][name="${name}"]`)[idx];
    return el?.files?.length > 0;
  }, { name: inputName, idx: info.bestIdx });

  await handle.dispose();

  if (!verified) {
    console.log(`[forrent] ! file: ${inputName} setInputFiles succeeded but files.length=0 (${info.total} elements, idx=${info.bestIdx})`);
  }

  return verified;
}

// image-ai.js カテゴリ → forrent.jp スロット マッピング
const GAIKAN_CATS = ["建物外観"];
const INTERIOR_CATS = [
  "居室・リビング", "その他部屋・スペース", "キッチン", "バス・シャワールーム",
  "トイレ", "洗面設備", "収納", "バルコニー", "庭", "玄関",
  "セキュリティ", "その他設備",
]; // shitsunaiShashinCategory 12択と完全一致
const MADORI_CATS = ["間取り図"];
const SHUHEN_CATS = ["周辺環境"];

// categoryLabel → forrent.jp カテゴリコード（プルダウン value と1:1対応）
const FORRENT_CATEGORY_MAP = {
  // 室内系 (040xxx)
  "居室・リビング": "040101",
  "その他部屋・スペース": "040102",
  "キッチン": "040103",
  "バス・シャワールーム": "040104",
  "トイレ": "040105",
  "洗面設備": "040106",
  "収納": "040107",
  "バルコニー": "040108",
  "庭": "040109",
  "玄関": "040110",
  "セキュリティ": "040111",
  "その他設備": "040199",
  // 外観 (020xxx)
  "建物外観": "020101",
  // 共有部分 (030xxx)
  "エントランス": "030101",
  "ロビー": "030102",
  "駐車場": "030103",
  "その他共有部分": "030199",
  // その他
  "眺望": "050101",
  "省エネ性能ラベル": "070101",
  "その他": "999999",
};

/**
 * 画像カテゴリselectを設定
 * @param {string} slotName - gaikanFile, shitsunaiFile, shashin1File, tsuikaGazo1File, etc.
 * @param {string} catCode - forrent.jpカテゴリコード (e.g. "040101")
 * @param {number} shashinIdx - 現在のshashin番号 (1-3) - shashinFile時のみ使用
 * @param {number} tsuikaIdx - 現在のtsuikaGazo番号 (1-8) - tsuikaGazoFile時のみ使用
 */
async function setImageCategory(frame, slotName, catCode, shashinIdx, tsuikaIdx) {
  await frame.evaluate(({ slot, code, sIdx, tIdx }) => {
    let sel = null;

    if (slot === "shitsunaiFile") {
      // 室内写真: shitsunaiShashinCategory or shitsunaiCategory
      sel = document.getElementById("shitsunaiShashinCategory")
        || document.getElementById("shitsunaiCategory")
        || document.querySelector("select[name*='shitsunaiCategory']");
    } else if (slot.startsWith("shashin") && slot.endsWith("File")) {
      // shashin1File → shashin1Category, shashin2File → shashin2Category ...
      const n = slot.replace("shashin", "").replace("File", "");
      sel = document.getElementById(`shashin${n}Category`);
    } else if (slot.startsWith("tsuikaGazo") && slot.endsWith("File")) {
      // tsuikaGazo1File → index 0 の categoryCd
      const n = parseInt(slot.replace("tsuikaGazo", "").replace("File", ""), 10);
      const idx = n - 1; // 1-based → 0-based
      const all = document.querySelectorAll("select[name*='tsuikaGazoInputForm'][name*='categoryCd']");
      if (idx < all.length) sel = all[idx];
    }
    // gaikanFile, shuhenKankyoFile → カテゴリselectなし（固定）

    if (sel) {
      sel.value = code;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, { slot: slotName, code: catCode, sIdx: shashinIdx, tIdx: tsuikaIdx });
}

async function uploadImages(mainFrame, processedImages) {
  const uploaded = [];
  const errors = [];

  const items = (processedImages || []).map(img =>
    typeof img === "string" ? { localPath: img } : img
  );
  if (!items.length) return { uploaded, errors };

  // 画像セクションへスクロール
  await mainFrame.evaluate(() => {
    const a = document.querySelector('[name="gazou"]');
    if (a) a.scrollIntoView();
  }).catch(() => {});
  await mainFrame.waitForTimeout(1000);

  // スロット使用トラッカー
  let gaikanDone = false, shitsunaiDone = false, madoriDone = false;
  let shashinN = 1;  // 1-3
  let tsuikaN = 1;   // 1-8
  let shuhenN = 1;   // 1-6

  for (const img of items) {
    const cat = img.categoryLabel || "";
    let inputName = null;

    // カテゴリ → スロット割り当て
    if (MADORI_CATS.includes(cat) && !madoriDone) {
      // 間取り図専用スロット（名寄せ5pt — shashin枠の1ptより大幅UP）
      inputName = "clientMadoriFile"; madoriDone = true;
    } else if (GAIKAN_CATS.includes(cat) && !gaikanDone) {
      inputName = "gaikanFile"; gaikanDone = true;
    } else if (INTERIOR_CATS.includes(cat) && !shitsunaiDone) {
      inputName = "shitsunaiFile"; shitsunaiDone = true;
    } else if (SHUHEN_CATS.includes(cat) && shuhenN <= 6) {
      const currentShuhen = shuhenN;
      inputName = `shuhenKankyo${shuhenN++}File`;
      // Required categories per slot: コンビニ/スーパー/ドラッグストア/病院/飲食店 etc.
      // NOTE: 070201(郵便局), 080101(学校) 等の非ショッピング系コードは
      // mokuteki selectに存在しない可能性があるため除外
      const SHUHEN_CATEGORIES = [
        { code: "060203", name: "コンビニ" },
        { code: "060202", name: "スーパー" },
        { code: "060204", name: "ドラッグストア" },
        { code: "060210", name: "病院" },
        { code: "060218", name: "飲食店" },
        { code: "060211", name: "郵便局" },
      ];
      // facilityTypeがある場合は画像の実際の施設種別に合ったカテゴリを使用
      // Derived from SHUHEN_CATEGORY_CODES (single source of truth at module top)
      const SHUHEN_TYPE_MAP = Object.fromEntries(
        Object.entries(SHUHEN_CATEGORY_CODES).map(([code, name]) => [name, { code, name }])
      );
      const catInfo = (img.facilityType && SHUHEN_TYPE_MAP[img.facilityType])
        || SHUHEN_CATEGORIES[currentShuhen - 1]
        || SHUHEN_CATEGORIES[0];
      const destName = (img.facilityName && img.facilityName !== catInfo.name)
        ? img.facilityName
        : `近隣${catInfo.name}`;
      try {
        const metaResult = await mainFrame.evaluate(({ n, catCode, catName }) => {
          const catEl = document.getElementById(`mokuteki${n}`);
          let catSet = false;
          if (catEl) {
            // mokuteki selectにコードが存在するか確認してから設定
            const hasOption = [...catEl.options].some(o => o.value === catCode);
            if (hasOption) {
              catEl.value = catCode;
              catEl.dispatchEvent(new Event("change", { bubbles: true }));
              catSet = true;
            }
          }
          const nameEl = document.getElementById(`destination${n}`);
          if (nameEl) {
            nameEl.value = catName;
            nameEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const distEl = document.getElementById(`distance${n}`);
          if (distEl) {
            distEl.value = "100";
            distEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return { catSet };
        }, { n: currentShuhen, catCode: catInfo.code, catName: destName });
        console.log(`[forrent] + 周辺環境${currentShuhen}メタ: ${destName}(${catInfo.name})/100m${metaResult.catSet ? "" : " [mokutekiコード無効]"}`);
      } catch (e) {
        console.log(`[forrent] x 周辺環境メタ: ${e.message.slice(0, 60)}`);
      }
    } else if (shashinN <= 3) {
      inputName = `shashin${shashinN++}File`;
    } else if (tsuikaN <= 8) {
      inputName = `tsuikaGazo${tsuikaN++}File`;
    } else {
      errors.push(`slot overflow: ${img.localPath}`);
      continue;
    }

    try {
      const ok = await setFileInput(mainFrame, inputName, img.localPath);
      if (ok) {
        uploaded.push(img.localPath);
        console.log(`[forrent] + image: ${inputName} <- ${img.localPath.split("/").pop()}`);

        // ★ カテゴリselect設定（名寄せスコアの主要配点）
        const forrentCatCode = FORRENT_CATEGORY_MAP[cat] || "";
        if (forrentCatCode) {
          await setImageCategory(mainFrame, inputName, forrentCatCode, shashinN - 1, tsuikaN - 1);
          console.log(`[forrent] + category: ${inputName} → ${forrentCatCode} (${cat})`);
        }
      } else {
        console.log(`[forrent] x image: ${inputName} not found in DOM`);
        errors.push(`image(${inputName}): element not found`);
      }
      await mainFrame.waitForTimeout(1500);
    } catch (e) {
      console.log(`[forrent] x image: ${inputName}: ${e.message.slice(0, 80)}`);
      errors.push(`image(${inputName}): ${e.message.slice(0, 60)}`);
    }
  }

  // ★ 残りtsuikaGazoスロットを未使用カテゴリで埋める
  // Create unique image variants (different crop/quality) to avoid duplicate detection
  const EXTRA_CATEGORIES = [
    { code: "040107", label: "収納" },
    { code: "040108", label: "バルコニー" },
    { code: "040109", label: "庭" },
    { code: "030101", label: "エントランス" },
    { code: "030102", label: "ロビー" },
    { code: "040111", label: "セキュリティ" },
    { code: "050101", label: "眺望" },
  ];
  const usedCodes = new Set();
  for (const img of items) {
    const cat = img.categoryLabel || "";
    const code = FORRENT_CATEGORY_MAP[cat];
    if (code) usedCodes.add(code);
  }
  const reuseImages = items.filter(img => INTERIOR_CATS.includes(img.categoryLabel || ""));

  if (reuseImages.length > 0 && tsuikaN <= 8) {
    let reuseIdx = 0;
    for (const extra of EXTRA_CATEGORIES) {
      if (tsuikaN > 8) break;
      if (usedCodes.has(extra.code)) continue;

      const reuseImage = reuseImages[reuseIdx % reuseImages.length];
      reuseIdx++;
      const inputName = `tsuikaGazo${tsuikaN++}File`;
      try {
        // Create a unique variant: different crop offset + quality to avoid duplicate detection
        const variantPath = reuseImage.localPath.replace(/\.jpg$/, `_var${reuseIdx}.jpg`);
        const meta = await sharp(reuseImage.localPath).metadata();
        const cropX = Math.min(reuseIdx * 3, Math.floor((meta.width || 1280) * 0.05));
        const cropY = Math.min(reuseIdx * 2, Math.floor((meta.height || 960) * 0.05));
        await sharp(reuseImage.localPath)
          .extract({
            left: cropX, top: cropY,
            width: (meta.width || 1280) - cropX * 2,
            height: (meta.height || 960) - cropY * 2,
          })
          .resize({ width: 1280, height: 960, fit: "cover" })
          .jpeg({ quality: 82 - reuseIdx }) // slightly different quality each time
          .toFile(variantPath);

        const ok = await setFileInput(mainFrame, inputName, variantPath);
        if (ok) {
          uploaded.push(variantPath);
          console.log(`[forrent] + image(variant): ${inputName} <- ${path.basename(variantPath)} as ${extra.label}`);
          await setImageCategory(mainFrame, inputName, extra.code, 0, tsuikaN - 1);
          console.log(`[forrent] + category: ${inputName} → ${extra.code} (${extra.label})`);
        }
        await mainFrame.waitForTimeout(1000);
      } catch (e) {
        console.log(`[forrent] x fill: ${inputName}: ${e.message.slice(0, 60)}`);
      }
    }
  }

  // ★ 周辺環境画像フォールバック削除
  // 外観写真を周辺環境として使うのは不適切（先方フィードバック: 全て物件の外観写真になるケースあり）
  // 周辺環境写真がない場合はスロットを空のままにする（らくらく周辺環境ポップアップで補完）
  if (shuhenN === 1) {
    console.log(`[forrent] 周辺環境画像なし → スロット空（外観フォールバック無効化済み）`);
  }

  console.log(`[forrent] images: ${uploaded.length} uploaded, ${errors.length} errors`);
  return { uploaded, errors };
}

// ══════════════════════════════════════════════════════════
//  特徴項目チェックボックス
// ══════════════════════════════════════════════════════════

// REINS設備フリーテキスト → forrent.jp categoryTokuchoCd value マッピング
const SETSUBI_TO_TOKUCHO = {
  // ── 交通・立地 ──
  "始発駅":             ["0101"],
  "駅前":               ["0110"],
  "閑静":               ["0122"],
  "オーシャンビュー":   ["0118"],
  "リバーサイド":       ["0119"],

  // ── 構造・建物 ──
  "耐震":               ["0201"],
  "制震":               ["0202"],
  "免震":               ["0203"],
  "二重床":             ["0208"],
  "二重天井":           ["0209"],
  "高気密":             ["0217"],
  "高断熱":             ["0218"],
  "タワー":             ["0231"],
  "デザイナーズ":       ["0233"],
  "分譲賃貸":           ["0256"],
  "分譲":               ["0256"],
  "バリアフリー":       ["0252"],
  "メゾネット":         ["1327"],
  "ロフト":             ["1326"],
  "平屋":               ["0230"],
  "吹抜":               ["0246"],
  "天井高2.5":          ["0247"],

  // ── 共用部 ──
  "エレベーター":       ["0501"],
  "エレベータ":         ["0501"],
  "宅配ボックス":       ["0517"],
  "24時間ゴミ":         ["0516"],
  "コインランドリー":   ["0520"],
  "駐輪場":             ["0816"],
  "バイク置場":         ["0817"],
  "平面駐車":           ["0813"],
  "トランクルーム":     ["2223"],
  "敷地内ごみ":         ["0527"],

  // ── セキュリティ ──
  "オートロック":       ["1201"],
  "ダブルロック":       ["1202"],
  "ディンプルキー":     ["1203"],
  "ディンプル":         ["1203"],
  "カードキー":         ["1204"],
  "電子ロック":         ["1205"],
  "電子キー":           ["1206"],
  "防犯カメラ":         ["1211"],
  "防犯ガラス":         ["1212"],
  "セキュリティ":       ["1218"],
  "セキュリティ会社":   ["1218"],
  "24時間管理":         ["1215"],
  "TVインターホン":     ["2414"],
  "モニター付きインターホン": ["2414"],
  "TVモニタ":           ["2414"],
  "モニタ付":           ["2414"],
  "インターホン":       ["2414"],

  // ── 居室 ──
  "角部屋":             ["1007"],
  "角住戸":             ["1007"],
  "振分":               ["1331"],
  "全居室洋室":         ["1333"],
  "和室":               ["1311"],
  "サンルーム":         ["1324"],
  "書斎":               ["1323"],
  "防音室":             ["1320"],
  "玄関ポーチ":         ["1328"],

  // ── キッチン ──
  "システムキッチン":   ["1401"],
  "独立型キッチン":     ["1402"],
  "独立キッチン":       ["1402"],
  "カウンターキッチン": ["1403"],
  "対面式キッチン":     ["1403"],
  "対面式":             ["1403"],
  "アイランドキッチン": ["1408"],
  "ガスコンロ":         ["1412"],
  "ガスレンジ":         ["1413"],
  "ガスコンロ（３口以上）": ["1415"],
  "3口以上":            ["1415"],
  "3口":                ["1415"],
  "ＩＨ":               ["1416"],
  "IH":                 ["1416"],
  "グリル":             ["1418"],
  "ガラストップ":       ["1421"],
  "食器洗":             ["1430"],
  "食洗":               ["1430"],
  "食洗機":             ["1430"],
  "浄水器":             ["1433"],
  "ディスポーザー":     ["1434"],
  "都市ガス":           ["1436"],
  "プロパン":           ["1437"],

  // ── バス・トイレ・洗面 ──
  "バストイレ別":       ["1501"],
  "BT別":               ["1501"],
  "浴室1坪":            ["1502"],
  "脱衣所":             ["1503"],
  "脱衣":               ["1503"],
  "オートバス":         ["1504"],
  "自動湯張":           ["1504"],
  "追い焚き":           ["1505"],
  "追焚":               ["1505"],
  "浴室乾燥機":         ["1507"],
  "浴室乾燥":           ["1507"],
  "ミストサウナ":       ["1513"],
  "シャワールーム":     ["1518"],
  "温水洗浄便座":       ["1603"],
  "ウォシュレット":     ["1603"],
  "タンクレス":         ["1604"],
  "トイレ2ヶ所":        ["1601"],
  "独立洗面":           ["1701"],
  "洗面所独立":         ["1701"],
  "洗面化粧台":         ["1707"],
  "三面鏡":             ["1708"],
  "シャワー付洗面":     ["1710"],

  // ── 冷暖房・換気 ──
  "24時間換気":         ["1801"],
  "床暖房":             ["1806"],
  "蓄熱":               ["1808"],
  "エアコン":           ["2801"],

  // ── 電気・エネルギー ──
  "オール電化":         ["1901"],
  "太陽光":             ["1902"],
  "エコキュート":       ["1904"],
  "エコジョーズ":       ["1905"],

  // ── バルコニー ──
  "バルコニー":         ["2001"],
  "ベランダ":           ["2001"],
  "ルーフバルコニー":   ["2002"],
  "ワイドバルコニー":   ["2003"],
  "ウッドデッキ":       ["2011"],
  "テラス":             ["2012"],

  // ── 室内設備 ──
  "フローリング":       ["2101"],
  "クッションフロア":   ["2105"],
  "無垢材":             ["2107"],
  "琉球畳":             ["2110"],
  "雨戸":               ["2116"],
  "シャッター":         ["2117"],
  "複層ガラス":         ["2122"],
  "ペアガラス":         ["2122"],
  "室内洗濯":           ["2129"],
  "洗濯機置場":         ["2129"],
  "室内物干":           ["2130"],
  "シーリングファン":   ["2132"],

  // ── 収納 ──
  "クロゼット":         ["2201"],
  "ウォークインクロゼット": ["2204"],
  "ウォークイン":       ["2204"],
  "WIC":                ["2204"],
  "シューズボックス":   ["2207"],
  "シューズクローゼット": ["2209"],
  "納戸":               ["2215"],
  "床下収納":           ["2221"],

  // ── 通信 ──
  "BS":                 ["2401"],
  "CS":                 ["2401"],
  "CATV":               ["2404"],
  "ネット使用料不要":   ["2406"],
  "光ファイバー":       ["2410"],
  "インターネット":     ["2408"],
  "高速ネット":         ["2408"],
  "LAN":                ["2413"],

  // ── リフォーム ──
  "リフォーム済":       ["2601"],
  "リノベーション":     ["2609"],
  "リノベ":             ["2609"],

  // ── 条件 ──
  "即入居":             ["2701"],
  "ペット":             ["2705"],
  "ペット可":           ["2705"],
  "ペット相談":         ["2705"],
  "楽器":               ["2711"],
  "楽器可":             ["2711"],
  "楽器相談":           ["2711"],
  "事務所":             ["2710"],
  "ルームシェア":       ["2709"],
  "保証人不要":         ["2724"],
  "保証会社":           ["2725"],
  "フリーレント":       ["2732"],
  "DIY":                ["2736"],
  "家具付":             ["2815"],
  "家具":               ["2815"],
  "照明付":             ["2817"],
  "眺望":               ["2901"],
  "通風":               ["2902"],
  "陽当り":             ["2903"],
  "日当たり":           ["2903"],
  "南向き":             ["1001"],

  // ── Additional mappings for coverage ──
  // 交通・立地
  "2沿線":              ["0103"],
  "3沿線":              ["0105"],
  "2駅":                ["0102"],
  "3駅":                ["0104"],

  // セキュリティ追加
  "管理人":             ["1215"],
  "コンシェルジュ":     ["1216"],
  "管理人常駐":         ["1215"],

  // キッチン追加
  "2口コンロ":          ["1414"],
  "2口":                ["1414"],
  "コンロ2口":          ["1414"],
  "食器棚":             ["1431"],

  // バス追加
  "追い炊き":           ["1505"],
  "おいだき":           ["1505"],

  // 室内設備追加
  "二重サッシ":         ["2122"],
  "ペアサッシ":         ["2122"],
  "出窓":               ["2115"],
  "ルームクリーニング": ["2601"],
  "クリーニング済":     ["2601"],

  // 収納追加
  "W.I.C":              ["2204"],
  "W.I.C.":             ["2204"],
  "ウォークスルー":     ["2205"],
  "パントリー":         ["2216"],

  // 通信追加
  "Wi-Fi":              ["2408"],
  "WiFi":               ["2408"],
  "無料インターネット": ["2406"],
  "ネット無料":         ["2406"],

  // 共用部追加
  "ゲストルーム":       ["0524"],
  "ラウンジ":           ["0525"],
  "フィットネス":       ["0523"],
  "ジム":               ["0523"],
  "キッズルーム":       ["0526"],
  "屋上":               ["0528"],

  // 条件追加
  "2人入居可":          ["2704"],
  "二人入居可":         ["2704"],
  "女性限定":           ["2706"],
  "女性専用":           ["2706"],
  "初期費用カード":     ["2734"],
  "クレジットカード":   ["2734"],
  "家賃カード":         ["2733"],
};

// 建物属性から推定できる特徴項目（修正点13: 全マッピング）
function inferTokuchoFromBuilding(reinsData) {
  const codes = new Set();
  const n = (s) => norm(s);

  // 階数からエレベーター推定（4階以上 → ほぼ確実）
  const floors = parseInt(n(reinsData.地上階層 || ""), 10);
  if (floors >= 4) codes.add("0501"); // エレベーター

  // 交通情報から駅数・沿線数
  const transport = reinsData.交通 || [];
  if (transport.length >= 2) codes.add("0102"); // 2駅利用可
  if (transport.length >= 3) codes.add("0104"); // 3駅以上利用可
  const lines = new Set(transport.map(t => t.沿線).filter(Boolean));
  if (lines.size >= 2) codes.add("0103"); // 2沿線利用可
  if (lines.size >= 3) codes.add("0105"); // 3沿線以上利用可

  // 徒歩分数
  const walk = transport.map(t => parseInt(n(t.徒歩 || ""), 10)).filter(x => !isNaN(x));
  if (walk.some(w => w <= 5)) codes.add("0129"); // 駅徒歩5分以内
  if (walk.some(w => w <= 10)) codes.add("0130"); // 駅徒歩10分以内

  // バルコニー方向
  const dir = n(reinsData.バルコニー方向 || "");
  if (dir.includes("南東") || dir.includes("東南")) { codes.add("1002"); codes.add("2005"); }
  else if (dir.includes("南西") || dir.includes("西南")) { codes.add("1003"); codes.add("2005"); }
  else if (dir === "南") { codes.add("1001"); codes.add("2005"); }
  if (dir.includes("角")) codes.add("1007");

  // 敷金・礼金からの推定
  const shikikin = n(reinsData.敷金 || "");
  const reikin = n(reinsData.礼金 || "");
  if (/なし|0|ー|^$/.test(shikikin)) codes.add("2712"); // 敷金不要
  else if (/1ヶ?月/.test(shikikin)) codes.add("2713");   // 敷金1ヶ月
  else if (/2ヶ?月/.test(shikikin)) codes.add("2714");   // 敷金2ヶ月
  if (/なし|0|ー|^$/.test(reikin)) codes.add("2719");     // 礼金不要
  else if (/1ヶ?月/.test(reikin)) codes.add("2720");      // 礼金1ヶ月
  else if (/2ヶ?月/.test(reikin)) codes.add("2721");      // 礼金2ヶ月
  if (/なし|0|ー/.test(shikikin) && /なし|0|ー/.test(reikin)) codes.add("2718"); // 敷金・礼金不要

  // 入居時期
  const nyukyo = n(reinsData.入居時期 || "");
  if (/即/.test(nyukyo)) codes.add("2701"); // 即入居可

  // 築年月からの推定
  const chiku = n(reinsData.築年月 || "");
  const builtYear = parseInt(chiku.match(/(\d{4})年/)?.[1] || "0", 10);
  const currentYear = new Date().getFullYear();
  if (builtYear && currentYear - builtYear <= 2) codes.add("0701"); // 築2年以内
  if (builtYear && currentYear - builtYear <= 3) codes.add("0702"); // 築3年以内
  if (builtYear && currentYear - builtYear <= 5) codes.add("0703"); // 築5年以内

  // 条件フリー / 備考3
  const cond = n(reinsData.条件フリー || "");
  const biko = n(reinsData.備考3 || "");
  const combined = cond + " " + biko;
  if (combined.includes("保証人不要")) codes.add("2724");
  if (combined.includes("保証会社")) codes.add("2725");
  if (combined.includes("フリーレント")) codes.add("2732");
  if (combined.includes("DIY")) codes.add("2736");
  if (combined.includes("リノベ")) codes.add("2609");
  if (combined.includes("リフォーム")) codes.add("2601");

  // 駐車場
  const parking = n(reinsData.駐車場在否 || "");
  if (/有|空有/.test(parking)) {
    // 駐車場ありの場合は駐輪場もある可能性が高い
    codes.add("0816"); // 駐輪場
  }

  return codes;
}

/**
 * 特徴項目チェックボックスを設定
 * @param {Frame} mainFrame
 * @param {object} reinsData - REINS抽出データ
 */
async function fillTokucho(mainFrame, reinsData) {
  console.log("[forrent] === TOKUCHO (特徴項目) START ===");

  // 1. 設備系テキスト全てからマッチング（修正点13: スキャン範囲拡大）
  const textFields = [
    reinsData.設備フリー || "",
    reinsData.設備 || "",
    reinsData.条件フリー || "",
    reinsData.備考1 || "",
    reinsData.備考2 || "",
    reinsData.備考3 || "",
    reinsData.その他一時金 || "",
  ].map(norm);
  const codesToCheck = new Set();

  for (const [keyword, codes] of Object.entries(SETSUBI_TO_TOKUCHO)) {
    const normKey = norm(keyword);
    if (textFields.some(t => t.includes(normKey))) {
      for (const c of codes) codesToCheck.add(c);
    }
  }

  // 2. 建物属性から推定
  const inferred = inferTokuchoFromBuilding(reinsData);
  for (const c of inferred) codesToCheck.add(c);

  if (codesToCheck.size === 0) {
    console.log("[forrent] tokucho: no matching features found");
    return { checked: 0, codes: [] };
  }

  // 3. チェックボックスを設定
  const codesArray = [...codesToCheck];
  const result = await mainFrame.evaluate((codes) => {
    let checked = 0;
    const checkedCodes = [];
    for (const code of codes) {
      // categoryTokuchoCd のチェックボックスで value=code のものを探す
      const cb = document.querySelector(
        `input[type="checkbox"][name="\${bukkenInputForm.categoryTokuchoCd}"][value="${code}"]`
      );
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        checked++;
        // ラベル取得
        let label = "";
        if (cb.nextSibling) label = (cb.nextSibling.textContent || "").trim().slice(0, 30);
        checkedCodes.push({ code, label });
      }
    }
    return { checked, checkedCodes };
  }, codesArray);

  for (const { code, label } of result.checkedCodes) {
    console.log(`[forrent] + 特徴: ${code} (${label})`);
  }
  console.log(`[forrent] === TOKUCHO END === checked: ${result.checked}`);

  return { checked: result.checked, codes: codesArray };
}

/**
 * らくらく周辺環境入力 — 物件の緯度経度から周辺施設を自動取得
 * ポップアップが開き、施設一覧からチェックボックスで選択→登録
 * @param {Page} page - Playwright page (ポップアップ検出用)
 * @param {Frame} mainFrame - forrent.jp main frame
 */
async function fillShuhenKankyo(page, mainFrame) {
  console.log("[forrent] === SHUHEN KANKYO (周辺環境) START ===");
  const filled = [];
  const errors = [];

  try {
    // 「らくらく周辺環境入力」ボタンをクリック
    const popupPromise = page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null);
    const btnClicked = await mainFrame.evaluate(() => {
      const buttons = document.querySelectorAll("input[type='button']");
      for (const btn of buttons) {
        if (btn.value.includes("らくらく周辺環境")) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!btnClicked) {
      console.log("[forrent] 周辺環境: らくらく周辺環境入力ボタンなし");
      return { filled, errors: ["らくらく周辺環境入力ボタンが見つかりません"] };
    }

    const popup = await popupPromise;
    if (!popup) {
      console.log("[forrent] 周辺環境: ポップアップが開きませんでした");
      return { filled, errors: ["周辺環境ポップアップが開きません"] };
    }

    console.log(`[forrent] 周辺環境ポップアップ検出: ${popup.url()}`);
    await popup.waitForLoadState("networkidle").catch(() => {});
    await popup.waitForTimeout(3000);

    // ポップアップ内の施設一覧を確認
    const facilityInfo = await popup.evaluate(() => {
      const result = {
        checkboxes: 0,
        checkedCount: 0,
        facilities: [],
        buttons: [],
      };

      // チェックボックスを検出
      const cbs = document.querySelectorAll("input[type='checkbox']");
      result.checkboxes = cbs.length;
      for (const cb of cbs) {
        if (cb.checked) result.checkedCount++;
        const tr = cb.closest("tr");
        const text = tr ? tr.textContent.trim().replace(/\s+/g, " ").slice(0, 100) : "";
        result.facilities.push({ checked: cb.checked, text, name: cb.name || "", value: cb.value || "" });
      }

      // ボタンを検出
      const buttons = document.querySelectorAll("input[type='button'], input[type='submit'], button, img[onclick]");
      for (const btn of buttons) {
        const text = (btn.value || btn.textContent || btn.alt || "").trim();
        if (text) result.buttons.push(text);
      }

      return result;
    }).catch(() => ({ checkboxes: 0, checkedCount: 0, facilities: [], buttons: [] }));

    console.log(`[forrent] 周辺環境ポップアップ: ${facilityInfo.checkboxes}件チェックボックス, ${facilityInfo.checkedCount}件チェック済み`);
    console.log(`[forrent] ボタン: ${facilityInfo.buttons.join(", ")}`);
    for (const f of facilityInfo.facilities.slice(0, 10)) {
      console.log(`[forrent]   [${f.checked ? "☑" : "☐"}] ${f.text.slice(0, 80)}`);
    }

    // Select up to 6 facilities, prioritizing required categories
    if (facilityInfo.checkboxes > 0 && facilityInfo.checkedCount === 0) {
      const selectedCount = await popup.evaluate(() => {
        const cbs = [...document.querySelectorAll("input[type='checkbox']")];
        const selected = [];
        // Priority categories to find (by text match in row)
        const priorities = ["コンビニ", "スーパー", "ドラッグストア", "薬局", "郵便局", "病院", "学校"];
        // First pass: select priority categories
        for (const keyword of priorities) {
          if (selected.length >= 6) break;
          for (const cb of cbs) {
            if (selected.includes(cb)) continue;
            const tr = cb.closest("tr");
            const text = tr ? tr.textContent : "";
            if (text.includes(keyword)) {
              cb.checked = true;
              cb.dispatchEvent(new Event("change", { bubbles: true }));
              selected.push(cb);
              break; // one per category
            }
          }
        }
        // Second pass: fill remaining slots
        for (const cb of cbs) {
          if (selected.length >= 6) break;
          if (!selected.includes(cb)) {
            cb.checked = true;
            cb.dispatchEvent(new Event("change", { bubbles: true }));
            selected.push(cb);
          }
        }
        return selected.length;
      });
      console.log(`[forrent] 周辺環境: ${selectedCount}件を優先順で自動選択`);
    }

    // 「登録」/「確定」/「反映」ボタンをクリック
    await popup.waitForTimeout(1000);
    const registClicked = await popup.evaluate(() => {
      // 登録ボタンを探す（ID、value、alt属性で検索）
      const btn = document.getElementById("registButton")
        || document.getElementById("regist")
        || document.getElementById("okButton");
      if (btn) { btn.click(); return btn.value || btn.alt || "registButton"; }

      // value で検索
      const buttons = [...document.querySelectorAll("input[type='button'], input[type='submit'], button")];
      for (const b of buttons) {
        const val = (b.value || b.textContent || "").trim();
        if (val.includes("登録") || val.includes("確定") || val.includes("反映") || val.includes("OK")) {
          b.click();
          return val;
        }
      }

      // img ボタンで検索
      const imgs = [...document.querySelectorAll("img")];
      for (const img of imgs) {
        const src = img.src || "";
        const alt = img.alt || "";
        if (src.includes("toroku") || alt.includes("登録") || src.includes("ok") || src.includes("regist")) {
          img.click();
          return alt || src;
        }
      }

      return null;
    }).catch((e) => {
      if (e.message.includes("closed") || e.message.includes("detach")) return "popup closed";
      return null;
    });

    console.log(`[forrent] 周辺環境ポップアップ: 登録=${registClicked}`);
    await mainFrame.waitForTimeout(3000);
    if (!popup.isClosed()) await popup.close().catch(() => {});

    // mainFrameの周辺環境フィールドが設定されたか確認
    await mainFrame.waitForTimeout(1000);
    const shuhenResult = await mainFrame.evaluate(() => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        const nameEl = document.querySelector(`input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].shuhenKankyoNm"]`);
        const kyoriEl = document.querySelector(`input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].kyori"]`);
        const catEl = document.querySelector(`select[name="bukkenInputForm.shuhenKankyoInputForm[${i}].categoryCd"]`);
        const name = nameEl?.value || "";
        const kyori = kyoriEl?.value || "";
        const cat = catEl?.options[catEl.selectedIndex]?.text?.trim() || "";
        const catCd = catEl?.value || "";
        if (name || kyori) out.push({ name, kyori, cat, catCd });
      }
      return out;
    });

    for (const s of shuhenResult) {
      filled.push(`${s.name} / ${s.kyori}m / ${s.cat}`);
      console.log(`[forrent] + 周辺: ${s.name} / ${s.kyori}m / ${s.cat} (${s.catCd})`);
    }

    // ポップアップ後にcategoryCdが空のスロットを補完
    // 郵便局・学校等はポップアップが自動設定しないため手動で設定
    try {
      await mainFrame.evaluate(() => {
        // Browser context: cannot reference SHUHEN_CATEGORY_CODES directly.
        // Canonical mapping is SHUHEN_CATEGORY_CODES at module top.
        const NAME_TO_CODE = {
          "コンビニ": "060203", "セブン": "060203", "ファミリーマート": "060203", "ローソン": "060203", "ミニストップ": "060203",
          "スーパー": "060202", "マルエツ": "060202", "まいばすけっと": "060202", "成城石井": "060202", "ライフ": "060202",
          "ドラッグ": "060204", "薬局": "060204", "スギ薬局": "060204", "マツモトキヨシ": "060204",
          "病院": "060210", "クリニック": "060210", "医院": "060210",
          "学校": "060207", "小学校": "060207", "中学校": "060207",
          "郵便局": "060211",
          "飲食": "060218", "レストラン": "060218",
        };
        for (let i = 0; i < 6; i++) {
          const catEl = document.querySelector(`select[name="bukkenInputForm.shuhenKankyoInputForm[${i}].categoryCd"]`);
          if (!catEl || (catEl.value && catEl.value !== "")) continue;
          const nameEl = document.querySelector(`input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].shuhenKankyoNm"]`);
          const name = nameEl?.value || "";
          if (!name) continue;
          // 施設名からカテゴリコードを推測
          let code = "";
          for (const [keyword, c] of Object.entries(NAME_TO_CODE)) {
            if (name.includes(keyword)) { code = c; break; }
          }
          if (!code) code = "060201"; // フォールバック: ショッピングセンター
          const hasOption = [...catEl.options].some(o => o.value === code);
          if (hasOption) {
            catEl.value = code;
            catEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      });
    } catch (e) {
      console.log(`[forrent] 周辺カテゴリ補完: ${e.message.slice(0, 60)}`);
    }

    if (filled.length === 0) {
      console.log("[forrent] 周辺環境: フィールドが更新されませんでした");
      errors.push("周辺環境フィールドが更新されませんでした");
    }

  } catch (e) {
    console.log(`[forrent] 周辺環境エラー: ${e.message.slice(0, 100)}`);
    errors.push(`周辺環境エラー: ${e.message.slice(0, 60)}`);
  }

  console.log(`[forrent] === SHUHEN KANKYO END === filled: ${filled.length}`);
  return { filled, errors };
}

// ── Utilities ──

function norm(str) {
  if (!str) return "";
  return str
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .trim();
}

/**
 * forrent.jp の備考・特記事項欄向け全角変換
 * 半角カナ・半角英数字・半角記号が禁止のため、全て全角に変換する
 */
function toFullWidth(str) {
  if (!str) return "";
  // Half-width katakana → full-width katakana
  const kanaMap = {
    "ｶﾞ":"ガ","ｷﾞ":"ギ","ｸﾞ":"グ","ｹﾞ":"ゲ","ｺﾞ":"ゴ",
    "ｻﾞ":"ザ","ｼﾞ":"ジ","ｽﾞ":"ズ","ｾﾞ":"ゼ","ｿﾞ":"ゾ",
    "ﾀﾞ":"ダ","ﾁﾞ":"ヂ","ﾂﾞ":"ヅ","ﾃﾞ":"デ","ﾄﾞ":"ド",
    "ﾊﾞ":"バ","ﾋﾞ":"ビ","ﾌﾞ":"ブ","ﾍﾞ":"ベ","ﾎﾞ":"ボ",
    "ﾊﾟ":"パ","ﾋﾟ":"ピ","ﾌﾟ":"プ","ﾍﾟ":"ペ","ﾎﾟ":"ポ",
    "ｳﾞ":"ヴ",
    "ｱ":"ア","ｲ":"イ","ｳ":"ウ","ｴ":"エ","ｵ":"オ",
    "ｶ":"カ","ｷ":"キ","ｸ":"ク","ｹ":"ケ","ｺ":"コ",
    "ｻ":"サ","ｼ":"シ","ｽ":"ス","ｾ":"セ","ｿ":"ソ",
    "ﾀ":"タ","ﾁ":"チ","ﾂ":"ツ","ﾃ":"テ","ﾄ":"ト",
    "ﾅ":"ナ","ﾆ":"ニ","ﾇ":"ヌ","ﾈ":"ネ","ﾉ":"ノ",
    "ﾊ":"ハ","ﾋ":"ヒ","ﾌ":"フ","ﾍ":"ヘ","ﾎ":"ホ",
    "ﾏ":"マ","ﾐ":"ミ","ﾑ":"ム","ﾒ":"メ","ﾓ":"モ",
    "ﾔ":"ヤ","ﾕ":"ユ","ﾖ":"ヨ",
    "ﾗ":"ラ","ﾘ":"リ","ﾙ":"ル","ﾚ":"レ","ﾛ":"ロ",
    "ﾜ":"ワ","ｦ":"ヲ","ﾝ":"ン",
    "ｧ":"ァ","ｨ":"ィ","ｩ":"ゥ","ｪ":"ェ","ｫ":"ォ",
    "ｯ":"ッ","ｬ":"ャ","ｭ":"ュ","ｮ":"ョ",
    "ｰ":"ー","｡":"。","｢":"「","｣":"」","､":"、","･":"・",
  };
  // Replace dakuten/handakuten combos first (2-char → 1-char), then singles
  let result = str;
  for (const [hw, fw] of Object.entries(kanaMap)) {
    result = result.split(hw).join(fw);
  }
  // Half-width ASCII (0x21-0x7E) → full-width (0xFF01-0xFF5E)
  // Space (0x20) → full-width space (0x3000)
  result = result.replace(/[\x20-\x7E]/g, c => {
    if (c === " ") return "　";
    return String.fromCharCode(c.charCodeAt(0) + 0xFEE0);
  });
  return result;
}

/**
 * バリデーション情報を確認画面のフレームから収集する。
 * 「エラー 一覧」見出しだけでなく、内側のリスト項目・フィールド別メッセージ・
 * 赤字警告などを網羅的に拾って `errors[]` と `errorSectionText` に集約する。
 */
async function scrapeValidation(frame) {
  return await frame.evaluate(() => {
    const body = document.body?.innerText || "";
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const uniq = (arr) => [...new Set(arr)];
    const scoreMatch = body.match(/名寄せスコア[：:\s]*(\d+)/);

    // forrent のエラー一覧テーブル構造:
    //   <table>
    //     <tr>...|状況|区分|内容|当該箇所へ| ...</tr>  ← ヘッダ
    //     <tr><td>...</td><td>区分名(ex:桁数チェック)</td><td>実エラー文</td><td>リンク</td></tr>
    //     ...
    //   </table>
    // この構造の tbody 行からのみエラーを拾い、他の画面要素（"よろしければ登録ボタンをクリックしてください" 等）は拾わない。
    const tables = [...document.querySelectorAll("table")];
    const errorRows = [];
    for (const tbl of tables) {
      // ヘッダ判定: tr:first-child または thead の text に 状況/区分/内容 が揃っているか
      const headerText = clean(
        (tbl.querySelector("thead") || tbl.querySelector("tr"))?.textContent || ""
      );
      const isErrorTable =
        /状況/.test(headerText) && /区分/.test(headerText) && /内容/.test(headerText);
      if (!isErrorTable) continue;
      const rows = [...tbl.querySelectorAll("tr")];
      for (const tr of rows) {
        const cells = [...tr.querySelectorAll("td")].map((td) => clean(td.textContent));
        if (cells.length < 3) continue;
        // 一般的なレイアウト: [状況, 区分, 内容, 当該箇所へ] だが 念のため後ろからも取る
        const category = cells[cells.length - 3] || "";
        const content = cells[cells.length - 2] || "";
        if (!content || content.length < 2) continue;
        if (/^当該箇所へ$/.test(content)) continue;
        errorRows.push({ category, content });
      }
    }

    // フォールバック: error クラス要素（エラーテーブルが壊れていた場合の保険）
    const fieldErrors = [];
    if (errorRows.length === 0) {
      const msgEls = document.querySelectorAll(
        '.errorMessage, .error_message, .errMsg, [class*="ErrorMsg"], .formError'
      );
      for (const el of msgEls) {
        const t = clean(el.textContent);
        if (t.length > 2 && t.length < 200 && !/^エラー\s*一覧$/.test(t)) fieldErrors.push(t);
      }
    }

    const errors = uniq([...errorRows.map((r) => r.content), ...fieldErrors]);
    // hasError は「エラーテーブルに具体的な行がある」を真のシグナルとする。
    // 確認画面(正常時)にも "エラー 一覧" テーブルは存在するが行は空なので hasError=false。
    const hasError = errors.length > 0;

    return {
      errors,
      errorRows,
      hasError,
      score: scoreMatch ? parseInt(scoreMatch[1]) : null,
      bodySnippet: body.slice(0, 500),
    };
  });
}

/**
 * artifact ディレクトリに確認画面の HTML / PNG を保存する（失敗原因の事後調査用）。
 */
async function saveFrameArtifacts(page, frame, dir, tag) {
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    const html = await frame.content();
    fs.writeFileSync(path.join(dir, `${tag}.html`), html);
  } catch (e) {
    try { fs.writeFileSync(path.join(dir, `${tag}.html.err`), String(e.message || e)); } catch {}
  }
  try {
    await page.screenshot({ path: path.join(dir, `${tag}.png`), fullPage: true });
  } catch (e) {
    try { fs.writeFileSync(path.join(dir, `${tag}.png.err`), String(e.message || e)); } catch {}
  }
}

/**
 * 物件登録 — 2ステップフロー:
 *   Step A: regButton2（確認画面へ）をクリック → バリデーション
 *   Step B: エラーなしなら確認画面上部の「登録」ボタンをクリック → 実登録
 *
 * エラーが出た場合はダイアログを受諾してリトライ（最大2回）
 *
 * @param {object} page - Playwright Page
 * @param {object} mainFrame - main frame reference
 * @param {object} [opts] - options
 * @param {string} [opts.artifactDir] - 指定時、確認画面の HTML/PNG を保存
 */
async function registerProperty(page, mainFrame, opts = {}) {
  const { artifactDir } = opts;
  console.log("[forrent] === REGISTER PROPERTY START ===");
  try {
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.accept();
    });

    const MAX_ATTEMPTS = 2;
    let lastValidation = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`[forrent] 確認画面へ 試行 ${attempt}/${MAX_ATTEMPTS}`);

      // mainFrame を最新に再取得
      mainFrame = page.frame({ name: "main" }) || mainFrame;
      await mainFrame.evaluate(() => window.scrollTo(0, 0));
      await mainFrame.waitForTimeout(500);

      // ── Step A: 「確認画面へ」(regButton2) をクリック ──
      const clicked = await mainFrame.evaluate(() => {
        const btn = document.getElementById("regButton2");
        if (btn) { btn.click(); return btn.value || btn.alt || "regButton2"; }
        // Fallback: テキスト検索
        const buttons = [...document.querySelectorAll("input[type='button'], input[type='submit'], input[type='image'], button")];
        for (const b of buttons) {
          const t = (b.value || b.textContent || b.alt || "").trim();
          if ((t.includes("確認") || t.includes("登録")) && !t.includes("削除") && !t.includes("一時")) {
            b.click(); return t;
          }
        }
        return null;
      });

      if (!clicked) {
        console.log("[forrent] 確認画面へボタンが見つかりません");
        return { saved: false, registrationType: null, error: "確認画面へボタンが見つかりません" };
      }

      console.log(`[forrent] 確認画面へクリック: ${clicked}`);
      await mainFrame.waitForTimeout(10000);

      // 確認画面のフレームを再取得
      const confirmFrame = page.frame({ name: "main" }) || mainFrame;

      // バリデーション結果を詳細スクレイプ
      const validation = await scrapeValidation(confirmFrame);
      lastValidation = validation;

      if (dialogs.length > 0) {
        console.log(`[forrent] ダイアログ: ${dialogs.map(d => d.message).join(", ")}`);
      }

      // 確認画面スナップショットを保存（成否問わず）
      await saveFrameArtifacts(page, confirmFrame, artifactDir, `confirm-attempt${attempt}`);

      // エラーあり → リトライ
      if (validation.hasError && attempt < MAX_ATTEMPTS) {
        console.log(`[forrent] バリデーションエラー (${validation.errors.length}件) → リトライ`);
        for (const e of validation.errors.slice(0, 8)) console.log(`[forrent]   - ${e}`);
        dialogs.length = 0;
        continue;
      }

      if (validation.hasError) {
        console.log(`[forrent] バリデーションエラー残存 (最終試行): ${validation.errors.slice(0, 8).join(" / ")}`);
        if (artifactDir) {
          try {
            fs.writeFileSync(
              path.join(artifactDir, "validation.json"),
              JSON.stringify(validation, null, 2)
            );
          } catch {}
        }
        return {
          saved: false,
          registrationType: null,
          score: validation.score,
          dialogs,
          errors: validation.errors,
          errorRows: validation.errorRows,
          error: `バリデーションエラー: ${validation.errors[0] || "詳細不明（artifactDir の validation.json を参照）"}`,
        };
      }

      // ── Step B: 確認画面上部の「登録」ボタンをクリック ──
      console.log(`[forrent] 確認画面到達 (score: ${validation.score}) → 登録ボタンを押下`);

      const regClicked = await confirmFrame.evaluate(() => {
        // Search for the registration button at the top of the confirmation screen
        // Try common patterns: id, value, alt text, button text
        const candidates = [
          ...document.querySelectorAll("input[type='button'], input[type='submit'], input[type='image'], button"),
        ];
        for (const b of candidates) {
          const t = (b.value || b.textContent || b.alt || "").trim();
          // Match "登録" but exclude "確認画面へ", "一時", "削除", "戻る"
          if (t.includes("登録") && !t.includes("確認") && !t.includes("一時") && !t.includes("削除") && !t.includes("戻")) {
            b.click();
            return t;
          }
        }
        // Fallback: try image buttons with src containing "toroku" or "regist"
        const imgs = [...document.querySelectorAll("input[type='image'], img[onclick]")];
        for (const img of imgs) {
          const src = (img.src || img.getAttribute("src") || "").toLowerCase();
          const alt = (img.alt || "").trim();
          const onclick = (img.getAttribute("onclick") || "");
          if (src.includes("toroku") || src.includes("regist") || alt.includes("登録") || onclick.includes("regist")) {
            img.click();
            return alt || src.split("/").pop() || "img-register";
          }
        }
        return null;
      });

      if (!regClicked) {
        console.log("[forrent] 確認画面の登録ボタンが見つかりません");
        return {
          saved: false,
          registrationType: null,
          score: validation.score,
          error: "確認画面の登録ボタンが見つかりません",
        };
      }

      console.log(`[forrent] 登録ボタンクリック: ${regClicked}`);
      await confirmFrame.waitForTimeout(10000);

      // ── 登録完了確認 ──
      const finalFrame = page.frame({ name: "main" }) || confirmFrame;
      const result = await finalFrame.evaluate(() => {
        const body = document.body?.innerText || "";
        const scoreMatch = body.match(/名寄せスコア[：:\s]*(\d+)/);
        const isComplete = body.includes("完了") || body.includes("登録しました");
        return { isComplete, score: scoreMatch ? parseInt(scoreMatch[1]) : null, bodySnippet: body.slice(0, 200) };
      });

      const finalScore = result.score || validation.score;
      console.log(`[forrent] === REGISTER END === 登録完了 (score: ${finalScore}, complete: ${result.isComplete})`);
      await saveFrameArtifacts(page, finalFrame, artifactDir, "final");
      return {
        saved: true,
        registrationType: "掲載保留",
        score: finalScore,
        dialogs,
        errors: [],
      };
    }
  } catch (e) {
    console.log(`[forrent] 登録エラー: ${e.message}`);
    if (artifactDir) {
      try {
        const f = page.frame({ name: "main" });
        if (f) await saveFrameArtifacts(page, f, artifactDir, "exception");
      } catch {}
    }
    return { saved: false, registrationType: null, error: e.message };
  }
}

module.exports = {
  login,
  navigateToNewProperty,
  fillPropertyForm,
  fillTransportViaMap,
  fillTransportCascade,
  fillTransportRakuraku,
  fillTexts,
  uploadImages,
  fillTokucho,
  fillShuhenKankyo,
  registerProperty,
};
