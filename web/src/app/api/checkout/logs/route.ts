import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.resolve(process.cwd(), "..", "results", "logs");

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const logId = searchParams.get("id");
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  if (!logId) {
    return getLogList();
  }

  return getLogContent(logId, offset);
}

function getLogList() {
  if (!fs.existsSync(LOG_DIR)) {
    return NextResponse.json({ logs: [] });
  }

  const metaFiles = fs.readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".meta.json"))
    .sort()
    .reverse();

  const logs = metaFiles.slice(0, 20).map((f) => {
    const content = fs.readFileSync(path.join(LOG_DIR, f), "utf8");
    return JSON.parse(content);
  });

  return NextResponse.json({ logs });
}

function getLogContent(logId: string, offset: number) {
  const logFile = path.join(LOG_DIR, `${logId}.log`);
  const metaFile = path.join(LOG_DIR, `${logId}.meta.json`);

  if (!fs.existsSync(logFile)) {
    return NextResponse.json({ error: "로그를 찾을 수 없습니다." }, { status: 404 });
  }

  const content = fs.readFileSync(logFile, "utf8");
  const newContent = content.slice(offset);

  let meta = null;
  if (fs.existsSync(metaFile)) {
    meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  }

  return NextResponse.json({
    logId,
    content: newContent,
    totalLength: content.length,
    offset,
    meta,
  });
}
