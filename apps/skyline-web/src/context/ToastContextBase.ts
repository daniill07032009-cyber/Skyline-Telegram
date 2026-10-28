import { createContext } from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastContextValue {
  showToast: (message: string, kind?: ToastKind) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
