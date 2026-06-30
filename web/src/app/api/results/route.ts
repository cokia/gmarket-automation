import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

export async function GET() {
  const resultsDir = path.resolve(process.cwd(), "..", "results");

  if (!fs.existsSync(resultsDir)) {
    return NextResponse.json({ results: [] });
  }

  const files = fs.readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 50);

  const results = files.map((f) => {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8"));
      return { filename: f, data: content };
    } catch {
      return { filename: f, data: null };
    }
  });

  return NextResponse.json({ results });
}
