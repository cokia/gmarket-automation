/**
 * batch-pay.ts
 *
 * CSV에서 계정/카드 정보를 읽어 자동 결제하는 배치 스크립트.
 *
 * 사용법:
 *   npx tsx batch-pay.ts                          # 기본: accounts.csv
 *   npx tsx batch-pay.ts --csv=my-accounts.csv    # 커스텀 CSV
 *   npx tsx batch-pay.ts --proxy=http://host:port # 프록시
 *   npx tsx batch-pay.ts --dry-run                # 실제 결제 안 함 (파싱만 확인)
 *
 * CSV 컬럼:
 *   gmarket_id, gmarket_pw, card_number, cvc, pin, card_password, card_type, item_code, quantity
 *
 * 결과: results/ 폴더에 JSON으로 저장
 */

import { GmarketCheckoutClient } from "./sample/gmarket.ts";
import type { CardInfo } from "./sample/gmarket.ts";
import * as fs from "fs";
import * as path from "path";

const __dirname = process.cwd();

// ─── CSV Parser (no external dep) ────────────────────────────────────────────

function parseCsv(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf8").trim();
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length < 2) throw new Error("CSV에 헤더와 최소 1행의 데이터가 필요합니다.");

  const headers = lines[0].split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim());
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || "";
    }
    rows.push(row);
  }
  return rows;
}

// ─── Token Cache ─────────────────────────────────────────────────────────────

const TOKEN_DIR = path.join(__dirname, ".tokens");

function loadToken(id: string): string | undefined {
  try {
    const file = path.join(TOKEN_DIR, `${id}.json`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.refreshToken && data.exp > Date.now()) return data.refreshToken;
  } catch {}
  return undefined;
}

function saveToken(id: string, refreshToken: string) {
  if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
  const exp = Date.now() + 11 * 30 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(
    path.join(TOKEN_DIR, `${id}.json`),
    JSON.stringify({ refreshToken, exp, saved: new Date().toISOString() }),
  );
}

// ─── Result Logger ───────────────────────────────────────────────────────────

const RESULT_DIR = path.join(__dirname, "results");

function saveResult(id: string, index: number, result: any) {
  if (!fs.existsSync(RESULT_DIR)) fs.mkdirSync(RESULT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(RESULT_DIR, `${ts}_${id}_${index}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}

// ─── Process Single Row ──────────────────────────────────────────────────────

interface RowResult {
  index: number;
  gmarket_id: string;
  item_code: string;
  success: boolean;
  orderKey?: string;
  paymentNo?: number;
  pins?: string[];
  error?: string;
  file?: string;
}

async function runCheckout(client: GmarketCheckoutClient, id: string, itemCode: string, card: CardInfo, index: number, seq: number): Promise<RowResult> {
  const tag = `[${index + 1}-${seq}]`;
  console.log(`  ${tag} 체크아웃 중...`);
  const checkout = await client.checkout(itemCode, 1);
  console.log(`  ${tag} → amount: ${checkout.totalAmount}`);

  console.log(`  ${tag} 카드 결제 인증 중...`);
  await client.payWithShinhan(card);

  console.log(`  ${tag} 주문 완료 중...`);
  const result = await client.completePayment(card.cardNumber);

  const pins = result.ecoupons.flatMap((ec) => ec.pins.map((p) => p.compAuthNo ? `${p.compCouponNo}/${p.compAuthNo}` : p.compCouponNo));
  console.log(`  ${tag} ✓ 성공! orderKey=${result.orderKey}, PIN=${pins.join(", ")}`);

  const file = saveResult(id, index, result);
  return { index, gmarket_id: id, item_code: itemCode, success: true, orderKey: result.orderKey, paymentNo: result.paymentNo, pins, file };
}

async function processRow(row: Record<string, string>, index: number, proxyUrl?: string, dryRun = false): Promise<RowResult[]> {
  const id = row.gmarket_id;
  const pw = row.gmarket_pw;
  const itemCode = row.item_code;
  const quantity = parseInt(row.quantity || "1", 10);
  const cardType = row.card_type || "corporate";
  const rowProxy = row.proxy ? (row.proxy.startsWith("http") ? row.proxy : `http://${row.proxy}`) : undefined;
  const effectiveProxy = rowProxy || proxyUrl;

  const card: CardInfo = {
    cardNumber: row.card_number,
    cvc: row.cvc,
    pin: row.pin,
    ...(cardType === "personal" ? { cardPassword: row.card_password } : {}),
  };

  console.log(`\n── [${index + 1}] ${id} | ${itemCode} x${quantity} | ${cardType} ──`);

  if (!id || !pw) {
    console.log("  ✗ 스킵: gmarket_id 또는 gmarket_pw 비어있음");
    return [{ index, gmarket_id: id, item_code: itemCode, success: false, error: "계정정보 누락" }];
  }

  if (dryRun) {
    console.log("  [DRY-RUN] 파싱 확인 완료, 결제 스킵");
    return [{ index, gmarket_id: id, item_code: itemCode, success: true }];
  }

  const savedToken = loadToken(id);
  const client = new GmarketCheckoutClient({
    refreshToken: savedToken,
    id,
    pw,
    proxyUrl: effectiveProxy,
  });

  const results: RowResult[] = [];

  try {
    if (savedToken) {
      try {
        console.log("  저장된 토큰으로 자동로그인...");
        await client.init();
      } catch {
        console.log("  토큰 만료, 재로그인 중...");
        try { fs.unlinkSync(path.join(TOKEN_DIR, `${id}.json`)); } catch {}
        const freshClient = new GmarketCheckoutClient({ id, pw, proxyUrl: effectiveProxy });
        await freshClient.init();
        await freshClient.login(id, pw);
        const rt = freshClient.getRefreshToken();
        if (rt) saveToken(id, rt);

        for (let seq = 1; seq <= quantity; seq++) {
          try {
            results.push(await runCheckout(freshClient, id, itemCode, card, index, seq));
          } catch (err: any) {
            console.error(`  [${index + 1}-${seq}] ✗ 실패: ${err.message}`);
            results.push({ index, gmarket_id: id, item_code: itemCode, success: false, error: err.message });
          }
        }
        await freshClient.destroy();
        return results;
      }
    } else {
      await client.init();
      console.log("  로그인 중...");
      await client.login(id, pw);
      const rt = client.getRefreshToken();
      if (rt) saveToken(id, rt);
    }

    for (let seq = 1; seq <= quantity; seq++) {
      try {
        results.push(await runCheckout(client, id, itemCode, card, index, seq));
      } catch (err: any) {
        console.error(`  [${index + 1}-${seq}] ✗ 실패: ${err.message}`);
        results.push({ index, gmarket_id: id, item_code: itemCode, success: false, error: err.message });
      }
    }
    return results;
  } catch (err: any) {
    console.error(`  ✗ 실패: ${err.message}`);

    if (err.message?.includes("자동로그인 실패")) {
      try { fs.unlinkSync(path.join(TOKEN_DIR, `${id}.json`)); } catch {}
      console.error("    → 토큰 만료, 삭제됨");
    }

    return [{ index, gmarket_id: id, item_code: itemCode, success: false, error: err.message }];
  } finally {
    await client.destroy();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const csvArg = args.find((a) => a.startsWith("--csv="));
  const proxyArg = args.find((a) => a.startsWith("--proxy="));
  const dryRun = args.includes("--dry-run");

  const csvFile = csvArg ? csvArg.slice("--csv=".length) : path.join(__dirname, "accounts.csv");
  const proxyUrl = proxyArg ? proxyArg.slice("--proxy=".length) : undefined;

  if (!fs.existsSync(csvFile)) {
    console.error(`CSV 파일을 찾을 수 없습니다: ${csvFile}`);
    process.exit(1);
  }

  const rows = parseCsv(csvFile);
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  Gmarket 배치 결제`);
  console.log(`  CSV: ${csvFile} (${rows.length}건)`);
  console.log(`  Proxy: ${proxyUrl || "(none)"}`);
  console.log(`  Mode: ${dryRun ? "DRY-RUN" : "LIVE"}`);
  console.log(`  Concurrency: ${rows.length} (전체 병렬)`);
  console.log(`═══════════════════════════════════════════\n`);

  const nested = await Promise.all(
    rows.map((row, i) => processRow(row, i, proxyUrl, dryRun))
  );
  const results: RowResult[] = nested.flat();

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  결과 요약`);
  console.log(`═══════════════════════════════════════════`);
  const success = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  console.log(`  성공: ${success.length}건`);
  console.log(`  실패: ${failed.length}건`);

  for (const r of success) {
    console.log(`    ✓ [${r.index + 1}] ${r.gmarket_id} → ${r.pins?.join(", ") || r.orderKey || "OK"}`);
  }
  for (const r of failed) {
    console.log(`    ✗ [${r.index + 1}] ${r.gmarket_id} → ${r.error}`);
  }

  if (!dryRun && results.length > 0) {
    const summaryFile = path.join(RESULT_DIR, `summary_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    if (!fs.existsSync(RESULT_DIR)) fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(summaryFile, JSON.stringify(results, null, 2));
    console.log(`\n  전체 결과: ${summaryFile}`);
  }

  console.log("");
}

main();
