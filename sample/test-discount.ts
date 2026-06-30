import { GmarketCheckoutClient } from "./gmarket.js";

const GMARKET_ID = "sky90want";
const GMARKET_PW = "sky90want";
const ITEM_CODE = "4787826157";

async function main() {
  const client = new GmarketCheckoutClient({ id: GMARKET_ID, pw: GMARKET_PW });

  try {
    console.log("[1] OCR 엔진 초기화...");
    await client.init();

    console.log("[2] 로그인...");
    await client.login(GMARKET_ID, GMARKET_PW);

    console.log("[3] 체크아웃 생성...");
    const checkout = await client.checkout(ITEM_CODE, 1);
    console.log(`  원가(totalAmount): ${checkout.totalAmount}원`);
    console.log(`  checkoutUnitId: ${checkout.checkoutUnitId}`);
    console.log(`  txKey: ${checkout.txKey}`);

    console.log("[4] 할인 조회 (getAvailableDiscount)...");
    const c = client as any;
    const base = "https://checkout.gmarket.co.kr/server/ko/m/api";
    const h = c.webviewHeaders({ "Referer": `https://checkout.gmarket.co.kr/ko/m/checkout?chid=${c.checkoutUnitId}&txKey=${c.txKey}` });

    const unit = c.checkoutData?.checkoutUnits?.[0];
    const seller = unit?.seller;
    const item = unit?.item;
    const member = c.checkoutData?.member;

    const discountRes = await c.httpPost(`${base}/discount/getAvailableDiscount`, {
      buyerGrade: String(member?.buyerGrade || "50"),
      requests: [{
        checkoutUnitId: c.checkoutUnitId,
        itemNo: String(unit?.itemNo || ""),
        itemPrice: unit?.itemPrice || 0,
        optionsAdditionalPrice: 0,
        additionsTotalAmount: 0,
        branchAdditionalPrice: 0,
        partnershipCode: null,
        quantity: unit?.quantity || 1,
        sellerKey: seller?.sellerKey || "",
        shopKindCode1: "P",
        shopKindCode2: " ",
        shopKindCode3: " ",
        smallCategoryCode: item?.smallCategoryCode || "",
        used: false,
        gift: false,
      }],
    }, h);

    const discountData = discountRes.data?.data;
    const discounts = Array.isArray(discountData) ? discountData[0]?.discounts || [] : [];
    const discountPrice = discounts.reduce((sum: number, d: any) => sum + (d.discountPrice || 0), 0);

    console.log("\n=== 할인 결과 ===");
    console.log(`  상품 원가: ${unit?.itemPrice}원`);
    console.log(`  할인 총액: ${discountPrice}원`);
    console.log(`  실결제액:  ${(unit?.itemPrice || 0) - discountPrice}원`);
    console.log(`  할인 목록:`);
    for (const d of discounts) {
      console.log(`    - [${d.discountType}] policyNo=${d.discountPolicyNo}, ${d.discountPrice}원`);
    }

    console.log("\n[5] 추가 할인 조회 (getAvailableExtraDiscount)...");
    const extraRes = await c.httpPost(
      "https://checkout.gmarket.co.kr/server/ko/pc/api/discount/getAvailableExtraDiscount",
      [{
        checkoutUnitId: c.checkoutUnitId,
        itemNo: String(unit?.itemNo || ""),
        largeCategoryCode: item?.largeCategoryCode || "",
        mediumCategoryCode: item?.mediumCategoryCode || "",
        smallCategoryCode: item?.smallCategoryCode || "",
        sellerKey: seller?.sellerKey || "",
        partnershipCode: null,
        paymentAmount: (unit?.itemPrice || 0) - discountPrice,
        oldCouponIssueNos: [],
        giftOrder: false,
      }],
      h,
    );

    console.log("\n=== 추가 할인 결과 ===");
    console.log(JSON.stringify(extraRes.data, null, 2));

    console.log("\n완료.");
  } catch (err: any) {
    console.error("\n에러:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", JSON.stringify(err.response.data)?.substring(0, 500));
    }
  } finally {
    await client.destroy();
  }
}

main();
