import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import GlassPanel from './GlassPanel';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <GlassPanel className="flex flex-col items-center gap-3 p-8 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-3xl bg-accent/10 text-accent">
        <Icon size={26} />
      </span>
      <p className="text-sm font-semibold text-t-primary">{title}</p>
      {description && <p className="max-w-xs text-xs leading-relaxed text-t-secondary">{description}</p>}
      {action}
    </GlassPanel>
  );
}
