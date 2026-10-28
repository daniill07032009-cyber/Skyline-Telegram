import { NavLink, useLocation } from 'react-router-dom';
import { Hash, MessagesSquare, Users } from 'lucide-react';
import { useUnreadCounts } from '../../hooks/useUnreadCounts';

const tabs = [
  { id: 'chats', to: '/chats', label: 'Чаты', Icon: MessagesSquare },
  { id: 'groups', to: '/groups', label: 'Группы', Icon: Users },
  { id: 'channels', to: '/channels', label: 'Каналы', Icon: Hash },
] as const;

export default function WorkspaceTabs() {
  const location = useLocation();
  const counts = useUnreadCounts();
  const activeId = tabs.find((t) => location.pathname.startsWith(t.to))?.id;

  return (
    <nav className="flex gap-1 rounded-2xl border border-white/[0.06] bg-slate-950/40 p-1" aria-label="Разделы">
      {tabs.map(({ id, to, label, Icon }) => {
        const value = counts[id];
        return (
          <NavLink
            key={id}
            to={to}
            className={({ isActive }) =>
              `flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl px-3 text-xs font-semibold transition-all duration-200 ${
                isActive ? 'glass-active text-t-primary shadow-lg' : 'text-t-secondary hover:bg-white/5 hover:text-t-primary'
              }`
            }
          >
            <Icon size={15} aria-hidden />
            <span>{label}</span>
            {value > 0 && activeId !== id && (
              <span className="badge-pop grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
                {value > 99 ? '99+' : value}
              </span>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}
