"use client";

import { useState, useEffect } from "react";

export function Watermark() {
  const [ip, setIp] = useState("");
  const [time, setTime] = useState("");

  useEffect(() => {
    fetch("https://ipv4-check-perf.radar.cloudflare.com/")
      .then((r) => r.json())
      .then((d) => setIp(d.ip_address || ""))
      .catch(() => {
        fetch("/api/ip")
          .then((r) => r.json())
          .then((d) => setIp(d.ip || ""));
      });
  }, []);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTime(
        now.toLocaleString("ko-KR", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!ip && !time) return null;

  const text = `${time}  ${ip}`;

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden select-none"
      aria-hidden="true"
    >
      <div className="absolute inset-0 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 -rotate-[22deg] scale-[1.8] origin-center leading-none">
        {Array.from({ length: 300 }).map((_, i) => (
          <span
            key={i}
            className="text-[8px] font-mono text-foreground/[0.04] whitespace-nowrap tracking-wide"
          >
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}
