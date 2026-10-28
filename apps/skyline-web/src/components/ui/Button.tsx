import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'glass' | 'danger';
  size?: 'md' | 'lg';
  children: ReactNode;
}

export default function Button({ variant = 'primary', size = 'lg', className = '', children, ...rest }: ButtonProps) {
  const base = 'btn-glow flex items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 min-h-[44px]';
  const sizes = size === 'lg' ? 'h-12 w-full text-sm' : 'h-10 px-4 text-sm';
  const variants = {
    primary: 'btn-shine bg-gradient-to-r from-accent-from to-accent-to text-white shadow-lg',
    glass: 'glass-panel text-t-primary hover:bg-white/10',
    danger: 'bg-rose-500/15 text-rose-300 border border-rose-400/20 hover:bg-rose-500/25',
  };
  return (
    <button className={`${base} ${sizes} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
