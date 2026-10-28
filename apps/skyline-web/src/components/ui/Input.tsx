import type { InputHTMLAttributes, ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  icon?: ReactNode;
}

export default function Input({ label, icon, className = '', ...rest }: InputProps) {
  return (
    <label className="block">
      {label && (
        <span className="mb-2 flex items-center gap-2 text-xs font-medium text-t-secondary">
          {icon}{label}
        </span>
      )}
      <input
        className={`h-12 w-full rounded-xl border border-white/[0.08] bg-white/[0.05] px-4 text-sm text-t-primary outline-none transition-all duration-200 placeholder:text-slate-600 focus:border-accent/50 focus:bg-white/[0.07] min-h-[44px] ${className}`}
        {...rest}
      />
    </label>
  );
}
