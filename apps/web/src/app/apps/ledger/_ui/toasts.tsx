'use client';

/**
 * The ledger's toast queue (COMPONENT_MAP CM-11 on the Embers ToastStack):
 * success/info auto-dismiss after 4 s, errors persist with a close button,
 * one polite and one assertive region. Dismissal never cancels work.
 */
import { ToastStack } from '@forge/ui';
import type { ToastStackItem } from '@forge/ui';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type PushToast = (toast: Omit<ToastStackItem, 'id'> & { dedupeKey?: string }) => void;

const ToastContext = createContext<PushToast>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastStackItem[]>([]);
  const seq = useRef(0);
  const push = useCallback<PushToast>(({ dedupeKey, ...toast }) => {
    seq.current += 1;
    const id = dedupeKey ?? `t${seq.current}`;
    setToasts((list) => [...list.filter((t) => t.id !== id), { ...toast, id }].slice(-4));
  }, []);
  const close = useCallback((id: string) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onClose={close} />
    </ToastContext.Provider>
  );
}

export function useToast(): PushToast {
  return useContext(ToastContext);
}
