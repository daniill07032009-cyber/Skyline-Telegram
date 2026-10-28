import { useEffect, useState } from 'react';
import { Crown, UserRoundCheck, UserRoundPlus } from 'lucide-react';
import { isAxiosError } from 'axios';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Contact, type User } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatAppDateTime } from '../time';
import GlassPanel from '../components/ui/GlassPanel';
import Avatar from '../components/ui/Avatar';
import Button from '../components/ui/Button';
import Spinner from '../components/ui/Spinner';

export default function UserProfile() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const [profile, setProfile] = useState<User | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [savingContact, setSavingContact] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeIsError, setNoticeIsError] = useState(false);
  const loading = loadedUserId !== userId;

  useEffect(() => {
    if (!userId) return;
    if (userId === currentUser?.id) {
      navigate('/profile', { replace: true });
      return;
    }
    let isCurrent = true;
    (async () => {
      try {
        const [profileResponse, contactsResponse] = await Promise.all([
          api.get<User>(`/users/${userId}`),
          api.get<Contact[]>('/contacts'),
        ]);
        if (!isCurrent) return;
        setProfile(profileResponse.data);
        setContact(contactsResponse.data.find((item) => item.id === userId) || null);
        setError('');
      } catch (loadError: unknown) {
        const data = isAxiosError(loadError)
          ? loadError.response?.data as { detail?: string } | undefined
          : undefined;
        if (isCurrent) setError(data?.detail || 'Не удалось загрузить профиль пользователя.');
      } finally {
        if (isCurrent) setLoadedUserId(userId || null);
      }
    })();
    return () => { isCurrent = false; };
  }, [userId, currentUser?.id, navigate]);

  const handleContact = async () => {
    if (!profile) return;
    const nickname = window.prompt(
      contact ? 'Изменить имя контакта' : 'Как записать пользователя в контактах?',
      contact?.nickname || profile.displayName || profile.username,
    );
    if (nickname === null) return;
    if (!nickname.trim()) {
      setNoticeIsError(true);
      setNotice('Имя контакта не может быть пустым.');
      return;
    }
    setSavingContact(true);
    setNoticeIsError(false);
    setNotice('');
    try {
      const response = await api.put('/contacts', { userId: profile.id, nickname: nickname.trim() });
      setContact({ ...profile, nickname: response.data.contact.nickname });
      setNotice('Контакт сохранён.');
    } catch (saveError: unknown) {
      const data = isAxiosError(saveError)
        ? saveError.response?.data as { detail?: string } | undefined
        : undefined;
      setNoticeIsError(true);
      setNotice(data?.detail || 'Не удалось сохранить контакт.');
    } finally {
      setSavingContact(false);
    }
  };

  if (loading) {
    return (
      <main className="grid h-full place-items-center bg-bg-base">
        <Spinner size={28} />
      </main>
    );
  }

  return (
    <main className="relative h-full overflow-y-auto bg-bg-base px-4 py-8 text-t-primary animate-fade-in">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_50%_0%,var(--glow),transparent_55%)]" />
      <GlassPanel className="relative mx-auto w-full max-w-xl p-6 sm:p-9">
        <button type="button" onClick={() => navigate(-1)}
          className="mb-6 inline-flex min-h-[44px] items-center gap-2 text-xs font-medium text-t-secondary transition hover:text-t-primary">
          ← Назад
        </button>

        {error ? (
          <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/[0.08] px-4 py-3 text-sm text-rose-200">{error}</p>
        ) : profile ? (
          <>
            <div className="mb-7 flex items-center gap-4">
              <Avatar src={profile.avatarUrl} name={profile.displayName || profile.username} size={72} online className={profile.isPremium ? 'ring-premium' : ''} />
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-xl font-semibold tracking-tight">
                  {profile.displayName || profile.username}
                  {profile.isPremium && <Crown size={16} className="shrink-0 fill-amber-300/20 text-amber-300" aria-label="Skyline Premium" />}
                </p>
                <p className="mt-1 truncate text-sm text-t-secondary">@{profile.username}</p>
                {profile.statusText && <p className="mt-1 truncate text-xs text-emerald-300/90">{profile.statusText}</p>}
              </div>
            </div>

            {profile.bio && (
              <p className="mb-5 whitespace-pre-wrap rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 text-sm leading-relaxed text-t-primary/90">{profile.bio}</p>
            )}
            {profile.lastSeen && (
              <p className="mb-5 text-xs text-t-secondary">
                Был(а) в сети: {formatAppDateTime(profile.lastSeen, { second: '2-digit' })}
              </p>
            )}

            {notice && (
              <p role="status" className={`mb-4 rounded-xl border px-4 py-3 text-sm ${noticeIsError ? 'border-rose-400/20 bg-rose-400/[0.08] text-rose-200' : 'border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-200'}`}>
                {notice}
              </p>
            )}

            <Button onClick={() => void handleContact()} disabled={savingContact}>
              {contact ? <><UserRoundCheck size={16} /> Изменить контакт</> : <><UserRoundPlus size={16} /> Добавить в контакты</>}
            </Button>
          </>
        ) : null}
      </GlassPanel>
    </main>
  );
}
