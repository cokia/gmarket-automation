"use client";

import { useState, useEffect, useCallback } from "react";

export interface SavedAccount {
  id: string;
  label: string;
  gmarket_id: string;
  gmarket_pw: string;
  proxy?: string; // "123.123.123.123:1234" 형태
}

const STORAGE_KEY = "gmarket-accounts";

function loadAccounts(): SavedAccount[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistAccounts(accounts: SavedAccount[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
}

export function useAccounts() {
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setAccounts(loadAccounts());
    setLoaded(true);
  }, []);

  const save = useCallback((updated: SavedAccount[]) => {
    setAccounts(updated);
    persistAccounts(updated);
  }, []);

  const add = useCallback((account: SavedAccount | SavedAccount[]) => {
    const toAdd = Array.isArray(account) ? account : [account];
    const current = loadAccounts();
    const existingIds = new Set(current.map((a) => a.gmarket_id));
    const filtered = toAdd.filter((a) => !existingIds.has(a.gmarket_id));
    if (filtered.length === 0) return 0;
    save([...current, ...filtered]);
    return filtered.length;
  }, [save]);

  const update = useCallback((id: string, data: Partial<SavedAccount>) => {
    save(accounts.map((a) => (a.id === id ? { ...a, ...data } : a)));
  }, [accounts, save]);

  const remove = useCallback((id: string) => {
    save(accounts.filter((a) => a.id !== id));
  }, [accounts, save]);

  const removeAll = useCallback(() => {
    save([]);
  }, [save]);

  return { accounts, loaded, add, update, remove, removeAll };
}
