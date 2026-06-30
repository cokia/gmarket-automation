"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAccounts, type SavedAccount } from "@/lib/use-accounts";
import { InlineWatermark } from "@/components/inline-watermark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

interface CheckoutResult {
  index: number;
  gmarket_id: string;
  item_code: string;
  success: boolean;
  orderKey?: string;
  paymentNo?: number;
  pins?: string[];
  error?: string;
}

export default function Home() {
  const { accounts, loaded, add, update, remove, removeAll } = useAccounts();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [itemCode, setItemCode] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CheckoutResult[]>([]);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [logId, setLogId] = useState<string | null>(null);
  const [logContent, setLogContent] = useState("");
  const logOffsetRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [cardNumber, setCardNumber] = useState("");
  const [cardCvc, setCardCvc] = useState("");
  const [cardPin, setCardPin] = useState("");
  const [cardPassword, setCardPassword] = useState("");
  const [cardType, setCardType] = useState<"corporate" | "personal">("corporate");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("gmarket-card");
      if (saved) {
        const { cardNumber: cn, cardCvc: cc, cardType: ct } = JSON.parse(saved);
        if (cn) setCardNumber(cn);
        if (cc) setCardCvc(cc);
        if (ct) setCardType(ct);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem("gmarket-card", JSON.stringify({ cardNumber, cardCvc, cardType }));
  }, [cardNumber, cardCvc, cardType, loaded]);

  const toggleAccount = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    if (selectedIds.length === accounts.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(accounts.map((a) => a.id));
    }
  };

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "업로드 실패");
      } else {
        const added = add(data.accounts);
        const skipped = data.accounts.length - (added || 0);
        if (skipped > 0) {
          setError(`${skipped}개 중복 계정 제외됨`);
        }
        const current = data.accounts.filter((a: { gmarket_id: string }) =>
          !accounts.some((e) => e.gmarket_id === a.gmarket_id)
        );
        setSelectedIds((prev) => [...prev, ...current.map((a: { id: string }) => a.id)]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "업로드 오류");
    }
    e.target.value = "";
  };

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback((id: string) => {
    stopPolling();
    logOffsetRef.current = 0;
    setLogContent("");
    setLogId(id);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/checkout/logs?id=${id}&offset=${logOffsetRef.current}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.content) {
          setLogContent((prev) => prev + data.content);
          logOffsetRef.current = data.totalLength;
        }
        if (data.meta?.status && data.meta.status !== "running") {
          stopPolling();
          setRunning(false);
          if (data.meta.results) {
            setResults(data.meta.results);
          }
        }
      } catch {}
    }, 1000);
  }, [stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleSubmit = async () => {
    if (!itemCode || selectedIds.length === 0 || !cardNumber) return;
    setRunning(true);
    setResults([]);
    setError("");

    const rows = selectedIds
      .map((id) => accounts.find((a) => a.id === id))
      .filter(Boolean)
      .map((a) => ({
        gmarket_id: a!.gmarket_id,
        gmarket_pw: a!.gmarket_pw,
        card_number: cardNumber,
        cvc: cardCvc,
        pin: cardPin,
        card_password: cardPassword,
        card_type: cardType,
        item_code: itemCode,
        quantity: quantity,
        proxy: a!.proxy || "",
      }));

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "요청 실패");
        setRunning(false);
      } else if (data.logId) {
        startPolling(data.logId);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "네트워크 오류");
      setRunning(false);
    }
  };

  if (!loaded) return null;

  return (
    <main className="flex-1 p-6 lg:p-8 max-w-6xl mx-auto w-full space-y-8">
      <header className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
            지마켓 결제 자동화 시스템
          </h1>
          <p className="text-sm text-muted-foreground">퍼스트페이/퍼스트핀 전용</p>
        </div>
        <div className="flex items-center gap-3">
          <InlineWatermark />
          <Link href="/results">
            <Button variant="outline" size="sm" className="gap-1.5">
              결과 히스토리
              <span className="text-xs">→</span>
            </Button>
          </Link>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card className="border-border/50 shadow-lg shadow-black/5">
          <CardHeader className="flex flex-row items-center justify-between pb-4 border-b border-border/50">
            <div className="space-y-0.5">
              <CardTitle className="text-base font-semibold">계정 관리</CardTitle>
              <p className="text-xs text-muted-foreground">{accounts.length}개 등록됨 · {selectedIds.length}개 선택</p>
            </div>
            <div className="flex items-center gap-2">
              <InlineWatermark className="mr-2" />
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleExcelUpload}
              />
              <Button size="sm" variant="ghost" className="text-xs h-8" onClick={() => fileInputRef.current?.click()}>
                엑셀 업로드
              </Button>
              <Button size="sm" variant="ghost" className="text-xs h-8" onClick={() => { window.location.href = "/api/upload/template"; }}>
                양식 다운로드
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs h-8 text-destructive/70 hover:text-destructive"
                onClick={() => { removeAll(); setSelectedIds([]); }}
                disabled={accounts.length === 0}
              >
                전체 삭제
              </Button>
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger>
                  <Button size="sm" className="h-8 text-xs">+ 추가</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>계정 추가</DialogTitle>
                  </DialogHeader>
                  <AccountForm
                    onSave={(a) => { add(a); setDialogOpen(false); }}
                  />
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {accounts.length === 0 ? (
              <div className="p-12 text-center space-y-2">
                <p className="text-sm text-muted-foreground">등록된 계정이 없습니다</p>
                <p className="text-xs text-muted-foreground/70">엑셀 업로드 또는 직접 추가하세요</p>
              </div>
            ) : (
              <div className="overflow-auto max-h-[400px]">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent border-b border-border/30">
                      <TableHead className="w-10">
                        <Checkbox
                          checked={selectedIds.length === accounts.length && accounts.length > 0}
                          onCheckedChange={toggleAll}
                        />
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wider text-muted-foreground/80">라벨</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider text-muted-foreground/80">ID</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider text-muted-foreground/80">비밀번호</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider text-muted-foreground/80">프록시</TableHead>
                      <TableHead className="w-14"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((a) => (
                      <TableRow key={a.id} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.includes(a.id)}
                            onCheckedChange={() => toggleAccount(a.id)}
                          />
                        </TableCell>
                        <TableCell className="font-medium text-sm">{a.label}</TableCell>
                        <TableCell className="text-sm text-muted-foreground font-mono">{a.gmarket_id}</TableCell>
                        <TableCell className="text-sm text-muted-foreground font-mono">{a.gmarket_pw}</TableCell>
                        <TableCell className="text-xs text-muted-foreground/70 font-mono">{a.proxy || "—"}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive/70 hover:text-destructive h-7 px-2 text-xs"
                            onClick={() => remove(a.id)}
                          >
                            삭제
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-border/50 shadow-lg shadow-black/5">
            <CardHeader className="pb-4 border-b border-border/50">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">주문 설정</CardTitle>
                <InlineWatermark />
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="item-code">상품코드</Label>
                <Input
                  id="item-code"
                  placeholder="예: 4551232530"
                  value={itemCode}
                  onChange={(e) => setItemCode(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="quantity">수량 (계정당)</Label>
                <Input
                  id="quantity"
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <Separator className="opacity-30" />
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">결제 카드</p>
              <div className="space-y-2">
                <Label htmlFor="card-number">카드번호</Label>
                <Input
                  id="card-number"
                  placeholder="16자리"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label htmlFor="card-cvc">CVC</Label>
                  <Input id="card-cvc" value={cardCvc} onChange={(e) => setCardCvc(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="card-pin">일반결제비밀번호 (6자리)</Label>
                  <Input id="card-pin" value={cardPin} onChange={(e) => setCardPin(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>카드유형</Label>
                <Select value={cardType} onValueChange={(v) => setCardType((v ?? "corporate") as "corporate" | "personal")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="corporate">법인</SelectItem>
                    <SelectItem value="personal">개인</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {cardType === "personal" && (
                <div className="space-y-2">
                  <Label htmlFor="card-pw">카드비밀번호</Label>
                  <Input id="card-pw" type="password" placeholder="앞 2자리" value={cardPassword} onChange={(e) => setCardPassword(e.target.value)} />
                </div>
              )}
              <Separator className="opacity-30" />
              <Button
                className="w-full h-11 font-semibold shadow-md shadow-primary/20 transition-all hover:shadow-lg hover:shadow-primary/30"
                disabled={running || !itemCode || !cardNumber || selectedIds.length === 0}
                onClick={handleSubmit}
              >
                {running
                  ? "처리 중..."
                  : `${selectedIds.length}개 계정 결제 실행`}
              </Button>
              {selectedIds.length === 0 && accounts.length > 0 && (
                <p className="text-xs text-muted-foreground text-center">
                  왼쪽에서 계정을 선택하세요
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5 shadow-lg shadow-destructive/5">
          <CardContent className="p-4 text-sm text-destructive font-medium">{error}</CardContent>
        </Card>
      )}

      {logContent && <ExecutionLog content={logContent} running={running} />}

      {results.length > 0 && <ResultsTable results={results} />}
    </main>
  );
}

function AccountForm({ onSave }: { onSave: (a: SavedAccount) => void }) {
  const [form, setForm] = useState({
    label: "",
    gmarket_id: "",
    gmarket_pw: "",
    proxy: "",
  });

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ id: crypto.randomUUID(), ...form });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label>라벨 (구분용)</Label>
        <Input placeholder="예: 계정1" value={form.label} onChange={(e) => set("label", e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>지마켓 ID</Label>
        <Input value={form.gmarket_id} onChange={(e) => set("gmarket_id", e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>비밀번호</Label>
        <Input type="password" value={form.gmarket_pw} onChange={(e) => set("gmarket_pw", e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>프록시 (선택)</Label>
        <Input placeholder="123.123.123.123:1234" value={form.proxy} onChange={(e) => set("proxy", e.target.value)} />
      </div>
      <Button type="submit" className="w-full">저장</Button>
    </form>
  );
}

function ExecutionLog({ content, running }: { content: string; running: boolean }) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [content]);

  return (
    <Card className="border-border/50 shadow-lg shadow-black/5">
      <CardHeader className="pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base font-semibold">실행 로그</CardTitle>
          {running && (
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              <span className="text-xs text-muted-foreground">실행 중</span>
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <pre className="bg-black/20 p-4 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-80 rounded-b-lg text-muted-foreground leading-relaxed">
          {content}
          <div ref={logEndRef} />
        </pre>
      </CardContent>
    </Card>
  );
}

function ResultsTable({ results }: { results: CheckoutResult[] }) {
  const success = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  return (
    <Card className="border-border/50 shadow-lg shadow-black/5">
      <CardHeader className="pb-3 border-b border-border/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base font-semibold">실행 결과</CardTitle>
            <InlineWatermark />
            <div className="flex gap-1.5">
              <Badge variant="default" className="bg-primary/20 text-primary border-primary/30">
                {success.length} 성공
              </Badge>
              {failed.length > 0 && (
                <Badge variant="destructive" className="bg-destructive/20 text-destructive border-destructive/30">
                  {failed.length} 실패
                </Badge>
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-8"
            onClick={() => { window.location.href = "/api/results/download"; }}
          >
            엑셀 다운로드
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-b border-border/30">
              <TableHead className="w-10 text-xs">#</TableHead>
              <TableHead className="text-xs">계정</TableHead>
              <TableHead className="text-xs">상품</TableHead>
              <TableHead className="text-xs">상태</TableHead>
              <TableHead className="text-xs">PIN / 에러</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r) => (
              <TableRow key={r.index} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                <TableCell className="text-muted-foreground text-xs">{r.index + 1}</TableCell>
                <TableCell className="font-medium text-sm">{r.gmarket_id}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{r.item_code}</TableCell>
                <TableCell>
                  <Badge
                    variant={r.success ? "default" : "destructive"}
                    className={r.success
                      ? "bg-primary/20 text-primary border-primary/30 text-xs"
                      : "bg-destructive/20 text-destructive border-destructive/30 text-xs"
                    }
                  >
                    {r.success ? "성공" : "실패"}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs max-w-[300px] truncate text-muted-foreground">
                  {r.success && r.pins && r.pins.length > 0
                    ? r.pins.join(", ")
                    : r.error || (r.orderKey ? `order: ${r.orderKey}` : "—")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
