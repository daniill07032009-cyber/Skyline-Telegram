interface AvatarProps {
  src?: string | null;
  name: string;
  size?: number;
  online?: boolean;
  className?: string;
}

export default function Avatar({ src, name, size = 44, online, className = '' }: AvatarProps) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <span className={`relative inline-block shrink-0 ${className}`} style={{ width: size, height: size }}>
      {src ? (
        <img src={src} alt={name} className="h-full w-full rounded-2xl object-cover" />
      ) : (
        <span className="grid h-full w-full place-items-center rounded-2xl bg-gradient-to-br from-accent-from to-accent-to text-sm font-bold text-white">
          {initial}
        </span>
      )}
      {online && (
        <span className="online-dot absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-bg-base bg-emerald-400" />
      )}
    </span>
  );
}
