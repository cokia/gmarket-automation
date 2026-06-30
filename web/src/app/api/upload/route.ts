import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "파일이 없습니다." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "" });

    if (rows.length === 0) {
      return NextResponse.json({ error: "엑셀에 데이터가 없습니다." }, { status: 400 });
    }

    const headerMap: Record<string, string> = {
      "아이디": "gmarket_id",
      "id": "gmarket_id",
      "gmarket_id": "gmarket_id",
      "비번": "gmarket_pw",
      "비밀번호": "gmarket_pw",
      "pw": "gmarket_pw",
      "password": "gmarket_pw",
      "gmarket_pw": "gmarket_pw",
      "프록시": "proxy",
      "프록시아이피": "proxy",
      "proxy": "proxy",
      "proxy_ip": "proxy",
    };

    const accounts = rows.map((row, i) => {
      const mapped: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) {
        const normalizedKey = key.trim().toLowerCase();
        const targetField = headerMap[normalizedKey];
        if (targetField) {
          mapped[targetField] = String(value).trim();
        }
      }
      return {
        id: crypto.randomUUID(),
        label: mapped.gmarket_id || `계정${i + 1}`,
        gmarket_id: mapped.gmarket_id || "",
        gmarket_pw: mapped.gmarket_pw || "",
        proxy: mapped.proxy || "",
      };
    }).filter((a) => a.gmarket_id && a.gmarket_pw);

    if (accounts.length === 0) {
      return NextResponse.json(
        { error: "유효한 계정 데이터가 없습니다. 엑셀에 '아이디', '비밀번호' 컬럼이 필요합니다." },
        { status: 400 },
      );
    }

    return NextResponse.json({ accounts, total: accounts.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "파일 파싱 오류";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
