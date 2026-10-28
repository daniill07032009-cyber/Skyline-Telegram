interface BadgeProps {
  value: number;
  className?: string;
}

export default function Badge({ value, className = '' }: BadgeProps) {
  if (value <= 0) return null;
  return (
    <span className={`grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ${className}`}>
      {value > 99 ? '99+' : value}
    </span>
  );
}
