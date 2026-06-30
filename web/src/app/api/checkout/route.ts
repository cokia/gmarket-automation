import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PROJECT_ROOT = process.env.PROJECT_ROOT || "/app";
const LOG_DIR = path.join(PROJECT_ROOT, "results", "logs");

interface AccountRow {
  gmarket_id: string;
  gmarket_pw: string;
  card_number: string;
  cvc: string;
  pin: string;
  card_password: string;
  card_type: "corporate" | "personal";
  item_code: string;
  quantity: string;
  proxy?: string;
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function createLogId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-") + "_" + Math.random().toString(36).slice(2, 8);
}

function runBatchProcess(rows: AccountRow[], tmpCsv: string, logId: string) {
  const logFile = path.join(LOG_DIR, `${logId}.log`);
  const metaFile = path.join(LOG_DIR, `${logId}.meta.json`);
  const projectRoot = PROJECT_ROOT;

  const args = ["tsx", "batch-pay.ts", `--csv=${tmpCsv}`];

  const child = spawn("npx", args, {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "production" },
  });

  let stdout = "";

  child.stdout.on("data", (data: Buffer) => {
    const text = data.toString();
    stdout += text;
    fs.appendFileSync(logFile, text);
  });

  child.stderr.on("data", (data: Buffer) => {
    fs.appendFileSync(logFile, `[STDERR] ${data.toString()}`);
  });

  child.on("close", (code) => {
    try { fs.unlinkSync(tmpCsv); } catch {}
    const completedAt = new Date().toISOString();
    fs.appendFileSync(logFile, `\n[${completedAt}] 배치 결제 완료 (exit code: ${code})\n`);

    const results = parseResults(rows, stdout);

    const resultDir = path.resolve(projectRoot, "results");
    for (const r of results) {
      if (r.success && !r.pins?.length) {
        try {
          const resultFiles = fs.readdirSync(resultDir)
            .filter((f) => f.includes(r.gmarket_id) && f.endsWith(".json") && !f.startsWith("summary"))
            .sort()
            .reverse();
          if (resultFiles.length > 0) {
            const data = JSON.parse(fs.readFileSync(path.join(resultDir, resultFiles[0]), "utf8"));
            if (data.ecoupons) {
            r.pins = data.ecoupons.flatMap((ec: { pins: { compCouponNo: string; compAuthNo?: string }[] }) =>
                ec.pins.map((p) => p.compAuthNo ? `${p.compCouponNo}/${p.compAuthNo}` : p.compCouponNo)
            );
            }
            if (data.orderKey) r.orderKey = data.orderKey;
          }
        } catch {}
      }
    }

    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    meta.status = code === 0 ? "completed" : "failed";
    meta.completedAt = completedAt;
    meta.results = results;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  });

  child.on("error", (err) => {
    fs.appendFileSync(logFile, `[ERROR] ${err.message}\n`);
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    meta.status = "failed";
    meta.completedAt = new Date().toISOString();
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  });

  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGTERM");
      fs.appendFileSync(logFile, `[TIMEOUT] 120초 초과로 강제 종료\n`);
    }
  }, 120000);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { rows } = body as { rows: AccountRow[] };

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: "계정 정보가 없습니다." }, { status: 400 });
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.gmarket_id || !row.gmarket_pw || !row.card_number || !row.cvc || !row.pin || !row.item_code) {
        return NextResponse.json(
          { error: `[${i + 1}번] 필수 필드가 비어있습니다.` },
          { status: 400 }
        );
      }
    }

    const csvHeader = "gmarket_id,gmarket_pw,card_number,cvc,pin,card_password,card_type,item_code,quantity,proxy";
    const csvRows = rows.map((r) =>
      [r.gmarket_id, r.gmarket_pw, r.card_number, r.cvc, r.pin, r.card_password || "", r.card_type, r.item_code, r.quantity || "1", r.proxy || ""].join(",")
    );
    const csvContent = [csvHeader, ...csvRows].join("\n");

    const tmpCsv = path.join(os.tmpdir(), `gmarket-batch-${Date.now()}.csv`);
    fs.writeFileSync(tmpCsv, csvContent);

    ensureLogDir();
    const logId = createLogId();
    const logFile = path.join(LOG_DIR, `${logId}.log`);
    const metaFile = path.join(LOG_DIR, `${logId}.meta.json`);

    const meta = {
      logId,
      startedAt: new Date().toISOString(),
      accounts: rows.map((r) => r.gmarket_id),
      itemCode: rows[0]?.item_code,
      quantity: rows[0]?.quantity || "1",
      status: "running",
      completedAt: null as string | null,
      results: null as unknown,
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    fs.writeFileSync(logFile, `[${meta.startedAt}] 배치 결제 시작 (${rows.length}건)\n`);

    runBatchProcess(rows, tmpCsv, logId);

    return NextResponse.json({ logId, status: "started" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseResults(rows: AccountRow[], stdout: string): Array<{
  index: number;
  gmarket_id: string;
  item_code: string;
  success: boolean;
  orderKey?: string;
  pins?: string[];
  error?: string;
}> {
  const results = [];
  const lines = stdout.split("\n");

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const marker = `[${i + 1}]`;

    const sectionStart = lines.findIndex((l) => l.includes(marker) && l.includes("──"));
    if (sectionStart === -1) {
      results.push({
        index: i,
        gmarket_id: row.gmarket_id,
        item_code: row.item_code,
        success: false,
        error: extractRawError(stdout, i),
      });
      continue;
    }

    const nextSection = lines.findIndex((l, idx) => idx > sectionStart && l.includes("──") && l.includes(`[${i + 2}]`));
    const sectionLines = lines.slice(sectionStart, nextSection === -1 ? undefined : nextSection);
    const section = sectionLines.join("\n");

    const successLine = sectionLines.find((l) => l.includes("✓ 성공"));
    const failLine = sectionLines.find((l) => l.includes("✗ 실패"));
    const dryRunLine = sectionLines.find((l) => l.includes("[DRY-RUN]"));

    if (dryRunLine) {
      results.push({
        index: i,
        gmarket_id: row.gmarket_id,
        item_code: row.item_code,
        success: true,
      });
    } else if (successLine) {
      const orderKeyMatch = successLine.match(/orderKey=([^,\s]+)/);
      const pinMatch = successLine.match(/PIN=(.+)$/);
      results.push({
        index: i,
        gmarket_id: row.gmarket_id,
        item_code: row.item_code,
        success: true,
        orderKey: orderKeyMatch?.[1],
        pins: pinMatch ? pinMatch[1].split(",").map((s) => s.trim()) : [],
      });
    } else if (failLine) {
      const errorMsg = failLine.replace(/.*✗ 실패:\s*/, "").trim();
      results.push({
        index: i,
        gmarket_id: row.gmarket_id,
        item_code: row.item_code,
        success: false,
        error: errorMsg,
      });
    } else {
      const stderrLines = sectionLines.filter((l) => l.includes("[STDERR]") || l.includes("Error") || l.includes("error"));
      const errorDetail = stderrLines.length > 0
        ? stderrLines.map((l) => l.replace("[STDERR] ", "")).join(" | ").slice(0, 300)
        : section.trim().slice(-200);
      results.push({
        index: i,
        gmarket_id: row.gmarket_id,
        item_code: row.item_code,
        success: false,
        error: errorDetail || "알 수 없는 에러 (로그 확인 필요)",
      });
    }
  }

  return results;
}

function extractRawError(stdout: string, index: number): string {
  const lines = stdout.split("\n");
  const errorLines = lines.filter((l) =>
    l.includes("Error") || l.includes("error") || l.includes("STDERR") || l.includes("실패")
  );
  if (errorLines.length > 0) {
    return errorLines.slice(0, 3).join(" | ").slice(0, 300);
  }
  return `계정 ${index + 1}: 실행 로그에서 결과를 찾을 수 없음 (로그 확인 필요)`;
}
