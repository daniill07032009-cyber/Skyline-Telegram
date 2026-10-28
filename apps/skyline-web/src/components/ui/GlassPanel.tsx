import type { HTMLAttributes, ReactNode } from 'react';

export default function GlassPanel({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={`glass-panel rounded-3xl ${className}`} {...rest}>
      {children}
    </div>
  );
}
