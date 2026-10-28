interface SpinnerProps {
  size?: number;
  className?: string;
}

export default function Spinner({ size = 18, className = '' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Загрузка"
      className={`inline-block animate-spin rounded-full border-2 border-white/15 border-t-accent ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
