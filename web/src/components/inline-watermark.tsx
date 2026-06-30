"use client";

import { useState, useEffect } from "react";

export function InlineWatermark({ className = "" }: { className?: string }) {
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
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      );
    };
    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, []);

  if (!ip && !time) return null;

  const text = `${time} ${ip}`;

  return (
    <span
      className={`pointer-events-none select-none text-[7px] font-mono text-foreground/[0.06] whitespace-nowrap ${className}`}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}
