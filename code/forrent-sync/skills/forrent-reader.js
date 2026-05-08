/**
 * forrent-reader.js — forrent.jp 読み取り専用スキル
 *
 * 掲載管理ページから物件データを読み取る関数群。
 * forrent.js (書き込み系) とは分離し、スクレイピング専用。
 */

// score-checker is no longer needed — score is extracted from page text

// ══════════════════════════════════════════════════════════
//  LIST PAGE: 一覧ページから物件リストを取得
// ══════════════════════════════════════════════════════════

/**
 * 掲載管理の一覧ページへ遷移し、表示件数を最大化する。
 * 前提: ログイン済み。
 *
 * @param {import('playwright').Page} page
 * @returns {import('playwright').Frame} mainFrame
 */
async function navigateToListPage(page) {
  const naviFrame = page.frame({ name: "navi" });
  if (!naviFrame) throw new Error("Navi frame not found");
  await naviFrame.click("#menu_3");
  await page.waitForTimeout(5000);

  let mainFrame = page.frame({ name: "main" });
  if (!mainFrame) throw new Error("Main frame not found after menu_3");

  // 全物件検索 (フィルタなし)
  await mainFrame.evaluate(() => {
    const form = document.querySelector("form[name='searchForm']") || document.querySelector("form");
    if (form) form.submit();
  });
  await page.waitForTimeout(8000);

  mainFrame = page.frame({ name: "main" });

  // 表示件数を200件に切り替え (ページング回避)
  const switched = await mainFrame.evaluate(() => {
    const links = document.querySelectorAll("a");
    for (const a of links) {
      if (a.textContent.includes("200件ずつ")) {
        a.click();
        return true;
      }
    }
    return false;
  });

  if (switched) {
    await page.waitForTimeout(8000);
    mainFrame = page.frame({ name: "main" });
  }

  return mainFrame;
}

/**
 * ページネーション: 次のページへ遷移する。
 * @returns {boolean} 次のページがあったか
 */
async function goToNextPage(page, mainFrame) {
  const hasNext = await mainFrame.evaluate(() => {
    const links = document.querySelectorAll("a");
    for (const a of links) {
      if (a.textContent.includes("次の")) {
        a.click();
        return true;
      }
    }
    return false;
  });
  if (hasNext) {
    await page.waitForTimeout(8000);
  }
  return hasNext;
}

/**
 * 一覧ページから全物件のサマリデータを抽出する (Tier 1)。
 *
 * forrent.jp の一覧テーブル構造 (discover-list-page.js で確認済み):
 *   列0:  チェックボックス等
 *   列1:  沿線/駅 住所
 *   列2:  交通数
 *   列3:  物件名 部屋番号
 *   列4:  賃料 管理 敷金 礼金
 *   列5:  タイプ 面積 建物 入居
 *   列6:  取引態様
 *   列7:  間取/外観/内観 + 名寄せスコア (e.g., "1941" → 画像19 + 名寄せ41)
 *   列10: 詳細PV/日
 *   列11: 掲載指示状況
 *   列12: 掲載終了日
 *   列14: 詳細リンク (href="javascript:dispChangeShousai(..., bukkenCd, ...)")
 *         + hidden input with bukkenCd
 *
 * @param {import('playwright').Frame} mainFrame
 * @returns {{properties: Array, total: number}}
 */
async function parseListPage(mainFrame) {
  return mainFrame.evaluate(() => {
    const properties = [];

    // Find all links containing dispChangeShousai
    const allLinks = document.querySelectorAll("a[href*='dispChangeShousai']");
    for (const link of allLinks) {
      const href = link.getAttribute("href") || "";
      const m = href.match(/dispChangeShousai\s*\(\s*'([^']*)'\s*,\s*'(\d+)'/);
      if (!m) continue;
      const bukkenCd = m[2];

      // Walk up to find the table row
      const tr = link.closest("tr");
      if (!tr) continue;

      const cells = Array.from(tr.querySelectorAll("td"));
      const getText = (idx) => cells[idx]?.textContent?.trim().replace(/\s+/g, " ") || "";

      // Parse individual fields from cells
      const col1 = getText(1); // 沿線/駅 住所
      const col3 = getText(3); // 物件名 部屋番号
      const col4 = getText(4); // 賃料 管理 敷金 礼金
      const col5 = getText(5); // タイプ 面積 建物 入居
      const col7 = getText(7); // 名寄せスコア (last 2 digits)
      const col10 = getText(10); // PV
      const col11 = getText(11); // 掲載指示状況
      const col12 = getText(12); // 掲載終了日

      // Parse rent + 敷金/礼金(ヶ月): "33.5万円2.5万円1ヶ月1ヶ月" → rent=33.5, shikikin=1, reikin=1
      const rentMatch = col4.match(/([\d.]+)万円/);
      const rent = rentMatch ? parseFloat(rentMatch[1]) : null;
      const tsukiMatches = [...col4.matchAll(/([\d.]+)ヶ月/g)];
      const shikikinMonths = tsukiMatches[0] ? parseFloat(tsukiMatches[0][1]) : null;
      const reikinMonths = tsukiMatches[1] ? parseFloat(tsukiMatches[1][1]) : null;

      // Parse layout + area: "1LDK50.05m2マンション相談"
      const layoutMatch = col5.match(/^([\d]*[A-Za-z\uFF21-\uFF3A]+)/);
      const layout = layoutMatch ? layoutMatch[1] : "";
      const areaMatch = col5.match(/([\d.]+)m2/);
      const area = areaMatch ? parseFloat(areaMatch[1]) : null;

      // 名寄せスコア: col7 の末尾数字列の下2桁 (0-43)
      // e.g., "1941" → 画像19 + 名寄せ41 → 41 が score
      const scoreNums = col7.match(/(\d+)/g);
      let nayoseScore = null;
      if (scoreNums && scoreNums.length > 0) {
        const lastNum = scoreNums[scoreNums.length - 1];
        nayoseScore = lastNum.length >= 2
          ? parseInt(lastNum.slice(-2))
          : parseInt(lastNum);
      }

      // Parse station from col1: "東京メトロ半蔵門線/半蔵門千代田区一番町"
      const station = col1;

      // 掲載指示状況 → ステータス推定
      const isPublished = col11.includes("ネット");

      // PV: "0.81効果分析―――" → 0.8
      const pvMatch = col10.match(/([\d.]+)/);
      const pvPerDay = pvMatch ? parseFloat(pvMatch[1]) : 0;

      // 掲載終了日 → ISO YYYY-MM-DD (Notion date compat)
      // forrent は "YY/MM/DD" (2桁年、西暦下2桁) で表示: "26/04/21" → 2026-04-21
      const endMatch = col12.match(/(\d{2,4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
      let endDate = null;
      if (endMatch) {
        const y = endMatch[1].length === 2 ? `20${endMatch[1]}` : endMatch[1];
        endDate = `${y}-${String(endMatch[2]).padStart(2, "0")}-${String(endMatch[3]).padStart(2, "0")}`;
      }

      properties.push({
        bukkenCd,
        name: col3,
        rent,
        layout,
        area,
        nayoseScore,
        station,
        isPublished,
        pvPerDay,
        listingEnd: col12,
        endDate,
        shikikinMonths,
        reikinMonths,
        rawCells: { col1, col3, col4, col5, col7, col10, col11, col12 },
      });
    }

    // Pagination info
    const body = document.body.innerText;
    const totalMatch = body.match(/(\d+)件該当/);
    const total = totalMatch ? parseInt(totalMatch[1]) : properties.length;

    return { properties, total };
  });
}

// ══════════════════════════════════════════════════════════
//  DETAIL PAGE: 個別物件の詳細データを取得 (Tier 2)
// ══════════════════════════════════════════════════════════

/**
 * 掲載管理の検索で物件コードを指定して1件だけ表示し、
 * 詳細→修正フォームまで遷移する。
 *
 * 一覧ページに全物件をロード→dispChangeShousai方式だと
 * 毎回ページネーション（5ページ×8秒 = 40秒）が必要になる。
 * 代わりに #menu_3 → 物件コード検索 → 1件表示 → 詳細 → 修正
 * とすると1件あたり ~15秒で済む。
 *
 * @param {import('playwright').Page} page
 * @param {string} bukkenCd - 物件コード
 * @returns {import('playwright').Frame} mainFrame (修正フォーム)
 */
async function navigateToDetail(page, _mainFrame, bukkenCd) {
  // 掲載管理へ遷移
  const naviFrame = page.frame({ name: "navi" });
  if (!naviFrame) throw new Error("Navi frame not found");
  await naviFrame.click("#menu_3");
  await page.waitForTimeout(4000);

  let mainFrame = page.frame({ name: "main" });

  // 物件コードで検索 (bukkenCd フィールドに入力してsubmit)
  await mainFrame.evaluate((cd) => {
    // 物件コード入力欄を探す
    const inputs = document.querySelectorAll("input[type='text']");
    for (const input of inputs) {
      const name = input.name || "";
      const tr = input.closest("tr");
      const label = tr?.querySelector("th, td")?.textContent || "";
      if (name.includes("bukkenCd") || label.includes("物件コード")) {
        input.value = cd;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
    }
    const form = document.querySelector("form[name='searchForm']") || document.querySelector("form");
    if (form) form.submit();
  }, bukkenCd);
  await page.waitForTimeout(6000);

  mainFrame = page.frame({ name: "main" });

  // 検索結果から詳細リンクをクリック
  const clicked = await mainFrame.evaluate((cd) => {
    // 方法1: dispChangeShousai リンクを探す
    const links = document.querySelectorAll("a[href*='dispChangeShousai']");
    for (const link of links) {
      if (link.href.includes(cd)) {
        link.click();
        return "link";
      }
    }
    // 方法2: dispChangeShousai が存在すれば直接呼ぶ
    if (typeof dispChangeShousai === "function") {
      dispChangeShousai("UPD1R3100.action", cd, "0", Date.now().toString(), 0);
      return "direct";
    }
    return null;
  }, bukkenCd);

  if (!clicked) throw new Error(`物件 ${bukkenCd} の詳細リンクが見つかりません`);
  await page.waitForTimeout(6000);

  mainFrame = page.frame({ name: "main" });

  // UPD1R3100 は詳細表示ページ。ここに名寄せスコア・物件コード等が表示される。
  // 修正ボタン(UPD1R3200)をクリックすると編集フォームに入るが、
  // 地図修正ポップアップが出るため、修正ボタンは押さない。
  // 詳細ページのテキストからデータを抽出する。

  // ポップアップ/オーバーレイが出ている場合は閉じる
  await dismissPopups(page, mainFrame);

  return mainFrame;
}

/**
 * ポップアップ/オーバーレイを閉じる。
 * forrent.jp は地図修正等のポップアップを出すことがある。
 */
async function dismissPopups(page, mainFrame) {
  // 1. HTML overlay の閉じるボタンを探す
  await mainFrame.evaluate(() => {
    const closeButtons = document.querySelectorAll(
      '[class*="close"], [id*="close"], [onclick*="close"], [onclick*="Close"], ' +
      'button[title="閉じる"], a[title="閉じる"], .modal-close, .popup-close'
    );
    for (const btn of closeButtons) {
      if (btn.offsetParent !== null) { // visible
        btn.click();
      }
    }
    // 2. overlay/modal 背景をクリック
    const overlays = document.querySelectorAll('.overlay, .modal-backdrop, [class*="overlay"]');
    for (const o of overlays) {
      if (o.offsetParent !== null) o.click();
    }
  }).catch(() => {});

  // 3. 新しいウィンドウ/ポップアップが開いていたら閉じる
  const pages = page.context().pages();
  for (const p of pages) {
    if (p !== page && p.url() !== "about:blank") {
      await p.close().catch(() => {});
    }
  }
}

/**
 * 詳細ページ（UPD1R3100）からデータを抽出する。
 * 修正フォーム（UPD1R3200）には入らず、詳細ページのフォーム値とテキストから
 * ハイブリッドで取得する。
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Frame} mainFrame
 * @returns {object} 抽出データ
 */
async function extractPropertyDetail(page, mainFrame) {
  return mainFrame.evaluate(() => {
    const data = {};
    const body = document.body.innerText || "";

    // Helper: get input value by selector
    const getVal = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.value?.trim() || "" : "";
    };

    // 貴社物件コード — form input or text
    data.kishaCode = getVal('[name*="kishaBukkenCd1"]');
    if (!data.kishaCode) {
      const m = body.match(/貴社物件コード[：:\s]*([^\s\n]+)/);
      data.kishaCode = m ? m[1].trim() : "";
    }

    // 物件名
    data.bukkenName = getVal("#bukkenNm");
    if (!data.bukkenName) {
      const m = body.match(/物件名[※]?\s*\n?\s*([^\n]{2,50})/);
      data.bukkenName = m ? m[1].trim() : "";
    }

    // 部屋番号
    data.roomNo = getVal("#heyaNoInput");

    // 掲載ステータス
    const statusEl = document.getElementById("shijiIsize");
    if (statusEl) {
      data.listingStatus = statusEl.value === "1" ? "掲載中" : statusEl.value === "3" ? "保留" : null;
    } else {
      data.listingStatus = body.includes("掲載中") ? "掲載中" : null;
    }

    // 賃料
    const man = document.querySelector('[name*="chinryo1"]');
    const sen = document.querySelector('[name*="chinryo2"]');
    if (man) {
      data.rent = parseFloat(man.value || "0") + parseFloat(sen?.value || "0") / 10;
    } else {
      const rm = body.match(/賃料[：:\s]*([\d.]+)万/);
      data.rent = rm ? parseFloat(rm[1]) : null;
    }

    // 間取り
    const rooms = document.getElementById("heyaCntInput");
    const typeEl = document.querySelector('[name*="madoriTypeKbnCd"]');
    if (typeEl) {
      const typeMap = {
        "01": "ワンルーム", "02": "K", "03": "DK", "04": "SDK",
        "05": "LDK", "06": "SLDK", "07": "LK", "08": "SK", "09": "SLK",
      };
      const typeName = typeMap[typeEl.value] || typeEl.value;
      data.layout = typeName === "ワンルーム" ? "ワンルーム" : `${rooms?.value || ""}${typeName}`;
    } else {
      data.layout = "";
    }

    // 面積
    const intEl = document.getElementById("mensekiIntegerInput");
    const decEl = document.getElementById("mensekiDecimalInput");
    if (intEl) {
      data.area = parseInt(intEl.value || "0") + parseInt(decEl?.value || "0") / 100;
    } else {
      data.area = null;
    }

    // 最寄駅
    const stationEl = document.querySelector('[name*="ekimei1"]') || document.querySelector('[id*="ekimei"]');
    data.station = stationEl ? stationEl.value?.trim() || "" : "";

    // 築年
    const yearEl = document.getElementById("Wareki2Seireki1");
    data.buildYear = yearEl ? parseInt(yearEl.value) || null : null;

    // 名寄せスコア — テキストから抽出
    const scoreMatch = body.match(/名寄せスコア\s*(\d+)/);
    data.nayoseScore = scoreMatch ? parseInt(scoreMatch[1]) : 0;

    // 画像 — file inputの画像チェック
    let imageCount = 0;
    const fileInputs = document.querySelectorAll("input[type='file']");
    for (const fi of fileInputs) {
      const tr = fi.closest("tr");
      if (!tr) continue;
      const imgs = [...tr.querySelectorAll("img")].filter(
        img => img.src && !img.src.includes("btn_") && !img.src.includes("icon_") &&
               !img.src.includes("spacer") && img.naturalWidth > 30
      );
      if (imgs.length > 0) imageCount++;
    }
    data.imageCount = imageCount;

    // テキスト入力状況
    const textFields = [
      { key: "bukkenCatch", selector: '[name*="bukkenCatch"], #bukkenCatch' },
      { key: "netCatch", selector: '[name*="netCatch"], #netCatch' },
      { key: "netFreeMemo", selector: '[name*="netFreeMemo"], #netFreeMemo' },
      { key: "freeMemo", selector: '[name*="freeMemo"], #freeMemo' },
    ];
    data.filledTexts = [];
    for (const f of textFields) {
      const el = document.querySelector(f.selector);
      if (el && el.value && el.value.trim().length > 0) {
        data.filledTexts.push(f.key);
      }
    }

    return data;
  });
}

/**
 * 画像スロットの充填数をカウントする。
 *
 * @param {import('playwright').Frame} mainFrame
 * @returns {number}
 */
async function countFilledImages(mainFrame) {
  return mainFrame.evaluate(() => {
    let count = 0;
    const fileInputs = document.querySelectorAll("input[type='file']");
    for (const fi of fileInputs) {
      const tr = fi.closest("tr");
      if (!tr) continue;
      const imgs = [...tr.querySelectorAll("img")].filter(
        img => img.src && !img.src.includes("btn_") && !img.src.includes("icon_") &&
               !img.src.includes("spacer") && img.naturalWidth > 30
      );
      if (imgs.length > 0) count++;
    }
    return count;
  });
}

/**
 * テキストフィールドの入力有無を確認する。
 *
 * @param {import('playwright').Frame} mainFrame
 * @returns {string[]} 入力済みフィールド名の配列
 */
async function checkTextFields(mainFrame) {
  return mainFrame.evaluate(() => {
    const fields = [
      { key: "bukkenCatch", selector: '[name*="bukkenCatch"], #bukkenCatch' },
      { key: "netCatch", selector: '[name*="netCatch"], #netCatch' },
      { key: "netFreeMemo", selector: '[name*="netFreeMemo"], #netFreeMemo' },
      { key: "freeMemo", selector: '[name*="freeMemo"], #freeMemo' },
    ];
    const filled = [];
    for (const f of fields) {
      const el = document.querySelector(f.selector);
      if (el && el.value && el.value.trim().length > 0) {
        filled.push(f.key);
      }
    }
    return filled;
  });
}

module.exports = {
  navigateToListPage,
  goToNextPage,
  parseListPage,
  navigateToDetail,
  extractPropertyDetail,
  dismissPopups,
};
