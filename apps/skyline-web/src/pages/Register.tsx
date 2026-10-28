import { useEffect, useState, type FormEvent } from 'react';
import { isAxiosError } from 'axios';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CloudLightning, LockKeyhole, Mail, ShieldCheck, User as UserIcon, X } from 'lucide-react';
import { authApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import GlassPanel from '../components/ui/GlassPanel';

function readPendingRegistration(): { email: string; username: string; password: string } | null {
  try {
    const raw = sessionStorage.getItem('pendingRegistration');
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value
      || typeof value !== 'object'
      || !('email' in value) || typeof value.email !== 'string'
      || !('username' in value) || typeof value.username !== 'string'
      || !('password' in value) || typeof value.password !== 'string'
    ) return null;
    return { email: value.email, username: value.username, password: value.password };
  } catch {
    return null;
  }
}

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [savedRegistration] = useState(readPendingRegistration);
  const [username, setUsername] = useState(() => savedRegistration?.username || '');
  const [email, setEmail] = useState(() => {
    try {
      return sessionStorage.getItem('verifiedEmailAddress') || savedRegistration?.email || '';
    } catch {
      return savedRegistration?.email || '';
    }
  });
  const [password, setPassword] = useState(() => savedRegistration?.password || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(() => Boolean(savedRegistration));
  const [verificationCode, setVerificationCode] = useState('');
  const [verificationError, setVerificationError] = useState('');
  const [verificationNotice, setVerificationNotice] = useState(() => {
    try {
      const token = sessionStorage.getItem('verifiedEmailToken');
      const address = sessionStorage.getItem('verifiedEmailAddress');
      if (token && address) return `Email ${address} уже подтверждён! Нажмите «Зарегистрироваться» для входа.`;
      if (savedRegistration) return `Продолжите подтверждение email для ${savedRegistration.email}. Введите код из письма.`;
      return '';
    } catch {
      return '';
    }
  });
  const [secondsRemaining, setSecondsRemaining] = useState(600);
  const [verificationLoading, setVerificationLoading] = useState(false);

  useEffect(() => {
    if (!verificationOpen || secondsRemaining <= 0) return;
    const timer = window.setTimeout(() => {
      setSecondsRemaining((remaining) => Math.max(0, remaining - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [verificationOpen, secondsRemaining]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    const verifiedToken = sessionStorage.getItem('verifiedEmailToken');
    const verifiedEmail = sessionStorage.getItem('verifiedEmailAddress');
    if (verifiedToken && verifiedEmail && verifiedEmail.toLowerCase() === email.trim().toLowerCase()) {
      setLoading(true);
      try {
        await register(email.trim(), password, username.trim(), verifiedToken);
        sessionStorage.removeItem('verifiedEmailToken');
        sessionStorage.removeItem('verifiedEmailAddress');
        const redirectPath = sessionStorage.getItem('skylineAfterLogin');
        sessionStorage.removeItem('skylineAfterLogin');
        navigate(redirectPath || '/', { replace: true });
        return;
      } catch (registrationError: unknown) {
        sessionStorage.removeItem('verifiedEmailToken');
        sessionStorage.removeItem('verifiedEmailAddress');
        const data = isAxiosError(registrationError)
          ? registrationError.response?.data as { detail?: string; error?: string } | undefined
          : undefined;
        setError(data?.detail || data?.error || 'Не удалось завершить регистрацию. Проверьте данные и попробуйте ещё раз.');
        return;
      } finally {
        setLoading(false);
      }
    }

    setLoading(true);
    try {
      sessionStorage.setItem('pendingRegistration', JSON.stringify({
        email: email.trim(),
        username: username.trim(),
        password,
      }));

      const res = await authApi.sendEmailCode(email.trim());
      setSecondsRemaining(res.data.expiresInSeconds || 600);
      setVerificationError('');
      setVerificationCode('');
      setVerificationNotice(`Письмо со ссылкой для подтверждения отправлено на ${email.trim()}. Введите код из письма или перейдите по ссылке в нём.`);
      setVerificationOpen(true);
    } catch (sendError: unknown) {
      const data = isAxiosError(sendError)
        ? sendError.response?.data as { detail?: string; error?: string } | undefined
        : undefined;
      setError(data?.detail || data?.error || 'Не удалось отправить код подтверждения. Попробуйте ещё раз.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    setVerificationError('');
    setVerificationNotice('');
    setVerificationCode('');
    setVerificationLoading(true);
    try {
      const res = await authApi.sendEmailCode(email.trim());
      setSecondsRemaining(res.data.expiresInSeconds || 600);
      setVerificationCode('');
      setVerificationNotice(`Новое письмо отправлено на ${email.trim()}. Введите код из письма или перейдите по ссылке в нём.`);
    } catch (sendError: unknown) {
      const data = isAxiosError(sendError)
        ? sendError.response?.data as { detail?: string; error?: string } | undefined
        : undefined;
      setVerificationError(data?.detail || data?.error || 'Не удалось отправить новый код.');
    } finally {
      setVerificationLoading(false);
    }
  };

  const handleVerifyCode = async (event?: FormEvent, codeOverride?: string) => {
    if (event) event.preventDefault();
    const codeToUse = codeOverride || verificationCode;
    if (codeToUse.length !== 6 || verificationLoading) return;
    setVerificationError('');
    setVerificationNotice('');
    setVerificationLoading(true);
    try {
      const response = await authApi.verifyEmailCode(email.trim(), codeToUse);
      await register(email.trim(), password, username.trim(), response.data.registrationToken);
      sessionStorage.removeItem('pendingRegistration');
      sessionStorage.removeItem('verifiedEmailToken');
      sessionStorage.removeItem('verifiedEmailAddress');
      const redirectPath = sessionStorage.getItem('skylineAfterLogin');
      sessionStorage.removeItem('skylineAfterLogin');
      navigate(redirectPath || '/', { replace: true });
    } catch (verifyError: unknown) {
      const data = isAxiosError(verifyError)
        ? verifyError.response?.data as { detail?: string; error?: string } | undefined
        : undefined;
      const message = data?.detail || data?.error || 'Не удалось подтвердить email.';
      setVerificationError(message);
      if (message.toLocaleLowerCase('ru-RU').includes('слишком много попыток')) {
        setVerificationCode('');
      }
    } finally {
      setVerificationLoading(false);
    }
  };

  const formatCountdown = (seconds: number) =>
    `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

  return (
    <main className="relative grid h-full w-full place-items-center overflow-y-auto bg-bg-base px-4 py-8 text-t-primary animate-fade-in">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,var(--glow),transparent_55%)]" />
      <div className="relative w-full max-w-[430px]">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="btn-glow grid h-14 w-14 place-items-center rounded-3xl bg-gradient-to-br from-accent-from to-accent-to shadow-lg">
            <CloudLightning size={26} />
          </span>
          <span className="text-2xl font-extrabold tracking-tight">Skyline</span>
        </div>

        <GlassPanel className="p-6 animate-scale-in">
          <h1 className="text-2xl font-semibold tracking-tight">Создать аккаунт</h1>
          <p className="mt-1 text-sm text-t-secondary">Присоединяйтесь к Skyline за минуту.</p>

          {error && (
            <div className="login-error-shake mb-5 mt-5 rounded-xl border border-rose-400/20 bg-rose-400/[0.08] px-3.5 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <Input
              type="text"
              label="Имя пользователя"
              icon={<UserIcon size={14} className="text-t-secondary" />}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
              placeholder="username"
            />
            <Input
              type="email"
              label="Электронная почта"
              icon={<Mail size={14} className="text-t-secondary" />}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              placeholder="name@example.com"
            />
            <Input
              type="password"
              label="Пароль"
              icon={<LockKeyhole size={14} className="text-t-secondary" />}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
              placeholder="Минимум 6 символов"
            />
            <Button type="submit" disabled={loading || !email.trim() || !password || !username.trim()} className="mt-2">
              {loading ? 'Создаем…' : <>Зарегистрироваться <ArrowRight size={16} /></>}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-t-secondary">
            Уже есть аккаунт?{' '}
            <Link to="/login" className="font-semibold text-accent transition hover:opacity-80">Войти</Link>
          </p>
        </GlassPanel>

        {verificationOpen && (
          <div
            className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm animate-fade-in"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !verificationLoading) setVerificationOpen(false);
            }}
          >
            <GlassPanel
              role="dialog"
              aria-modal="true"
              aria-labelledby="email-verification-title"
              className="w-full max-w-md p-6 shadow-2xl animate-scale-in sm:p-8"
            >
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-accent">Подтверждение почты</p>
                  <h2 id="email-verification-title" className="text-xl font-semibold">Введите код из письма</h2>
                </div>
                <button type="button" onClick={() => setVerificationOpen(false)} aria-label="Закрыть" className="min-h-[44px] min-w-[44px] grid place-items-center rounded-xl text-t-secondary transition hover:bg-white/5 hover:text-t-primary">
                  <X size={18} />
                </button>
              </div>
              <p className="mb-5 text-sm leading-relaxed text-t-secondary">
                Если адрес может принять письмо, код отправлен на <span className="text-t-primary">{email.trim()}</span>.
                Он действует ещё <span className="font-mono text-accent">{formatCountdown(secondsRemaining)}</span>.
              </p>
              {verificationError && (
                <div role="status" className="mb-4 rounded-xl border border-rose-400/20 bg-rose-400/[0.08] px-3.5 py-3 text-sm text-rose-200">
                  {verificationError}
                </div>
              )}
              {verificationNotice && (
                <div role="status" className="mb-4 rounded-xl border border-accent/20 bg-accent/[0.08] px-3.5 py-3 text-sm text-t-primary">
                  {verificationNotice}
                </div>
              )}
              <form onSubmit={handleVerifyCode} className="space-y-4">
                <label className="block">
                  <span className="mb-2 block text-xs font-medium text-t-secondary">Шестизначный код</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    aria-label="Код подтверждения"
                    className="h-14 w-full rounded-xl border border-white/[0.08] bg-white/[0.05] text-center font-mono text-2xl tracking-[0.45em] text-t-primary outline-none transition-all duration-200 placeholder:text-slate-700 focus:border-accent/50"
                    required
                  />
                </label>
                {verificationCode.length === 6 && (
                  <Button type="button" onClick={() => void handleVerifyCode(undefined, verificationCode)} disabled={verificationLoading}>
                    {verificationLoading ? 'Подтверждаем…' : <>⚡ Подтвердить в 1 клик <ArrowRight size={16} /></>}
                  </Button>
                )}
                <Button type="submit" variant="glass" disabled={verificationLoading || verificationCode.length !== 6}>
                  {verificationLoading ? 'Проверяем…' : <>Подтвердить и создать аккаунт <ArrowRight size={16} /></>}
                </Button>
              </form>
              <button type="button" onClick={() => void handleResendCode()} disabled={verificationLoading} className="mt-4 w-full rounded-xl px-3 py-2 text-xs font-medium text-accent transition hover:bg-accent/10 disabled:opacity-50 min-h-[44px]">
                {verificationLoading ? 'Отправляем…' : 'Отправить код повторно'}
              </button>
            </GlassPanel>
          </div>
        )}

        <p className="mt-5 flex items-center justify-center gap-2 text-[11px] text-slate-600">
          <ShieldCheck size={14} className="text-emerald-400/70" /> Регистрация занимает всего минуту
        </p>
      </div>
    </main>
  );
}
