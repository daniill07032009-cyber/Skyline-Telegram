import { Search, Settings as SettingsIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getSocket } from '../../api/socket';

interface WorkspaceSidebarHeaderProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
}

function subscribeSocketStatus(onStoreChange: () => void) {
  const socket = getSocket();
  if (!socket) return () => undefined;
  socket.on('connect', onStoreChange);
  socket.on('disconnect', onStoreChange);
  return () => {
    socket.off('connect', onStoreChange);
    socket.off('disconnect', onStoreChange);
  };
}

function getSocketStatusSnapshot() {
  return Boolean(getSocket()?.connected);
}

export default function WorkspaceSidebarHeader({
  searchValue,
  onSearchChange,
  searchPlaceholder,
}: WorkspaceSidebarHeaderProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isOnline = useSyncExternalStore(subscribeSocketStatus, getSocketStatusSnapshot, () => false);

  return (
    <>
      <header className="flex items-center justify-between border-b border-slate-800/50 px-4 py-3.5 sm:px-5">
        <button type="button" onClick={() => navigate('/profile')} className="group flex min-w-0 items-center gap-3 text-left">
          <span className="relative shrink-0">
            <span className="grid h-10 w-10 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-accent to-emerald-400 text-lg font-bold text-slate-950 shadow-lg transition-transform duration-300 group-hover:scale-105">
              {user?.avatarUrl
                ? <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                : user?.username?.[0]?.toUpperCase() || 'U'}
            </span>
            <span className={`absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-[#0f172a] ${isOnline ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-slate-600'}`} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-t-primary transition-colors group-hover:text-accent">{user?.displayName || user?.username || 'Пользователь'}</span>
            <span className={`mt-0.5 block text-[10px] font-mono tracking-wider ${isOnline ? 'text-emerald-400' : 'text-slate-500'}`}>{isOnline ? 'В сети' : 'Не в сети'}</span>
          </span>
        </button>
        <button type="button" onClick={() => navigate('/settings')} className="ml-2 shrink-0 rounded-xl p-2 text-slate-500 transition-all hover:bg-accent/10 hover:text-accent" title="Настройки" aria-label="Открыть настройки">
          <SettingsIcon size={19} />
        </button>
      </header>
      <div className="border-b border-slate-800/50 p-3">
        <label className="relative block">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 transition-colors peer-focus:text-accent" />
          <input
            type="search"
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="peer h-10 w-full rounded-2xl border border-slate-700/50 bg-slate-900/50 pl-9 pr-4 text-xs text-slate-200 shadow-inner outline-none transition-all placeholder:text-slate-500 focus:border-accent/50 focus:bg-slate-900/80"
          />
        </label>
      </div>
    </>
  );
}
