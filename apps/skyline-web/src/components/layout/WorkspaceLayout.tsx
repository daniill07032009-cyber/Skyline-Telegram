import { useEffect, useState } from 'react';
import { ArrowUpRight, MessageSquarePlus, Pencil, Radio, Users } from 'lucide-react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, UserRound, X } from 'lucide-react';
import { api, type User } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import WorkspaceSidebarHeader from './WorkspaceSidebarHeader';
import UnifiedWorkspaceList from './UnifiedWorkspaceList';

export default function WorkspaceLayout() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [newChatSearch, setNewChatSearch] = useState('');
  const [newChatResults, setNewChatResults] = useState<User[]>([]);
  const [newChatLoading, setNewChatLoading] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isGroup = location.pathname.startsWith('/groups');
  const isChannel = location.pathname.startsWith('/channels');
  const activeKind = isGroup ? 'group' : isChannel ? 'channel' : 'chat';
  const activeId = isGroup ? params.get('group') || (params.get('discover') === '1' ? 'discover' : null) : isChannel ? params.get('channel') : params.get('chat') || params.get('user');
  const showDiscover = params.get('discover') === '1';
  const showCreateChat = !isGroup && !isChannel && params.get('create') === '1';

  useEffect(() => {
    const query = newChatSearch.trim().replace(/^@/, '');
    if (!showCreateChat || query.length < 2) {
      return;
    }
    let current = true;
    const timeout = window.setTimeout(() => {
      setNewChatLoading(true);
      void api.get<User[]>('/users/search', { params: { q: query } })
        .then((response) => { if (current) setNewChatResults(response.data); })
        .catch((error: unknown) => { console.error('Не удалось найти пользователей для нового чата:', error); if (current) setNewChatResults([]); })
        .finally(() => { if (current) setNewChatLoading(false); });
    }, 250);
    return () => { current = false; window.clearTimeout(timeout); };
  }, [newChatSearch, showCreateChat]);
  return (
    <main className="flex h-full min-h-0 w-full overflow-hidden bg-bg-base text-t-primary">
      <aside className={`${activeId || showCreateChat ? 'hidden md:flex' : 'flex'} relative w-full shrink-0 flex-col border-r border-white/[0.08] bg-panel md:w-[340px]`}>
        <WorkspaceSidebarHeader searchValue={search} onSearchChange={setSearch} searchPlaceholder="Поиск чатов, групп и каналов" />
        <div className="flex items-center justify-between px-4 pb-1 pt-3"><span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Все переписки</span>
          <button type="button" onClick={() => navigate(showDiscover ? '/channels' : '/channels?discover=1')} className="inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-accent"><Radio size={12} /> {showDiscover ? 'Мои каналы' : 'Найти каналы'}</button></div>
        <UnifiedWorkspaceList key={user?.id || 'anonymous'} search={search} activeKind={activeKind} activeId={activeId} includeDiscover={showDiscover} />
        <div className="absolute bottom-4 left-4 z-50" onMouseEnter={() => setCreateMenuOpen(true)} onMouseLeave={() => setCreateMenuOpen(false)} onKeyDown={(event) => { if (event.key === 'Escape') setCreateMenuOpen(false); }}>
          <button
            type="button"
            aria-label="Создать новую переписку"
            aria-expanded={createMenuOpen}
            aria-controls="workspace-create-menu"
            title="Создать"
            onClick={() => setCreateMenuOpen((open) => !open)}
            className="grid h-12 w-12 place-items-center rounded-full border border-white/15 bg-gradient-to-br from-accent to-sky-500 text-white shadow-lg shadow-accent/25 transition duration-200 hover:scale-105 hover:shadow-xl hover:shadow-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          >
            <Pencil size={19} strokeWidth={2.2} />
          </button>
          <div
            id="workspace-create-menu"
            className={`absolute bottom-0 left-14 w-[264px] transition-all duration-200 ease-out ${createMenuOpen ? 'pointer-events-auto translate-y-0 translate-x-0 opacity-100' : 'pointer-events-none translate-y-2 translate-x-1 opacity-0'}`}
          >
            <div className="overflow-hidden rounded-2xl border border-white/[0.12] bg-[#0e1726]/[0.98] p-2 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
              <div className="px-3 pb-2.5 pt-2">
                <p className="text-sm font-semibold tracking-tight text-white">Создать новое</p>
                <p className="mt-0.5 text-[11px] leading-4 text-slate-400">С чего начнём?</p>
              </div>
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => { setCreateMenuOpen(false); navigate('/chats?create=1'); }}
                  className="group/item flex w-full items-center gap-3 rounded-xl border border-transparent p-2.5 text-left transition duration-150 hover:border-emerald-300/20 hover:bg-emerald-300/[0.07] focus-visible:border-emerald-300/30 focus-visible:bg-emerald-300/[0.07] focus-visible:outline-none"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-300/10 text-emerald-300 transition group-hover/item:bg-emerald-300/15">
                    <MessageSquarePlus size={19} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-slate-100">Новый чат</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">Найдите человека и начните переписку</span>
                  </span>
                  <ArrowUpRight size={15} className="shrink-0 text-slate-500 transition group-hover/item:-translate-y-0.5 group-hover/item:translate-x-0.5 group-hover/item:text-emerald-300" />
                </button>
                <button
                  type="button"
                  onClick={() => { setCreateMenuOpen(false); navigate('/groups?create=1'); }}
                  className="group/item flex w-full items-center gap-3 rounded-xl border border-transparent p-2.5 text-left transition duration-150 hover:border-accent/20 hover:bg-accent/[0.09] focus-visible:border-accent/30 focus-visible:bg-accent/[0.09] focus-visible:outline-none"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent transition group-hover/item:bg-accent/20">
                    <Users size={19} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-slate-100">Новая группа</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">Общайтесь вместе с друзьями</span>
                  </span>
                  <ArrowUpRight size={15} className="shrink-0 text-slate-500 transition group-hover/item:-translate-y-0.5 group-hover/item:translate-x-0.5 group-hover/item:text-accent" />
                </button>
                <button
                  type="button"
                  onClick={() => { setCreateMenuOpen(false); navigate('/channels?create=1'); }}
                  className="group/item flex w-full items-center gap-3 rounded-xl border border-transparent p-2.5 text-left transition duration-150 hover:border-cyan-300/20 hover:bg-cyan-300/[0.07] focus-visible:border-cyan-300/30 focus-visible:bg-cyan-300/[0.07] focus-visible:outline-none"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-300/10 text-cyan-300 transition group-hover/item:bg-cyan-300/15">
                    <Radio size={19} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-slate-100">Новый канал</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">Делитесь новостями и постами</span>
                  </span>
                  <ArrowUpRight size={15} className="shrink-0 text-slate-500 transition group-hover/item:-translate-y-0.5 group-hover/item:translate-x-0.5 group-hover/item:text-cyan-300" />
                </button>
              </div>
              <div className="mx-2 mt-2 border-t border-white/[0.08] pt-2">
                <p className="px-1 pb-1 text-[10px] text-slate-500"><MessageSquarePlus size={12} className="mr-1 inline-block -translate-y-px" /> Новое пространство для общения</p>
              </div>
            </div>
          </div>
        </div>
      </aside><section className={`${activeId || showCreateChat || isGroup || isChannel ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col overflow-hidden`}>{isGroup || isChannel || activeId ? <Outlet /> : showCreateChat ? <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-8"><div className="w-full max-w-xl overflow-hidden rounded-[28px] border border-white/10 bg-[#101827] shadow-[0_30px_100px_rgba(0,0,0,0.4)]"><div className="flex items-start justify-between gap-4 border-b border-white/[0.07] p-6 sm:p-8"><div><div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-accent/20 bg-accent/10 text-accent"><MessageSquarePlus size={22} /></div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">Новое сообщение</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-white">Создать чат</h1><p className="mt-2 max-w-sm text-xs leading-5 text-slate-400">Найдите пользователя, чтобы открыть с ним личную переписку.</p></div><button type="button" onClick={() => { setNewChatSearch(''); navigate('/chats', { replace: true }); }} aria-label="Закрыть создание чата" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/[0.08] text-slate-400 transition hover:bg-white/[0.06] hover:text-white"><X size={16} /></button></div><div className="p-6 sm:p-8"><label className="relative block"><Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" /><input autoFocus value={newChatSearch} onChange={(event) => setNewChatSearch(event.target.value)} placeholder="Введите имя или @username" className="h-12 w-full rounded-2xl border border-white/10 bg-[#080e19]/80 pl-11 pr-4 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-accent/60 focus:ring-4 focus:ring-accent/10" /></label><div className="mt-4 space-y-1">{newChatLoading && newChatSearch.trim().replace(/^@/, '').length >= 2 && <p className="px-2 py-4 text-center text-xs text-slate-400">Ищем пользователей…</p>}{!newChatLoading && newChatSearch.trim().replace(/^@/, '').length < 2 && <p className="px-2 py-5 text-center text-xs leading-5 text-slate-500">Начните вводить имя или имя пользователя — здесь появятся результаты поиска.</p>}{!newChatLoading && newChatSearch.trim().replace(/^@/, '').length >= 2 && newChatResults.length === 0 && <p className="px-2 py-5 text-center text-xs text-slate-500">Пользователи не найдены.</p>}{newChatResults.map((candidate) => <button key={candidate.id} type="button" onClick={() => { setNewChatSearch(''); navigate('/chats?user=' + encodeURIComponent(candidate.username)); }} className="flex w-full items-center gap-3 rounded-2xl p-3 text-left transition hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-accent/10 text-accent">{candidate.avatarUrl ? <img src={candidate.avatarUrl} alt="" className="h-full w-full object-cover" /> : <UserRound size={19} />}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-100">{candidate.displayName || candidate.username}</span><span className="mt-1 block truncate text-xs text-slate-500">@{candidate.username}</span></span><ArrowUpRight size={16} className="text-slate-500" /></button>)}</div></div><div className="border-t border-white/[0.07] bg-black/10 px-6 py-4 sm:px-8"><p className="text-[10px] leading-5 text-slate-500">Выберите человека из результатов, чтобы перейти в личный чат. Сообщения начнут отображаться после открытия переписки.</p></div></div></div> : <div className="hidden flex-1 flex-col items-center justify-center text-center text-slate-500 md:flex"><div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.03]"><Radio size={26} className="text-accent/60" /></div><p className="text-sm font-medium text-t-secondary">Выберите чат</p><p className="mt-1 max-w-xs text-xs leading-5 text-slate-500">Откройте переписку из списка слева, чтобы прочитать сообщения и ответить.</p></div>}</section>
    </main>
  );
}
