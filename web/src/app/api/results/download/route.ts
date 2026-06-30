import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

export async function GET(request: NextRequest) {
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || request.headers.get("x-client-ip")
    || "unknown";
  const downloadedAt = new Date().toISOString();

  const resultsDir = path.resolve(process.cwd(), "..", "results");
  const logsDir = path.join(resultsDir, "logs");

  if (!fs.existsSync(resultsDir)) {
    return NextResponse.json({ error: "결과 폴더가 없습니다." }, { status: 404 });
  }

  const allResults: Array<{
    timestamp: string;
    gmarket_id: string;
    item_code: string;
    quantity: string;
    success: string;
    orderKey: string;
    pins: string;
    error: string;
  }> = [];

  const metaFiles = fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).filter((f) => f.endsWith(".meta.json")).sort().reverse()
    : [];

  for (const metaFile of metaFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(logsDir, metaFile), "utf8"));
      const timestamp = meta.startedAt || metaFile.replace(".meta.json", "");
      const results = meta.results || [];

      for (const r of results) {
        allResults.push({
          timestamp,
          gmarket_id: r.gmarket_id || "",
          item_code: r.item_code || "",
          quantity: meta.quantity || "1",
          success: r.success ? "성공" : "실패",
          orderKey: r.orderKey || "",
          pins: (r.pins || []).join("\n"),
          error: r.error || "",
        });
      }
    } catch {}
  }

  if (allResults.length === 0) {
    const summaryFiles = fs.readdirSync(resultsDir)
      .filter((f) => f.startsWith("summary_") && f.endsWith(".json"))
      .sort().reverse();

    for (const sf of summaryFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(resultsDir, sf), "utf8"));
        const timestamp = sf.replace("summary_", "").replace(".json", "");
        const items = Array.isArray(data) ? data : [data];
        for (const r of items) {
          allResults.push({
            timestamp,
            gmarket_id: r.gmarket_id || "",
            item_code: r.item_code || "",
            quantity: "1",
            success: r.success ? "성공" : "실패",
            orderKey: r.orderKey || "",
            pins: (r.pins || []).join("\n"),
            error: r.error || "",
          });
        }
      } catch {}
    }
  }

  if (allResults.length === 0) {
    return NextResponse.json({ error: "다운로드할 결과가 없습니다." }, { status: 404 });
  }

  const wsData = [
    ["실행시간", "계정ID", "상품코드", "수량", "결과", "주문번호", "PIN", "에러"],
    ...allResults.map((r) => [
      r.timestamp, r.gmarket_id, r.item_code, r.quantity,
      r.success, r.orderKey, r.pins, r.error,
    ]),
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  ws["!cols"] = [
    { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 6 },
    { wch: 6 }, { wch: 20 }, { wch: 30 }, { wch: 40 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, "결과");

  wb.Props = {
    Title: "결제 결과",
    Author: clientIp,
    Comments: `Downloaded by ${clientIp} at ${downloadedAt}`,
    LastAuthor: clientIp,
    Company: clientIp,
    CreatedDate: new Date(),
  };

  const wmSheet = XLSX.utils.aoa_to_sheet([
    ["다운로드 IP", clientIp],
    ["다운로드 시각", downloadedAt],
    ["워터마크", `이 파일은 ${clientIp}에 의해 ${downloadedAt}에 다운로드되었습니다.`],
  ]);
  wmSheet["!cols"] = [{ wch: 14 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wmSheet, "_watermark");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const itemCodes = [...new Set(allResults.map((r) => r.item_code).filter(Boolean))];
  const itemCodeStr = itemCodes.join("_") || "unknown";
  const totalQty = allResults.reduce((sum, r) => sum + (parseInt(r.quantity) || 1), 0);
  const filename = `${dateStr}_${itemCodeStr}_${totalQty}건.xlsx`;

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
