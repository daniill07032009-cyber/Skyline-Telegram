import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Bell, Check, Copy, Download, FileText, Hash, LockKeyhole, Mic, Paperclip, Pencil, Pin, Plus, Radio, Search, Send, Settings, Share2, Trash2, Users, X } from 'lucide-react';
import VoiceMessagePlayer from '../components/chat/VoiceMessagePlayer';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { getSocket } from '../api/socket';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/useToast';
import WorkspaceSidebarHeader from '../components/layout/WorkspaceSidebarHeader';
import WorkspaceTabs from '../components/layout/WorkspaceTabs';
import UnifiedWorkspaceList from '../components/layout/UnifiedWorkspaceList';
import { formatAppTime } from '../time';

interface Channel {
  id: string;
  title: string;
  description: string;
  visibility: 'public' | 'private';
  avatarUrl: string;
  ownerId: string;
  ownerUsername: string;
  ownerName: string;
  memberCount: number;
  isSubscribed: boolean;
  isOwner: boolean;
  createdAt: string;
  updatedAt?: string;
  lastMessageAt?: string | null;
}

interface ChannelPost {
  id: string;
  channelId: string;
  senderId: string;
  text: string;
  type?: 'text' | 'image' | 'file';
  fileName?: string;
  contentType?: string;
  fileData?: string;
  reactions: { userId: string; emoji: string }[];
  pinned: boolean;
  pinnedAt: string | null;
  createdAt: string;
}

interface ChannelMember {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  role: string;
  joinedAt: string;
}

interface InvitePreview {
  id: string;
  title: string;
  description: string;
  avatarUrl: string;
  memberCount: number;
  ownerName: string;
}

const REACTIONS = ['❤️', '👍', '😂', '🔥', '🎉', '😢'];

function sortChannelPosts(items: ChannelPost[]) {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
}

export default function Channels({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const { inviteCode } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const showToast = useToast();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(searchParams.get('channel'));

  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [postSearch, setPostSearch] = useState('');
  const [loadedPostChannelId, setLoadedPostChannelId] = useState<string | null>(null);
  const [invitePreviewState, setInvitePreviewState] = useState<{ code: string; preview: InvitePreview } | null>(null);
  const [search, setSearch] = useState('');
  const [listMode, setListMode] = useState<'mine' | 'discover'>('mine');
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [channelAvatarUrl, setChannelAvatarUrl] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [draft, setDraft] = useState('');
  const [postAttachment, setPostAttachment] = useState<File | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editPostDraft, setEditPostDraft] = useState('');
  const [savingPostEdit, setSavingPostEdit] = useState(false);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceCancelledRef = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => {
    voiceCancelledRef.current = true;
    voiceChunksRef.current = [];
    const recorder = voiceRecorderRef.current;
    voiceRecorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);
  const [inviteLink, setInviteLink] = useState('');
  const [membersOpen, setMembersOpen] = useState(false);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const postListRef = useRef<HTMLDivElement>(null);
  const scrollToLatestPostRef = useRef(false);

  /* oxlint-disable react-hooks/set-state-in-effect -- The route query is an external navigation signal that opens the create form and selects list mode. */
  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setVisibility('public');
      setCreating(true);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('create');
        return next;
      }, { replace: true });
    }
    setListMode(searchParams.get('discover') === '1' ? 'discover' : 'mine');
  }, [searchParams, setSearchParams]);
  /* oxlint-enable react-hooks/set-state-in-effect */

  const activeChannel = channels.find((channel) => channel.id === activeChannelId) || null;
  const activePosts = loadedPostChannelId === activeChannel?.id ? posts : [];
  const filteredPosts = postSearch.trim()
    ? activePosts.filter((post) => post.text.toLocaleLowerCase().includes(postSearch.trim().toLocaleLowerCase()))
    : activePosts;
  const invitePreview = inviteCode && invitePreviewState?.code === inviteCode
    ? invitePreviewState.preview
    : null;

  const loadChannels = useCallback(async () => {
    const response = await api.get<Channel[]>('/channels');
    const sorted = [...response.data].sort((a, b) => {
      const aTime = Date.parse(a.lastMessageAt || a.updatedAt || a.createdAt) || 0;
      const bTime = Date.parse(b.lastMessageAt || b.updatedAt || b.createdAt) || 0;
      return bTime - aTime;
    });
    setChannels(sorted);
    return sorted;
  }, []);

  const initializeChannels = useCallback(async () => {
    try {
      const items = await loadChannels();
      const requested = searchParams.get('channel');
      const discovering = searchParams.get('discover') === '1';
      const initial = requested && items.some((channel) => channel.id === requested)
        ? requested
        : (embedded || discovering) ? null : items.find((channel) => channel.isSubscribed)?.id || items[0]?.id || null;
      setActiveChannelId(initial);
      if (initial && !requested && !discovering) setSearchParams({ channel: initial }, { replace: true });
    } catch (error) {
      console.error('Не удалось загрузить каналы:', error);
      showToast('Не удалось загрузить каналы.', 'error');
    }
  }, [loadChannels, searchParams, setSearchParams, showToast, embedded]);

  const loadInvitePreview = useCallback(async (code: string, signal: AbortSignal) => {
    try {
      const response = await api.get<InvitePreview>(`/channels/invites/${code}`, { signal });
      setInvitePreviewState({ code, preview: response.data });
    } catch (error) {
      if (signal.aborted) return;
      console.error('Не удалось открыть приглашение в канал:', error);
      showToast('Ссылка-приглашение недействительна или устарела.', 'error');
    }
  }, [showToast]);

  const loadPosts = useCallback(async (channelId: string) => {
    scrollToLatestPostRef.current = true;
    setLoadingPosts(true);
    try {
      const response = await api.get<ChannelPost[]>(`/channels/${channelId}/posts`, { params: { limit: 50 } });
      setPosts(sortChannelPosts(response.data));
      setLoadedPostChannelId(channelId);
    } finally {
      setLoadingPosts(false);
    }
  }, []);

  useLayoutEffect(() => {
    if (!scrollToLatestPostRef.current || loadingPosts || loadedPostChannelId !== activeChannelId) return;
    const list = postListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    scrollToLatestPostRef.current = false;
  }, [posts, loadingPosts, loadedPostChannelId, activeChannelId]);

  /* oxlint-disable react-hooks/set-state-in-effect -- Initialize channel data asynchronously when route parameters change. */
  useEffect(() => {
    if (inviteCode) {
      return;
    }
    void initializeChannels();
  }, [inviteCode, initializeChannels]);
  /* oxlint-enable react-hooks/set-state-in-effect */

  /* oxlint-disable react-hooks/set-state-in-effect -- Load invitation preview asynchronously when an invite route is opened. */
  useEffect(() => {
    if (!inviteCode) return;
    const controller = new AbortController();
    void loadInvitePreview(inviteCode, controller.signal);
    return () => controller.abort();
  }, [inviteCode, loadInvitePreview]);
  /* oxlint-enable react-hooks/set-state-in-effect */

  /* oxlint-disable react-hooks/set-state-in-effect -- Synchronize channel selection and cleared embedded state with router navigation. */
  useEffect(() => {
    const requested = searchParams.get('channel');
    if (requested && channels.some((channel) => channel.id === requested) && requested !== activeChannelId) {
      setActiveChannelId(requested);
      setInviteLink('');
    } else if (!requested && embedded && activeChannelId) {
      setActiveChannelId(null);
      setPosts([]);
      setLoadedPostChannelId(null);
    }
  }, [searchParams, channels, activeChannelId, embedded]);
  /* oxlint-enable react-hooks/set-state-in-effect */

  /* oxlint-disable react-hooks/set-state-in-effect -- Loading posts is an asynchronous side effect for the selected channel. */
  useEffect(() => {
    if (!activeChannelId || inviteCode) return;
    void loadPosts(activeChannelId).catch((error: unknown) => {
      console.error('Не удалось загрузить публикации канала:', error);
      showToast('Не удалось загрузить публикации канала.', 'error');
    });
  }, [activeChannelId, inviteCode, loadPosts, showToast]);
  /* oxlint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handleChannelChanged = (event: { channelId?: string; action?: string; post?: ChannelPost; postId?: string }) => {
      if (event.action === 'deleted' && event.channelId === activeChannelId) {
        setActiveChannelId(null);
        setPosts([]);
      }
      if (event.channelId === activeChannelId) {
        if (event.action === 'post_deleted' && event.postId) {
          setPosts((current) => current.filter((post) => post.id !== event.postId));
        } else if (event.post && ['post_created', 'post_updated'].includes(event.action || '')) {
          if (event.action === 'post_created') scrollToLatestPostRef.current = true;
          setPosts((current) => {
            const exists = current.some((post) => post.id === event.post?.id);
            const updated = exists
              ? current.map((post) => post.id === event.post?.id ? event.post! : post)
              : [...current, event.post!];
            return sortChannelPosts(updated);
          });
        }
      }
      void loadChannels().catch((error: unknown) => {
        console.error('Не удалось обновить список каналов:', error);
      });
    };
    socket.on('channel_changed', handleChannelChanged);
    return () => {
      socket.off('channel_changed', handleChannelChanged);
    };
  }, [activeChannelId, loadChannels]);

  const selectChannel = (channelId: string) => {
    setActiveChannelId(channelId);
    setSearchParams({ channel: channelId, ...(searchParams.get('discover') === '1' ? { discover: '1' } : {}) });
    setInviteLink('');
  };

  const createChannel = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await api.post<Channel & { inviteCode?: string }>('/channels', {
        title,
        description,
        avatarUrl: channelAvatarUrl,
        visibility,
      });
      const refreshed = await loadChannels();
      const created = refreshed.find((channel) => channel.id === response.data.id);
      if (created) selectChannel(created.id);
      setCreating(false);
      setTitle('');
      setDescription('');
      setChannelAvatarUrl('');
      setVisibility('public');
      showToast('Канал создан.', 'success');
      if (response.data.inviteCode) {
        setInviteLink(`${window.location.origin}${window.location.pathname}#/join/${response.data.inviteCode}`);
      }
    } catch (error) {
      console.error('Не удалось создать канал:', error);
      showToast('Не удалось создать канал.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveChannelSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeChannel) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const values: { title: string; description: string; visibility: 'public' | 'private'; avatarUrl?: string } = {
      title: String(form.get('title') || ''),
      description: String(form.get('description') || ''),
      visibility: form.get('visibility') === 'private' ? 'private' : 'public',
    };
    const avatarFile = form.get('avatar');
    try {
      if (avatarFile instanceof File && avatarFile.size > 0) {
        if (!avatarFile.type.startsWith('image/') || avatarFile.size > 1_000_000) {
          showToast('Выберите изображение размером до 1 МБ.', 'error');
          return;
        }
        values.avatarUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Не удалось прочитать файл'));
          reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
          reader.readAsDataURL(avatarFile);
        });
      }
      await api.patch(`/channels/${activeChannel.id}`, values);
      await loadChannels();
      setEditing(false);
      showToast('Настройки канала сохранены.', 'success');
    } catch (error) {
      console.error('Не удалось сохранить настройки канала:', error);
      showToast('Не удалось сохранить настройки канала.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const deleteChannel = async () => {
    if (!activeChannel || !window.confirm(`Удалить канал «${activeChannel.title}» и все его публикации?`)) return;
    setBusy(true);
    try {
      await api.delete(`/channels/${activeChannel.id}`);
      setChannels((current) => current.filter((channel) => channel.id !== activeChannel.id));
      setActiveChannelId(null);
      setPosts([]);
      setSearchParams(searchParams.get('discover') === '1' ? { discover: '1' } : {});
      setEditing(false);
      showToast('Канал удалён.', 'success');
    } catch (error) {
      console.error('Не удалось удалить канал:', error);
      showToast('Не удалось удалить канал.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const subscribe = async (channel: Channel) => {
    setBusy(true);
    try {
      await api.post(`/channels/${channel.id}/subscription`);
      await loadChannels();
      showToast('Вы подписались на канал.', 'success');
    } catch (error) {
      console.error('Не удалось подписаться на канал:', error);
      showToast('Не удалось подписаться на канал.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async (channel: Channel) => {
    if (!window.confirm(`Отписаться от канала «${channel.title}»?`)) return;
    setBusy(true);
    try {
      await api.delete(`/channels/${channel.id}/subscription`);
      await loadChannels();
      showToast('Вы отписались от канала.', 'success');
    } catch (error) {
      console.error('Не удалось отписаться от канала:', error);
      showToast('Не удалось отписаться от канала.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const startVoiceRecording = async () => {
    if (recordingVoice || busy) return;
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
        if (blob.size > 2 * 1024 * 1024) {
          showToast('Запись больше 2 МБ. Запишите голосовое покороче.', 'error');
          return;
        }
        const extension = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        setPostAttachment(new File([blob], `voice-message.${extension}`, { type }));
        showToast('Голосовое готово к публикации. Можно добавить текст или сразу опубликовать.', 'success');
      };
      voiceRecorderRef.current = recorder;
      recorder.start();
      setRecordingVoice(true);
      showToast('Запись началась. Нажмите галочку для завершения или крестик для отмены.', 'info');
    } catch {
      showToast('Нет доступа к микрофону. Разрешите его в браузере.', 'error');
    }
  };

  const stopVoiceRecording = () => {
    const recorder = voiceRecorderRef.current;
    voiceRecorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
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

  const publishPost = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeChannel || recordingVoice || (!draft.trim() && !postAttachment) || busy) return;
    setBusy(true);
    try {
      let attachmentPayload: { fileName?: string; contentType?: string; fileData?: string } = {};
      if (postAttachment) {
        const allowedTypes = new Set([
          'image/jpeg', 'image/png', 'image/gif', 'image/webp',
          'application/pdf', 'text/plain', 'text/csv', 'application/zip',
          'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
        ]);
        if (!allowedTypes.has(postAttachment.type)) throw new Error('Этот формат файла нельзя опубликовать в канале.');
        if (!postAttachment.size || postAttachment.size > 2 * 1024 * 1024) throw new Error('Размер вложения должен быть от 1 байта до 2 МБ.');
        const fileData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Не удалось прочитать вложение.'));
          reader.onerror = () => reject(new Error('Не удалось прочитать вложение.'));
          reader.readAsDataURL(postAttachment);
        });
        attachmentPayload = { fileName: postAttachment.name, contentType: postAttachment.type, fileData };
      }
      const response = await api.post<ChannelPost>(`/channels/${activeChannel.id}/posts`, { text: draft, ...attachmentPayload });
      scrollToLatestPostRef.current = true;
      setPosts((current) => sortChannelPosts(current.some((post) => post.id === response.data.id)
        ? current.map((post) => post.id === response.data.id ? response.data : post)
        : [...current, response.data]));
      setDraft('');
      setPostAttachment(null);
      showToast('Публикация опубликована.', 'success');
    } catch (error) {
      console.error('Не удалось опубликовать сообщение:', error);
      showToast(error instanceof Error ? error.message : 'Не удалось опубликовать сообщение.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyPostText = async (post: ChannelPost) => {
    try {
      await navigator.clipboard.writeText(post.text);
      showToast('Текст публикации скопирован.', 'success');
    } catch (error) {
      console.error('Не удалось скопировать публикацию:', error);
      window.prompt('Скопируйте текст публикации:', post.text);
    }
  };

  const toggleReaction = async (post: ChannelPost, emoji: string) => {
    if (!activeChannel) return;
    try {
      const response = await api.post<ChannelPost>(`/channels/${activeChannel.id}/posts/${post.id}/reactions`, { emoji });
      setPosts((current) => current.map((item) => item.id === post.id ? response.data : item));
    } catch (error) {
      console.error('Не удалось сохранить реакцию:', error);
      showToast('Не удалось сохранить реакцию.', 'error');
    }
  };

  const togglePin = async (post: ChannelPost) => {
    if (!activeChannel) return;
    try {
      const response = await api.post<ChannelPost>(`/channels/${activeChannel.id}/posts/${post.id}/pin`);
      setPosts((current) => sortChannelPosts(current.map((item) => item.id === post.id ? response.data : item)));
    } catch (error) {
      console.error('Не удалось закрепить публикацию:', error);
      showToast('Не удалось изменить закрепление.', 'error');
    }
  };

  const beginEditPost = (post: ChannelPost) => {
    setEditingPostId(post.id);
    setEditPostDraft(post.text);
  };

  const cancelEditPost = () => {
    setEditingPostId(null);
    setEditPostDraft('');
  };

  const savePostEdit = async (post: ChannelPost) => {
    if (!activeChannel || !editingPostId || savingPostEdit) return;
    if (!editPostDraft.trim() && !post.fileData) {
      showToast('Добавьте текст или вложение в публикацию.', 'error');
      return;
    }
    setSavingPostEdit(true);
    try {
      const response = await api.patch<ChannelPost>(`/channels/${activeChannel.id}/posts/${post.id}`, { text: editPostDraft });
      setPosts((current) => sortChannelPosts(current.map((item) => item.id === post.id ? response.data : item)));
      cancelEditPost();
      showToast('Публикация обновлена.', 'success');
    } catch (error) {
      console.error('Не удалось изменить публикацию:', error);
      showToast('Не удалось изменить публикацию.', 'error');
    } finally {
      setSavingPostEdit(false);
    }
  };

  const deletePost = async (post: ChannelPost) => {
    if (!activeChannel || !window.confirm('Удалить эту публикацию?')) return;
    try {
      await api.delete(`/channels/${activeChannel.id}/posts/${post.id}`);
      setPosts((current) => current.filter((item) => item.id !== post.id));
    } catch (error) {
      console.error('Не удалось удалить публикацию:', error);
      showToast('Не удалось удалить публикацию.', 'error');
    }
  };

  const openChannelMembers = async () => {
    if (!activeChannel?.isOwner) return;
    setMembersOpen(true);
    setLoadingMembers(true);
    try {
      const response = await api.get<ChannelMember[]>(`/channels/${activeChannel.id}/members`);
      setChannelMembers(response.data);
    } catch (error) {
      console.error('Не удалось загрузить подписчиков канала:', error);
      showToast('Не удалось загрузить список подписчиков.', 'error');
    } finally {
      setLoadingMembers(false);
    }
  };

  const removeChannelMember = async (member: ChannelMember) => {
    if (!activeChannel || member.userId === activeChannel.ownerId) return;
    if (!window.confirm(`Удалить @${member.username || member.displayName} из подписчиков канала?`)) return;
    setRemovingMemberId(member.userId);
    try {
      await api.delete(`/channels/${activeChannel.id}/members/${member.userId}`);
      setChannelMembers((items) => items.filter((item) => item.userId !== member.userId));
      await loadChannels();
      showToast('Подписчик удалён из канала.', 'success');
    } catch (error) {
      console.error('Не удалось удалить подписчика канала:', error);
      showToast('Не удалось удалить подписчика.', 'error');
    } finally {
      setRemovingMemberId(null);
    }
  };

  const copyInvite = async () => {
    if (!activeChannel) return;
    try {
      let url: string;
      if (activeChannel.visibility === 'private') {
        const response = await api.get<{ inviteCode: string }>(`/channels/${activeChannel.id}/invite`);
        url = `${window.location.origin}${window.location.pathname}#/join/${response.data.inviteCode}`;
      } else {
        url = `${window.location.origin}${window.location.pathname}#/channels?channel=${encodeURIComponent(activeChannel.id)}&discover=1`;
      }
      await navigator.clipboard.writeText(url);
      setInviteLink(url);
      showToast(activeChannel.visibility === 'private' ? 'Ссылка-приглашение скопирована.' : 'Ссылка на публичный канал скопирована.', 'success');
    } catch (error) {
      console.error('Не удалось получить ссылку канала:', error);
      showToast('Не удалось скопировать ссылку канала.', 'error');
    }
  };

  const joinFromInvite = async () => {
    if (!inviteCode) return;
    if (!user) {
      sessionStorage.setItem('skylineAfterLogin', `/join/${inviteCode}`);
      navigate('/login');
      return;
    }
    setBusy(true);
    try {
      const response = await api.post<Channel>(`/channels/invites/${inviteCode}/join`);
      await loadChannels();
      const nextParams = new URLSearchParams({ channel: response.data.id });
      if (searchParams.get('discover') === '1') nextParams.set('discover', '1');
      navigate(`/channels?${nextParams.toString()}`, { replace: true });
      showToast('Вы присоединились к каналу.', 'success');
    } catch (error) {
      console.error('Не удалось присоединиться к каналу:', error);
      showToast('Не удалось присоединиться к каналу.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const invitePage = Boolean(inviteCode);
  if (invitePage) {
    return (
      <main className="grid h-full place-items-center bg-bg-base p-5 text-t-primary">
        <section className="w-full max-w-md rounded-3xl border border-white/10 bg-[#111a2a] p-7 text-center shadow-2xl">
          <div className="mx-auto mb-5 grid h-16 w-16 place-items-center overflow-hidden rounded-2xl bg-accent/15 text-accent">
            {invitePreview?.avatarUrl ? <img src={invitePreview.avatarUrl} alt="" className="h-full w-full object-cover" /> : <Radio size={30} />}
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Приглашение в канал</p>
          <h1 className="mt-2 text-2xl font-bold">{invitePreview?.title || 'Загрузка приглашения…'}</h1>
          {invitePreview && <>
            <p className="mt-3 text-sm leading-6 text-t-secondary">{invitePreview.description || 'Подпишитесь, чтобы следить за новыми публикациями.'}</p>
            <p className="mt-4 text-xs text-slate-500">{invitePreview.memberCount} подписчиков · автор {invitePreview.ownerName || 'Skyline'}</p>
            <button type="button" disabled={busy} onClick={() => void joinFromInvite()} className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent disabled:opacity-50">
              <Bell size={16} /> Подписаться на канал
            </button>
          </>}
          <button type="button" onClick={() => navigate('/channels')} className="mt-3 w-full rounded-xl px-4 py-2 text-sm text-t-secondary hover:bg-white/5">К списку каналов</button>
        </section>
      </main>
    );
  }

  return (
    <main className="animate-fade-in flex h-full min-h-0 w-full bg-bg-base text-t-primary">
      <aside className={`${embedded ? 'hidden' : activeChannel ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-white/[0.08] bg-panel md:w-[340px]`}>
        <WorkspaceSidebarHeader
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Поиск переписок"
        />
        <div className="border-b border-white/[0.06] px-3 py-2"><WorkspaceTabs /></div>
        <header className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-4">
          <button type="button" onClick={() => navigate('/')} aria-label="Назад к чатам" className="rounded-xl p-2 text-t-secondary transition hover:bg-white/[0.06] hover:text-white"><ArrowLeft size={18} /></button>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-sm font-semibold"><Radio size={17} className="text-accent" /> Каналы</h1>
            <p className="mt-0.5 text-[11px] text-slate-500">Публикации и сообщества</p>
          </div>
          <button type="button" onClick={() => { setVisibility('public'); setCreating(true); }} title="Создать канал" aria-label="Создать канал" className="rounded-xl p-2 text-accent transition hover:bg-accent/10"><Plus size={19} /></button>
        </header>
        <div className="border-b border-white/[0.08] p-3">
          <div className="grid grid-cols-2 rounded-xl bg-slate-950/50 p-1">
            <button type="button" onClick={() => setSearchParams((current) => { const next = new URLSearchParams(current); next.delete('discover'); return next; })} className={`rounded-lg px-3 py-2 text-xs font-medium transition ${listMode === 'mine' ? 'bg-accent/20 text-accent' : 'text-slate-500 hover:text-slate-300'}`}>Мои каналы</button>
            <button type="button" onClick={() => setSearchParams((current) => { const next = new URLSearchParams(current); next.set('discover', '1'); return next; })} className={`rounded-lg px-3 py-2 text-xs font-medium transition ${listMode === 'discover' ? 'bg-accent/20 text-accent' : 'text-slate-500 hover:text-slate-300'}`}>Найти каналы</button>
          </div>
        </div>
        <UnifiedWorkspaceList search={search} activeKind="channel" activeId={activeChannelId} includeDiscover={listMode === 'discover'} />
        <footer className="border-t border-white/[0.08] px-4 py-3 text-center text-[10px] text-slate-600">Публичные каналы доступны всем участникам Skyline</footer>
      </aside>

      <section className={`${embedded || activeChannel ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-accent/20 via-[#090d16] to-[#090d16]`}>
        {!activeChannel ? (
          <div className="m-auto max-w-sm px-6 text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-accent/10 text-accent"><Radio size={29} /></div>
            <h2 className="mt-5 text-lg font-semibold">Ваши каналы Skyline</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">Создавайте сообщества, делитесь публикациями и собирайте подписчиков.</p>
            <button type="button" onClick={() => { setVisibility('public'); setCreating(true); }} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-accent"><Plus size={16} /> Создать канал</button>
          </div>
        ) : <>
          <header className="relative z-10 flex items-center gap-3 border-b border-slate-800/60 p-2.5 glass-panel sm:p-4">
            <button type="button" onClick={() => { setActiveChannelId(null); setSearchParams(searchParams.get('discover') === '1' ? { discover: '1' } : {}); }} aria-label="Назад к каналам" className="rounded-xl p-2 text-t-secondary hover:bg-white/5 md:hidden"><ArrowLeft size={18} /></button>
            <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-2xl bg-accent/15 text-accent">
              {activeChannel.avatarUrl ? <img src={activeChannel.avatarUrl} alt="" className="h-full w-full object-cover" /> : activeChannel.visibility === 'private' ? <LockKeyhole size={18} /> : <Radio size={19} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><h2 className="truncate text-sm font-bold">{activeChannel.title}</h2><span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${activeChannel.visibility === 'public' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-200'}`}>{activeChannel.visibility === 'public' ? 'публичный' : 'приватный'}</span></div>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500"><Users size={12} /> {activeChannel.memberCount} подписчиков <span>·</span> {activeChannel.isOwner ? 'Ваш канал' : `Автор: ${activeChannel.ownerName || activeChannel.ownerUsername || 'Skyline'}`}</p>
            </div>
            {activeChannel.isOwner ? <>
              <button type="button" onClick={() => void openChannelMembers()} title="Управление подписчиками" aria-label="Управление подписчиками" className="relative rounded-xl p-2.5 text-t-secondary transition hover:bg-white/5 hover:text-accent"><Users size={17} /><span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent/20 px-1 text-[9px] leading-4 text-accent">{activeChannel.memberCount}</span></button>
              <button type="button" onClick={() => void copyInvite()} title="Скопировать ссылку на канал" aria-label="Ссылка на канал" className="rounded-xl p-2.5 text-t-secondary transition hover:bg-white/5 hover:text-accent"><Share2 size={17} /></button>
              <button type="button" onClick={() => { setVisibility(activeChannel.visibility); setEditing(true); }} title="Настройки канала" aria-label="Настройки канала" className="rounded-xl p-2.5 text-t-secondary transition hover:bg-white/5 hover:text-white"><Settings size={17} /></button>
            </> : activeChannel.isSubscribed ? <button disabled={busy} type="button" onClick={() => void unsubscribe(activeChannel)} className="rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50">Отписаться</button> : <button disabled={busy} type="button" onClick={() => void subscribe(activeChannel)} className="rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent disabled:opacity-50">Подписаться</button>}
          </header>
          {activeChannel.description && <div className="border-b border-white/[0.06] px-5 py-3 text-sm leading-6 text-t-secondary md:px-8">{activeChannel.description}</div>}
          {inviteLink && <button type="button" onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => showToast('Ссылка скопирована.', 'success')).catch((error: unknown) => { console.error('Не удалось скопировать ссылку:', error); showToast('Не удалось скопировать ссылку.', 'error'); })} className="flex items-center gap-2 border-b border-accent/10 bg-accent/[0.06] px-5 py-2.5 text-left text-xs text-accent md:px-8"><Copy size={13} /> Ссылка-приглашение создана. Нажмите, чтобы скопировать</button>}
          {activePosts.length > 0 && <div className="border-b border-white/[0.06] bg-panel/80 px-3 py-2.5 sm:px-5"><div className="mx-auto flex max-w-2xl items-center gap-2 rounded-xl border border-white/[0.08] bg-black/15 px-3"><Search size={15} className="shrink-0 text-slate-500" /><input value={postSearch} onChange={(event) => setPostSearch(event.target.value)} placeholder="Найти публикацию в канале…" aria-label="Поиск публикаций канала" className="h-10 min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-slate-500" />{postSearch && <button type="button" onClick={() => setPostSearch('')} aria-label="Очистить поиск публикаций" className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-white"><X size={14} /></button>}</div><p className="mx-auto mt-1.5 max-w-2xl text-[10px] text-slate-600">{postSearch.trim() ? `Найдено: ${filteredPosts.length}` : 'Поиск по тексту загруженных публикаций'}</p></div>}

          <div ref={postListRef} className="chat-wallpaper-surface custom-scrollbar relative z-10 min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 sm:py-6">
            {loadingPosts && <div className="mx-auto max-w-2xl space-y-3">{[0, 1, 2].map((item) => <div key={item} className="h-36 animate-pulse rounded-3xl bg-white/[0.04]" />)}</div>}
            {!loadingPosts && filteredPosts.length === 0 && <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-2.5 rounded-3xl border border-white/[0.06] bg-white/[0.02] p-8 text-center animate-scale-in">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.04] text-slate-500"><Hash size={22} /></div>
              <p className="mt-4 text-sm font-semibold">{postSearch.trim() ? 'Ничего не найдено' : 'Пока нет публикаций'}</p>
              <p className="mt-1 text-xs text-slate-500">{postSearch.trim() ? 'Попробуйте изменить поисковый запрос.' : activeChannel.isOwner ? 'Напишите первый пост для подписчиков.' : 'Здесь появятся новые публикации канала.'}</p>
            </div>}
            <div className="mx-auto flex max-w-2xl flex-col gap-3">
              {filteredPosts.map((post) => {
                const counts = REACTIONS.map((emoji) => ({
                  emoji,
                  count: post.reactions.filter((reaction) => reaction.emoji === emoji).length,
                  mine: post.reactions.some((reaction) => reaction.emoji === emoji && reaction.userId === user?.id),
                }));
                return <div key={post.id} className="flex justify-start animate-slide-in">
                  <article className="chat-message chat-message-bubble chat-message-other relative max-w-[88%] rounded-2xl rounded-bl-none border p-3.5 text-xs leading-relaxed shadow-lg sm:max-w-[80%]">
                    {post.pinned && <div className="pinned-message-label mb-2 flex items-center gap-1 text-[10px] text-amber-200/90"><Pin size={12} /> Закреплено</div>}
                    <div className="mb-2 flex items-center gap-2">
                      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"><Radio size={13} /></div>
                      <div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold">{activeChannel.title}</p></div>
                      <button type="button" onClick={() => void copyPostText(post)} title="Скопировать текст публикации" aria-label="Скопировать текст публикации" className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-accent"><Copy size={13} /></button>
                      {activeChannel.isOwner && <div className="flex items-center gap-0.5">
                        <button type="button" onClick={() => beginEditPost(post)} title="Изменить публикацию" aria-label="Изменить публикацию" className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-accent"><Pencil size={13} /></button>
                        <button type="button" onClick={() => void togglePin(post)} title={post.pinned ? 'Открепить' : 'Закрепить'} aria-label={post.pinned ? 'Открепить публикацию' : 'Закрепить публикацию'} className={`rounded-lg p-1.5 transition hover:bg-white/5 ${post.pinned ? 'text-accent' : 'text-slate-500 hover:text-slate-200'}`}><Pin size={13} /></button>
                        <button type="button" onClick={() => void deletePost(post)} title="Удалить публикацию" aria-label="Удалить публикацию" className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"><Trash2 size={13} /></button>
                      </div>}
                    </div>
                    {editingPostId === post.id ? <div className="mt-2 space-y-2">
                      <textarea value={editPostDraft} onChange={(event) => setEditPostDraft(event.target.value)} maxLength={10_000} rows={4} autoFocus className="w-full resize-y rounded-xl border border-accent/25 bg-black/20 p-3 text-xs leading-relaxed text-t-primary outline-none focus:border-accent/60" aria-label="Изменить текст публикации" />
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={cancelEditPost} disabled={savingPostEdit} className="rounded-lg px-3 py-1.5 text-[10px] text-t-secondary transition hover:bg-white/5">Отмена</button>
                        <button type="button" onClick={() => void savePostEdit(post)} disabled={savingPostEdit} className="rounded-lg bg-accent px-3 py-1.5 text-[10px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50">{savingPostEdit ? 'Сохранение…' : 'Сохранить'}</button>
                      </div>
                    </div> : post.text && <div className="chat-message-content whitespace-pre-wrap break-words text-xs leading-relaxed">{post.text}</div>}
                    {post.fileData && post.contentType?.startsWith('image/') && <a href={post.fileData} target="_blank" rel="noreferrer" className="mt-2 block overflow-hidden rounded-xl"><img src={post.fileData} alt={post.fileName || 'Изображение из публикации'} loading="lazy" className="max-h-[420px] max-w-full rounded-xl object-contain" /></a>}
                    {post.fileData && post.contentType?.startsWith('audio/') && <div className="mt-2"><VoiceMessagePlayer src={post.fileData} fileName={post.fileName} /></div>}
                    {post.fileData && !post.contentType?.startsWith('image/') && !post.contentType?.startsWith('audio/') && <a href={post.fileData} download={post.fileName || 'attachment'} className="mt-2 flex items-center gap-3 rounded-xl border border-white/[0.08] bg-black/15 p-3 transition hover:border-accent/30"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><FileText size={18} /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{post.fileName || 'Вложение'}</span><span className="mt-1 block text-[10px] text-slate-500">{post.contentType || 'Файл'}</span></span><Download size={15} className="shrink-0 text-slate-400" /></a>}
                    <div className="mt-1.5 flex items-center justify-end gap-1 text-[9px] font-mono text-t-secondary/70"><time>{formatAppTime(post.createdAt)}</time></div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2">
                      {counts.map(({ emoji, count, mine }) => <button key={emoji} type="button" disabled={!activeChannel.isSubscribed} onClick={() => void toggleReaction(post, emoji)} className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] transition disabled:cursor-not-allowed disabled:opacity-60 ${mine ? 'border-accent/30 bg-accent/10 text-accent' : 'border-white/[0.08] bg-white/[0.025] text-slate-300 hover:border-white/20'}`}><span>{emoji}</span>{count > 0 && <span>{count}</span>}</button>)}
                      {!activeChannel.isSubscribed && <span className="ml-auto text-[9px] text-slate-600">Подпишитесь, чтобы ставить реакции</span>}
                    </div>
                  </article>
                </div>;
              })}
            </div>
          </div>

          {activeChannel.isOwner && <form onSubmit={(event) => void publishPost(event)} className="glass-panel relative z-10 mx-3 mb-3 mt-2 rounded-2xl p-1.5 shadow-2xl transition-all focus-within:ring-2 focus-within:ring-accent/30 sm:mx-5 sm:p-2">
            {postAttachment && <div className="mx-auto mb-1 flex max-w-2xl items-center gap-2 rounded-xl border border-accent/20 bg-accent/[0.06] px-3 py-2"><Paperclip size={14} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 truncate text-[11px] text-t-primary">{postAttachment.name} <span className="text-t-secondary">· {(postAttachment.size / 1024 / 1024).toFixed(2)} МБ</span></span><button type="button" onClick={() => setPostAttachment(null)} aria-label="Убрать вложение" className="rounded-lg p-1 text-t-secondary hover:bg-white/5 hover:text-rose-300"><X size={14} /></button></div>}
            <div className="mx-auto flex max-w-2xl items-end gap-2">
              {recordingVoice && <div className="flex min-h-10 flex-1 items-center gap-2 rounded-xl bg-rose-500/10 px-3 text-sm text-rose-300"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" />Идёт запись голосового…</div>}
              <input ref={attachmentInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv,application/zip,audio/webm,audio/ogg,audio/mpeg,audio/mp4,audio/wav" className="hidden" onChange={(event) => { const file = event.target.files?.[0] || null; event.target.value = ''; if (!file) return; if (file.size > 2 * 1024 * 1024) { showToast('Размер вложения не должен превышать 2 МБ.', 'error'); return; } setPostAttachment(file); }} />
              <button type="button" onClick={() => attachmentInputRef.current?.click()} disabled={busy || recordingVoice} aria-label="Прикрепить файл к публикации" title="Фото, аудио или файл до 2 МБ" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-t-secondary transition hover:bg-white/[0.06] hover:text-accent disabled:opacity-40"><Paperclip size={17} /></button>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} disabled={recordingVoice} maxLength={10_000} rows={1} placeholder="Напишите публикацию или прикрепите файл…" className="max-h-36 min-h-10 flex-1 resize-y bg-transparent px-2 py-2 text-sm leading-5 text-t-primary outline-none placeholder:text-slate-600" />
              <button type="button" onClick={() => { if (recordingVoice) stopVoiceRecording(); else void startVoiceRecording(); }} disabled={busy || (!!postAttachment && !recordingVoice)} aria-label={recordingVoice ? "Завершить запись голосового сообщения" : "Записать голосовое сообщение"} title={recordingVoice ? "Завершить запись" : "Записать голосовое"} className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-40 ${recordingVoice ? "bg-emerald-500 text-white hover:bg-emerald-400" : "text-t-secondary hover:bg-white/[0.06] hover:text-accent"}`}>{recordingVoice ? <Check size={16} /> : <Mic size={17} />}</button>
              {recordingVoice && <button type="button" onClick={cancelVoiceRecording} aria-label="Отменить запись голосового сообщения" title="Отменить запись" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-rose-300 transition hover:bg-rose-500/10"><X size={17} /></button>}
              <button type="submit" disabled={busy || recordingVoice || (!draft.trim() && !postAttachment)} aria-label="Опубликовать" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <span className="h-4 w-4 animate-spin rounded-full border border-white/40 border-t-white" /> : <Send size={16} />}</button>
            </div>
          </form>}
        </>}
      </section>

      {membersOpen && activeChannel && <div className="fixed inset-0 z-[115] flex justify-end bg-black/65 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setMembersOpen(false); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="channel-members-title" className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-[#0c1422] shadow-2xl animate-slide-in">
          <header className="flex items-center gap-3 border-b border-white/[0.08] p-5">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent/10 text-accent"><Users size={19} /></div>
            <div className="min-w-0 flex-1"><h2 id="channel-members-title" className="text-sm font-bold text-white">Подписчики канала</h2><p className="mt-1 text-[11px] text-slate-500">{activeChannel.title} · {channelMembers.length || activeChannel.memberCount} человек</p></div>
            <button type="button" onClick={() => setMembersOpen(false)} aria-label="Закрыть список подписчиков" className="grid h-9 w-9 place-items-center rounded-xl text-slate-400 transition hover:bg-white/[0.06] hover:text-white"><X size={17} /></button>
          </header>
          <div className="border-b border-white/[0.06] p-4"><p className="text-xs leading-5 text-slate-400">Здесь можно посмотреть аудиторию и удалить пользователя из подписчиков. Владелец канала защищён от удаления.</p></div>
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            {loadingMembers && <div className="space-y-2 p-2">{[0, 1, 2, 3].map((item) => <div key={item} className="h-14 animate-pulse rounded-xl bg-white/[0.04]" />)}</div>}
            {!loadingMembers && channelMembers.map((member) => <div key={member.userId} className="mb-1.5 flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
              {member.avatarUrl ? <img src={member.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" /> : <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent/10 text-sm font-semibold text-accent">{(member.displayName || member.username || '?').slice(0, 1).toUpperCase()}</div>}
              <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-slate-200">{member.displayName || member.username || 'Пользователь'}</p><p className="mt-1 truncate text-[10px] text-slate-500">@{member.username || 'username не указан'} · {member.role === 'owner' ? 'Владелец' : 'Подписчик'}</p></div>
              {member.userId !== activeChannel.ownerId && <button type="button" disabled={removingMemberId === member.userId} onClick={() => void removeChannelMember(member)} title="Удалить подписчика" aria-label={`Удалить @${member.username} из канала`} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300 disabled:opacity-40">{removingMemberId === member.userId ? <span className="h-4 w-4 animate-spin rounded-full border border-slate-500 border-t-rose-300" /> : <Trash2 size={15} />}</button>}
            </div>)}
            {!loadingMembers && channelMembers.length === 0 && <p className="py-12 text-center text-xs text-slate-500">Подписчики не найдены.</p>}
          </div>
          <footer className="border-t border-white/[0.08] p-4"><button type="button" onClick={() => void copyInvite()} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-semibold text-white transition hover:brightness-110"><Share2 size={15} /> Создать / скопировать приглашение</button></footer>
        </section>
      </div>}

      {(creating || editing) && <div className="fixed inset-0 z-[120] flex justify-center overflow-y-auto bg-[#030712]/80 p-3 backdrop-blur-md sm:items-center sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) { setCreating(false); setEditing(false); } }}>
        <section role="dialog" aria-modal="true" aria-labelledby="channel-form-title" className="my-auto w-full max-w-3xl overflow-hidden rounded-[28px] border border-white/10 bg-[#101827] shadow-[0_30px_100px_rgba(0,0,0,0.55)] animate-scale-in">
          <header className="relative overflow-hidden border-b border-white/[0.07] px-5 pb-6 pt-6 sm:px-8">
            <div className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-sky-400/10 blur-3xl" />
            <div className="relative flex items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-sky-400/20 bg-gradient-to-br from-sky-400/20 to-accent/10 text-sky-300 shadow-lg shadow-sky-500/10"><Radio size={25} /></div>
                <div><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-sky-300">{creating ? 'Новое пространство' : 'Управление сообществом'}</p><h2 id="channel-form-title" className="mt-1 text-xl font-bold tracking-tight text-white sm:text-2xl">{creating ? 'Создать канал' : 'Настройки канала'}</h2><p className="mt-1.5 max-w-md text-xs leading-5 text-slate-400">{creating ? 'Поделитесь новостями, идеями и публикациями со своей аудиторией.' : 'Обновите описание и параметры доступа к каналу.'}</p></div>
              </div>
              <button type="button" onClick={() => { setCreating(false); setEditing(false); }} aria-label="Закрыть" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/[0.07] text-slate-400 transition hover:border-white/15 hover:bg-white/[0.06] hover:text-white"><X size={17} /></button>
            </div>
          </header>
          <form onSubmit={creating ? (event) => void createChannel(event) : (event) => void saveChannelSettings(event)} className="grid gap-0 md:grid-cols-[minmax(0,1fr)_250px]">
            <div className="space-y-5 px-5 py-6 sm:px-8">
              {creating && <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3">
                <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-sky-400/10 text-sky-300">{channelAvatarUrl ? <img src={channelAvatarUrl} alt="Предпросмотр аватара канала" className="h-full w-full object-cover" /> : <Radio size={19} />}</div>
                <label className="min-w-0 flex-1 text-xs font-semibold text-slate-200">Изображение канала <span className="mt-1 block text-[10px] font-normal text-slate-500">PNG, JPG, GIF или WebP · до 1 МБ</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (file.size > 1_000_000 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { showToast('Выберите PNG, JPG, GIF или WebP размером до 1 МБ.', 'error'); return; } const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') setChannelAvatarUrl(reader.result); }; reader.onerror = () => showToast('Не удалось прочитать изображение.', 'error'); reader.readAsDataURL(file); }} className="mt-2 block w-full text-[10px] text-slate-500 file:mr-2 file:rounded-lg file:border-0 file:bg-white/10 file:px-2 file:py-1.5 file:text-[10px] file:text-slate-200" /></label>
                {channelAvatarUrl && <button type="button" onClick={() => setChannelAvatarUrl('')} className="rounded-lg p-2 text-slate-500 hover:bg-rose-400/10 hover:text-rose-300" aria-label="Убрать аватар"><X size={15} /></button>}
              </div>}
              {editing && activeChannel && <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3">
                <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-sky-400/10 text-sky-300">{activeChannel.avatarUrl ? <img src={activeChannel.avatarUrl} alt="" className="h-full w-full object-cover" /> : <Radio size={19} />}</div>
                <label className="min-w-0 flex-1 text-xs font-semibold text-slate-200">Изображение канала <span className="mt-1 block text-[10px] font-normal text-slate-500">PNG, JPG или WebP · до 1 МБ</span><input type="file" name="avatar" accept="image/*" className="mt-2 block w-full text-[10px] text-slate-500 file:mr-2 file:rounded-lg file:border-0 file:bg-white/10 file:px-2 file:py-1.5 file:text-[10px] file:text-slate-200" /></label>
              </div>}
              <div><div className="mb-2 flex items-center justify-between gap-3"><label htmlFor="channel-title" className="text-xs font-semibold text-slate-200">Название канала</label><span className="text-[10px] tabular-nums text-slate-500">{title.length}/64</span></div><input id="channel-title" name="title" required minLength={2} maxLength={64} value={creating ? title : undefined} defaultValue={editing ? activeChannel?.title : undefined} onChange={creating ? (event) => setTitle(event.target.value) : undefined} placeholder="Например, Skyline Новости" className="h-12 w-full rounded-2xl border border-white/10 bg-[#080e19]/80 px-4 text-sm text-white outline-none transition placeholder:text-slate-600 hover:border-white/15 focus:border-sky-400/50 focus:ring-4 focus:ring-sky-400/10" /></div>
              <div><div className="mb-2 flex items-center justify-between gap-3"><label htmlFor="channel-description" className="text-xs font-semibold text-slate-200">Описание</label><span className="text-[10px] tabular-nums text-slate-500">{description.length}/500</span></div><textarea id="channel-description" name="description" maxLength={500} rows={4} value={creating ? description : undefined} defaultValue={editing ? activeChannel?.description : undefined} onChange={creating ? (event) => setDescription(event.target.value) : undefined} placeholder="Расскажите, о чём этот канал и что здесь найдут подписчики…" className="w-full resize-y rounded-2xl border border-white/10 bg-[#080e19]/80 px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-600 hover:border-white/15 focus:border-sky-400/50 focus:ring-4 focus:ring-sky-400/10" /></div>
              <fieldset><legend className="mb-2.5 text-xs font-semibold text-slate-200">Кто сможет найти канал?</legend><div className="grid gap-2 sm:grid-cols-2">
                {(['public', 'private'] as const).map((kind) => <label key={kind} className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition ${visibility === kind ? 'border-sky-400/35 bg-sky-400/[0.07] shadow-[inset_0_0_0_1px_rgba(56,189,248,0.04)]' : 'border-white/[0.08] hover:border-white/15 hover:bg-white/[0.025]'}`}>
                  <input type="radio" name="visibility" value={kind} checked={visibility === kind} onChange={() => setVisibility(kind)} className="mt-1 accent-sky-400" />
                  <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-xs font-semibold text-slate-200">{kind === 'public' ? <Radio size={15} className="text-sky-300" /> : <LockKeyhole size={15} className="text-amber-300" />}{kind === 'public' ? 'Публичный' : 'Приватный'}</span><span className="mt-1.5 block text-[10px] leading-4 text-slate-500">{kind === 'public' ? 'Появится в каталоге, его смогут найти другие.' : 'Вступление будет доступно по ссылке-приглашению.'}</span></span>
                </label>)}
              </div></fieldset>
            </div>
            <aside className="border-t border-white/[0.07] bg-black/10 px-5 py-6 sm:px-8 md:border-l md:border-t-0 md:px-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Предпросмотр</p>
              <div className="mt-3 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a111e]">
                <div className="h-16 bg-gradient-to-br from-sky-500/20 via-accent/10 to-transparent" />
                <div className="-mt-8 px-4 pb-4">
                  <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-2xl border-4 border-[#0a111e] bg-gradient-to-br from-sky-400/20 to-accent/15 text-sky-300 shadow-lg">{(creating ? channelAvatarUrl : activeChannel?.avatarUrl) ? <img src={(creating ? channelAvatarUrl : activeChannel?.avatarUrl) || ''} alt="" className="h-full w-full object-cover" /> : <Radio size={23} />}</div>
                  <p className="mt-3 break-words text-sm font-bold text-white">{(creating ? title : activeChannel?.title || title).trim() || 'Название канала'}</p>
                  <p className="mt-2 min-h-12 whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-400">{(creating ? description : activeChannel?.description || description).trim() || 'Здесь будет отображаться описание вашего канала.'}</p>
                  <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-3"><span className="inline-flex items-center gap-1.5 text-[10px] text-slate-500"><Users size={12} />{editing ? activeChannel?.memberCount || 0 : 0} подписчиков</span><span className={`rounded-full px-2 py-1 text-[9px] font-semibold ${visibility === 'public' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-200'}`}>{visibility === 'public' ? 'Публичный' : 'Приватный'}</span></div>
                </div>
              </div>
              <p className="mt-3 text-[10px] leading-5 text-slate-500">Так канал будет выглядеть в списке сообществ. Параметры можно изменить позже.</p>
            </aside>
            <div className="flex flex-col-reverse gap-2 border-t border-white/[0.07] bg-black/10 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 md:col-span-2">
              {editing && <button type="button" disabled={busy} onClick={() => void deleteChannel()} className="mr-auto inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-rose-300 transition hover:bg-rose-400/10 disabled:opacity-50"><Trash2 size={14} />Удалить канал</button>}
              <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row"><button type="button" onClick={() => { setCreating(false); setEditing(false); }} className="h-11 rounded-xl border border-white/10 px-5 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.05]">Отмена</button><button type="submit" disabled={busy || (creating && title.trim().length < 2)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent-from to-accent-to px-6 text-xs font-bold text-white shadow-lg shadow-accent/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"><Check size={15} />{busy ? 'Сохраняем…' : creating ? 'Создать канал' : 'Сохранить изменения'}</button></div>
            </div>
          </form>
        </section>
      </div>}
    </main>
  );
}
