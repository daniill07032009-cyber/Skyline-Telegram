interface ToggleProps {
  on: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  description?: string;
}

export default function Toggle({ on, onChange, label, description }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-on={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-4 rounded-2xl px-4 py-3 text-left transition hover:bg-white/[0.03] min-h-[44px]"
    >
      <span>
        {label && <span className="block text-sm font-medium text-t-primary">{label}</span>}
        {description && <span className="mt-0.5 block text-xs text-t-secondary">{description}</span>}
      </span>
      <span className="toggle" data-on={on} />
    </button>
  );
}
