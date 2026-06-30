/**
 * GmarketMobileCheckoutClient
 *
 * mitm_app/app01 기반 Gmarket 모바일 앱 결제 + 선물코드 자동화.
 * 순수 HTTP 기반 (camoufox/브라우저 없음).
 *
 * 플로우:
 * 1. spacegate create-token → signinssl loginProc → stargate get-login-cookie
 * 2. checkout.gmarket.co.kr/server/ko/m/api/* (setOrders, getCheckout, etc)
 * 3. MPI prepare → 신한카드 VBV (NPPFS 키패드 OCR)
 * 4. addOrder → poll → afterPayment → getOrders → getEcouponInfo
 */

import * as crypto from "crypto";
import forge from "node-forge";
import sharp from "sharp";

const APP_API_KEY = "610e2d2071015ec7ff27371e7feb6368";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CardInfo {
  cardNumber: string;
  cvc: string;
  pin: string;
  cardPassword?: string;
}

export interface CheckoutResult {
  checkoutUnitId: number;
  totalAmount: number;
  txKey: string;
}

export interface EcouponPin {
  compCouponNo: string;
  compAuthNo: string;
  state: string;
  expireStartDate: string;
  expireEndDate: string;
}

export interface EcouponResult {
  contrNo: number;
  orderNo: number;
  couponServiceName: string;
  pins: EcouponPin[];
}

export interface OrderResult {
  orderKey: string;
  paymentNo: number;
  giftKey: string;
  hashedPaymentNo: string;
  ecoupons: EcouponResult[];
}

export interface GmarketCheckoutOptions {
  /** refreshToken이 있으면 login() 없이 자동로그인 */
  refreshToken?: string;
  /** 자동로그인 시 쿠키 획득용 (refreshToken 사용 시 필요) */
  id?: string;
  pw?: string;
  proxyUrl?: string;
  /** 디바이스 식별자 (앱 설치 시 고정되는 값) */
  device?: {
    duid?: string;       // 디바이스 UUID (예: 3C954DAA-5F11-4512-9795-8615F0DDEBF1)
    utdid?: string;      // UT 디바이스 ID (예: agwIcEGExTUDAIINrxaXEzT1)
    cguid?: string;      // 26자리 (예: 11574484349315006132000000)
    pcid?: string;       // (예: 41735553499231)
    jaehuid?: string;    // (예: 200003765)
    natIp?: string;      // 공인 IP (예: 1.209.169.130)
    dguid?: string;      // (예: 21I408282071039545)
    idfv?: string;       // iOS identifierForVendor (예: D48B4B22-8DE4-4054-B077-F20084B958FF)
  };
}

// ─── NPPFS Crypto ────────────────────────────────────────────────────────────

function bytesToHex(b: number[]): string {
  return b.map((x) => (x < 16 ? "0" : "") + x.toString(16)).join("");
}
function hexToBytes(h: string): number[] {
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length % 2) h += "0";
  const r: number[] = [];
  for (let i = 0; i < h.length; i += 2) r.push(parseInt(h.slice(i, i + 2), 16));
  return r;
}
function hexToStr(h: string): string {
  return hexToBytes(h).map((b) => String.fromCharCode(b)).join("");
}
function strToBytes(s: string): number[] {
  return Array.from(s).map((c) => c.charCodeAt(0) & 0xff);
}
function pad16(d: number[]): number[] {
  const r = [...d];
  const p = 16 - (r.length % 16);
  if (p > 0 && p < 16) for (let i = 0; i < p; i++) r.push(0);
  return r;
}
function aesEnc(pt: string, key: string): number[] {
  const kb = strToBytes(key);
  const algo = kb.length === 32 ? "aes-256-ecb" : "aes-128-ecb";
  const c = crypto.createCipheriv(algo, Buffer.from(kb), null);
  c.setAutoPadding(false);
  return Array.from(Buffer.concat([c.update(Buffer.from(pad16(strToBytes(pt)))), c.final()]));
}
function aesDec(ct: number[], key: string): number[] {
  const kb = strToBytes(key);
  const algo = kb.length === 32 ? "aes-256-ecb" : "aes-128-ecb";
  const d = crypto.createDecipheriv(algo, Buffer.from(kb), null);
  d.setAutoPadding(false);
  const r = Array.from(Buffer.concat([d.update(Buffer.from(ct)), d.final()]));
  while (r.length > 0 && r[r.length - 1] === 0) r.pop();
  return r;
}
function procKeyResp(hex: string): string {
  const t = hex.trim();
  if (t.length <= 64) throw new Error("Key too short");
  return aesDec(hexToBytes(t.substring(64)), hexToStr(t.substring(0, 64))).map((b) => String.fromCharCode(b)).join("").trim();
}
function parsePubKey(pem: string) {
  const body = pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").trim();
  const pk = forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(forge.util.decode64(body))) as forge.pki.rsa.PublicKey;
  return { mod: pk.n.toString(16), exp: pk.e.toString(16) };
}
function rsaEnc(pt: string, mod: string, exp: string): string {
  const k = forge.pki.setRsaPublicKey(new forge.jsbn.BigInteger(mod, 16), new forge.jsbn.BigInteger(exp, 16));
  return forge.util.bytesToHex(k.encrypt(pt, "RSAES-PKCS1-V1_5"));
}

class Nppfs {
  uuid = ""; key = ""; rsa = "";
  genUuid() { this.uuid = Date.now() + "" + Math.floor(Math.random() * 89 + 10); return this.uuid; }
  initKey(resp: string) { const pk = parsePubKey(procKeyResp(resp)); this.key = bytesToHex(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))); this.rsa = rsaEnc(this.key, pk.mod, pk.exp); }
  enc(ch: string) { return bytesToHex(aesEnc(ch, hexToStr(this.key))); }
  encInput(val: string, map: Record<string, string>) { let r = ""; for (const c of val) { const a = map[c]; if (!a) throw new Error(`'${c}' not in keypad`); r += this.enc(a); } return r; }
}

// ─── Keypad Solver ───────────────────────────────────────────────────────────

// NPPFS 키패드 숫자 해시 (신한카드 VBV, greyscale raw 34x34)
// 키패드 렌더링이 세션마다 다를 수 있으므로 동적으로 학습
const KEYPAD_DIGIT_HASHES: Record<string, string> = {
  "9fbc6c8430fd4d91b4834b1507ed924f": "0",
  "b3b7d194bdd907876ae0047e291126c1": "1",
  "9cd35703441d6f60318e37997e9c15fb": "2",
  "c6896430e89065baef3cb65c7046925b": "3",
  "c8f1a757b59b1a1f9086b86272f37040": "4",
  "addd1f57ae45c807ce5115137b1384e6": "5",
  "2847ed7aadbc8935487cb50421bb803d": "6",
  "68ace070b6a9a38d57bc15a0d5568146": "7",
  "17a1f762989c5eb146f45dfb56588ad2": "8",
  "ca6c86ff20a109f84433d5da4a5a09e0": "9",
};

async function solveKp(img: Buffer, coords: any, btns: any[]): Promise<Record<string, string>> {
  const { sx, sy, bw, bh, mx, my, count } = coords;
  const map: Record<string, string> = {};

  // data: 버튼만 추출 (숫자 버튼)
  const dataButtons = btns.filter((b: any) => b?.action?.startsWith("data:"));

  // blank 셀 감지: mean이 낮으면 blank (X 버튼 등 비숫자 셀)
  // 숫자 셀은 흰색 텍스트가 있어서 mean > 215, blank/기능 셀은 mean < 212
  const isBlankCell = (buf: Buffer): boolean => {
    const mean = buf.reduce((a, b) => a + b, 0) / buf.length;
    return mean < 212;
  };

  // 그리드 순회: blank 건너뛰고, 비blank 셀을 순서대로 dataButtons에 매핑
  let btnIdx = 0;
  const cellHashes: { hash: string; btnIdx: number }[] = [];
  for (let row = 0; row < count.line; row++) {
    const totalCols = (count.button[row] || 0) + (count.blank[row] || 0);
    for (let col = 0; col < totalCols; col++) {
      if (btnIdx >= dataButtons.length) break;
      const x = sx + col * (bw + mx);
      const y = sy + row * (bh + my);

      const cellBuf = await sharp(img).extract({ left: x, top: y, width: bw, height: bh }).greyscale().raw().toBuffer();

      // blank 체크: 분산 기반
      if (isBlankCell(cellBuf)) continue;

      const cellHash = crypto.createHash("md5").update(cellBuf).digest("hex");

      // 해시 기반 숫자 매칭
      const digit = KEYPAD_DIGIT_HASHES[cellHash];
      if (digit !== undefined) {
        map[digit] = dataButtons[btnIdx].action.split(":")[1];
      } else {
        cellHashes.push({ hash: cellHash, btnIdx });
      }
      btnIdx++;
    }
  }

  // 해시 매칭 실패한 셀에 대해: 0-9 중 map에 없는 숫자를 할당
  if (cellHashes.length > 0 && dataButtons.length === 10) {
    const unmapped = "0123456789".split("").filter(d => !map[d]);
    if (unmapped.length === cellHashes.length) {
      // 미매칭 셀 수 = 미매핑 숫자 수 → 1:1 할당 가능
      for (let i = 0; i < cellHashes.length; i++) {
        map[unmapped[i]] = dataButtons[cellHashes[i].btnIdx].action.split(":")[1];
        KEYPAD_DIGIT_HASHES[cellHashes[i].hash] = unmapped[i];
      }
    }
  }

  return map;
}

// ─── HTTP helpers (axios + tough-cookie cookiejar) ───────────────────────────

import axios, { AxiosInstance } from "axios";
import { CookieJar } from "tough-cookie";
import { HttpsProxyAgent } from "https-proxy-agent";

const APP_UA = "MobileApp/1.0 (iOS; 10.9.3; kr.co.gmarket.GMKTIP)";
const WEBVIEW_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MobileApp/1.0 (iOS; 10.9.3; kr.co.gmarket.GMKTIP) AplusBridgeLite";

interface HttpRes {
  status: number;
  data: any;
  headers: any;
  raw: string;
}

function createHttpClient(proxyUrl?: string): { client: AxiosInstance; jar: CookieJar } {
  const jar = new CookieJar();
  const agent = proxyUrl
    ? new HttpsProxyAgent(proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`)
    : undefined;

  const client = axios.create({
    maxRedirects: 5,
    validateStatus: () => true,
    proxy: false,
    ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
  });

  client.interceptors.request.use(async (config) => {
    const url = config.url || "";
    const cookies = await jar.getCookieString(url);
    if (cookies) {
      config.headers = config.headers || {};
      config.headers["Cookie"] = cookies;
    }
    return config;
  });

  client.interceptors.response.use(async (response) => {
    const url = response.config.url || "";
    const setCookies = response.headers["set-cookie"];
    if (setCookies) {
      for (const raw of setCookies) {
        try { await jar.setCookie(raw, url); } catch {}
      }
    }
    return response;
  });

  return { client, jar };
}

// ─── Main Client ─────────────────────────────────────────────────────────────

export class GmarketCheckoutClient {
  private http: AxiosInstance;
  private jar: CookieJar;
  private accessToken = "";
  private refreshToken = "";

  // State
  private checkoutUnitId = 0;
  private totalAmount = 0;
  private txKey = "";
  private mpiReturn: Record<string, string> = {};
  private orderKey = "";
  private paymentNo = 0;
  private giftKey = "";
  private hashedPaymentNo = "";
  private checkoutData: any = null; // getCheckout 응답 전체 저장
  private fdsCheckoutNo = "";
  private mpiGatewayId = "";
  private appliedDiscounts: any[] = [];

  private loginId = "";
  private loginPw = "";
  private dev = {
    duid: "",
    utdid: "",
    cguid: "",
    pcid: "",
    jaehuid: "",
    natIp: "",
    dguid: "",
    idfv: "",
  };

  constructor(private opts: GmarketCheckoutOptions = {}) {
    const { client, jar } = createHttpClient(opts.proxyUrl);
    this.http = client;
    this.jar = jar;
    console.log(`[client] 생성됨, proxy: ${opts.proxyUrl || "(직접 연결)"}`);
    if (opts.refreshToken) this.refreshToken = opts.refreshToken;
    if (opts.id) this.loginId = opts.id;
    if (opts.pw) this.loginPw = opts.pw;
    const d = opts.device || {};
    const ts13 = Date.now().toString();
    this.dev.duid = d.duid || crypto.randomUUID().toUpperCase();
    this.dev.utdid = d.utdid || crypto.randomBytes(18).toString("base64").replace(/[+/=]/g, "").substring(0, 24);
    this.dev.cguid = d.cguid || ("1" + ts13 + Math.floor(Math.random() * 1e6).toString().padStart(6, "0") + "000000");
    this.dev.pcid = d.pcid || ("4" + ts13.substring(0, 13));
    this.dev.jaehuid = d.jaehuid || "";
    this.dev.natIp = d.natIp || "";
    this.dev.dguid = d.dguid || ("21I" + Math.floor(Date.now() / 1000).toString() + Math.floor(Math.random() * 1e6).toString().padStart(6, "0"));
    this.dev.idfv = d.idfv || crypto.randomUUID().toUpperCase();
  }

  /** 디바이스 설정 조회 (저장/재사용용) */
  getDeviceInfo() {
    return { ...this.dev };
  }

  private async httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpRes> {
    const res = await this.http.get(url, { headers });
    const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return { status: res.status, data: res.data, headers: res.headers, raw };
  }

  private async httpPost(url: string, body: string | object, headers: Record<string, string> = {}, opts?: { maxRedirects?: number }): Promise<HttpRes> {
    const data = typeof body === "object" ? body : body;
    const isStr = typeof body === "string";
    const isJson = isStr ? (body.startsWith("{") || body.startsWith("[")) : true;
    if (!headers["content-type"] && !headers["Content-Type"] && body !== "") {
      headers["content-type"] = isStr && !isJson ? "application/x-www-form-urlencoded" : "application/json;charset=utf-8";
    }
    const res = await this.http.post(url, data || undefined, { headers, maxRedirects: opts?.maxRedirects ?? 5 });
    const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return { status: res.status, data: res.data, headers: res.headers, raw };
  }

  private async httpGetBuf(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
    const res = await this.http.get(url, { headers, responseType: "arraybuffer" });
    return Buffer.from(res.data);
  }

  private appHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "User-Agent": APP_UA,
      "Accept": "*/*",
      "Content-Type": "application/json",
      "Accept-Language": "ko-KR;q=1.0, en-KR;q=0.9",
      "Accept-Encoding": "br;q=1.0, gzip;q=0.9, deflate;q=0.8",
      "ApiKey": APP_API_KEY,
      "Hermes-AppVersion": "10.9.3",
      "Hermes-AppType": "C",
      "Hermes-OsType": "I",
      "Hermes-OsVersion": "26.5",
      "Hermes-DUID": this.dev.duid,
      "Hermes-UTDID": this.dev.utdid,
      "Hermes-CGUID": this.dev.cguid,
      "Hermes-PGUID": "2" + this.dev.cguid.substring(1),
      "Hermes-SGUID": "3" + this.dev.cguid.substring(1),
      "Hermes-GP": `adtid=0;adoptout=1;jaehuid=${this.dev.jaehuid}`,
      "Connection": "keep-alive",
      ...(this.accessToken ? { "Authorization": `Bearer ${this.accessToken}` } : {}),
      ...extra,
    };
  }

  private webviewHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "User-Agent": WEBVIEW_UA,
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=utf-8",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Origin": "https://checkout.gmarket.co.kr",
      "Referer": "https://checkout.gmarket.co.kr/",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Cache-Control": "no-cache",
      ...extra,
    };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async init(): Promise<void> {
    // refreshToken이 있으면 자동로그인
    if (this.refreshToken) {
      await this.authenticate();
    }
  }

  async destroy(): Promise<void> {}

  /** refreshToken 반환 (외부 저장용) */
  getRefreshToken(): string {
    return this.refreshToken;
  }

  /** refreshToken으로 accessToken 발급 + 로그인 쿠키 획득 */
  private async authenticate(): Promise<void> {
    // 앱 쿠키 설정 (stargate에 전송되어야 함)
    await this.setAppCookies();

    this.accessToken = this.refreshToken;
    const updateRes = await this.httpGet(
      "https://stargate.gmarket.co.kr/hermes/auth/v1/token/update-token",
      this.appHeaders(),
    );
    const newToken = updateRes.data?.data?.accessToken || "";
    if (!newToken) throw new Error("자동로그인 실패: update-token 응답에 accessToken 없음. login() 호출 필요.");
    this.accessToken = newToken;

    await this.httpGet(
      "https://stargate.gmarket.co.kr/hermes/auth/v1/security/get-member-context",
      this.appHeaders(),
    );

    const cookieRes = await this.httpGet(
      "https://stargate.gmarket.co.kr/hermes/auth/v1/login/get-login-cookie",
      this.appHeaders(),
    );
    const loginCookies: string[] = cookieRes.data?.data?.loginCookies || [];
    for (const cookieStr of loginCookies) {
      try {
        const kv = cookieStr.split(";")[0];
        await this.jar.setCookie(`${kv}; domain=.gmarket.co.kr; path=/`, "https://stargate.gmarket.co.kr/");
        await this.jar.setCookie(`${kv}; domain=.gmarket.co.kr; path=/`, "https://checkout.gmarket.co.kr/");
      } catch {}
    }

    // loginProc 쿠키 획득 (user_info, PCIDJCN 등 — lat은 제외)
    const existingUserInfo = (await this.jar.getCookies("https://checkout.gmarket.co.kr/")).find(c => c.key === "user%5Finfo");
    if (!existingUserInfo) {
      await this.acquireLoginCookies();
    }

    console.log("[auth] 자동로그인 완료");
  }

  /** 앱 고유 쿠키를 .gmarket.co.kr 도메인에 설정 */
  private async setAppCookies(): Promise<void> {
    const appCookies = [
      `pcid=${this.dev.pcid}`,
      "Scheme=gmarket://escrow", "adoptout=1", "app_info=iPhone:10.9.3:iPhone",
      `duid=${this.dev.duid}`, "goSet=Y", "idfa=0",
      `idfv=${this.dev.idfv}`, "mmyglink=Y",
      "osversion=26%2E4", `utdid=${this.dev.utdid}`,
      "viewLayoutAll=Y", `jaehuid=${this.dev.jaehuid}`,
      ...(this.dev.natIp ? [`nat_ip=${this.dev.natIp}`] : []),
      `g_dguid=${this.dev.dguid}`, `cguid=${this.dev.cguid}`,
      `pguid=2${this.dev.cguid.substring(1)}`,
      `sguid=3${this.dev.cguid.substring(1)}`,
    ];
    const domains = ["https://mobile.gmarket.co.kr/", "https://stargate.gmarket.co.kr/", "https://trust.gmarket.co.kr/", "https://checkout.gmarket.co.kr/", "https://www.gmarket.co.kr/"];
    for (const c of appCookies) {
      for (const d of domains) {
        await this.jar.setCookie(`${c}; domain=.gmarket.co.kr; path=/`, d);
      }
    }
  }

  /** loginProc을 호출해서 로그인 쿠키 획득 (lat 제외 — lat이 있으면 addOrder 실패) */
  private async acquireLoginCookies(): Promise<void> {
    const loginPageRes = await this.httpGet(
      "https://mobile.gmarket.co.kr/Login/Login?URL=https://my.gmarket.co.kr/ko/mo/Main",
      { "User-Agent": WEBVIEW_UA },
    );
    const xsrf = (await this.jar.getCookies("https://mobile.gmarket.co.kr/")).find(c => c.key === "XSRF-TOKEN")?.value || "";
    if (!xsrf) return;

    await this.httpPost("https://mobile.gmarket.co.kr/login/pre-loginProc", "", {
      "User-Agent": WEBVIEW_UA, "X-XSRF-TOKEN": xsrf, "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://mobile.gmarket.co.kr",
      "Referer": "https://mobile.gmarket.co.kr/Login/Login?URL=https://my.gmarket.co.kr/ko/mo/Main",
      "Content-Type": "application/x-www-form-urlencoded",
    });

    const formData = new URLSearchParams({
      _csrf: xsrf, command: "LOGIN", memberType: "MEM", fromWhere: "G",
      targetUrl: "https://my.gmarket.co.kr/ko/mo/Main",
      loginId: this.loginId, password: this.loginPw,
      isAutoLogin: "true", failCheck: "0", faceData: "", uniqueKey: "",
      isDisplayCaptcha: "false", socialAutoLoginType: "NONE", socialType: "1", saveId: "",
    }).toString();

    await this.httpPost("https://mobile.gmarket.co.kr/login/loginProc", formData, {
      "User-Agent": WEBVIEW_UA, "Content-Type": "application/x-www-form-urlencoded",
      "X-XSRF-TOKEN": xsrf, "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://mobile.gmarket.co.kr",
      "Referer": "https://mobile.gmarket.co.kr/Login/Login?URL=https://my.gmarket.co.kr/ko/mo/Main",
    }, { maxRedirects: 0 });

    // 로그인 쿠키를 checkout 도메인에 복사 (lat 제외)
    const mobileCookies = await this.jar.getCookies("https://mobile.gmarket.co.kr/");
    for (const c of mobileCookies) {
      if (["user%5Finfo", "PCIDJCN", "pds", "mgpid", "isSFC", "illegal%5Finfo", "usernon%5Finfo", "mRecentLoginType"].includes(c.key)) {
        const cookieStr = `${c.key}=${c.value}; domain=.gmarket.co.kr; path=/`;
        await this.jar.setCookie(cookieStr, "https://checkout.gmarket.co.kr/");
        await this.jar.setCookie(cookieStr, "https://stargate.gmarket.co.kr/");
      }
      if (c.key === "jaehuid" && c.value) {
        this.dev.jaehuid = c.value;
      }
    }
  }

  // ─── 1. Login (앱 플로우) ────────────────────────────────────────────

  async login(id: string, pw: string): Promise<void> {
    this.loginId = id;
    this.loginPw = pw;
    // 앱 쿠키 설정 (loginProc에서 useHerAPI=Y를 받기 위해 필수)
    await this.setAppCookies();

    // 1-1. 로그인 페이지 (XSRF-TOKEN 쿠키 획득)
    const loginPageRes = await this.httpGet(
      "https://mobile.gmarket.co.kr/Login/Login?URL=https://my.gmarket.co.kr/ko/mo/Main",
      { "User-Agent": WEBVIEW_UA, "Accept": "text/html" },
    );
    console.log(`[login] 로그인 페이지 응답: status=${loginPageRes.status}, content-length=${loginPageRes.raw.length}`);
    console.log(`[login] 응답 헤더:`, JSON.stringify(loginPageRes.headers, null, 2));
    const mobileCookies = await this.jar.getCookies("https://mobile.gmarket.co.kr/");
    console.log(`[login] mobile.gmarket.co.kr 쿠키:`, mobileCookies.map(c => `${c.key}=${c.value.substring(0, 20)}...`).join(", ") || "(없음)");
    const xsrf = mobileCookies.find(c => c.key === "XSRF-TOKEN")?.value || "";
    if (!xsrf) throw new Error("로그인 실패: XSRF-TOKEN 쿠키 없음");
    console.log("[login] XSRF-TOKEN 획득");

    // 1-2. ATO /see + /face
    const seeKey = crypto.randomBytes(16).toString("hex");
    const seeIv = crypto.randomBytes(8).toString("hex");
    let faceData = "", uniqueKey = "";
    try {
      const seeRes = await this.httpPost("https://trust.gmarket.co.kr/see", "", {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(seeKey + ":" + seeIv).toString("base64"),
        "User-Agent": WEBVIEW_UA,
        "Origin": "https://mobile.gmarket.co.kr",
        "Referer": "https://mobile.gmarket.co.kr/",
        "X-XSRF-TOKEN": xsrf,
      });
      if (seeRes.status === 200 && seeRes.raw.length > 50) {
        // Decrypt see response
        const seeDecipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(seeKey, "utf8"), Buffer.from(seeIv, "utf8"));
        const seeData = JSON.parse(Buffer.concat([seeDecipher.update(Buffer.from(seeRes.raw, "base64")), seeDecipher.final()]).toString("utf8"));

        // Build browserEnvKey (envConfig에 맞는 디바이스 정보)
        const envData: Record<string, any> = {
          "112": true, "203": "ko-KR", "204": -540,
          "205": "d6483714608e18afa11c658b6d88334649813de4963f7e523f6ad270dbb7ef01",
          "313": 24,
          "605": "b3457a785e3399ef02cf51e6a265d49315d59444fadfafe55ef41e2ae9f96d65",
          "612": "Apple GPU", "700": false, "705": false,
          "710": "safari", "711": "-1", "712": false, "713": true, "714": "ios",
          "715": true, "716": false,
          "777": "d3458d126ef9f9ca0fe0a82ba2a4ca8f98046c54fafef30ad3a2df0ad60baef0",
          "779": 5,
          "780": "0b60311364780649e9503f38132ce2ab9331f0127ee0937721091c0de7676269",
          "781": "b647379aa1b2d069ed06909819d9791595012b5160309ed4b5d9d5be0b45c0b4",
          "782": 124.04346777588944,
        };
        const envCipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(seeData.key, "utf8"), Buffer.from(seeData.iv, "utf8"));
        const currentEnvKey = Buffer.concat([envCipher.update(JSON.stringify(envData), "utf8"), envCipher.final()]).toString("base64");

        // Face payload
        const facePayload = JSON.stringify({
          packetVersion: 3, previousEnvKey: "", currentEnvKey,
          uuidKey: "", previousUuidKeyWrapper: "", envSecret: "", lastUpdateTime: 0,
          navigator: { webDriver: false, maxTouchPoints: 5, languages: ["ko-KR"] },
        });
        const faceCipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(seeData.key, "utf8"), Buffer.from(seeData.iv, "utf8"));
        const faceEnc = Buffer.concat([faceCipher.update(facePayload, "utf8"), faceCipher.final()]).toString("base64");

        // POST /face (고정 Authorization)
        const faceRes = await this.httpPost(`https://trust.gmarket.co.kr/${seeData.url}/face`, faceEnc, {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Basic NDc4ZTA5MGU5N2QyNDMwNmEzYjE0NDFhNjNlMThhZjI6MmNkMTkxYzg1MmU3NDM5Zg==",
          "User-Agent": WEBVIEW_UA,
          "Origin": "https://mobile.gmarket.co.kr",
          "Referer": "https://mobile.gmarket.co.kr/",
          "X-XSRF-TOKEN": xsrf,
        });

        // Decrypt face response → uuidKey
        const faceDecipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(seeData.key, "utf8"), Buffer.from(seeData.iv, "utf8"));
        const faceRespData = JSON.parse(Buffer.concat([faceDecipher.update(Buffer.from(faceRes.raw, "base64")), faceDecipher.final()]).toString("utf8"));
        uniqueKey = faceRespData.uuidKey || "";

        // Build faceData (Kk: AES-128-CBC encrypt of full browserMap)
        const fullMap: Record<string, any> = {
          "101": WEBVIEW_UA, "102": "Apple Computer, Inc.", "105": true, "106": "Netscape", "107": "Mozilla",
          "108": "5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MobileApp/1.0 (iOS; 10.9.3; kr.co.gmarket.GMKTIP) AplusBridgeLite",
          "110": "Gecko", "111": false, "112": true, "201": "iPhone", "203": "ko-KR", "204": -540,
          "205": "d6483714608e18afa11c658b6d88334649813de4963f7e523f6ad270dbb7ef01",
          "301": 402, "302": 402, "303": 874, "304": 874, "305": 0, "306": 0, "307": 402, "308": 730,
          "309": 402, "310": 730, "311": 402, "312": 730, "313": 24, "314": 24, "315": 3,
          "325": "mobile.gmarket.co.kr",
          "401": "PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF",
          "501": faceRespData.natIp, "601": faceRespData.uuidKey, "602": "", "603": String(faceRespData.uuidKeyExist),
          "605": "b3457a785e3399ef02cf51e6a265d49315d59444fadfafe55ef41e2ae9f96d65",
          "606": faceRespData.uuidKeyStatus, "609": "", "610": String(faceRespData.timestamp),
          "612": "Apple GPU", "700": false,
          "701": String(faceRespData.firstEnv), "702": String(faceRespData.firstIp),
          "703": String(faceRespData.firstUuid), "704": String(faceRespData.uuidCreateAt), "705": false,
          "710": "safari", "711": "-1", "712": false, "713": true, "714": "ios", "715": true, "716": false,
          "777": "d3458d126ef9f9ca0fe0a82ba2a4ca8f98046c54fafef30ad3a2df0ad60baef0",
          "778": "360f3dd440ea474481a1b89e5bc781632e84506de2b217f38c8b333de3b73bad",
          "779": 5, "780": "0b60311364780649e9503f38132ce2ab9331f0127ee0937721091c0de7676269",
          "781": "b647379aa1b2d069ed06909819d9791595012b5160309ed4b5d9d5be0b45c0b4",
          "782": 124.04346777588944,
        };
        faceData = this.buildFaceData(fullMap);
        console.log("[login] ATO face 완료");
      }
    } catch (e: any) {
      console.log("[login] ATO face 실패 (계속 진행):", e.message);
    }

    // 1-3. pre-loginProc
    await this.httpPost("https://mobile.gmarket.co.kr/login/pre-loginProc", "", {
      "User-Agent": WEBVIEW_UA, "X-XSRF-TOKEN": xsrf, "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://mobile.gmarket.co.kr",
      "Referer": "https://mobile.gmarket.co.kr/Login/Login?URL=https://my.gmarket.co.kr/ko/mo/Main",
      "Content-Type": "application/x-www-form-urlencoded",
    });

    // 1-4. loginProc
    const loginBody = new URLSearchParams({
      _csrf: xsrf, command: "LOGIN", memberType: "MEM", fromWhere: "G",
      targetUrl: "https://my.gmarket.co.kr/ko/mo/Main", loginId: id, password: pw,
      isAutoLogin: "true", failCheck: "0", faceData, uniqueKey,
      isDisplayCaptcha: "false", socialAutoLoginType: "NONE", socialType: "1", saveId: "",
    }).toString();

    const loginRes = await this.httpPost("https://mobile.gmarket.co.kr/login/loginProc", loginBody, {
      "User-Agent": WEBVIEW_UA, "Content-Type": "application/x-www-form-urlencoded",
      "X-XSRF-TOKEN": xsrf, "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://mobile.gmarket.co.kr",
      "Referer": "https://mobile.gmarket.co.kr/Login/Login?URL=https://my.gmarket.co.kr/ko/mo/Main",
    }, { maxRedirects: 0 });

    // loginResult 파싱
    const jsonMatch = loginRes.raw.match(/var loginResult\s*=\s*(\{.*?\});/s);
    if (!jsonMatch) throw new Error(`로그인 실패: loginResult 없음`);
    const result = JSON.parse(jsonMatch[1]);
    if (result.loginResult !== 0) throw new Error(`로그인 실패: loginResult=${result.loginResult}`);

    // redirectUrl에서 AT/RT 파싱
    const params = new URLSearchParams(result.redirectUrl.split("?")[1]);
    const useHerAPI = params.get("useHerAPI");
    const success = params.get("success");
    const at = params.get("at");
    const rt = params.get("rt");

    if (useHerAPI === "Y" && success === "true" && at && rt) {
      this.accessToken = at;
      this.refreshToken = rt;
      console.log("[login] useHerAPI=Y, refreshToken 획득 성공");
    } else {
      console.log(`[login] useHerAPI=${useHerAPI}, success=${success} — refreshToken 미발급`);
    }

    // 1-5. get-member-context + get-login-cookie (app05 플로우 — update-token 호출 안 함)
    await this.httpGet(
      "https://stargate.gmarket.co.kr/hermes/auth/v1/security/get-member-context",
      this.appHeaders(),
    );
    const cookieRes = await this.httpGet(
      "https://stargate.gmarket.co.kr/hermes/auth/v1/login/get-login-cookie",
      this.appHeaders(),
    );
    const loginCookiesList: string[] = cookieRes.data?.data?.loginCookies || [];
    for (const cookieStr of loginCookiesList) {
      try {
        const kv = cookieStr.split(";")[0];
        await this.jar.setCookie(`${kv}; domain=.gmarket.co.kr; path=/`, "https://stargate.gmarket.co.kr/");
        await this.jar.setCookie(`${kv}; domain=.gmarket.co.kr; path=/`, "https://checkout.gmarket.co.kr/");
      } catch {}
    }

    // 1-6. loginProc에서 받은 쿠키를 checkout 도메인에도 복사
    const mobileCookiesAfter = await this.jar.getCookies("https://mobile.gmarket.co.kr/");
    const importantKeys = ["user%5Finfo", "PCIDJCN", "pds", "mgpid", "isSFC", "illegal%5Finfo", "usernon%5Finfo", "mRecentLoginType"];
    for (const c of mobileCookiesAfter) {
      if (importantKeys.includes(c.key)) {
        const cookieStr = `${c.key}=${c.value}; domain=.gmarket.co.kr; path=/`;
        await this.jar.setCookie(cookieStr, "https://checkout.gmarket.co.kr/");
        await this.jar.setCookie(cookieStr, "https://stargate.gmarket.co.kr/");
      }
      // jaehuid 쿠키에서 디바이스 값 업데이트
      if (c.key === "jaehuid" && c.value) {
        this.dev.jaehuid = c.value;
      }
    }

    console.log("[login] 완료, refreshToken:", this.refreshToken ? "있음" : "없음");
  }

  /** Kk: browserMap을 AES-128-CBC로 암호화하여 faceData 생성 */
  private buildFaceData(data: Record<string, any>): string {
    const plaintext = JSON.stringify(data);
    let n = Date.now();
    let o = "";
    for (let i = 0; i < 32; i++) {
      const r = (n + 16 * Math.random()) % 16 | 0;
      n = Math.floor(n / 16);
      o += r.toString(16);
    }
    const key = Buffer.from(o, "hex"); // 16 bytes
    const ivBuf = Buffer.alloc(16);
    ivBuf.writeInt32BE(489824794, 0);
    ivBuf.writeInt32BE(124536943, 4);
    ivBuf.writeInt32BE(-1636233340, 8);
    ivBuf.writeInt32BE(611703768, 12);
    const cipher = crypto.createCipheriv("aes-128-cbc", key, ivBuf);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const prefix = Buffer.alloc(24);
    crypto.randomFillSync(prefix, 0, 4);
    key.copy(prefix, 4);
    crypto.randomFillSync(prefix, 20, 4);
    return Buffer.concat([prefix, encrypted]).toString("base64");
  }

  // ─── 2. Checkout (순수 HTTP) ─────────────────────────────────────────

  async checkout(itemCode: string, quantity = 1): Promise<CheckoutResult> {
    // stargate add-checkout API로 체크아웃 유닛 생성
    const addCheckoutRes = await this.httpPost(
      "https://stargate.gmarket.co.kr/hermes/flux/v1/vip/add-checkout",
      {
        items: [{ quantity, itemAdditions: [], shippingMethodType: "GENERAL", itemNo: Number(itemCode), requestKey: 0, shippingChargePayType: "PAYMENT_IN_ADVANCE" }],
        cartPid: "",
        smileFreshType: "UNKNOWN",
        giftType: "SELF_ECOUPON",
      },
      this.appHeaders(),
    );

    const addData = addCheckoutRes.data?.data;
    if (!addData?.isSuccess || !addData?.checkoutUrl) {
      throw new Error(`add-checkout 실패: ${JSON.stringify(addCheckoutRes.data).substring(0, 300)}`);
    }

    // checkoutUrl에서 chid, txKey 파싱
    const urlMatch = addData.checkoutUrl.match(/chid=(\d+).*?txKey=([a-z0-9]+)/);
    if (!urlMatch) throw new Error("checkoutUrl 파싱 실패");
    const chid = urlMatch[1];
    const txKey = urlMatch[2];

    // ORDER_INFO 쿠키 설정 (URL-encoded 이름 그대로 저장)
    if (addData.cookies) {
      for (const c of addData.cookies) {
        await this.jar.setCookie(`${c.key}=${c.value}; domain=.gmarket.co.kr; path=/`, "https://checkout.gmarket.co.kr/");
      }
    }

    // checkout 페이지 로드 (서버 세션 초기화)
    const checkoutPageUrl = `https://checkout.gmarket.co.kr/ko/m/checkout?chid=${chid}&txKey=${txKey}`;
    await this.httpGet(checkoutPageUrl, { "User-Agent": WEBVIEW_UA, "Accept": "text/html" });

    // env API
    await this.httpGet("https://checkout.gmarket.co.kr/server/ko/m/api/env", { "User-Agent": WEBVIEW_UA, "Accept": "application/json, text/plain, */*", "Referer": checkoutPageUrl });

    // getCheckout으로 상세 정보 조회
    const checkoutRes = await this.httpPost(
      "https://checkout.gmarket.co.kr/server/ko/m/api/checkout/getCheckout",
      { checkoutUnitIds: [Number(chid)], txKey },
      this.webviewHeaders({ "Referer": checkoutPageUrl }),
    );

    this.checkoutData = checkoutRes.data?.data;
    const unit = this.checkoutData?.checkoutUnits?.[0];
    this.checkoutUnitId = unit?.checkoutUnitId || Number(chid);
    this.totalAmount = unit?.itemPrice || 0;
    this.txKey = txKey;

    console.log(`[checkout] unitId=${this.checkoutUnitId}, amount=${this.totalAmount}, txKey=${this.txKey}`);
    return { checkoutUnitId: this.checkoutUnitId, totalAmount: this.totalAmount, txKey: this.txKey };
  }

  // ─── 3. 신한카드 결제 인증 ─────────────────────────────────────────────

  async payWithShinhan(card: CardInfo): Promise<Record<string, string>> {
    const base = "https://checkout.gmarket.co.kr/server/ko/m/api";
    const h = this.webviewHeaders({ "Referer": `https://checkout.gmarket.co.kr/ko/m/checkout?chid=${this.checkoutUnitId}&txKey=${this.txKey}` });

    // getAvailableDiscount (dump 형식)
    const unit = this.checkoutData?.checkoutUnits?.[0];
    const seller = unit?.seller;
    const item = unit?.item;
    const member = this.checkoutData?.member;
    const discountRes = await this.httpPost(`${base}/discount/getAvailableDiscount`, {
      buyerGrade: String(member?.buyerGrade || "50"),
      requests: [{
        checkoutUnitId: this.checkoutUnitId,
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
    const payAmount = this.totalAmount - discountPrice;
    this.appliedDiscounts = discounts;
    console.log(`[pay] discount=${discountPrice}, payAmount=${payAmount}`);

    // setOrders는 completePayment에서 addOrder 직전에 호출 (dump 순서와 동일)

    // getAvailablePaymentMethods (app04 flow 127 형식)
    await this.httpPost(`${base}/payment/getAvailablePaymentMethods`, {
      orderPageType: "General",
      itemDetails: [{
        itemNo: String(unit?.itemNo || ""),
        sellerKey: seller?.sellerKey || "",
        largeCategoryCode: item?.largeCategoryCode || "",
        mediumCategoryCode: item?.mediumCategoryCode || "",
        smallCategoryCode: item?.smallCategoryCode || "",
        detailCategoryCode: item?.detailCategoryCode || "",
        shopGroupCodes: [],
        shippingPolicyId: item?.shippingPolicyId || 0,
        isIncomeDutyFreeItem: false,
        isZeroPrice: false,
        isAvailableZeroPrice: false,
        isRental: false,
      }],
      couponKeyList: [],
      discountKeyList: discounts.map((d: any) => d.discountPolicyNo).filter(Boolean),
      freeDeliveryTicketKeyList: [],
      totalPayAmnt: payAmount,
      hasC2CItem: false,
      isMember: true,
      isForeigner: false,
      isSimpleJoinForeigner: false,
      isSimpleMember: false,
      isApp: true,
      isGiftOrder: true,
    }, h);

    // FDS
    const fdsBody = {
      purchaseInfo: {
        partnershipBuyerNo: member?.partnershipBuyerNo || member?.memberKey || "",
        buyerName: member?.memberName || "",
        totalPaymentAmount: payAmount,
        totalShippingFee: 0,
        totalDiscountAmount: discountPrice,
        checkouts: [{
          checkoutUnitId: this.checkoutUnitId,
          largeCategoryCode: item?.largeCategoryCode || "",
          mediumCategoryCode: item?.mediumCategoryCode || "",
          smallCategoryCode: item?.smallCategoryCode || "",
          sellerKey: seller?.sellerKey || "",
          miniShopName: seller?.miniShopName || "",
          itemNo: String(unit?.itemNo || ""),
          itemName: unit?.itemName || "",
          quantity: unit?.quantity || 1,
          shippingMethodType: "General",
          itemRegistrationDate: item?.itemRegistrationDate || "",
          itemPrice: unit?.itemPrice || 0,
          branchAdditionalPrice: 0,
          optionsAdditionalPrice: 0,
          additionsTotalAmount: 0,
          checkoutUnitTotalAmount: unit?.itemPrice || 0,
          discounts: discounts.map((d: any) => ({ discountPolicyNo: d.discountPolicyNo, discountPrice: d.discountPrice, discountType: d.discountType })),
          coupons: [],
          isMoneyCategory: true,
          isEcoupon: true,
          isRental: false,
          isZeroPrice: false,
          isReservation: false,
          isSellerDeposit: false,
        }],
        payments: [{ smallMethodCode: "300000030", paymentAmount: payAmount }],
        shippingAddress: {
          countryType: "SouthKorea",
          name: member?.memberName || "",
          hpNo: member?.phoneNo || "",
          address: "", detailAddress: "", zipCode: "",
        },
        isGiftOrder: false,
      },
    };
    const fdsRes = await this.httpPost(`${base}/fds/issueFdsCheckoutNo`, fdsBody, h);
    this.fdsCheckoutNo = fdsRes.data?.data?.data || fdsRes.data?.data?.fdsCheckoutNo || "";

    if (this.fdsCheckoutNo) {
      // sendPurchaseInfo — full purchaseInfo + checkoutNo (app04 flow 156 형식)
      await this.httpPost(`${base}/fds/sendPurchaseInfo`, {
        purchaseInfo: fdsBody.purchaseInfo,
        isGmarketGlobal: false,
        checkoutNo: this.fdsCheckoutNo,
      }, h);
      // detectPaymentAuth — buyer/item/payment 정보 (app04 flow 157 형식)
      await this.httpPost(`${base}/fds/detectPaymentAuth`, {
        buyerBirthDate: member?.birthDate || "",
        buyerEmail: member?.email || "",
        buyerPhoneNumber: member?.phoneNo || "",
        checkoutNo: this.fdsCheckoutNo,
        items: [{
          ecoupon: true,
          moneyCategory: true,
          name: unit?.itemName || "",
          no: String(unit?.itemNo || ""),
          largeCategory: item?.largeCategoryCode || "",
          mediumCategory: item?.mediumCategoryCode || "",
          smallCategory: item?.smallCategoryCode || "",
          sellerId: seller?.sellerId || "",
          rental: false,
          reservation: false,
          sellerDeposit: false,
          zeroPrice: false,
        }],
        partnershipBuyerNo: member?.partnershipBuyerNo || member?.memberKey || "",
        pays: [{ mediumMethodCode: "200000009", paymentAmount: payAmount, smallMethodCode: "300000030" }],
        delivery: {
          phoneNumber: member?.phoneNo || "",
          name: member?.memberName || "",
          zipCode: "",
        },
      }, h);
    }

    // getCreditCardDetailPolicy (app04 flow 158 형식)
    await this.httpPost(`${base}/payment/getCreditCardDetailPolicy`, {
      checkoutUnitCount: 1,
      smallMethodCode: "300000030",
      paymentAmount: payAmount,
      vanCardCompanyCode: "CCLG",
      cardInstallmentMonth: 0,
      paymentSettleCode: 26007,
      cardPolicyNo: 0,
      cardInstallmentPolicyNo: 0,
      hasIncomeDutyFreeItem: false,
      hasIntoMoneyItem: false,
      isUseCardPoint: false,
      isFreeInstallment: false,
      hasECouponItem: true,
      hasGiftCardItem: true,
    }, h);

    // guardian/purchaseInfoCollect (결제 세션 등록 — addOrder 전 필수)
    await this.httpPost(`${base}/guardian/purchaseInfoCollect`, {
      totalPayAmount: payAmount,
      totalDiscountAmount: discountPrice,
      totalShippingCost: 0,
      pays: [{ payAmount, payMethodCode: "300000030" }],
      discounts: [],
      items: [{
        itemNo: String(this.checkoutData?.checkoutUnits?.[0]?.itemNo || ""),
        sellerId: this.checkoutData?.checkoutUnits?.[0]?.seller?.sellerKey || "",
        options: [{ skuMatchingVerNo: 0 }],
        discounts: discounts.map((d: any) => ({ discountNo: d.discountPolicyNo, discountPrice: d.discountPrice, discountType: d.discountType })),
        orderPrice: this.checkoutData?.checkoutUnits?.[0]?.itemPrice || payAmount,
        orderQty: this.checkoutData?.checkoutUnits?.[0]?.quantity || 1,
      }],
    }, h);

    // MPI info
    const mpiRes = await this.httpPost(`${base}/payment/getCardMPI`, {
      checkoutUnitCount: 1, vanCardCompanyCode: "CCLG", affiliateNo: null,
      paymentSettleCode: 26007, hasIntoMoneyItem: false, cardInstallmentMonth: 0,
      hasECouponItem: true, hasGoldItem: false, hasGiftCardItem: true,
    }, h);
    const mpiInfo = mpiRes.data?.data;

    // KCP MPI — request_smart_comm → request_smart (prepare는 completePayment에서 호출)
    // mpiGatewayId 생성 (앱에서는 항상 mpi_26)
    this.mpiGatewayId = "mpi_26";
    const itemName = this.checkoutData?.checkoutUnits?.[0]?.itemName || "";
    const kcpFormData: Record<string, string> = {
      txtVisaCode: "CCLG", txtPayAmnt: String(payAmount), amt: String(payAmount),
      card_mony: String(payAmount), txtRecpCard: String(payAmount),
      ss_useyn: "Y", inst_term: "0",
      curr_code: mpiInfo?.orderCurrencyCode || "410",
      order_mname: mpiInfo?.siteName || "Gmarket Inc.",
      site_name: mpiInfo?.siteName || "Gmarket Inc.",
      MerchantName: mpiInfo?.siteName || "Gmarket Inc.",
      term_idxx: mpiInfo?.termIdx || "M34300", termId: mpiInfo?.termIdx || "M34300",
      rtn_url: "https://checkout.gmarket.co.kr/server/ko/m/gateway/" + this.mpiGatewayId + "/creditcard-mpi/return",
      order_currency: mpiInfo?.orderCurrencyCode || "410", currency: mpiInfo?.orderCurrencyCode || "410",
      site_midx: mpiInfo?.siteMIdx || "M343", MIDbyKCP: mpiInfo?.siteMIdx || "M343",
      order_amount: String(payAmount), expiry_yy: "79", ccexpyy: "79",
      expiry_mm: "12", ccexpmm: "12", join_no: mpiInfo?.joinCode || "",
      card_code: "CCLG", ss_useyn_hd: "", APP_INTENT_YN: "N",
      sp_chain_code: mpiInfo?.spChainCode || "0",
      spay_user_id_encYn: "Y", txtNointOfferAmnt: "0",
      goodname: encodeURIComponent(itemName),
      mall_app_name: "gmarket://",
      tax_no: "2208183676",
    };

    // Step 1: request_smart_comm.jsp
    const commRes = await this.httpPost("https://v3d.kcp.co.kr/XMPI/v3d/request_smart_comm.jsp",
      new URLSearchParams(kcpFormData).toString(),
      { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://checkout.gmarket.co.kr", "Referer": "https://checkout.gmarket.co.kr/", "User-Agent": WEBVIEW_UA, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe", "Accept-Language": "ko-KR,ko;q=0.9" },
    );

    // Step 2: comm 응답에서 form → request_smart.jsp
    const commAction = commRes.raw.match(/action="([^"]+request_smart\.jsp[^"]*)"/)?.[1] || "https://v3d.kcp.co.kr/XMPI/v3d/request_smart.jsp";
    const commInputs = [...commRes.raw.matchAll(/name="([^"]+)"\s+value="([^"]*)"/g)];
    if (commInputs.length === 0) throw new Error("KCP comm 응답에서 form 추출 실패");

    const smartBody = new URLSearchParams();
    for (const m of commInputs) smartBody.set(m[1], m[2]);
    const smartRes = await this.httpPost(commAction, smartBody.toString(), {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://v3d.kcp.co.kr", "Referer": "https://v3d.kcp.co.kr/", "User-Agent": WEBVIEW_UA, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe", "Accept-Language": "ko-KR,ko;q=0.9",
    });

    // Step 3: pareq 추출
    let pareqs = this.extractPareqs(smartRes.raw);
    if (!pareqs) throw new Error("MPI pareq 추출 실패 (request_smart 응답에서)");

    // VBV 인증
    this.mpiReturn = await this.shinhanVbvAuth(pareqs, card);
    this.totalAmount = payAmount; // 할인 적용된 금액으로 업데이트
    console.log("[pay] 카드 인증 완료");
    return this.mpiReturn;
  }

  // ─── 4. 주문 완료 ──────────────────────────────────────────────────────

  async completePayment(cardNumber: string): Promise<OrderResult> {
    const base = "https://checkout.gmarket.co.kr/server/ko/m/api";
    const h = this.webviewHeaders({ "Referer": `https://checkout.gmarket.co.kr/ko/m/checkout?chid=${this.checkoutUnitId}&txKey=${this.txKey}` });

    // MPI — result_smart.jsp 호출 후 mpi/return에 form POST
    let mpiXid = "", mpiEci = "", mpiCavv = "", mpiCardNo = cardNumber;
    const resultSmartUrl = this.mpiReturn._resultSmartUrl || "";

    if (resultSmartUrl && this.mpiReturn.r0) {
      // result_smart.jsp에 r0~r4 POST (KCP가 내부적으로 rtn_url에 결과 전달)
      const resultBody = new URLSearchParams();
      for (const k of ["r0", "r1", "r2", "r3", "r4", "msg", "enc_msg"]) {
        if (this.mpiReturn[k]) resultBody.set(k, this.mpiReturn[k]);
      }
      const resultRes = await this.http.post(resultSmartUrl, resultBody.toString(), {
        headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://vbv.shinhancard.com", "Referer": "https://vbv.shinhancard.com/", "User-Agent": WEBVIEW_UA, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe", "Accept-Language": "ko-KR,ko;q=0.9", "Accept-Encoding": "identity" },
        responseType: "arraybuffer",
        transformResponse: [(data: any) => data], // 변환 비활성화
      });
      // raw bytes 수집
      const rawResultBuf = Buffer.from(resultRes.data);
      // euc-kr 응답에서 form inputs의 raw bytes를 추출하고 EUC-KR percent-encode
      const rawBuf = rawResultBuf;
      const resultHtml = rawBuf.toString("latin1");
      const resultInputs = [...resultHtml.matchAll(/name=["']?([^"'\s>]+)["']?\s+value="([^"]*)"/g)];

      if (resultInputs.length > 0 && resultInputs.some(m => m[1] === "xid")) {
        // form values를 EUC-KR raw bytes 그대로 percent-encode (브라우저 동작 재현)
        // res_msg는 KCP가 UTF-8 replacement로 깨뜨리므로 EUC-KR 원본으로 하드코딩
        const EUC_KR_RES_MSG = "%C0%CE%C1%F5%C0%C0%B4%E4+%BC%BA%B0%F8"; // "인증응답 성공" in EUC-KR
        const parts: string[] = [];
        for (const [_, k, v] of resultInputs) {
          if (k === "res_msg") {
            parts.push(`res_msg=${EUC_KR_RES_MSG}`);
          } else {
            // value를 latin1 bytes → 그대로 percent-encode
            let encVal = "";
            for (let i = 0; i < v.length; i++) {
              const code = v.charCodeAt(i);
              if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A) || code === 0x2D || code === 0x2E || code === 0x5F || code === 0x7E || code === 0x2A) {
                encVal += v[i];
              } else if (code === 0x20) {
                encVal += "+";
              } else {
                encVal += "%" + code.toString(16).toUpperCase().padStart(2, "0");
              }
            }
            parts.push(`${k}=${encVal}`);
          }
        }
        const mpiReturnBodyStr = parts.join("&");

        // mpi/return에 POST
        const mpiReturnRes = await this.httpPost(
          "https://checkout.gmarket.co.kr/server/ko/m/gateway/" + this.mpiGatewayId + "/creditcard-mpi/return",
          mpiReturnBodyStr,
          { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://v3d.kcp.co.kr", "Referer": "https://v3d.kcp.co.kr/", "User-Agent": WEBVIEW_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe", "Accept-Language": "ko-KR,ko;q=0.9" },
        );

        // xid/cavv/eci 추출
        const xidM = resultInputs.find(m => m[1] === "xid");
        const eciM = resultInputs.find(m => m[1] === "eci");
        const cavvM = resultInputs.find(m => m[1] === "cavv");
        const cardM = resultInputs.find(m => m[1] === "card_no");
        if (xidM) mpiXid = xidM[2];
        if (eciM) mpiEci = eciM[2];
        if (cavvM) mpiCavv = cavvM[2];
        if (cardM) mpiCardNo = cardM[2];
      }
    }

    // Build addOrder body from getCheckout data
    const unit = this.checkoutData?.checkoutUnits?.[0];
    const seller = unit?.seller;
    const item = unit?.item;
    const member = this.checkoutData?.member;

    const addOrderBody: any = {
      checkoutPageType: "Gift",
      env: { isApp: true, isMobile: true, languageType: "Korean" },
      encodedRepItemName: encodeURIComponent(unit?.itemName || ""),
      sellerNames: [seller?.miniShopName || ""],
      checkoutItemTree: {
        checkoutUnitIdList: [this.checkoutUnitId],
        shippingGroups: [{
          key: `${seller?.sellerKey || ""}_${item?.shippingPolicyId || ""}`,
          shippingFee: 0,
          checkoutUnitIdList: [this.checkoutUnitId],
          itemGroups: [{
            itemNo: String(unit?.itemNo || ""),
            sellerKey: seller?.sellerKey || "",
            checkoutUnitIdList: [this.checkoutUnitId],
            checkoutUnitList: [{
              checkoutUnitId: this.checkoutUnitId,
              quantity: unit?.quantity || 1,
              itemNo: String(unit?.itemNo || ""),
              itemPrice: unit?.itemPrice || 0,
              sellerKey: seller?.sellerKey || "",
              largeCategoryCode: item?.largeCategoryCode || "",
              mediumCategoryCode: item?.mediumCategoryCode || "",
              smallCategoryCode: item?.smallCategoryCode || "",
              detailCategoryCode: item?.detailCategoryCode || null,
              isSmileDelivery: false,
            }],
            transPolicyNo: item?.transPolicyNo || item?.shippingPolicyId || 0,
            totalItemPrice: unit?.itemPrice || 0,
          }],
        }],
      },
      checkoutUnitList: [{
        checkoutUnitId: this.checkoutUnitId,
        quantity: unit?.quantity || 1,
        itemNo: String(unit?.itemNo || ""),
        itemPrice: unit?.itemPrice || 0,
        sellerKey: seller?.sellerKey || "",
        largeCategoryCode: item?.largeCategoryCode || "",
        mediumCategoryCode: item?.mediumCategoryCode || "",
        smallCategoryCode: item?.smallCategoryCode || "",
        detailCategoryCode: item?.detailCategoryCode || null,
        isSmileDelivery: false,
      }],
      groupCoupons: [],
      deliveryCoupons: [],
      discounts: this.appliedDiscounts.map((d: any) => ({ type: d.discountType, discountPolicyNo: d.discountPolicyNo, discountPrice: d.discountPrice, appliedCheckoutUnitId: this.checkoutUnitId })),
      fundingDiscounts: [],
      gift: {
        giftKey: this.checkoutData?.checkoutUnits?.[0]?.giftInfo?.giftKey || "",
        txKey: this.txKey,
      },
      ecoupon: {
        receiverName: "",
        receiverPhoneNumber: member?.phoneNo || "",
        senderName: "",
        senderPhoneNumber: "",
        receiverType: "Me",
        receiveWayType: "None",
      },
      buyer: {
        memberType: "Member",
        buyerName: member?.memberName || "",
        email: member?.email || "",
        phoneNumber: member?.phoneNo || "",
        partnershipBuyerNo: member?.partnershipBuyerNo || member?.memberKey || "",
        nonMemberPassword: "",
        isSavingMemberInfo: false,
        taiwanNameCertType: "PhoneNumber",
        isSavingPaymentMethodAsDefault: false,
      },
      receiver: {
        isNewAddress: false, addressNo: -1,
        receiverName: member?.memberName || "",
        receiverPhoneNumber: member?.phoneNo || "",
        isUsingSafeNumber: false,
        zipCode: "", address1: "", address2: "",
        shippingRequestType: 0, shippingRequest: "",
        isSmileBox: false, smileBoxBranchNo: 0, smileBoxBranchName: "",
        countryCode: "KR", countryName: "South Korea", countryType: "SouthKorea",
        overseaShippingCompany: "Unknown",
        fastDeliveryRequestInfo: { deliveryPickUpCode: "", deliveryPickUpType: "Unknown", deliveryPickUpDetail: "", isFreeEntry: false, deliveryNoticeCode: 0, addressNo: -1 },
      },
      smileDeliveryList: [],
      installReservationInfo: [],
      agreements: [
        { type: "Over14YearsOld", isAgreed: false },
        { type: "CollectingPersonalInfo", isAgreed: true },
        { type: "ProvidingPersonalInfo", isAgreed: true },
        { type: "EbayBuyerAgreement", isAgreed: false },
        { type: "ETradeAgreement", isAgreed: false },
        { type: "ProvidingSSGPointPersonalInfo", isAgreed: true },
        { type: "ProvidingGmarketPersonalInfo", isAgreed: true },
        { type: "CustomsClearance", isAgreed: true },
        { type: "ProvidingCustomsClearance", isAgreed: true },
        { type: "OverseasRelocation", isAgreed: true },
        { type: "TaxId", isAgreed: false },
        { type: "PassportNumber", isAgreed: false },
        { type: "TaiwanEntryAgreement", isAgreed: false },
        { type: "TaiwanSeparateDeclarationAgreement", isAgreed: false },
        { type: "PaypalOneClickPay", isAgreed: false },
      ],
      payment: {
        totalPaymentAmount: this.totalAmount,
        totalPrice: this.totalAmount,
        totalShippingFee: 0,
        totalItemPrice: unit?.itemPrice || this.totalAmount,
        totalDiscountPrice: (unit?.itemPrice || 0) - this.totalAmount,
        totalCouponPrice: 0,
        appliedSmileCash: 0,
        appliedPoints: [],
        siteLargeMethodCode: "100000003",
        siteMediumMethodCode: "200000009",
        siteSmallMethodCode: "300000030",
        paymentSettleCode: 26007,
        creditCard: {
          vanCardCompanyCode: "CCLG",
          cardPolicyNo: 0,
          policyTargetDate: "",
          installmentMonth: 0,
          isFreeInstallment: false,
          installmentPolicyNo: 0,
          useCardPoint: false,
          detailMethod: "MPI",
        },
        selectedExchange: "Unknown",
        authData: {
          mpi: {
            cardNumber: mpiCardNo,
            xid: mpiXid,
            eci: mpiEci,
            cavv: mpiCavv,
            kvpCardCode: mpiCardNo,
          },
          mcpInfo: {
            exchangeRateId: "",
            homeCurrency: "KRW",
            homeCurrencyNumber: "410",
            homeAmount: String(this.totalAmount),
            exchangeRate: "",
            invertedRate: "",
            tradeStatus: "1",
          },
        },
        fdsCheckoutNo: this.fdsCheckoutNo,
        fdsCollectInfoForSmilePay: {
          itemType: "L",
          shopCheckoutNo: this.fdsCheckoutNo,
          receiverName: member?.memberName || "",
          receiverZipCode: "",
          receiverAddress: "",
          languageType: "ko",
          deviceType: "M",
          mobileAppType: "G",
        },
      },
      expressShop: { branchDecisions: [] },
      cashback: { totalCashbackAmount: 0, sellerCashbackAmount: 0 },
    };

    // setOrders (addOrder 직전에 호출해야 함 — 할인 정보 포함)
    const setOrdersDiscounts = this.appliedDiscounts.map((d: any) => ({
      discountPolicyNo: d.discountPolicyNo,
      discountType: d.discountType,
      discountPrice: d.discountPrice,
      oldDiscountSubTypeCode: d.oldDiscountSubTypeCode || "SELLER",
      oldDiscountTypeCode: d.oldDiscountTypeCode || "GOODS",
    }));
    await this.httpPost(`${base}/checkout/setOrders`, { checkoutUnits: [{ checkoutUnitId: this.checkoutUnitId, availableDiscounts: setOrdersDiscounts, appliedCoupons: [] }] }, h);

    const orderRes = await this.httpPost(`${base}/order/addOrder`, addOrderBody, h);
    this.orderKey = orderRes.data?.data?.orderKey || "";
    if (!this.orderKey) throw new Error(`addOrder 실패: ${JSON.stringify(orderRes.data).substring(0, 300)}`);
    console.log(`[order] orderKey=${this.orderKey}`);

    // Poll getOrderPaymentStatus
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await this.httpPost(`${base}/order/getOrderPaymentStatus`, { orderKey: this.orderKey }, h);
      const sd = s.data?.data;
      if (sd?.paymentStatus === "succeeded") { this.paymentNo = sd.paymentNo; break; }
      if (sd?.paymentStatus === "failed") throw new Error("결제 실패: " + JSON.stringify(sd));
    }
    if (!this.paymentNo) throw new Error("결제 타임아웃");
    console.log(`[order] paymentNo=${this.paymentNo}`);

    // afterPayment
    await this.httpPost(`${base}/order/afterPayment`, {
      checkoutPageType: "Gift",
      env: { isApp: true, isMobile: true, languageType: "Korean" },
      paymentNo: this.paymentNo,
      orderKey: this.orderKey,
    }, h);

    // getOrders
    const ordersRes = await this.httpPost(`${base}/order/getOrders?paymentNo=${this.paymentNo}`, {}, h);
    const od = ordersRes.data?.data;
    this.giftKey = od?.orderGift?.giftKey || "";
    this.hashedPaymentNo = od?.hashedPaymentNo || "";

    // getEcouponInfo (PIN 발급에 시간이 걸릴 수 있으므로 재시도)
    let ecoupons: EcouponResult[] = [];
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2000));
      ecoupons = await this.getEcouponInfo();
      if (ecoupons.length > 0 && ecoupons[0].pins.length > 0 && ecoupons[0].pins[0].compCouponNo) break;
    }
    console.log(`[order] 완료: paymentNo=${this.paymentNo}, giftKey=${this.giftKey}, 쿠폰=${ecoupons.length}개`);
    return { orderKey: this.orderKey, paymentNo: this.paymentNo, giftKey: this.giftKey, hashedPaymentNo: this.hashedPaymentNo, ecoupons };
  }

  // ─── 5. E쿠폰 조회 ────────────────────────────────────────────────────

  async getEcouponInfo(): Promise<EcouponResult[]> {
    const res = await this.httpPost(
      "https://checkout.gmarket.co.kr/server/ko/m/api/ecoupon/getEcouponInfo",
      { paymentNo: this.paymentNo, hashedPaymentNo: this.hashedPaymentNo },
      this.webviewHeaders(),
    );
    return (res.data?.data || []).map((item: any) => ({
      contrNo: item.contrNo,
      orderNo: item.orderNo,
      couponServiceName: item.couponServiceName,
      pins: (item.ecouponPinList || []).map((pin: any) => ({
        compCouponNo: pin.compCouponNo, compAuthNo: pin.compAuthNo,
        state: pin.state, expireStartDate: pin.expireStartDate, expireEndDate: pin.expireEndDate,
      })),
    }));
  }

  // ─── 6. 전체 플로우 ────────────────────────────────────────────────────

  async runFullFlow(id: string, pw: string, itemCode: string, card: CardInfo, quantity = 1): Promise<OrderResult> {
    await this.init();
    try {
      await this.login(id, pw);
      await this.checkout(itemCode, quantity);
      await this.payWithShinhan(card);
      return await this.completePayment(card.cardNumber);
    } finally {
      await this.destroy();
    }
  }

  getState() {
    return { checkoutUnitId: this.checkoutUnitId, totalAmount: this.totalAmount, txKey: this.txKey, orderKey: this.orderKey, paymentNo: this.paymentNo, giftKey: this.giftKey, hashedPaymentNo: this.hashedPaymentNo };
  }

  // ─── Private: pareq ────────────────────────────────────────────────────

  private extractPareqs(html: string) {
    const p1 = html.match(/name="pareq1"[^>]*value="([^"]+)"/);
    if (!p1) return null;
    const p2 = html.match(/name="pareq2"[^>]*value="([^"]+)"/);
    const p3 = html.match(/name="pareq3"[^>]*value="([^"]+)"/);
    const p4 = html.match(/name="pareq4"[^>]*value="([^"]+)"/);
    if (!p2 || !p3 || !p4) return null;
    return { pareq1: p1[1], pareq2: p2[1], pareq3: p3[1], pareq4: p4[1] };
  }

  private async kcpPareqFlow(html: string) {
    const formDataMatch = html.match(/var formData = JSON\.parse\(JSON\.stringify\((\{.*?\})\)\)/s);
    if (!formDataMatch) return null;
    const formData = JSON.parse(formDataMatch[1]) as Record<string, string>;

    // 추가 필드 (dump 기반)
    if (!formData.goodname) formData.goodname = encodeURIComponent(this.checkoutData?.checkoutUnits?.[0]?.itemName || "");
    if (!formData.mall_app_name) formData.mall_app_name = "gmarket://";

    // Step 1: request_smart_comm.jsp
    const commBody = new URLSearchParams();
    for (const [k, v] of Object.entries(formData)) commBody.set(k, String(v ?? ""));

    const commRes = await this.httpPost("https://v3d.kcp.co.kr/XMPI/v3d/request_smart_comm.jsp", commBody.toString(), {
      "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://checkout.gmarket.co.kr", "Referer": "https://checkout.gmarket.co.kr/", "User-Agent": WEBVIEW_UA,
    });

    // Step 2: comm 응답에서 form action + hidden inputs 추출 → request_smart.jsp
    const commAction = commRes.raw.match(/action="([^"]+request_smart\.jsp[^"]*)"/)?.[1] || "https://v3d.kcp.co.kr/XMPI/v3d/request_smart.jsp";
    const commInputs = [...commRes.raw.matchAll(/name="([^"]+)"\s+value="([^"]*)"/g)];
    if (commInputs.length === 0) return null;

    const smartBody = new URLSearchParams();
    for (const m of commInputs) smartBody.set(m[1], m[2]);

    const smartRes = await this.httpPost(commAction, smartBody.toString(), {
      "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://v3d.kcp.co.kr", "Referer": "https://v3d.kcp.co.kr/", "User-Agent": WEBVIEW_UA,
    });

    // Step 3: pareq 추출
    const rp1 = smartRes.raw.match(/name="pareq1"[^>]*value="([^"]+)"/);
    const rp2 = smartRes.raw.match(/name="pareq2"[^>]*value="([^"]+)"/);
    const rp3 = smartRes.raw.match(/name="pareq3"[^>]*value="([^"]+)"/);
    const rp4 = smartRes.raw.match(/name="pareq4"[^>]*value="([^"]+)"/);
    if (!rp1 || !rp2 || !rp3 || !rp4) return null;
    return { pareq1: rp1[1], pareq2: rp2[1], pareq3: rp3[1], pareq4: rp4[1] };
  }

  // ─── Private: 신한카드 VBV ─────────────────────────────────────────────

  private async shinhanVbvAuth(pareqs: { pareq1: string; pareq2: string; pareq3: string; pareq4: string }, card: CardInfo): Promise<Record<string, string>> {
    const VBV = "https://vbv.shinhancard.com";
    const nppfs = new Nppfs();
    let jsid = "";
    const sUrl = (p: string) => `${VBV}${p}${jsid ? ";JSESSIONID=" + jsid : ""}`;
    const sh = (): Record<string, string> => ({ "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "Origin": VBV, "Referer": sUrl("/xacsv2/WAVTFX301.jsp"), "User-Agent": WEBVIEW_UA });

    const initKp = async () => { nppfs.genUuid(); const r = await this.httpPost(sUrl("/pluginfree/jsp/nppfs.keypad.jsp"), `m=p&u=${nppfs.uuid}`, sh()); nppfs.initKey(r.raw.trim()); };
    const makeKp = async (field: string, len: number, neededChars?: string): Promise<{ uuid: string; ki: string; map: Record<string, string> }> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const fid = "d" + Math.random().toString(16).substring(2, 19);
        const p = new URLSearchParams({ m: "e", u: nppfs.uuid, ev: "v4", d: "nppfs-keypad-div", jv: "1.13.0", t: "p", at: "r", st: "l", dp: "hide", ut: "f", f: fid, i: field, il: len.toString(), w: "1945", h: "1326", ar: "false", ip: sUrl("/pluginfree/jsp/nppfs.keypad.jsp") });
        const r = await this.httpPost(sUrl("/pluginfree/jsp/nppfs.keypad.jsp"), p.toString(), sh());
        const j = typeof r.data === "object" ? r.data : JSON.parse(r.raw.trim());
        let ki = ""; if (j.info.dynamic) for (const d of j.info.dynamic) if (d.k.startsWith("__KI_")) ki = d.v;
        const map: Record<string, string> = {};
        for (const item of j.items) {
          const imgUrl = j.info.src.startsWith("http") ? j.info.src : `${VBV}${j.info.src}`;
          const img = await this.httpGetBuf(imgUrl, { "Referer": sUrl("/xacsv2/WAVTFX301.jsp"), "User-Agent": WEBVIEW_UA });
          const groupMap = await solveKp(img, j.info.coords, item.buttons);
          Object.assign(map, groupMap);
        }
        // 9/10 매핑 시 나머지 1개 자동 추론
        if (Object.keys(map).length === 9) {
          const missingDigit = "0123456789".split("").find(d => !map[d]);
          const usedActions = new Set(Object.values(map));
          const allDataActions = (j.items[0]?.buttons || []).filter((b: any) => b?.action?.startsWith("data:")).map((b: any) => b.action.split(":")[1]);
          const unusedAction = allDataActions.find((a: string) => !usedActions.has(a));
          if (missingDigit && unusedAction) {
            map[missingDigit] = unusedAction;
          }
        }
        // 필요한 문자가 모두 매핑되었는지 확인
        if (neededChars) {
          const missing = [...neededChars].filter(c => !map[c]);
          if (missing.length > 0) {
            continue;
          }
        }
        return { uuid: j.info.keypadUuid, ki, map };
      }
      throw new Error(`키패드 OCR 실패: ${field}에서 필요한 문자를 10회 시도 후에도 인식 못함`);
    };

    // Session
    const introRes = await this.httpPost(`${VBV}/xacs/WBITFX201.do`, new URLSearchParams(pareqs as any).toString(), { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": WEBVIEW_UA }, { maxRedirects: 0 });
    const loc = introRes.headers.get("location") || "";
    const jsMatch = loc.match(/JSESSIONID=([^?&;]+)/);
    if (jsMatch) jsid = jsMatch[1];
    await this.httpGet(loc.startsWith("http") ? loc : `${VBV}${loc}`, { "User-Agent": WEBVIEW_UA });
    await this.httpPost(sUrl("/xacsv2/WBVTFX101.jsp"), "ktb_agent=", sh());
    await this.httpPost(sUrl("/xacsv2/WAVTFX300.jsp"), "cardInputPage=%2Fxacsv2%2FWAVTFX300.jsp&ktb_agent=", sh());

    // Card + CVC
    await this.httpGet(sUrl("/xacsv2/WAVTFX301.jsp"), { "User-Agent": WEBVIEW_UA });
    await initKp();
    const cn2 = card.cardNumber.substring(4, 8), cn3 = card.cardNumber.substring(8, 12);
    const kp2 = await makeKp("cardNum2", 4, cn2);
    const kp3 = await makeKp("cardNum3", 4, cn3);
    const kpC = await makeKp("inputCVC", 3, card.cvc);
    const cp = new URLSearchParams();
    cp.set("__E2E_KEYPAD__", nppfs.rsa); cp.set("__E2E_UNIQUE__", nppfs.uuid);
    cp.set(`__KH_${kp2.uuid}`, nppfs.encInput(cn2, kp2.map)); cp.set("__KI_cardNum2", kp2.ki || nppfs.encInput(cn2, kp2.map)); cp.set(`__KU_${kp2.uuid}`, "Y");
    cp.set(`__KH_${kp3.uuid}`, nppfs.encInput(cn3, kp3.map)); cp.set("__KI_cardNum3", kp3.ki || nppfs.encInput(cn3, kp3.map)); cp.set(`__KU_${kp3.uuid}`, "Y");
    cp.set(`__KH_${kpC.uuid}`, nppfs.encInput(card.cvc, kpC.map)); cp.set("__KI_inputCVC", kpC.ki || nppfs.encInput(card.cvc, kpC.map)); cp.set(`__KU_${kpC.uuid}`, "Y");
    cp.set("mode", "KEYCRYPT"); cp.set("cardNum1", card.cardNumber.substring(0, 4));
    cp.set("cardNum2", cn2); cp.set("cardNum3", cn3); cp.set("cardNum4", card.cardNumber.substring(12, 16)); cp.set("inputCVC", card.cvc);
    const cardRes = await this.httpPost(sUrl("/xacsv2/WAVTFX202.do"), cp.toString(), sh());
    if (cardRes.data?.rsCode !== "0000") throw new Error(`카드인증 실패: ${cardRes.data?.rsCodeMessage}`);

    const isCorporate = (cardRes.data?.sendRedirectPage || "").includes("WAVTFX308");

    if (isCorporate) {
      await this.httpGet(sUrl("/xacsv2/WAVTFX308.jsp"), { "User-Agent": WEBVIEW_UA });
      await initKp();
      const kpP = await makeKp("pinNo", 16, card.pin);
      const iP = new URLSearchParams();
      iP.set("__E2E_KEYPAD__", nppfs.rsa); iP.set("__E2E_UNIQUE__", nppfs.uuid);
      iP.set(`__KH_${kpP.uuid}`, nppfs.encInput(card.pin, kpP.map)); iP.set("__KI_pinNo", kpP.ki || nppfs.encInput(card.pin, kpP.map)); iP.set(`__KU_${kpP.uuid}`, "Y");
      iP.set("mode", "KEYCRYPT"); iP.set("cert_type", "CP"); iP.set("cert_type_1", "CP"); iP.set("pinNo", card.pin); iP.set("TS_PCD", "903");
      const authRes = await this.httpPost(sUrl("/xacsv2/WAVTFX206.do"), iP.toString(), sh(), { maxRedirects: 0 });
      return this.extractMpiReturnFromRedirect(authRes);
    } else {
      await this.httpGet(sUrl("/xacsv2/WAVTFX302.jsp"), { "User-Agent": WEBVIEW_UA });
      await initKp();
      const kpP = await makeKp("pinNo", 6);
      const pp = new URLSearchParams();
      pp.set("__E2E_KEYPAD__", nppfs.rsa); pp.set("__E2E_UNIQUE__", nppfs.uuid);
      pp.set(`__KH_${kpP.uuid}`, nppfs.encInput(card.pin, kpP.map)); pp.set("__KI_pinNo", kpP.ki || nppfs.encInput(card.pin, kpP.map)); pp.set(`__KU_${kpP.uuid}`, "Y");
      pp.set("mode", "KEYCRYPT"); pp.set("pinNo", card.pin);
      const pinRes = await this.httpPost(sUrl("/xacsv2/WAVTFX203.do"), pp.toString(), sh());
      if (pinRes.data?.rsCode !== "0000") throw new Error(`PIN 실패: ${pinRes.data?.rsCodeMessage}`);

      await this.httpGet(sUrl("/xacsv2/WAVTFX303.jsp"), { "User-Agent": WEBVIEW_UA });
      await initKp();
      const kpPw = await makeKp("cdpass", 4);
      const iP = new URLSearchParams();
      iP.set("__E2E_KEYPAD__", nppfs.rsa); iP.set("__E2E_UNIQUE__", nppfs.uuid);
      iP.set(`__KH_${kpPw.uuid}`, nppfs.encInput(card.cardPassword || "", kpPw.map)); iP.set("__KI_cdpass", kpPw.ki || nppfs.encInput(card.cardPassword || "", kpPw.map)); iP.set(`__KU_${kpPw.uuid}`, "Y");
      iP.set("mode", "KEYCRYPT"); iP.set("cert_type", "P"); iP.set("cdpass", card.cardPassword || "");
      await this.httpPost(sUrl("/xacsv2/WAVTFX204.do"), iP.toString(), sh());
      const authRes = await this.httpPost(sUrl("/xacsv2/WAVTFX206.do"), iP.toString(), sh(), { maxRedirects: 0 });
      return this.extractMpiReturnFromRedirect(authRes);
    }
  }

  private async extractMpiReturnFromRedirect(authRes: HttpRes): Promise<Record<string, string>> {
    let mpiReturn: Record<string, string> = {};
    const loc = authRes.headers.get("location") || "";
    if (loc) {
      const cbRes = await this.httpGet(loc.startsWith("http") ? loc : `https://vbv.shinhancard.com${loc}`, { "User-Agent": WEBVIEW_UA });
      // MBVTFX320: form action = result_smart.jsp URL, inputs = r0~r4
      const formAction = cbRes.raw.match(/action="([^"]+)"/)?.[1] || "";
      const re = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(cbRes.raw)) !== null) mpiReturn[m[1]] = m[2];
      if (formAction) mpiReturn._resultSmartUrl = formAction;
    }
    return mpiReturn;
  }
}

