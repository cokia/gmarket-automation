import { NextRequest, NextResponse } from "next/server";

const ALLOWED_IPS = [
  "1.209.169.130",
  "127.0.0.1",
  "::1",
];

function getClientIp(request: NextRequest): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "127.0.0.1";
}

export function middleware(request: NextRequest) {
  const ip = getClientIp(request);
  const normalizedIp = ip === "::ffff:127.0.0.1" ? "127.0.0.1" : ip;

  const response = NextResponse.next();
  response.headers.set("x-client-ip", normalizedIp);

  if (!ALLOWED_IPS.includes(normalizedIp)) {
    return new NextResponse(
      `<!DOCTYPE html><html><head><title>403</title></head><body style="background:#0d0f1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui"><div style="text-align:center"><h1 style="font-size:4rem;margin:0;opacity:0.3">403</h1><p>접근이 거부되었습니다</p><p style="opacity:0.5;font-size:0.8rem">IP: ${normalizedIp}</p></div></body></html>`,
      {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/ip).*)",
  ],
};
