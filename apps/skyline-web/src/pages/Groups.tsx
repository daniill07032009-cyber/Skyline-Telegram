import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Copy, Crown, Download, FileText, Forward, Globe, Lock, LogOut, Mic, Paperclip, Plus, Reply, Search, Send, Settings, ShieldCheck, SmilePlus, Trash2, UserPlus, Users, X } from 'lucide-react';
import VoiceMessagePlayer from '../components/chat/VoiceMessagePlayer';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { api, type User } from '../api/client';
import { getSocket } from '../api/socket';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/useToast';
import WorkspaceSidebarHeader from '../components/layout/WorkspaceSidebarHeader';
import WorkspaceTabs from '../components/layout/WorkspaceTabs';
import UnifiedWorkspaceList from '../components/layout/UnifiedWorkspaceList';
import { formatAppDateTime } from '../time';
import EncryptionNotice from '../components/EncryptionNotice';
import { canSendEncryptedMessages } from '../crypto/encryptionStatus';
import { decryptBytes, encryptBytes, packAttachmentPayload, unpackAttachmentPayload, type RecipientPublicKey } from '../crypto/encrypt';

interface GroupMember extends User {
  userId: string;
  joinedAt: string;
  publicKey: string;
  role: 'owner' | 'admin' | 'member';
}

interface Group {
  id: string;
  title: string;
  description?: string;
  avatarUrl?: string;
  memberCount: number;
  members: GroupMember[];
  createdAt: string;
  updatedAt?: string;
  lastMessageAt?: string | null;
  ownerId: string;
  isPublic: boolean;
  inviteCode: string;
  currentUserRole: 'owner' | 'admin' | 'member';
}

interface GroupMessage {
  id: string;
  groupId: string;
  senderId: string;
  text: string;
  createdAt: string;
  edited?: boolean;
  reactions: { userId: string; emoji: string }[];
  type?: 'text' | 'image' | 'file';
  fileName?: string;
  contentType?: string;
  fileData?: string;
  replyTo?: string | null;
  forwardedFrom?: string | null;
}

const REACTIONS = ['❤️', '👍', '😂', '🔥', '🎉', '😢'];
const GROUP_ATTACHMENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
]);

function groupRecipients(group: Group): RecipientPublicKey[] {
  const recipients = group.members.map((member) => ({ userId: member.userId, publicKey: member.publicKey }));
  if (!recipients.length || recipients.some((recipient) => !recipient.publicKey)) {
    throw new Error('У всех участников группы должен быть ключ шифрования. Попросите участников войти в Skyline и повторите попытку.');
  }
  return recipients;
}

function bytesToDataUrl(data: Uint8Array, contentType: string): string {
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function decryptGroupMessage(message: GroupMessage, userId: string): Promise<GroupMessage> {
  const encryptedPayload = message.text.startsWith('skyline-e2e:v4:')
    ? message.text
    : message.fileData?.startsWith('skyline-e2e:v4:') ? message.fileData : null;
  if (!encryptedPayload) return message;
  try {
    const plaintext = await decryptBytes(encryptedPayload, userId);
    const attachment = unpackAttachmentPayload(plaintext);
    if (attachment) {
      const { fileName, contentType } = attachment.metadata;
      if (!GROUP_ATTACHMENT_TYPES.has(contentType) || !attachment.data.length || attachment.data.length > 2 * 1024 * 1024) {
        throw new Error('Invalid attachment payload');
      }
      return {
        ...message,
        text: '',
        type: contentType.startsWith('image/') ? 'image' : 'file',
        fileName,
        contentType,
        fileData: bytesToDataUrl(attachment.data, contentType),
      };
    }
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { kind?: string; text?: string };
    if (parsed.kind !== 'text' || typeof parsed.text !== 'string') throw new Error('Invalid group message');
    return { ...message, text: parsed.text, type: 'text' };
  } catch {
    return { ...message, text: '[Зашифрованное сообщение недоступно на этом устройстве]', type: 'text' };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function groupDraftKey(userId: string, groupId: string) {
  return `skyline:group-draft:${userId}:${groupId}`;
}

function readGroupDraft(userId: string | undefined, groupId: string | undefined) {
  if (!userId || !groupId) return '';
  try {
    return localStorage.getItem(groupDraftKey(userId, groupId)) || '';
  } catch {
    return '';
  }
}

function writeGroupDraft(userId: string | undefined, groupId: string | undefined, value: string) {
  if (!userId || !groupId) return;
  try {
    const key = groupDraftKey(userId, groupId);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (error) {
    console.warn('Не удалось сохранить черновик группы:', error);
  }
}

export default function Groups({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedGroupId = searchParams.get('group');
  const { user, e2eeStatus } = useAuth();
  const userId = user?.id;
  const showToast = useToast();
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(requestedGroupId);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [messageSearch, setMessageSearch] = useState('');
  const [searchingHistory, setSearchingHistory] = useState(false);
  const [searchedHistoryPages, setSearchedHistoryPages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadedGroupId, setLoadedGroupId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceCancelledRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [addingMembers, setAddingMembers] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [groupTitleDraft, setGroupTitleDraft] = useState('');
  const [groupDescriptionDraft, setGroupDescriptionDraft] = useState('');
  const [groupAvatarDraft, setGroupAvatarDraft] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [publicGroups, setPublicGroups] = useState<Array<{ id: string; title: string; memberCount: number; ownerUsername: string }>>([]);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [joiningPublicGroup, setJoiningPublicGroup] = useState<string | null>(null);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [groupAvatarUrl, setGroupAvatarUrl] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [memberResults, setMemberResults] = useState<User[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [replyingMessage, setReplyingMessage] = useState<GroupMessage | null>(null);
  const [replyPreviews, setReplyPreviews] = useState<Record<string, GroupMessage | null>>({});
  const [forwardingMessage, setForwardingMessage] = useState<GroupMessage | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [forwarding, setForwarding] = useState(false);
  /* oxlint-disable react-hooks/set-state-in-effect -- The route query requests opening the group creation form. */
  useEffect(() => { if (searchParams.get('create') === '1') { setCreating(true); setSearchParams((current) => { const next = new URLSearchParams(current); next.delete('create'); return next; }, { replace: true }); } }, [searchParams, setSearchParams]);
  /* oxlint-enable react-hooks/set-state-in-effect */
  const activeGroup = activeGroupId === ''
    ? null
    : groups.find((group) => group.id === activeGroupId) || (!embedded ? groups[0] || null : null);
  const loadingMessages = Boolean(activeGroup && activeGroup.id !== loadedGroupId);
  const activeGroupKey = activeGroup?.id;
  const activeGroupKeyRef = useRef<string | undefined>(activeGroupKey);

  const loadGroups = useCallback(async () => {
    const response = await api.get<Group[]>('/groups');
    const sorted = [...response.data].sort((a, b) => {
      const aTime = Date.parse(a.lastMessageAt || a.updatedAt || a.createdAt) || 0;
      const bTime = Date.parse(b.lastMessageAt || b.updatedAt || b.createdAt) || 0;
      return bTime - aTime;
    });
    setGroups(sorted);
    return sorted;
  }, []);

  /* oxlint-disable react-hooks/set-state-in-effect -- Keep editable group settings drafts synchronized with the selected group's current metadata. */
  useEffect(() => {
    if (activeGroup) {
      setGroupTitleDraft(activeGroup.title);
      setGroupDescriptionDraft(activeGroup.description || '');
      setGroupAvatarDraft(activeGroup.avatarUrl || '');
    }
  }, [activeGroup]);
  /* oxlint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    const inviteToken = searchParams.get('invite');
    if (!inviteToken || !userId) return;
    let current = true;
    void api.post<{ id: string }>('/groups/join-by-invite', { token: inviteToken })
      .then(async (response) => {
        if (!current) return;
        await loadGroups();
        setSearchParams({ group: response.data.id }, { replace: true });
        setActiveGroupId(response.data.id);
        showToast('Вы присоединились к группе по приглашению.', 'success');
      })
      .catch((error: unknown) => {
        console.error('Не удалось принять приглашение в группу:', error);
        if (current) showToast('Ссылка приглашения недействительна или устарела.', 'error');
      });
    return () => { current = false; };
  }, [searchParams, userId, loadGroups, setSearchParams, showToast]);
  /* oxlint-disable react-hooks/set-state-in-effect -- Resolve the requested group after the asynchronous group list has loaded. */
  useEffect(() => {
    void loadGroups().then((items) => {
      if (requestedGroupId && items.some((group) => group.id === requestedGroupId)) setActiveGroupId(requestedGroupId);
    }).catch((error: unknown) => {
      console.error('Не удалось загрузить группы:', error);
      showToast('Не удалось загрузить список групп.', 'error');
    });
  }, [loadGroups, requestedGroupId, showToast]);
  /* oxlint-enable react-hooks/set-state-in-effect */

  const loadMessages = useCallback(async (groupId: string, before?: string) => {
    const response = await api.get<GroupMessage[]>(`/groups/${groupId}/messages`, {
      params: { limit: 20, ...(before ? { before } : {}) },
    });
    const decryptedMessages = userId
      ? await Promise.all(response.data.map((message) => decryptGroupMessage(message, userId)))
      : response.data;
    if (activeGroupKeyRef.current !== groupId) return decryptedMessages;
    setMessages((current) => {
      if (!before) return decryptedMessages;
      const ids = new Set(current.map((message) => message.id));
      return [...decryptedMessages.filter((message) => !ids.has(message.id)), ...current];
    });
    setHasMore(decryptedMessages.length === 20);
    setLoadedGroupId(groupId);
  }, [userId]);

  /* oxlint-disable react-hooks/set-state-in-effect -- Reset the reply target and restore the draft when the selected group changes. */
  useEffect(() => {
    activeGroupKeyRef.current = activeGroupKey;
    setReplyingMessage(null);
    setDraft(readGroupDraft(userId, activeGroupKey));
  }, [activeGroupKey, userId]);
  /* oxlint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!activeGroupKey) return;
    void loadMessages(activeGroupKey).catch((error: unknown) => {
      console.error('Не удалось загрузить сообщения группы:', error);
      showToast('Не удалось загрузить сообщения группы.', 'error');
    });
  }, [activeGroupKey, loadMessages, showToast]);

  useEffect(() => {
    const missingReplyIds = [...new Set(messages
      .map((message) => message.replyTo)
      .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0 && !(messageId in replyPreviews)))];
    if (!missingReplyIds.length || !userId) return;
    let active = true;
    void Promise.all(missingReplyIds.map(async (messageId) => {
      try {
        const response = await api.get<GroupMessage>(`/messages/${messageId}/preview`);
        return [messageId, await decryptGroupMessage(response.data, userId)] as const;
      } catch {
        return [messageId, null] as const;
      }
    })).then((entries) => {
      if (active) setReplyPreviews((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => { active = false; };
  }, [messages, replyPreviews, userId]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handleMessage = (event: { action: string; groupId?: string; messageId?: string; senderId?: string; message?: Partial<GroupMessage> }) => {
      if (!event.groupId) return;
      if (event.action === 'created') {
        void loadGroups().catch((error: unknown) => {
          console.error('Не удалось обновить порядок групп после нового сообщения:', error);
        });
      }
      if (event.action === 'created' && event.senderId && event.senderId !== user?.id && event.groupId !== activeGroupKey) {
        const groupName = groups.find((group) => group.id === event.groupId)?.title || 'группе';
        showToast(`Новое сообщение в группе «${groupName}».`, 'info');
      }
      if (event.groupId === activeGroupKey) {
        if (event.action === 'deleted' && event.messageId) {
          setMessages((current) => current.filter((message) => message.id !== event.messageId));
        } else if (event.message && event.messageId) {
          if (!user?.id) return;
          void decryptGroupMessage({ ...event.message, id: event.messageId, groupId: event.groupId, senderId: event.senderId || '', text: String(event.message.text || ''), reactions: event.message.reactions || [], createdAt: String(event.message.createdAt || '') } as GroupMessage, user.id)
            .then((decrypted) => setMessages((current) => current.map((message) => message.id === event.messageId ? { ...message, ...decrypted } : message)));
        } else {
          void loadMessages(event.groupId).catch((error: unknown) => {
            console.error('Не удалось обновить сообщения группы:', error);
            showToast('Не удалось обновить сообщения группы.', 'error');
          });
        }
      }
    };
    const handleMessageDeletedForAll = (event: { messageId: string; groupId?: string }) => {
      if (!event?.messageId || !event.groupId) return;
      void loadGroups().catch((error: unknown) => {
        console.error('Не удалось обновить список групп после удаления сообщения:', error);
      });
      if (event.groupId !== activeGroupKey) return;
      setMessages((current) => current.map((message) => message.id === event.messageId
        ? { ...message, text: 'Сообщение удалено', type: 'text', fileName: '', contentType: '', fileData: '' }
        : message,
      ));
    };
    const handleGroupChanged = () => {
      void loadGroups().catch((error: unknown) => {
        console.error('Не удалось обновить список групп:', error);
        showToast('Не удалось обновить список групп.', 'error');
      });
    };
    socket.on('message_changed', handleMessage);
    socket.on('message_deleted_for_all', handleMessageDeletedForAll);
    socket.on('group_changed', handleGroupChanged);
    return () => {
      socket.off('message_changed', handleMessage);
      socket.off('message_deleted_for_all', handleMessageDeletedForAll);
      socket.off('group_changed', handleGroupChanged);
    };
  }, [activeGroupKey, groups, loadGroups, loadMessages, showToast, user?.id]);

  useEffect(() => {
    const query = memberSearch.trim();
    if (!query.startsWith('@') || query.length < 4) return;
    let current = true;
    const timeout = window.setTimeout(() => {
      setSearching(true);
      void api.get<User[]>('/users/search', { params: { q: query } })
        .then((response) => {
          if (current) setMemberResults(response.data.filter((candidate) => candidate.id !== user?.id));
        })
        .catch((error: unknown) => {
          console.error('Не удалось найти участника:', error);
          if (current) showToast('Не удалось выполнить поиск пользователей.', 'error');
        })
        .finally(() => {
          if (current) setSearching(false);
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timeout);
    };
  }, [memberSearch, showToast, user?.id]);

  const selectedIds = useMemo(() => new Set(selectedMembers.map((member) => member.id)), [selectedMembers]);
  const addableResults = memberSearch.trim().startsWith('@') && memberSearch.trim().length >= 4
    ? memberResults.filter((candidate) =>
    !selectedIds.has(candidate.id)
    && !(addingMembers && activeGroup?.members.some((member) => member.userId === candidate.id)),
    )
    : [];

  const toggleMember = (candidate: User) => {
    setSelectedMembers((current) => current.some((member) => member.id === candidate.id)
      ? current.filter((member) => member.id !== candidate.id)
      : [...current, candidate]);
  };

  const handleMemberSearchChange = (value: string) => {
    setMemberSearch(value);
    setMemberResults([]);
  };

  const createGroup = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const response = await api.post<{ id: string }>('/groups', {
        title: groupTitle.trim(),
        description: groupDescription.trim(),
        avatarUrl: groupAvatarUrl,
        memberIds: selectedMembers.map((member) => member.id),
      });
      const refreshedGroups = await loadGroups();
      setActiveGroupId(refreshedGroups.find((group) => group.id === response.data.id)?.id || null);
      setCreating(false);
      setGroupTitle('');
      setGroupDescription('');
      setGroupAvatarUrl('');
      setMemberSearch('');
      setSelectedMembers([]);
      showToast('Группа создана.', 'success');
    } catch (error) {
      console.error('Не удалось создать группу:', error);
      showToast('Не удалось создать группу.', 'error');
    }
  };

  const addMembersToGroup = async () => {
    if (!activeGroup || !selectedMembers.length) return;
    try {
      await api.post(`/groups/${activeGroup.id}/members`, {
        memberIds: selectedMembers.map((member) => member.id),
      });
      await loadGroups();
      setSelectedMembers([]);
      setMemberSearch('');
      setAddingMembers(false);
      showToast('Участники добавлены. Они увидят переписку с момента вступления.', 'success');
    } catch (error) {
      console.error('Не удалось добавить участников:', error);
      showToast('Не удалось добавить участников.', 'error');
    }
  };

  const saveGroupSettings = async () => {
    if (!activeGroup || !['owner', 'admin'].includes(activeGroup.currentUserRole)) return;
    setSavingSettings(true);
    try {
      await api.patch(`/groups/${activeGroup.id}/settings`, { title: groupTitleDraft.trim(), description: groupDescriptionDraft.trim(), avatarUrl: groupAvatarDraft });
      await loadGroups();
      showToast('Настройки группы сохранены.', 'success');
    } catch (error) {
      console.error('Не удалось сохранить настройки группы:', error);
      showToast('Не удалось сохранить настройки группы.', 'error');
    } finally { setSavingSettings(false); }
  };

  const toggleGroupPrivacy = async () => {
    if (!activeGroup || !['owner', 'admin'].includes(activeGroup.currentUserRole)) return;
    setSavingSettings(true);
    try {
      await api.patch(`/groups/${activeGroup.id}/settings`, { isPublic: !activeGroup.isPublic });
      await loadGroups();
      showToast(!activeGroup.isPublic ? 'Группа теперь публичная.' : 'Группа теперь приватная.', 'success');
    } catch (error) {
      console.error('Не удалось изменить видимость группы:', error);
      showToast('Не удалось изменить видимость группы.', 'error');
    } finally { setSavingSettings(false); }
  };

  const copyInviteLink = async () => {
    if (!activeGroup?.inviteCode) { showToast('Для этой группы пока нет ссылки приглашения.', 'error'); return; }
    const appPath = window.location.pathname.endsWith('/')
      ? window.location.pathname
      : `${window.location.pathname}/`;
    const link = `${window.location.origin}${appPath}#/groups?invite=${encodeURIComponent(activeGroup.inviteCode)}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast('Ссылка приглашения скопирована.', 'success');
    } catch (error) {
      console.error('Не удалось скопировать ссылку:', error);
      window.prompt('Скопируйте ссылку приглашения:', link);
    }
  };

  const updateMemberRole = async (member: GroupMember, role: 'admin' | 'member') => {
    if (!activeGroup) return;
    try {
      await api.patch(`/groups/${activeGroup.id}/members/${member.userId}/role`, { role });
      await loadGroups();
      showToast(role === 'admin' ? `@${member.username} назначен администратором.` : `У @${member.username} сняты права администратора.`, 'success');
    } catch (error) {
      console.error('Не удалось изменить роль участника:', error);
      showToast('Не удалось изменить роль участника.', 'error');
    }
  };

  const transferOwnership = async (member: GroupMember) => {
    if (!activeGroup || !window.confirm(`Передать владение группой пользователю @${member.username}? Вы станете администратором.`)) return;
    try {
      await api.post(`/groups/${activeGroup.id}/transfer-ownership`, { userId: member.userId });
      await loadGroups();
      showToast(`Владелец группы изменён: @${member.username}.`, 'success');
    } catch (error) {
      console.error('Не удалось передать владение группой:', error);
      showToast('Не удалось передать владение группой.', 'error');
    }
  };

  const removeGroupMember = async (member: GroupMember) => {
    if (!activeGroup) return;
    const isSelf = member.userId === userId;
    const question = isSelf
      ? `Выйти из группы «${activeGroup.title}»? История группы больше не будет доступна.`
      : `Удалить @${member.username} из группы «${activeGroup.title}»?`;
    if (!window.confirm(question)) return;
    try {
      await api.delete(`/groups/${activeGroup.id}/members/${member.userId}`);
      await loadGroups();
      if (isSelf) {
        setActiveGroupId('');
        setMessages([]);
        setLoadedGroupId(null);
        setSearchParams({}, { replace: true });
        setSettingsOpen(false);
        showToast('Вы вышли из группы.', 'success');
      } else {
        showToast(`@${member.username} удалён(а) из группы.`, 'success');
      }
    } catch (error) {
      console.error('Не удалось изменить состав группы:', error);
      showToast('Не удалось изменить состав группы. Проверьте права и попробуйте снова.', 'error');
    }
  };

  const loadPublicGroups = useCallback(async () => {
    try {
      const response = await api.get<typeof publicGroups>('/groups/discover');
      setPublicGroups(response.data);
      setDiscoverOpen(true);
    } catch (error) {
      console.error('Не удалось загрузить публичные группы:', error);
      showToast('Не удалось загрузить публичные группы.', 'error');
    }
  }, [showToast]);

  /* oxlint-disable react-hooks/set-state-in-effect -- The route query requests loading public groups for the discovery screen. */
  useEffect(() => {
    if (searchParams.get('discover') === '1') void loadPublicGroups();
  }, [searchParams, loadPublicGroups]);
  /* oxlint-enable react-hooks/set-state-in-effect */

  const joinPublicGroup = async (groupId: string) => {
    setJoiningPublicGroup(groupId);
    try {
      await api.post(`/groups/${groupId}/join`);
      await loadGroups();
      setDiscoverOpen(false);
      setSearchParams({ group: groupId }, { replace: true });
      setActiveGroupId(groupId);
      showToast('Вы вступили в группу.', 'success');
    } catch (error) {
      console.error('Не удалось вступить в публичную группу:', error);
      showToast('Не удалось вступить в группу.', 'error');
    } finally { setJoiningPublicGroup(null); }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeGroup || !user?.id || !draft.trim() || sending) return;
    if (!canSendEncryptedMessages(e2eeStatus)) { showToast('Отправка приостановлена: сначала восстановите ключ переписки на этом устройстве.', 'error'); return; }
    const targetGroup = activeGroup;
    const replyTarget = replyingMessage;
    const messageText = draft;
    setSending(true);
    try {
      const encrypted = await encryptBytes(
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: messageText })),
        groupRecipients(targetGroup),
      );
      const mentionedUserIds = targetGroup.members
        .filter((member) => member.userId !== user.id && new RegExp(`(^|[^\\w])@${escapeRegExp(member.username)}(?![\\w.-])`, 'i').test(messageText))
        .map((member) => member.userId);
      const response = replyTarget
        ? await api.post<GroupMessage>(`/messages/${replyTarget.id}/reply`, { text: encrypted, type: 'text', mentionUserIds: mentionedUserIds })
        : await api.post<GroupMessage>(`/groups/${targetGroup.id}/messages`, {
          text: encrypted,
          mentionUserIds: mentionedUserIds,
        });
      const decrypted = await decryptGroupMessage(response.data, user.id);
      if (activeGroupKeyRef.current === targetGroup.id) {
        setMessages((current) => [...current, decrypted]);
        setDraft('');
        setReplyingMessage(null);
      }
      writeGroupDraft(user.id, targetGroup.id, '');
    } catch (error) {
      console.error('Не удалось отправить сообщение в группу:', error);
      showToast(error instanceof Error ? error.message : 'Не удалось отправить сообщение.', 'error');
    } finally {
      setSending(false);
    }
  };

  const toggleReaction = async (message: GroupMessage, emoji: string) => {
    try {
      await api.post(`/messages/${message.id}/reactions`, { emoji });
    } catch (error) {
      console.error('Не удалось сохранить реакцию:', error);
      showToast('Не удалось сохранить реакцию.', 'error');
    }
  };

  const deleteMessage = async (message: GroupMessage) => {
    try {
      await api.delete(`/messages/${message.id}`);
      setMessages((current) => current.filter((item) => item.id !== message.id));
    } catch (error) {
      console.error('Не удалось удалить сообщение:', error);
      showToast('Не удалось удалить сообщение.', 'error');
    }
  };

  const saveEdit = async (messageId: string) => {
    if (!activeGroup || !user?.id) return;
    if (!canSendEncryptedMessages(e2eeStatus)) { showToast('Изменение приостановлено: сначала восстановите ключ переписки на этом устройстве.', 'error'); return; }
    try {
      const encrypted = await encryptBytes(
        new TextEncoder().encode(JSON.stringify({ kind: 'text', text: editDraft })),
        groupRecipients(activeGroup),
      );
      const response = await api.patch<GroupMessage>(`/messages/${messageId}`, { text: encrypted });
      const decrypted = await decryptGroupMessage(response.data, user.id);
      setMessages((current) => current.map((message) => message.id === messageId ? decrypted : message));
      setEditingMessage(null);
      setEditDraft('');
    } catch (error) {
      console.error('Не удалось изменить сообщение:', error);
      showToast(error instanceof Error ? error.message : 'Не удалось изменить сообщение.', 'error');
    }
  };

  const sendGroupAttachment = async (file: File) => {
    if (!activeGroup || !user?.id || sending) return;
    if (!canSendEncryptedMessages(e2eeStatus)) { showToast('Отправка приостановлена: сначала восстановите ключ переписки на этом устройстве.', 'error'); return; }
    const targetGroup = activeGroup;
    const replyTarget = replyingMessage;
    if (!GROUP_ATTACHMENT_TYPES.has(file.type)) {
      showToast('Неподдерживаемый формат файла.', 'error');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast('Размер вложения не должен превышать 2 МБ.', 'error');
      return;
    }
    if (!file.size) {
      showToast('Нельзя отправить пустой файл.', 'error');
      return;
    }
    setSending(true);
    try {
      const packed = packAttachmentPayload(new Uint8Array(await file.arrayBuffer()), {
        fileName: file.name,
        contentType: file.type,
      });
      const encrypted = await encryptBytes(packed, groupRecipients(targetGroup));
      const response = replyTarget
        ? await api.post<GroupMessage>(`/messages/${replyTarget.id}/reply`, { type: 'file', fileData: encrypted })
        : await api.post<GroupMessage>(`/groups/${targetGroup.id}/messages`, { text: encrypted, type: 'file' });
      const decrypted = await decryptGroupMessage(response.data, user.id);
      if (activeGroupKeyRef.current === targetGroup.id) {
        setMessages((current) => [...current, decrypted]);
        setReplyingMessage(null);
      }
      showToast(file.type.startsWith('audio/') ? 'Голосовое сообщение отправлено.' : 'Файл отправлен в зашифрованном виде.', 'success');
    } catch (error) {
      console.error('Не удалось отправить вложение в группу:', error);
      showToast(error instanceof Error ? error.message : 'Не удалось отправить файл.', 'error');
    } finally {
      setSending(false);
    }
  };

  const sendAttachment = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void sendGroupAttachment(file);
  };

  const startVoiceRecording = async () => {
    if (recordingVoice || sending) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('Запись голосовых сообщений не поддерживается этим браузером.', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm', 'audio/ogg', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      voiceChunksRef.current = [];
      voiceCancelledRef.current = false;
      recorder.ondataavailable = (event) => { if (event.data.size) voiceChunksRef.current.push(event.data); };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecordingVoice(false);
        showToast('Не удалось записать голосовое сообщение.', 'error');
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecordingVoice(false);
        if (voiceCancelledRef.current) {
          voiceChunksRef.current = [];
          voiceCancelledRef.current = false;
          return;
        }
        const type = (recorder.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(voiceChunksRef.current, { type });
        voiceChunksRef.current = [];
        if (!blob.size) return;
        const extension = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        void sendGroupAttachment(new File([blob], `voice-message.${extension}`, { type }));
      };
      voiceRecorderRef.current = recorder;
      recorder.start();
      setRecordingVoice(true);
      showToast('Запись началась. Нажмите микрофон для отправки или крестик для отмены.', 'info');
    } catch {
      showToast('Нет доступа к микрофону. Разрешите его в браузере.', 'error');
    }
  };

  const stopVoiceRecording = () => {
    const recorder = voiceRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    voiceRecorderRef.current = null;
  };

  const cancelVoiceRecording = () => {
    const recorder = voiceRecorderRef.current;
    voiceCancelledRef.current = true;
    voiceChunksRef.current = [];
    voiceRecorderRef.current = null;
    setRecordingVoice(false);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else voiceCancelledRef.current = false;
    showToast('Запись голосового сообщения отменена.', 'info');
  };

  const forwardMessage = async (targetGroup: Group) => {
    const source = forwardingMessage;
    if (!source || !user?.id || forwarding) return;
    if (!canSendEncryptedMessages(e2eeStatus)) { showToast('Пересылка приостановлена: сначала восстановите ключ переписки на этом устройстве.', 'error'); return; }
    setForwarding(true);
    try {
      let payload: { targetGroupId: string; text?: string; type: 'text' | 'file'; fileData?: string };
      if (source.type === 'text') {
        const encrypted = await encryptBytes(
          new TextEncoder().encode(JSON.stringify({ kind: 'text', text: source.text })),
          groupRecipients(targetGroup),
        );
        payload = { targetGroupId: targetGroup.id, text: encrypted, type: 'text' };
      } else {
        if (!source.fileData || !source.fileName || !source.contentType || !GROUP_ATTACHMENT_TYPES.has(source.contentType)) {
          throw new Error('Исходное вложение недоступно для пересылки.');
        }
        const sourceBlob = await fetch(source.fileData).then((response) => {
          if (!response.ok) throw new Error('Не удалось прочитать вложение.');
          return response.blob();
        });
        if (!sourceBlob.size || sourceBlob.size > 2 * 1024 * 1024) throw new Error('Вложение превышает допустимый размер.');
        const packed = packAttachmentPayload(new Uint8Array(await sourceBlob.arrayBuffer()), {
          fileName: source.fileName,
          contentType: source.contentType,
        });
        const encrypted = await encryptBytes(packed, groupRecipients(targetGroup));
        payload = { targetGroupId: targetGroup.id, type: 'file', fileData: encrypted };
      }
      const response = await api.post<GroupMessage>(`/messages/${source.id}/forward`, payload);
      if (activeGroupKeyRef.current === targetGroup.id) {
        const decrypted = await decryptGroupMessage(response.data, user.id);
        setMessages((current) => [...current, decrypted]);
      }
      setForwardingMessage(null);
      setForwardSearch('');
      showToast(`Сообщение переслано в группу «${targetGroup.title}».`, 'success');
    } catch (error) {
      console.error('Не удалось переслать сообщение в группу:', error);
      showToast(error instanceof Error ? error.message : 'Не удалось переслать сообщение.', 'error');
    } finally {
      setForwarding(false);
    }
  };

  const loadOlder = async () => {
    if (!activeGroup || !messages.length || !hasMore) return;
    try {
      await loadMessages(activeGroup.id, messages[0].id);
    } catch (error) {
      console.error('Не удалось загрузить предыдущие сообщения:', error);
      showToast('Не удалось загрузить предыдущие сообщения.', 'error');
    }
  };

  const searchEntireGroupHistory = async () => {
    if (!activeGroup || !hasMore || searchingHistory || !messages.length) return;
    const groupId = activeGroup.id;
    let cursor = messages[0].id;
    let pages = 0;
    setSearchingHistory(true);
    setSearchedHistoryPages(0);
    try {
      while (cursor && activeGroupKeyRef.current === groupId) {
        const response = await api.get<GroupMessage[]>(`/groups/${groupId}/messages`, { params: { limit: 20, before: cursor } });
        const page = userId ? await Promise.all(response.data.map((message) => decryptGroupMessage(message, userId))) : response.data;
        if (activeGroupKeyRef.current !== groupId) break;
        if (!page.length) {
          setHasMore(false);
          break;
        }
        setMessages((current) => {
          const ids = new Set(current.map((message) => message.id));
          return [...page.filter((message) => !ids.has(message.id)), ...current];
        });
        cursor = page[0].id;
        pages += 1;
        setSearchedHistoryPages(pages);
        setHasMore(page.length === 20);
        if (page.length < 20) break;
      }
    } catch (error) {
      console.error('Не удалось выполнить поиск по истории группы:', error);
      showToast('Не удалось загрузить часть истории для поиска.', 'error');
    } finally {
      setSearchingHistory(false);
    }
  };

  const exportGroup = async (format: 'json' | 'html') => {
    if (!activeGroup || !user?.id) return;
    try {
      const response = await api.get<GroupMessage[]>(`/groups/${activeGroup.id}/export`, { params: { format: 'json' } });
      const decrypted = await Promise.all(response.data.map((message) => decryptGroupMessage(message, user.id)));
      const exportData = format === 'json'
        ? JSON.stringify(decrypted, null, 2)
        : `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${escapeHtml(activeGroup.title)}</title><style>body{font:15px system-ui;max-width:760px;margin:32px auto;padding:0 16px;background:#0b1020;color:#e2e8f0}article{padding:14px;margin:10px 0;border:1px solid #334155;border-radius:14px}time{color:#94a3b8;font-size:12px;margin-right:12px}p{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>${escapeHtml(activeGroup.title)}</h1>${decrypted.map((message) => `<article><time>${escapeHtml(formatAppDateTime(message.createdAt, { second: '2-digit' }))}</time><b>${escapeHtml(message.senderId)}</b><p>${escapeHtml(message.type === 'text' ? message.text : message.fileName || 'Вложение')}</p></article>`).join('')}</html>`;
      const blob = new Blob([exportData], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pulse-group-${activeGroup.id}.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`История группы скачана в формате ${format.toUpperCase()}.`, 'success');
    } catch (error) {
      console.error('Не удалось экспортировать группу:', error);
      showToast('Не удалось экспортировать историю группы.', 'error');
    }
  };

  return (
    <>
    <main className="animate-fade-in flex h-full min-h-0 w-full bg-bg-base text-t-primary">
      <aside className={`${embedded ? 'hidden' : activeGroup ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-white/[0.08] bg-panel md:w-80`}>
        <WorkspaceSidebarHeader
          searchValue={groupSearch}
          onSearchChange={setGroupSearch}
          searchPlaceholder="Поиск переписок"
        />
        <div className="border-b border-white/[0.06] px-3 py-2"><WorkspaceTabs /></div>
        <header className="flex items-center justify-between border-b border-white/[0.08] p-4">
          <button type="button" onClick={() => navigate('/')} className="rounded-xl p-2 text-t-secondary transition hover:bg-white/[0.06] hover:text-white" aria-label="Назад к чатам">
            <ArrowLeft size={18} />
          </button>
          <h1 className="flex items-center gap-2 text-sm font-semibold"><Users size={17} className="text-accent" /> Общие группы</h1>
          <button type="button" onClick={() => { setCreating(true); setAddingMembers(false); setSelectedMembers([]); setMemberSearch(''); setActiveGroupId(''); }} className="rounded-xl p-2 text-accent transition hover:bg-accent/10" aria-label="Создать группу" title="Создать группу">
            <Plus size={18} />
          </button>
        </header>



        <UnifiedWorkspaceList search={groupSearch} activeKind="group" activeId={activeGroup?.id || null} />
      </aside>

      <section className={`${embedded || activeGroup ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col`}>
        {activeGroup ? (
          <>
            <EncryptionNotice />
            <header className="relative z-10 flex items-center gap-3 border-b border-slate-800/60 p-2.5 glass-panel sm:p-4">
              <button type="button" onClick={() => { setActiveGroupId(''); setSearchParams({}, { replace: true }); }} className="rounded-lg p-2 text-t-secondary hover:bg-white/[0.06] md:hidden" aria-label="К списку групп"><ArrowLeft size={18} /></button>
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"><Users size={18} /></div>
              <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{activeGroup.title}</h2><p className="text-[11px] text-slate-500">{activeGroup.memberCount} участников</p></div>
              <button type="button" onClick={() => void exportGroup('json')} title="Экспорт JSON" aria-label="Экспортировать группу в JSON" className="rounded-xl p-2 text-slate-500 hover:bg-white/[0.05] hover:text-accent"><Download size={15} /></button>
              <button type="button" onClick={() => void exportGroup('html')} title="Экспорт HTML" aria-label="Экспортировать группу в HTML" className="rounded-xl p-2 text-slate-500 hover:bg-white/[0.05] hover:text-accent"><FileText size={15} /></button>
              <button type="button" onClick={() => { setAddingMembers(true); setCreating(false); setSelectedMembers([]); setMemberSearch(''); }} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.05]"><UserPlus size={15} /><span className="hidden sm:inline">Добавить</span></button>
              <button type="button" onClick={() => void loadPublicGroups()} title="Найти публичные группы" aria-label="Найти публичные группы" className="rounded-xl border border-white/10 p-2 text-slate-300 hover:bg-white/[0.05] hover:text-accent"><Globe size={16} /></button>
              <button type="button" onClick={() => setSettingsOpen((value) => !value)} title="Участники и настройки" aria-label="Участники и настройки группы" className="rounded-xl border border-white/10 p-2 text-slate-300 hover:bg-white/[0.05] hover:text-accent"><Settings size={16} /></button>
            </header>

            {discoverOpen && (
              <section className="max-h-[35vh] overflow-y-auto border-b border-white/[0.08] bg-panel p-4 sm:px-5">
                <div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-semibold">Публичные группы</h3><p className="mt-1 text-[11px] text-slate-500">Вступайте без приглашения.</p></div><button type="button" onClick={() => setDiscoverOpen(false)} aria-label="Закрыть публичные группы" className="rounded-lg p-2 text-t-secondary hover:bg-white/5"><X size={15} /></button></div>
                <div className="space-y-1.5">
                  {publicGroups.map((group) => <div key={group.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] px-3 py-2"><div className="grid h-8 w-8 place-items-center rounded-xl bg-accent/10 text-accent"><Users size={15} /></div><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{group.title}</p><p className="text-[10px] text-slate-500">{group.memberCount} участников · владелец @{group.ownerUsername}</p></div><button type="button" disabled={joiningPublicGroup === group.id} onClick={() => void joinPublicGroup(group.id)} className="rounded-lg bg-accent px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50">{joiningPublicGroup === group.id ? 'Вступаем…' : 'Вступить'}</button></div>)}
                  {!publicGroups.length && <p className="py-5 text-center text-xs text-slate-500">Пока нет доступных публичных групп.</p>}
                </div>
              </section>
            )}
            {settingsOpen && (<>
              <button type="button" aria-label="Закрыть меню настроек группы" onClick={() => setSettingsOpen(false)} className="fixed inset-0 z-[79] bg-black/55 backdrop-blur-sm" />
              <section className="fixed inset-y-0 right-0 z-[80] w-full max-w-lg overflow-y-auto border-l border-white/10 bg-panel p-4 shadow-2xl sm:p-6">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div><h3 className="text-sm font-semibold">Участники группы</h3><p className="mt-1 text-[11px] text-slate-500">{activeGroup.members.length} участников · владелец и администраторы отмечены отдельно</p></div>
                  <button type="button" onClick={() => void copyInviteLink()} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent hover:bg-accent/15"><Copy size={14} /> Скопировать приглашение</button>
                  <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Закрыть настройки группы" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-t-secondary hover:bg-white/5 hover:text-white"><X size={16} /></button>
                </div>
                <div className="space-y-1.5">
                  {activeGroup.members.map((member) => {
                    const role = member.role || (member.userId === activeGroup.ownerId ? 'owner' : 'member');
                    const isOwner = role === 'owner' || member.userId === activeGroup.ownerId;
                    return <div key={member.userId} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] px-3 py-2">
                      {member.avatarUrl ? <img src={member.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" /> : <div className="grid h-8 w-8 place-items-center rounded-full bg-accent/10 text-xs text-accent">{(member.displayName || member.username || '?').slice(0, 1).toUpperCase()}</div>}
                      <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{member.displayName || member.username} <span className="text-slate-500">@{member.username}</span></p>
                        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">{isOwner ? <><Crown size={11} className="text-amber-400" /> Владелец</> : role === 'admin' ? <><ShieldCheck size={11} className="text-accent" /> Администратор</> : 'Участник'}</p></div>
                      {activeGroup.currentUserRole === 'owner' && !isOwner && <>
                        <button type="button" onClick={() => void updateMemberRole(member, role === 'admin' ? 'member' : 'admin')} className="rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-t-secondary hover:border-accent/30 hover:text-accent">{role === 'admin' ? 'Снять админа' : 'Назначить админом'}</button>
                        <button type="button" onClick={() => void transferOwnership(member)} className="rounded-lg border border-amber-400/20 px-2 py-1.5 text-[10px] text-amber-300 hover:bg-amber-400/10">Передать владельца</button>
                        <button type="button" onClick={() => void removeGroupMember(member)} title="Удалить участника" aria-label={`Удалить @${member.username} из группы`} className="rounded-lg p-1.5 text-slate-500 hover:bg-rose-400/10 hover:text-rose-300"><Trash2 size={14} /></button>
                      </>}
                    </div>;
                  })}
                </div>
                <div className="mt-4 rounded-xl border border-white/[0.07] p-3">
                  <div className="mb-2 flex items-center justify-between gap-3"><div><p className="text-xs font-semibold">Приглашение и видимость</p><p className="mt-1 text-[10px] text-slate-500">Ссылку можно отправить любому пользователю.</p></div><span className="inline-flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-t-secondary">{activeGroup.isPublic ? <Globe size={12} /> : <Lock size={12} />}{activeGroup.isPublic ? 'Публичная' : 'Приватная'}</span></div>
                  {['owner', 'admin'].includes(activeGroup.currentUserRole) ? <>
                    <label className="mb-2 block text-[10px] text-t-secondary">Название группы</label>
                    <input value={groupTitleDraft} onChange={(event) => setGroupTitleDraft(event.target.value)} maxLength={64} minLength={2} className="mb-3 h-9 w-full rounded-lg border border-white/10 bg-slate-950/50 px-3 text-xs outline-none focus:border-accent/40" />
                    <label className="mb-2 block text-[10px] text-t-secondary">Описание группы</label>
                    <textarea value={groupDescriptionDraft} onChange={(event) => setGroupDescriptionDraft(event.target.value)} maxLength={500} rows={3} placeholder="Кратко расскажите о группе" className="mb-3 w-full resize-y rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-xs outline-none focus:border-accent/40" />
                    <label className="mb-2 block text-[10px] text-t-secondary">Аватар группы · PNG, JPG, GIF или WebP до 1 МБ</label>
                    <div className="mb-3 flex items-center gap-3">
                      <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-accent/10 text-accent">{groupAvatarDraft ? <img src={groupAvatarDraft} alt="Аватар группы" className="h-full w-full object-cover" /> : <Users size={17} />}</div>
                      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (file.size > 1_000_000 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { showToast('Выберите PNG, JPG, GIF или WebP размером до 1 МБ.', 'error'); return; } const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') setGroupAvatarDraft(reader.result); }; reader.onerror = () => showToast('Не удалось прочитать изображение.', 'error'); reader.readAsDataURL(file); }} className="min-w-0 flex-1 text-[10px] text-slate-500 file:mr-2 file:rounded-lg file:border-0 file:bg-white/10 file:px-2 file:py-1.5 file:text-[10px] file:text-slate-200" />
                      {groupAvatarDraft && <button type="button" onClick={() => setGroupAvatarDraft('')} className="rounded-lg px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-400/10">Убрать</button>}
                    </div>
                    <button type="button" disabled={savingSettings || groupTitleDraft.trim().length < 2} onClick={() => void saveGroupSettings()} className="w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{savingSettings ? 'Сохраняем…' : 'Сохранить изменения'}</button>
                    <button type="button" disabled={savingSettings} onClick={() => void toggleGroupPrivacy()} className="w-full rounded-lg border border-white/10 px-3 py-2 text-xs text-t-secondary hover:border-accent/30 hover:text-accent disabled:opacity-50">{activeGroup.isPublic ? 'Сделать группу приватной' : 'Сделать группу публичной'}</button>
                  </> : <p className="text-[11px] text-slate-500">Изменять настройки группы могут администраторы и владелец. Назначать администраторов и передавать владение может только владелец.</p>}
                </div>
                {activeGroup.currentUserRole !== 'owner' && <button type="button" onClick={() => { const self = activeGroup.members.find((member) => member.userId === userId); if (self) void removeGroupMember(self); }} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/20 px-3 py-2.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-400/10"><LogOut size={14} /> Выйти из группы</button>}
              </section>
              </>)}

            <div className="flex items-center gap-2 border-b border-white/[0.06] bg-panel px-3 py-2 sm:px-5">
              <label className="relative min-w-0 flex-1"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" /><input value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Поиск в переписке" aria-label="Поиск по сообщениям группы" className="h-9 w-full rounded-xl border border-white/10 bg-slate-950/50 pl-9 pr-3 text-xs outline-none focus:border-accent/40" /></label>
              {messageSearch.trim() && <span className="shrink-0 text-[10px] text-t-secondary">{messages.filter((message) => `${message.text} ${message.fileName || ''}`.toLocaleLowerCase().includes(messageSearch.trim().toLocaleLowerCase())).length} в загруженной истории</span>}
              {messageSearch.trim() && hasMore && <button type="button" disabled={searchingHistory} onClick={() => void searchEntireGroupHistory()} className="shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-t-secondary hover:border-accent/30 hover:text-accent disabled:opacity-50">{searchingHistory ? `Ищем… ${searchedHistoryPages}` : 'Искать дальше'}</button>}
            </div>

            {addingMembers && (
              <div className="border-b border-white/[0.08] bg-slate-900/70 p-3 sm:px-5">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {activeGroup.members.map((member) => <span key={member.userId} className="rounded-full bg-white/[0.05] px-2.5 py-1 text-[10px] text-t-secondary">@{member.username}</span>)}
                </div>
                <div className="flex gap-2">
                  <input value={memberSearch} onChange={(event) => handleMemberSearchChange(event.target.value)} placeholder="Найти по полному @username" className="h-10 min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950/50 px-3 text-xs outline-none focus:border-accent/50" />
                  <button type="button" disabled={!selectedMembers.length} onClick={() => void addMembersToGroup()} className="rounded-xl bg-accent px-3 text-xs font-semibold disabled:opacity-40">Добавить</button>
                  <button type="button" onClick={() => { setAddingMembers(false); setMemberSearch(''); setSelectedMembers([]); }} className="rounded-xl p-2 text-t-secondary hover:bg-white/[0.05]" aria-label="Закрыть"><X size={16} /></button>
                </div>
                {!!selectedMembers.length && <div className="mt-2 flex flex-wrap gap-1.5">{selectedMembers.map((member) => <button key={member.id} type="button" onClick={() => toggleMember(member)} className="inline-flex items-center gap-1 rounded-full border border-accent/20 bg-accent/10 px-2.5 py-1 text-[10px] text-accent">@{member.username}<X size={11} /></button>)}</div>}
                {!!addableResults.length && <div className="mt-2 flex flex-wrap gap-2">{addableResults.map((candidate) => <button key={candidate.id} type="button" onClick={() => toggleMember(candidate)} className={`rounded-full border px-3 py-1.5 text-[11px] ${selectedIds.has(candidate.id) ? 'border-accent/40 bg-accent/15 text-accent' : 'border-white/10 text-slate-300'}`}>@{candidate.username}</button>)}</div>}
                <p className="mt-2 text-[10px] text-slate-500">Новые участники видят сообщения только после вступления. Все участники могут приглашать других.</p>
              </div>
            )}

            <div className="chat-wallpaper-surface custom-scrollbar relative z-10 flex-1 min-h-0 space-y-3 overflow-y-auto px-3 py-4 sm:px-6">
              {hasMore && <button type="button" onClick={() => void loadOlder()} className="mx-auto block rounded-full border border-white/10 px-3 py-1.5 text-[10px] text-t-secondary hover:bg-white/[0.04]">Загрузить более ранние сообщения</button>}
              {loadingMessages && <div role="status" className="space-y-3">{[0, 1, 2].map((item) => <div key={item} className="chat-skeleton h-14 w-2/3 rounded-2xl" />)}</div>}
              {!loadingMessages && !messages.length && <p className="m-auto py-10 text-center text-xs text-slate-500">В этой группе пока нет сообщений.</p>}
              {messages.map((message) => {
                const author = activeGroup.members.find((member) => member.userId === message.senderId);
                const own = message.senderId === user?.id;
                const quotedMessage = message.replyTo
                  ? messages.find((item) => item.id === message.replyTo) || replyPreviews[message.replyTo] || undefined
                  : undefined;
                return (
                  <article key={message.id} id={`group-message-${message.id}`} className={`chat-message-bubble group max-w-[min(80%,640px)] rounded-2xl border px-4 py-3 ${own ? 'chat-message-own' : 'chat-message-other'} ${messageSearch.trim() && `${message.text} ${message.fileName || ''}`.toLocaleLowerCase().includes(messageSearch.trim().toLocaleLowerCase()) ? 'ring-1 ring-amber-300/30' : ''}`}>
                    {!own && <p className="mb-1 text-[10px] font-semibold text-accent">{author?.displayName || author?.username || 'Участник'} <span className="font-normal text-slate-500">@{author?.username}</span></p>}
                    {message.forwardedFrom && <div className="mb-2 flex items-center gap-1 text-[10px] font-medium text-slate-400"><Forward size={11} /> Переслано</div>}
                    {message.replyTo && <button type="button" disabled={!messages.some((item) => item.id === message.replyTo)} onClick={() => document.getElementById(`group-message-${message.replyTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })} className="mb-2 block w-full rounded-lg border-l-2 border-accent/60 bg-black/15 px-2.5 py-1.5 text-left disabled:cursor-default"><p className="text-[9px] font-semibold uppercase tracking-wider text-accent">{quotedMessage ? activeGroup.members.find((member) => member.userId === quotedMessage.senderId)?.username || 'Участник' : 'Ответ на сообщение'}</p><p className="truncate text-[10px] text-slate-300">{quotedMessage?.text || (quotedMessage && quotedMessage.type !== 'text' ? '📎 Вложение' : 'Исходное сообщение недоступно')}</p></button>}
                    {message.type === 'image' && message.fileData ? <img src={message.fileData} alt={message.fileName || 'Изображение'} className="mb-2 max-h-72 max-w-full rounded-lg object-contain" /> : message.type === 'file' && message.fileData && message.contentType?.startsWith('audio/') ? <VoiceMessagePlayer src={message.fileData} fileName={message.fileName} mine={own} /> : message.type === 'file' && message.fileData ? <a href={message.fileData} download={message.fileName || 'attachment'} className="mb-2 flex items-center gap-2 rounded-lg bg-black/10 p-3 hover:bg-black/20"><FileText size={20} /><span className="max-w-56 break-all">{message.fileName || 'Скачать файл'}</span></a> : null}
                    {editingMessage === message.id && message.type === 'text' ? (
                      <div className="space-y-2"><textarea value={editDraft} onChange={(event) => setEditDraft(event.target.value)} className="w-full resize-y rounded-lg border border-white/10 bg-slate-950/60 p-2 text-sm outline-none focus:border-accent/40" /><div className="flex justify-end gap-2"><button type="button" onClick={() => setEditingMessage(null)} className="text-[10px] text-t-secondary">Отмена</button><button type="button" onClick={() => void saveEdit(message.id)} className="text-[10px] font-semibold text-accent">Сохранить</button></div></div>
                    ) : message.type === 'text' ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{messageSearch.trim() && message.text.toLocaleLowerCase().includes(messageSearch.trim().toLocaleLowerCase()) ? <>{message.text.split(new RegExp(`(${escapeRegExp(messageSearch.trim())})`, 'ig')).map((part, index) => part.toLocaleLowerCase() === messageSearch.trim().toLocaleLowerCase() ? <mark key={index} className="rounded bg-amber-300/30 text-inherit">{part}</mark> : part)}</> : message.text}</p> : null}
                    <div className="mt-2 flex items-center justify-between gap-4 text-[9px] text-slate-500">
                      <time>{formatAppDateTime(message.createdAt, { second: '2-digit' })}</time>
                      <span className="flex items-center gap-1"><button type="button" onClick={() => setReplyingMessage(message)} aria-label="Ответить на сообщение" className="rounded p-1 hover:bg-white/10 hover:text-accent"><Reply size={12} /></button><button type="button" onClick={() => { setForwardingMessage(message); setForwardSearch(''); }} aria-label="Переслать сообщение" className="rounded p-1 hover:bg-white/10 hover:text-accent"><Forward size={12} /></button>{message.edited && <span>изменено</span>}{own && <>{message.type === 'text' && <button type="button" onClick={() => { setEditingMessage(message.id); setEditDraft(message.text); }} aria-label="Редактировать" className="rounded p-1 hover:bg-white/10 hover:text-white"><span className="sr-only">Редактировать</span>✎</button>}<button type="button" onClick={() => void deleteMessage(message)} aria-label="Удалить" className="rounded p-1 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 size={12} /></button></>}</span>
                    </div>
                    {!!message.reactions.length && <div className="mt-2 flex flex-wrap gap-1">{REACTIONS.map((emoji) => { const count = message.reactions.filter((reaction) => reaction.emoji === emoji).length; return count ? <button key={emoji} type="button" onClick={() => void toggleReaction(message, emoji)} className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-xs">{emoji} {count}</button> : null; })}</div>}
                    <div className="mt-1 flex gap-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">{REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={() => void toggleReaction(message, emoji)} aria-label={`Поставить реакцию ${emoji}`} className="rounded-md p-1 text-[11px] hover:bg-white/10"><SmilePlus size={12} className="inline" /> {emoji}</button>)}</div>
                  </article>
                );
              })}
            </div>

            {replyingMessage && <div className="flex items-center gap-3 border-t border-white/[0.08] bg-panel px-4 pt-3"><Reply size={14} className="shrink-0 text-accent" /><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-wider text-accent">Ответ участнику группы</p><p className="truncate text-xs text-t-secondary">{replyingMessage.text || '📎 Вложение'}</p></div><button type="button" onClick={() => setReplyingMessage(null)} aria-label="Отменить ответ" className="grid h-10 w-10 place-items-center rounded-xl text-t-secondary hover:bg-white/5 hover:text-white"><X size={15} /></button></div>}
            <form onSubmit={(event) => void sendMessage(event)} className="glass-panel relative z-10 mx-3 mb-3 mt-2 flex items-end gap-1 rounded-2xl p-1.5 shadow-2xl transition-all focus-within:ring-2 focus-within:ring-accent/30 sm:mx-5 sm:gap-2 sm:p-2">
              <label className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-t-secondary transition ${sending ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-white/5 hover:text-accent'}`} title="Зашифрованное вложение"><Paperclip size={17} /><input type="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv,application/zip,audio/webm,audio/ogg,audio/mpeg,audio/mp4,audio/wav" onChange={(event) => void sendAttachment(event)} className="hidden" disabled={sending || recordingVoice} /></label>
              <div className="hidden max-w-[30%] gap-1 overflow-hidden sm:flex">{activeGroup.members.slice(0, 3).map((member) => <button key={member.userId} type="button" onClick={() => setDraft((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@${member.username} `)} className="truncate rounded-full bg-white/[0.04] px-2 py-1 text-[9px] text-slate-500 hover:text-accent">@{member.username}</button>)}</div>
              <textarea value={draft} onChange={(event) => { setDraft(event.target.value); writeGroupDraft(userId, activeGroupKey, event.target.value); }} rows={1} maxLength={4000} disabled={sending} placeholder="Сообщение группе… Используйте @username для упоминания" className="max-h-36 min-h-10 min-w-0 flex-1 resize-y bg-transparent px-2 py-2 text-sm leading-5 text-t-primary outline-none placeholder:text-slate-500 focus:outline-none" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && localStorage.getItem('skylineEnterToSend') !== 'false') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              {recordingVoice && <button type="button" onClick={cancelVoiceRecording} aria-label="Отменить голосовое сообщение" title="Отменить запись" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-rose-300 transition hover:bg-rose-500/10"><X size={17} /></button>}
              <button type="button" onClick={() => { if (recordingVoice) stopVoiceRecording(); else void startVoiceRecording(); }} disabled={sending} aria-label={recordingVoice ? 'Отправить голосовое сообщение' : 'Записать голосовое сообщение'} title={recordingVoice ? 'Завершить и отправить запись' : 'Записать голосовое сообщение'} className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition disabled:opacity-40 ${recordingVoice ? 'animate-pulse bg-rose-500/15 text-rose-300' : 'text-t-secondary hover:bg-white/5 hover:text-accent'}`}><Mic size={17} /></button>
              <button type="submit" disabled={!draft.trim() || sending} aria-label="Отправить сообщение" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40">{sending ? <span className="text-xs">…</span> : <Send size={17} />}</button>
            </form>
          </>
        ) : discoverOpen ? <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Публичные группы</h2><p className="mt-1 text-xs text-slate-500">Вступайте в открытые группы без ссылки-приглашения.</p></div><button type="button" onClick={() => { setDiscoverOpen(false); navigate('/groups'); }} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-t-secondary hover:bg-white/5">Закрыть</button></div>
            <div className="space-y-2">
              {publicGroups.map((group) => <div key={group.id} className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-panel p-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Users size={17} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{group.title}</p><p className="mt-1 text-[11px] text-slate-500">{group.memberCount} участников · владелец @{group.ownerUsername}</p></div><button type="button" disabled={joiningPublicGroup === group.id} onClick={() => void joinPublicGroup(group.id)} className="rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{joiningPublicGroup === group.id ? 'Вступаем…' : 'Вступить'}</button></div>)}
              {!publicGroups.length && <p className="rounded-2xl border border-white/[0.06] py-12 text-center text-xs text-slate-500">Пока нет доступных публичных групп.</p>}
            </div>
          </div>
        </div> : !embedded ? <div className="grid flex-1 place-items-center text-center text-sm text-slate-500"><div><Users size={28} className="mx-auto mb-3 text-slate-600" />Выберите группу или создайте новую.</div></div> : null}
      </section>
    </main>
    {creating && createPortal(
      <div className="fixed inset-0 z-[120] grid place-items-center overflow-y-auto bg-[#030712]/80 p-4 backdrop-blur-md" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false); }}>
        <form onSubmit={(event) => void createGroup(event)} className="my-auto w-full max-w-xl overflow-hidden rounded-[28px] border border-white/10 bg-[#101827] shadow-[0_30px_100px_rgba(0,0,0,0.55)] animate-scale-in">
          <div className="relative overflow-hidden border-b border-white/[0.07] px-6 pb-6 pt-6 sm:px-8">
            <div className="pointer-events-none absolute -right-10 -top-16 h-44 w-44 rounded-full bg-accent/15 blur-3xl" />
            <div className="relative flex items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/25 to-sky-400/10 text-accent shadow-lg shadow-accent/10"><Users size={25} /></div>
                <div><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Новое сообщество</p><h2 className="mt-1 text-xl font-bold tracking-tight text-white sm:text-2xl">Создать группу</h2><p className="mt-1.5 max-w-sm text-xs leading-5 text-slate-400">Соберите людей в одном месте и начните общаться.</p></div>
              </div>
              <button type="button" onClick={() => setCreating(false)} aria-label="Закрыть" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/[0.07] text-slate-400 transition hover:border-white/15 hover:bg-white/[0.06] hover:text-white"><X size={17} /></button>
            </div>
          </div>
          <div className="space-y-6 px-6 py-6 sm:px-8">
            <div className="flex items-center gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
              <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border border-accent/20 bg-accent/10 text-accent shadow-lg">{groupAvatarUrl ? <img src={groupAvatarUrl} alt="Предпросмотр аватара группы" className="h-full w-full object-cover" /> : <Users size={25} />}</div>
              <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-200">Аватар группы</p><p className="mt-1 text-[10px] leading-4 text-slate-500">Изображение помогает участникам узнать группу</p><label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-[10px] font-semibold text-slate-300 transition hover:bg-white/[0.05]"><Plus size={12} />{groupAvatarUrl ? 'Изменить изображение' : 'Выбрать изображение'}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (file.size > 1_000_000 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { showToast('Выберите PNG, JPG, GIF или WebP размером до 1 МБ.', 'error'); return; } const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') setGroupAvatarUrl(reader.result); }; reader.onerror = () => showToast('Не удалось прочитать изображение.', 'error'); reader.readAsDataURL(file); }} /></label></div>
              {groupAvatarUrl && <button type="button" onClick={() => setGroupAvatarUrl('')} className="rounded-lg p-2 text-slate-500 hover:bg-rose-400/10 hover:text-rose-300" aria-label="Убрать аватар"><X size={15} /></button>}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-3"><label htmlFor="new-group-title" className="text-xs font-semibold text-slate-200">Название группы</label><span className="text-[10px] tabular-nums text-slate-500">{groupTitle.length}/64</span></div>
              <input id="new-group-title" autoFocus value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} required minLength={2} maxLength={64} placeholder="Например, Друзья, команда или клуб" className="h-12 w-full rounded-2xl border border-white/10 bg-[#080e19]/80 px-4 text-sm text-white outline-none transition placeholder:text-slate-600 hover:border-white/15 focus:border-accent/60 focus:ring-4 focus:ring-accent/10" />
              <p className="mt-2 text-[10px] leading-4 text-slate-500">Название можно будет изменить позже в настройках группы.</p>
            </div>
            <div><div className="mb-2 flex items-center justify-between gap-3"><label htmlFor="new-group-description" className="text-xs font-semibold text-slate-200">Описание группы</label><span className="text-[10px] tabular-nums text-slate-500">{groupDescription.length}/500</span></div><textarea id="new-group-description" value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} maxLength={500} rows={3} placeholder="О чём эта группа? Расскажите участникам…" className="w-full resize-y rounded-2xl border border-white/10 bg-[#080e19]/80 px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-600 focus:border-accent/50 focus:ring-4 focus:ring-accent/10" /></div>
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
              <div className="mb-3 flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-sky-400/10 text-sky-300"><UserPlus size={17} /></div>
                <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-200">Добавить участников</p><p className="mt-1 text-[10px] text-slate-500">Необязательно — можно пригласить позже</p></div>
                {!!selectedMembers.length && <span className="rounded-full bg-accent/10 px-2.5 py-1 text-[10px] font-semibold text-accent">{selectedMembers.length} выбрано</span>}
              </div>
              <label className="relative block"><Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" /><input value={memberSearch} onChange={(event) => handleMemberSearchChange(event.target.value)} placeholder="Поиск по @username" className="h-11 w-full rounded-xl border border-white/10 bg-[#080e19]/80 pl-10 pr-3 text-xs text-white outline-none transition placeholder:text-slate-600 focus:border-accent/50 focus:ring-4 focus:ring-accent/10" /></label>
              {searching && <p className="mt-3 flex items-center gap-2 text-[11px] text-slate-400"><span className="h-3 w-3 animate-spin rounded-full border border-slate-500 border-t-accent" />Ищем пользователей…</p>}
              {!!addableResults.length && <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">{addableResults.map((candidate) => <button key={candidate.id} type="button" onClick={() => toggleMember(candidate)} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-white/[0.05]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/10 text-xs font-semibold text-accent">{(candidate.displayName || candidate.username || '?').slice(0,1).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-slate-200">{candidate.displayName || candidate.username}</span><span className="mt-0.5 block truncate text-[10px] text-slate-500">@{candidate.username}</span></span><UserPlus size={15} className="text-accent" /></button>)}</div>}
              {!!selectedMembers.length && <div className="mt-3 flex flex-wrap gap-2">{selectedMembers.map((member) => <button key={member.id} type="button" onClick={() => toggleMember(member)} className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 text-[10px] font-medium text-accent transition hover:bg-rose-400/10 hover:text-rose-300">@{member.username}<X size={11} /></button>)}</div>}
              {!searching && memberSearch.trim().startsWith('@') && memberSearch.trim().length >= 4 && !addableResults.length && <p className="mt-3 text-[11px] text-slate-500">Новых пользователей по этому запросу не найдено.</p>}
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-slate-950/35 px-3.5 py-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.05] text-slate-400"><Users size={15} /></div><p className="text-[11px] leading-5 text-slate-400">После создания вы сможете открыть группу и настроить её участников и доступ.</p></div>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-white/[0.07] bg-black/10 px-6 py-5 sm:flex-row sm:justify-end sm:px-8">
            <button type="button" onClick={() => setCreating(false)} className="h-11 rounded-xl border border-white/10 px-5 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.05]">Отмена</button>
            <button disabled={groupTitle.trim().length < 2} className="btn-glow btn-shine inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent-from to-accent-to px-6 text-xs font-bold text-white shadow-lg shadow-accent/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"><Plus size={15} />Создать группу</button>
          </div>
        </form>
      </div>,
      document.body,
    )}
    {forwardingMessage && createPortal(
      <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget && !forwarding) setForwardingMessage(null); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="group-forward-dialog-title" className="w-full max-w-md rounded-3xl border border-white/10 bg-panel p-5 shadow-2xl">
          <div className="mb-4 flex items-center justify-between gap-3"><div><h2 id="group-forward-dialog-title" className="text-sm font-semibold text-t-primary">Переслать сообщение</h2><p className="mt-1 text-xs text-t-secondary">Выберите группу-получателя</p></div><button type="button" disabled={forwarding} onClick={() => setForwardingMessage(null)} aria-label="Закрыть" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-t-secondary hover:bg-white/5 hover:text-white disabled:opacity-50"><X size={17} /></button></div>
          <input value={forwardSearch} onChange={(event) => setForwardSearch(event.target.value)} autoFocus placeholder="Найти группу" aria-label="Найти группу-получателя" className="mb-3 h-11 w-full rounded-xl border border-white/10 bg-slate-950/50 px-3 text-sm text-t-primary outline-none placeholder:text-slate-500 focus:border-accent/50" />
          <div className="max-h-72 space-y-1 overflow-y-auto">{groups.filter((group) => group.id !== activeGroupKey && group.title.toLocaleLowerCase().includes(forwardSearch.trim().toLocaleLowerCase())).map((group) => <button key={group.id} type="button" disabled={forwarding} onClick={() => void forwardMessage(group)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-50"><span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/10 text-accent"><Users size={16} /></span><span className="min-w-0 flex-1 truncate text-sm text-t-primary">{group.title}</span><span className="text-[10px] text-t-secondary">{group.memberCount} участников</span>{forwarding ? <span className="text-[10px] text-accent">Отправляю…</span> : <Forward size={15} className="text-t-secondary" />}</button>)}
            {!groups.some((group) => group.id !== activeGroupKey && group.title.toLocaleLowerCase().includes(forwardSearch.trim().toLocaleLowerCase())) && <p className="px-3 py-8 text-center text-xs text-t-secondary">Другие группы не найдены.</p>}
          </div>
        </section>
      </div>,
      document.body,
    )}
    </>
  );
}
