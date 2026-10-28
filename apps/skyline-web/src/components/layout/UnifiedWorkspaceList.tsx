import { useEffect, useMemo, useState } from 'react';
import { BellOff, Flag, MessageCircle, Pin, Radio, Trash2, Users, Volume2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, socialApi, type Contact, type User } from '../../api/client';
import { getSocket } from '../../api/socket';
import { useAuth } from '../../context/AuthContext';
import { formatAppDateTime } from '../../time';

interface GroupItem {
  id: string;
  title: string;
  description?: string;
  avatarUrl?: string;
  memberCount: number;
  lastMessageAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
}
interface ChannelItem {
  id: string;
  title: string;
  description: string;
  avatarUrl?: string;
  memberCount: number;
  isSubscribed: boolean;
  visibility: 'public' | 'private';
  lastMessageAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
}
type Entry =
  | { kind: 'chat'; id: string; title: string; subtitle: string; time?: string | null; contact: Contact }
  | { kind: 'group'; id: string; title: string; subtitle: string; time?: string | null; group: GroupItem }
  | { kind: 'channel'; id: string; title: string; subtitle: string; time?: string | null; channel: ChannelItem };

interface UnifiedWorkspaceListProps {
  search: string;
  activeKind: 'chat' | 'group' | 'channel';
  activeId: string | null;
  includeDiscover?: boolean;
}

export default function UnifiedWorkspaceList({ search, activeKind, activeId, includeDiscover = false }: UnifiedWorkspaceListProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [searchedUsers, setSearchedUsers] = useState<User[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ entry: Entry; x: number; y: number } | null>(null);
  const mutedStorageKey = `skyline:muted-workspace-items:${user?.id || 'anonymous'}`;
  const hiddenStorageKey = `skyline:hidden-workspace-items:${user?.id || 'anonymous'}`;
  const [mutedKeys, setMutedKeys] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(`skyline:muted-workspace-items:${user?.id || 'anonymous'}`) || '[]') as string[]); } catch { return new Set(); } });
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(`skyline:hidden-workspace-items:${user?.id || 'anonymous'}`) || '[]') as string[]); } catch { return new Set(); } });

  const entryKey = (entry: Entry) => entry.kind + ':' + entry.id;
  const toggleMute = (entry: Entry) => { const key = entryKey(entry); setMutedKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); try { localStorage.setItem(mutedStorageKey, JSON.stringify([...next])); } catch {} return next; }); setContextMenu(null); };
  const hideEntry = (entry: Entry) => { const key = entryKey(entry); setHiddenKeys((current) => { const next = new Set(current); next.add(key); try { localStorage.setItem(hiddenStorageKey, JSON.stringify([...next])); } catch {} return next; }); setContextMenu(null); };
  const reportEntry = async (entry: Entry) => { const reason = window.prompt('Укажите причину жалобы на «' + entry.title + '»:'); if (!reason || !reason.trim()) return; try { const targetType = entry.kind === 'chat' ? 'user' : entry.kind; await socialApi.report(targetType, entry.id, reason.trim()); window.alert('Жалоба отправлена на рассмотрение.'); } catch (error) { console.error('Не удалось отправить жалобу:', error); window.alert('Не удалось отправить жалобу. Попробуйте позже.'); } finally { setContextMenu(null); } };

  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      api.get<Contact[]>('/contacts'),
      api.get<GroupItem[]>('/groups'),
      api.get<ChannelItem[]>('/channels'),
    ]).then(([contactsResult, groupsResult, channelsResult]) => {
      if (!current) return;
      if (contactsResult.status === 'fulfilled') {
        setContacts(contactsResult.value.data.filter((contact) => contact.id !== user?.id && !contact.chatHidden));
      }
      if (groupsResult.status === 'fulfilled') setGroups(groupsResult.value.data);
      if (channelsResult.status === 'fulfilled') {
        setChannels(channelsResult.value.data);
      }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [user?.id, includeDiscover]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !user?.id) return;

    let disposed = false;
    const refreshContacts = () => {
      void api.get<Contact[]>('/contacts')
        .then((response) => {
          if (!disposed) setContacts(response.data.filter((contact) => contact.id !== user.id && !contact.chatHidden));
        })
        .catch((error: unknown) => console.error('Не удалось обновить личные чаты:', error));
    };
    const refreshGroups = () => {
      void api.get<GroupItem[]>('/groups')
        .then((response) => { if (!disposed) setGroups(response.data); })
        .catch((error: unknown) => console.error('Не удалось обновить список групп:', error));
    };
    const refreshChannels = () => {
      void api.get<ChannelItem[]>('/channels')
        .then((response) => { if (!disposed) setChannels(response.data); })
        .catch((error: unknown) => console.error('Не удалось обновить список каналов:', error));
    };
    const refreshForMessageEvent = (event: { groupId?: string }) => {
      if (event.groupId) refreshGroups();
      else refreshContacts();
    };
    const handleMessageChanged = (event: { action?: string; groupId?: string }) => {
      if (event.action !== 'created') return;
      refreshForMessageEvent(event);
    };
    const handleMessageDeletedForAll = (event: { groupId?: string }) => {
      refreshForMessageEvent(event);
    };
    const handleChannelChanged = () => refreshChannels();
    const handleGroupChanged = () => refreshGroups();
    const handleReconnect = () => {
      refreshContacts();
      refreshGroups();
      refreshChannels();
    };

    socket.on('message_changed', handleMessageChanged);
    socket.on('message_deleted_for_all', handleMessageDeletedForAll);
    socket.on('channel_changed', handleChannelChanged);
    socket.on('group_changed', handleGroupChanged);
    socket.on('connect', handleReconnect);
    return () => {
      disposed = true;
      socket.off('message_changed', handleMessageChanged);
      socket.off('message_deleted_for_all', handleMessageDeletedForAll);
      socket.off('channel_changed', handleChannelChanged);
      socket.off('group_changed', handleGroupChanged);
      socket.off('connect', handleReconnect);
    };
  }, [user?.id]);

  useEffect(() => {
    const query = search.trim();
    if (query.replace(/^@/, '').trim().length < 2) {
      return;
    }
    let current = true;
    const timeout = window.setTimeout(() => {
      setSearchingUsers(true);
      void api.get<User[]>('/users/search', { params: { q: query } })
        .then((response) => {
          if (current) setSearchedUsers(response.data.filter((candidate) => candidate.id !== user?.id));
        })
        .catch((error: unknown) => {
          console.error('Не удалось выполнить поиск пользователей:', error);
          if (current) setSearchedUsers([]);
        })
        .finally(() => { if (current) setSearchingUsers(false); });
    }, 250);
    return () => { current = false; window.clearTimeout(timeout); };
  }, [search, user?.id]);

  const entries = useMemo<Entry[]>(() => {
    const query = search.trim().toLocaleLowerCase();
    const contactIds = new Set(contacts.map((contact) => String(contact.id)));
    const chats: Entry[] = contacts.map((contact) => ({
      kind: 'chat',
      id: String(contact.id),
      title: contact.nickname || contact.displayName || contact.username,
      subtitle: contact.lastMessageType && contact.lastMessageType !== 'text'
        ? `📎 ${contact.lastMessageFileName || 'Вложение'}`
        : contact.lastMessageText?.startsWith('skyline-e2e:') ? 'Сообщение' : contact.lastMessageText || contact.displayName || `@${contact.username}`,
      time: contact.lastMessageAt,
      contact,
    }));
    const externalUserEntries: Entry[] = searchedUsers
      .filter((candidate) => !contactIds.has(String(candidate.id)))
      .map((candidate) => {
        const contact = { ...candidate, nickname: '', isContact: false } as Contact;
        return {
          kind: 'chat' as const,
          id: String(candidate.id),
          title: candidate.displayName || candidate.username,
          subtitle: `@${candidate.username}`,
          contact,
        };
      });
    const groupEntries: Entry[] = groups.map((group) => ({
      kind: 'group', id: group.id, title: group.title,
      subtitle: `${group.memberCount} участников${group.description ? ` · ${group.description}` : ''}`, time: group.lastMessageAt || group.updatedAt || group.createdAt, group,
    }));
    const channelEntries: Entry[] = channels
      .filter((channel) => channel.isSubscribed || includeDiscover || (query.length > 0 && channel.visibility === 'public'))
      .map((channel) => ({
      kind: 'channel', id: channel.id, title: channel.title,
      subtitle: `${channel.memberCount} подписчиков · ${channel.description || 'Канал Skyline'}`,
      time: channel.lastMessageAt || channel.updatedAt || channel.createdAt, channel,
    }));
    return [...chats, ...externalUserEntries, ...groupEntries, ...channelEntries]
      .filter((entry) => !hiddenKeys.has(entryKey(entry)))
      .filter((entry) => {
        if (!query) return true;
        const searchable = entry.kind === 'chat'
          ? `${entry.title} ${entry.subtitle} ${entry.contact.username} ${entry.contact.displayName || ''}`
          : entry.kind === 'channel'
            ? `${entry.title} ${entry.subtitle} ${entry.channel.description}`
            : `${entry.title} ${entry.subtitle} ${entry.group.description || ''}`;
        return searchable.toLocaleLowerCase().includes(query.replace(/^@/, '').trim());
      })
      .sort((a, b) => (Date.parse(b.time || '') || 0) - (Date.parse(a.time || '') || 0));
  }, [contacts, groups, channels, searchedUsers, search, includeDiscover, hiddenKeys]);

  if (loading) return <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" role="status" aria-label="Загрузка переписок">{[0, 1, 2, 3].map((item) => <div key={item} className="chat-skeleton h-14 rounded-xl" />)}</div>;
  if (!entries.length) return <div className="m-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 text-center text-xs leading-5 text-slate-500">{searchingUsers ? 'Ищем людей, группы и каналы…' : search.trim() ? 'Ничего не найдено.' : 'Здесь появятся ваши личные чаты, группы и каналы.'}</div>;

  return (
    <div className="stagger min-h-0 flex-1 overflow-y-auto p-2" aria-label="Все переписки">
      {entries.map((entry) => {
        const active = entry.kind === activeKind && (entry.id === activeId || (entry.kind === 'chat' && entry.contact.username === activeId));
        return (
          <button
            key={`${entry.kind}:${entry.id}`}
            type="button"
            onContextMenu={(event) => { event.preventDefault(); setContextMenu({ entry, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 248)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 310)) }); }}
            onClick={() => {
              if (entry.kind === 'chat') {
                if (entry.contact.isContact === false) navigate('/chats?user=' + encodeURIComponent(entry.contact.username));
                else navigate('/chats?chat=' + encodeURIComponent(entry.id));
              }
              else if (entry.kind === 'group') navigate('/groups?group=' + encodeURIComponent(entry.id));
              else navigate('/channels?channel=' + encodeURIComponent(entry.id) + (includeDiscover ? '&discover=1' : ''));
            }}
            aria-current={active ? 'page' : undefined}
            className={`chat-card chat-list-item group mb-1 flex w-full items-center gap-3 rounded-2xl p-3 text-left ${active ? 'chat-active text-white' : 'text-slate-300'}`}
          >
            <span className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl ${entry.kind === 'chat' ? 'bg-emerald-400/10 text-emerald-300' : entry.kind === 'group' ? 'bg-accent/15 text-accent' : 'bg-cyan-400/10 text-cyan-300'}`}>
              {entry.kind === 'chat' ? entry.contact.avatarUrl ? <img src={entry.contact.avatarUrl} alt="" className="h-full w-full object-cover" /> : <span className="text-sm font-semibold">{entry.contact.username?.[0]?.toUpperCase() || <MessageCircle size={18} />}</span> : entry.kind === 'group' ? entry.group.avatarUrl ? <img src={entry.group.avatarUrl} alt="" className="h-full w-full object-cover" /> : <Users size={18} /> : entry.channel.avatarUrl ? <img src={entry.channel.avatarUrl} alt="" className="h-full w-full object-cover" /> : <Radio size={18} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1 truncate text-sm font-medium">{entry.title}{mutedKeys.has(entryKey(entry)) && <BellOff size={12} className="shrink-0 text-slate-500" />}</span>
                {entry.time && <time className="shrink-0 text-[10px] text-slate-500">{formatAppDateTime(entry.time, { hour: '2-digit', minute: '2-digit' })}</time>}{entry.kind === 'chat' && (entry.contact.unreadCount || 0) > 0 && <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">{entry.contact.unreadCount! > 99 ? '99+' : entry.contact.unreadCount}</span>}
              </span>
              <span className="mt-1 block truncate text-[11px] text-slate-500">{entry.subtitle}</span>
            </span>
          </button>
        );
      })}
      {contextMenu && <>
        <button type="button" aria-label="Закрыть меню чата" className="fixed inset-0 z-[80] cursor-default" onClick={() => setContextMenu(null)} />
        <div role="menu" className="fixed z-[81] w-60 overflow-hidden rounded-xl border border-white/10 bg-slate-900 p-1.5 shadow-2xl shadow-black/40" style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={(event) => event.preventDefault()}>
          <div className="truncate px-3 py-2 text-xs font-semibold text-slate-400">{contextMenu.entry.title}</div><div className="my-1 border-t border-white/10" />
          <button role="menuitem" type="button" onClick={() => toggleMute(contextMenu.entry)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-200 hover:bg-white/10">{mutedKeys.has(entryKey(contextMenu.entry)) ? <Volume2 size={16} /> : <BellOff size={16} />}{mutedKeys.has(entryKey(contextMenu.entry)) ? 'Включить звук' : 'Убрать звук'}</button>
          <button role="menuitem" type="button" onClick={() => { const entry = contextMenu.entry; setContextMenu(null); if (entry.kind === 'chat') { if (entry.contact.isContact === false) navigate('/chats?user=' + encodeURIComponent(entry.contact.username)); else navigate('/chats?chat=' + encodeURIComponent(entry.id)); } else if (entry.kind === 'group') navigate('/groups?group=' + encodeURIComponent(entry.id)); else navigate('/channels?channel=' + encodeURIComponent(entry.id) + (includeDiscover ? '&discover=1' : '')); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-200 hover:bg-white/10"><Pin size={16} />Открыть переписку</button>
          <button role="menuitem" type="button" onClick={() => void reportEntry(contextMenu.entry)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-200 hover:bg-white/10"><Flag size={16} />Пожаловаться</button>
          <div className="my-1 border-t border-white/10" />
          <button role="menuitem" type="button" onClick={() => { const entry = contextMenu.entry; if (window.confirm('Убрать «' + entry.title + '» из списка на этом устройстве? История сообщений не удаляется.')) hideEntry(entry); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-rose-300 hover:bg-rose-500/10"><Trash2 size={16} />Убрать из списка</button>
          <button type="button" onClick={() => setContextMenu(null)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-400 hover:bg-white/10"><X size={16} />Отмена</button>
        </div>
      </>}
    </div>
  );
}
