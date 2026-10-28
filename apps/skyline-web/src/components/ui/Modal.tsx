import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import GlassPanel from './GlassPanel';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  wide?: boolean;
}

export default function Modal({ open, onClose, title, subtitle, children, wide }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <GlassPanel role="dialog" aria-modal="true" className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} p-6 shadow-2xl animate-scale-in`}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-lg font-semibold text-t-primary">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs text-t-secondary">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="grid min-h-[44px] min-w-[44px] place-items-center rounded-xl text-t-secondary transition hover:bg-white/5 hover:text-t-primary"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </GlassPanel>
    </div>
  );
}
