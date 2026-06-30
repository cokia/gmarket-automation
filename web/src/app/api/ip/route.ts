import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const ip = request.headers.get("x-client-ip") || "unknown";
  return NextResponse.json({ ip });
}
