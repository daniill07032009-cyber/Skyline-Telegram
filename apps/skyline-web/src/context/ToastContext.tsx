import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { ToastContext, type ToastKind } from './ToastContextBase';

interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
}

let nextToastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const showToast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++nextToastId;
    setToasts((current) => [...current.slice(-3), { id, kind, message }]);
    window.setTimeout(() => dismissToast(id), 5000);
  }, [dismissToast]);
  const contextValue = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div aria-label="Уведомления" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((toast) => {
          const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? AlertCircle : Info;
          const colors = toast.kind === 'success'
            ? 'border-emerald-400/20 bg-emerald-950/90 text-emerald-100'
            : toast.kind === 'error'
              ? 'border-rose-400/20 bg-rose-950/90 text-rose-100'
              : 'border-accent/20 bg-slate-950/95 text-t-primary';
          return (
            <div key={toast.id} role={toast.kind === 'error' ? 'alert' : 'status'} className={`toast-enter pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-xl ${colors}`}>
              <Icon size={18} className="mt-0.5 shrink-0" />
              <p className="flex-1 text-sm leading-relaxed">{toast.message}</p>
              <button type="button" onClick={() => dismissToast(toast.id)} aria-label="Закрыть уведомление" className="rounded-lg p-1 opacity-70 transition hover:bg-white/10 hover:opacity-100">
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
