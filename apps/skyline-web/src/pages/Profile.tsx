import { useState, type ChangeEvent, type FormEvent } from 'react';
import { ArrowLeft, Coins, Crown, ImagePlus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatAppDate } from '../time';
import Button from '../components/ui/Button';
import GlassPanel from '../components/ui/GlassPanel';
import Avatar from '../components/ui/Avatar';
import Toggle from '../components/ui/Toggle';

const inputClassName = 'mt-2 h-12 w-full rounded-xl border border-white/[0.08] bg-white/[0.05] px-4 text-sm text-t-primary outline-none transition-all duration-200 focus:border-accent/50 focus:bg-white/[0.07] min-h-[44px]';

export default function Profile() {
  const navigate = useNavigate();
  const { user, updateUser } = useAuth();

  const [displayName, setDisplayName] = useState(user?.displayName || user?.username || '');
  const [username, setUsername] = useState(user?.username || '');
  const [dateOfBirth, setDateOfBirth] = useState(user?.dateOfBirth || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [statusText, setStatusText] = useState(user?.statusText || '');
  const [showLastSeen, setShowLastSeen] = useState(user?.showLastSeen ?? true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);

  const handleAvatarChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setMessageIsError(true);
      setMessage('Выберите файл изображения.');
      return;
    }
    if (file.size > 900 * 1024) {
      setMessageIsError(true);
      setMessage('Изображение должно быть меньше 900 КБ.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAvatarUrl(reader.result);
        setMessageIsError(false);
        setMessage('');
      }
    };
    reader.onerror = () => {
      setMessageIsError(true);
      setMessage('Не удалось прочитать изображение.');
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessageIsError(false);
    setMessage('');

    try {
      await api.patch('/users/me/profile', {
        displayName: displayName.trim(),
        username: username.trim(),
        dateOfBirth: dateOfBirth || null,
        avatarUrl,
        bio: bio.trim(),
        statusText: statusText.trim(),
        showLastSeen,
      });
      updateUser({ displayName: displayName.trim(), username: username.trim(), dateOfBirth: dateOfBirth || null, avatarUrl, bio: bio.trim(), statusText: statusText.trim(), showLastSeen });
      setMessage('Настройки профиля сохранены.');
    } catch (error: unknown) {
      const data = isAxiosError(error)
        ? error.response?.data as { detail?: string; error?: string } | undefined
        : undefined;
      setMessageIsError(true);
      setMessage(data?.detail || data?.error || 'Не удалось сохранить настройки профиля.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative h-full overflow-y-auto bg-bg-base px-4 py-8 text-t-primary animate-fade-in">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_50%_0%,var(--glow),transparent_55%)]" />
      <div className="relative mx-auto w-full max-w-3xl">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mb-6 inline-flex min-h-[44px] items-center gap-2 text-xs font-medium text-t-secondary transition hover:text-t-primary"
        >
          <ArrowLeft size={15} /> Назад к чатам
        </button>

        <GlassPanel className="p-6 sm:p-9">
          <div className="mb-7">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Аккаунт</p>
            <h1 className="text-2xl font-semibold tracking-tight">Настройки профиля</h1>
            <p className="mt-2 text-sm text-t-secondary">Управляйте публичной информацией и приватностью.</p>
          </div>

          <section className="mb-7 overflow-hidden rounded-2xl border border-amber-300/15 bg-gradient-to-r from-amber-300/[0.08] via-white/[0.025] to-accent/[0.06] p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-amber-300/10 text-amber-200"><Coins size={21} /></span>
                <span>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200/70">Skyline Coins</span>
                  <span className="mt-0.5 block text-lg font-bold text-amber-100">{user?.coinsBalance ?? 0} <span className="text-xs font-medium text-t-secondary">монет</span></span>
                  <span className="block text-[10px] text-t-secondary">{user?.isPremium ? 'Premium активен' : 'Откройте больше возможностей'}</span>
                </span>
              </div>
              <button type="button" onClick={() => navigate('/premium')} className="btn-glow inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 via-yellow-300 to-emerald-400 px-4 text-xs font-bold text-slate-950">
                <Crown size={15} />{user?.isPremium ? 'Premium и монеты' : 'Купить Premium'}
              </button>
            </div>
            {user?.isPremium && user.premiumUntil && <p className="mt-3 border-t border-white/[0.06] pt-3 text-[10px] text-t-secondary">Premium действует до {formatAppDate(user.premiumUntil)}</p>}
          </section>

          <div className="mb-7 flex flex-wrap items-center gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.025] p-4">
            <Avatar src={avatarUrl} name={displayName || username || 'U'} size={64} online className={user?.isPremium ? 'ring-premium' : ''} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold">{displayName || username}{user?.isPremium && <Crown size={14} className="shrink-0 fill-amber-300/20 text-amber-300" aria-label="Skyline Premium" />}</p>
              <p className="mt-1 truncate text-xs text-t-secondary">@{username}</p>
            </div>
            <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-xs text-t-primary transition hover:bg-white/5">
              <ImagePlus size={15} /> Изменить фото
              <input type="file" accept="image/*" onChange={handleAvatarChange} className="sr-only" />
            </label>
            {avatarUrl && (
              <button type="button" onClick={() => setAvatarUrl('')} aria-label="Удалить фото профиля" className="grid min-h-[44px] min-w-[44px] place-items-center rounded-xl text-t-secondary transition hover:bg-rose-400/10 hover:text-rose-300">
                <Trash2 size={15} />
              </button>
            )}
          </div>

          {message && (
            <div role="status" className={`mb-4 rounded-xl border px-3.5 py-3 text-sm ${messageIsError ? 'border-rose-400/20 bg-rose-400/[0.08] text-rose-200' : 'border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-200'}`}>
              {message}
            </div>
          )}

          <form onSubmit={handleSave} className="space-y-6">
            <section className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold">Публичный профиль</h2>
                <p className="mt-1 text-xs text-t-secondary">Эти данные увидят пользователи, открывшие ваш профиль.</p>
              </div>
              <label className="block text-xs font-medium text-t-secondary">
                Отображаемое имя
                <input type="text" value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={32} className={inputClassName} required />
              </label>
              <label className="block text-xs font-medium text-t-secondary">
                Имя пользователя
                <span className="mt-2 flex h-12 min-h-[44px] items-center rounded-xl border border-white/[0.08] bg-white/[0.05] px-4 text-sm text-t-secondary transition-all duration-200 focus-within:border-accent/50">
                  @
                  <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9_.-]+" className="h-full min-w-0 flex-1 bg-transparent pl-1 text-t-primary outline-none" required />
                </span>
                <span className="mt-1 block text-[10px] text-slate-600">Буквы латиницы, цифры, точка, дефис и подчёркивание.</span>
              </label>
              <label className="block text-xs font-medium text-t-secondary">
                Дата рождения
                <input
                  type="date"
                  value={dateOfBirth}
                  onChange={(event) => setDateOfBirth(event.target.value)}
                  className={inputClassName}
                />
                <span className="mt-1 block text-[10px] text-slate-600">Дата рождения сохранится только в вашем аккаунте.</span>
              </label>
              <label className="block text-xs font-medium text-t-secondary">
                О себе
                <textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={300} rows={3} placeholder="Пара слов о себе" className="mt-2 w-full resize-y rounded-xl border border-white/[0.08] bg-white/[0.05] px-4 py-3 text-sm text-t-primary outline-none transition-all duration-200 focus:border-accent/50" />
                <span className="mt-1 block text-right text-[10px] text-slate-600">{bio.length}/300</span>
              </label>
              <label className="block text-xs font-medium text-t-secondary">
                Статус
                <input type="text" value={statusText} onChange={(event) => setStatusText(event.target.value)} maxLength={80} placeholder="Например: на связи" className={inputClassName} />
              </label>
            </section>

            <section className="rounded-2xl border border-white/[0.06] bg-white/[0.025] p-2">
              <Toggle
                on={showLastSeen}
                onChange={setShowLastSeen}
                label="Время последнего посещения"
                description="Разрешить другим пользователям видеть, когда вы заходили в Skyline."
              />
            </section>

            {user?.createdAt && (
              <p className="text-xs text-t-secondary">
                Аккаунт создан: {formatAppDate(user.createdAt)}
              </p>
            )}

            <Button type="submit" disabled={loading || !displayName.trim() || !username.trim()}>
              {loading ? 'Сохраняем…' : <><Save size={16} /> Сохранить настройки</>}
            </Button>
          </form>
          <p className="mt-5 flex items-center justify-center gap-2 text-[10px] text-slate-600">
            <ShieldCheck size={13} className="text-emerald-400/70" /> Email и пароль не отображаются в профиле.
          </p>
        </GlassPanel>
      </div>
    </main>
  );
}
