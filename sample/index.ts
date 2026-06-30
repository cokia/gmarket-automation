import { GmarketCheckoutClient } from "./gmarket.js";
import type { CardInfo } from "./gmarket.js";
import * as fs from "fs";
import * as path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const CARD_TYPE: "personal" | "corporate" = "corporate";

const GMARKET_ID = "llde265";
const GMARKET_PW = "aass1122!!";

/** 상품코드: (SOOP) 별풍선교환권 100개 */
const ITEM_CODE = "4551232530";

const PROXY_URL = undefined; // "http://user:pass@host:port"

const TOKEN_FILE = path.join(import.meta.dirname || ".", ".gmarket-token.json");

const PERSONAL_CARD: CardInfo = {
  cardNumber: "4890230018010676",
  cvc: "111",
  pin: "111111",
  cardPassword: "1111",
};

const CORPORATE_CARD: CardInfo = {
  cardNumber: "5525764213631944",
  cvc: "029",
  pin: "150215",
};

// ─── Token & Device persistence ──────────────────────────────────────────────

interface SavedState {
  refreshToken?: string;
  exp?: number;
  saved?: string;
  device?: {
    duid: string;
    utdid: string;
    cguid: string;
    pcid: string;
    jaehuid: string;
    natIp: string;
    dguid: string;
    idfv: string;
  };
}

function loadState(): SavedState {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    return data;
  } catch {}
  return {};
}

function saveState(state: SavedState) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(state, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const proxyArg = process.argv.find((arg) => arg.startsWith("--proxy="));
  const proxyUrl = proxyArg ? proxyArg.slice("--proxy=".length) : PROXY_URL;
  const card = CARD_TYPE === "personal" ? PERSONAL_CARD : CORPORATE_CARD;

  const state = loadState();
  const savedToken = (state.refreshToken && state.exp && state.exp > Date.now()) ? state.refreshToken : undefined;
  const client = new GmarketCheckoutClient({
    refreshToken: savedToken,
    id: GMARKET_ID,
    pw: GMARKET_PW,
    proxyUrl,
    device: state.device,
  });

  try {
    console.log(
      `\n══════ ${CARD_TYPE === "personal" ? "개인카드" : "법인카드"} 테스트 ══════\n`,
    );
    console.log(`  proxy : ${proxyUrl || "(none)"}`);
    console.log(`  item  : ${ITEM_CODE}`);
    console.log(
      `  card  : ${card.cardNumber.substring(0, 4)}****${card.cardNumber.substring(12)}`,
    );
    console.log(
      `  token : ${savedToken ? "저장된 토큰 사용" : "새로 로그인"}\n`,
    );

    console.log("[1/5] OCR 엔진 초기화...");
    await client.init();

    if (!savedToken) {
      console.log("[2/5] 지마켓 로그인...");
      await client.login(GMARKET_ID, GMARKET_PW);
      const rt = client.getRefreshToken();
      if (rt) {
        const deviceInfo = client.getDeviceInfo();
        saveState({
          refreshToken: rt,
          exp: Date.now() + 11 * 30 * 24 * 60 * 60 * 1000,
          saved: new Date().toISOString(),
          device: deviceInfo,
        });
        console.log("  → refreshToken + device 저장 완료");
      }
    } else {
      console.log("[2/5] 저장된 토큰으로 자동로그인...");
    }

    console.log("[3/5] 장바구니 + 체크아웃...");
    const checkout = await client.checkout(ITEM_CODE, 1);
    console.log(`  → checkoutUnitId: ${checkout.checkoutUnitId}`);
    console.log(`  → totalAmount: ${checkout.totalAmount}`);
    console.log(`  → txKey: ${checkout.txKey}`);

    console.log("[4/5] 신한카드 결제 인증...");
    const mpiReturn = await client.payWithShinhan(card);
    console.log(`  → MPI keys: ${Object.keys(mpiReturn).join(", ")}`);

    console.log("[5/5] 주문 완료 + 결제 확인 + 선물코드 조회...");
    const result = await client.completePayment(card.cardNumber);
    console.log(`  → orderKey: ${result.orderKey}`);
    console.log(`  → paymentNo: ${result.paymentNo}`);
    console.log(`  → giftKey: ${result.giftKey}`);
    for (const ec of result.ecoupons) {
      console.log(`  → ${ec.couponServiceName}`);
      for (const pin of ec.pins) {
        console.log(`    PIN: ${pin.compCouponNo} (인증: ${pin.compAuthNo})`);
        console.log(`    상태: ${pin.state}`);
        console.log(
          `    유효기간: ${pin.expireStartDate} ~ ${pin.expireEndDate}`,
        );
      }
    }

    console.log("\n결과 요약:");
    console.log(JSON.stringify(result, null, 2));
    console.log("\n완료.\n");
  } catch (err: any) {
    console.error("\n에러:", err.message);
    if (err.response) {
      console.error("  Status:", err.response.status);
      console.error(
        "  Data:",
        JSON.stringify(err.response.data)?.substring(0, 300),
      );
    }
    if (err.stack)
      console.error("  Stack:", err.stack.split("\n").slice(1, 4).join("\n"));

    // 토큰 만료 시 삭제
    if (
      err.message?.includes("자동로그인 실패") ||
      err.message?.includes("update-token")
    ) {
      try {
        fs.unlinkSync(TOKEN_FILE);
      } catch {}
      console.error("  → 토큰 만료, 삭제됨. 다시 실행하면 로그인합니다.");
    }

    fs.writeFileSync(
      "error-dump.txt",
      typeof err.page === "string"
        ? err.page
        : err.message + "\n" + (err.stack || ""),
    );
    console.error("  (error-dump.txt 저장됨)");
  } finally {
    await client.destroy();
  }
}

main();

