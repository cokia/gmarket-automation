import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

export async function GET() {
  const wsData = [
    ["아이디", "비밀번호", "프록시아이피"],
    ["gmarket_id_1", "password123", "123.123.123.123:1234"],
    ["gmarket_id_2", "password456", ""],
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  ws["!cols"] = [
    { wch: 20 },
    { wch: 20 },
    { wch: 24 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, "계정목록");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="upload-template.xlsx"',
    },
  });
}
