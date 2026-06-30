# Gmarket E쿠폰 자동 구매

순수 HTTP 기반 Gmarket 모바일 앱 결제 자동화. 브라우저 없음.

## 파일

- `src/gmarket.ts` — 클라이언트
- `src/test.ts` — 실행 예시

## 설치

```bash
npm install
```

의존성: `axios`, `axios-cookiejar-support`, `tough-cookie`, `node-forge`, `sharp`, `tsx`

## 실행

```bash
npx tsx src/test.ts
```

## 사용법

```typescript
import { GmarketCheckoutClient } from "./gmarket.ts";

const client = new GmarketCheckoutClient({
  id: "지마켓ID",
  pw: "비밀번호",
  // refreshToken: "저장된토큰",  // 있으면 login() 스킵
  // device: { ... }              // 없으면 랜덤 생성
});

await client.init();

// 첫 실행 시 로그인 (refreshToken 없을 때)
await client.login("지마켓ID", "비밀번호");

// refreshToken 저장 (1년 유효)
const rt = client.getRefreshToken();
// 디바이스 정보 저장 (재사용)
const dev = client.getDeviceInfo();

// 구매
const checkout = await client.checkout("상품코드", 1);

// 결제 (신한카드)
const mpi = await client.payWithShinhan({
  cardNumber: "카드번호16자리",
  cvc: "CVC",
  pin: "법인카드PIN",        // 법인카드
  // cardPassword: "비밀번호앞2자리",  // 개인카드
});

// 주문 완료 + E쿠폰 PIN 조회
const result = await client.completePayment("카드번호16자리");
console.log(result.ecoupons[0].pins[0].compCouponNo);  // PIN 코드
console.log(result.ecoupons[0].pins[0].compAuthNo);    // 인증번호

await client.destroy();
```

## 옵션

```typescript
interface GmarketCheckoutOptions {
  refreshToken?: string;  // 저장된 토큰 (있으면 login() 불필요)
  id?: string;            // 지마켓 ID (자동로그인 쿠키 획득용)
  pw?: string;            // 비밀번호
  proxyUrl?: string;      // HTTP 프록시
  device?: {
    duid?: string;        // 디바이스 UUID
    utdid?: string;       // UT 디바이스 ID (24자)
    cguid?: string;       // 26자리
    pcid?: string;        // 14자리
    jaehuid?: string;     // 계정 고유 ID (로그인 시 자동 설정)
    natIp?: string;       // 공인 IP (비워두면 서버 자동 감지)
    dguid?: string;       // 내부 트래킹 ID
    idfv?: string;        // iOS identifierForVendor
  };
}
```

## 플로우

1. `login()` — ATO face 인증 + refreshToken 획득
2. `init()` — refreshToken으로 자동로그인 (저장된 토큰 사용 시)
3. `checkout(itemCode)` — add-checkout + getCheckout
4. `payWithShinhan(card)` — 할인 조회 + FDS + KCP MPI + 신한카드 VBV 키패드
5. `completePayment(cardNumber)` — result_smart + mpi/return + setOrders + addOrder + getEcouponInfo

## 토큰 재사용

refreshToken은 1년 유효. 첫 로그인 후 저장하고 재사용:

```typescript
// 첫 실행
const client = new GmarketCheckoutClient({ id: "ID", pw: "PW" });
await client.init();
await client.login("ID", "PW");
const rt = client.getRefreshToken();  // 저장
const dev = client.getDeviceInfo();   // 저장

// 이후 실행
const client = new GmarketCheckoutClient({ id: "ID", pw: "PW", refreshToken: rt, device: dev });
await client.init();  // 자동로그인
```

## 키패드 해시

신한카드 VBV 키패드는 OCR 대신 픽셀 해시 매칭으로 풀림. 해시가 맞지 않으면 (키패드 이미지 변경 시) `KEYPAD_DIGIT_HASHES`를 업데이트해야 함.

