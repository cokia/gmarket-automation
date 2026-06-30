"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { InlineWatermark } from "@/components/inline-watermark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface ResultFile {
  filename: string;
  data: unknown;
}

export default function ResultsPage() {
  const [results, setResults] = useState<ResultFile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/results")
      .then((r) => r.json())
      .then((d) => setResults(d.results || []))
      .finally(() => setLoading(false));
  }, []);

  const handleDownload = () => {
    window.location.href = "/api/results/download";
  };

  return (
    <main className="flex-1 p-6 lg:p-8 max-w-6xl mx-auto w-full space-y-8">
      <header className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
            결과 히스토리
          </h1>
          <p className="text-sm text-muted-foreground">{results.length}건의 실행 기록</p>
        </div>
        <div className="flex items-center gap-2">
          <InlineWatermark />
          <Button
            variant="default"
            size="sm"
            onClick={handleDownload}
            disabled={results.length === 0}
            className="shadow-md shadow-primary/20"
          >
            엑셀 다운로드
          </Button>
          <Link href="/">
            <Button variant="ghost" size="sm">← 결제 페이지</Button>
          </Link>
        </div>
      </header>

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          <span className="text-sm">로딩 중...</span>
        </div>
      )}

      {!loading && results.length === 0 && (
        <Card className="border-border/50">
          <CardContent className="p-12 text-center space-y-2">
            <p className="text-muted-foreground">아직 결과가 없습니다</p>
            <p className="text-xs text-muted-foreground/70">결제를 실행하면 여기에 기록됩니다</p>
          </CardContent>
        </Card>
      )}

      {!loading && results.length > 0 && (
        <div className="space-y-3">
          {results.map((r) => (
            <Card key={r.filename} className="border-border/50 shadow-sm hover:shadow-md transition-shadow">
              <CardHeader className="pb-2 cursor-pointer">
                <details>
                  <summary className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors">
                    {r.filename}
                  </summary>
                  <pre className="mt-3 text-xs overflow-auto bg-black/20 p-4 rounded-lg max-h-80 text-muted-foreground leading-relaxed">
                    {JSON.stringify(r.data, null, 2)}
                  </pre>
                </details>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
