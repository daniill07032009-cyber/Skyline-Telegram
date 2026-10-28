import type { HTMLAttributes, ReactNode } from 'react';
import GlassPanel from './GlassPanel';

interface SectionCardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  children: ReactNode;
}

export default function SectionCard({ title, description, children, className = '', ...rest }: SectionCardProps) {
  return (
    <GlassPanel className={`p-5 sm:p-6 ${className}`} {...rest}>
      {(title || description) && (
        <div className="mb-4">
          {title && <h2 className="text-sm font-semibold text-t-primary">{title}</h2>}
          {description && <p className="mt-1 text-xs text-t-secondary">{description}</p>}
        </div>
      )}
      {children}
    </GlassPanel>
  );
}
