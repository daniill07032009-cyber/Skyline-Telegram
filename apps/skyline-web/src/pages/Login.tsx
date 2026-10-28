import { useState, type FormEvent } from 'react';
import { isAxiosError } from 'axios';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CloudLightning, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import GlassPanel from '../components/ui/GlassPanel';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email.trim(), password);
      const redirectPath = sessionStorage.getItem('skylineAfterLogin');
      sessionStorage.removeItem('skylineAfterLogin');
      navigate(redirectPath || '/', { replace: true });
    } catch (loginError: unknown) {
      const data = isAxiosError(loginError)
        ? loginError.response?.data as { detail?: string; error?: string } | undefined
        : undefined;
      setError(data?.detail || data?.error || 'Не удалось войти. Проверьте email и пароль.');
    } finally {
      setLoading(false);
    }
  };

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
          <h1 className="text-2xl font-semibold tracking-tight">Войти в Skyline</h1>
          <p className="mt-1 text-sm text-t-secondary">С возвращением! Введите свои данные.</p>

          {error && (
            <div className="login-error-shake mb-5 mt-5 rounded-xl border border-rose-400/20 bg-rose-400/[0.08] px-3.5 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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
              autoComplete="current-password"
              required
              placeholder="Ваш пароль"
            />
            <Button type="submit" disabled={loading || !email.trim() || !password} className="mt-2">
              {loading ? 'Входим…' : <>Войти <ArrowRight size={16} /></>}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-t-secondary">
            Ещё нет аккаунта?{' '}
            <Link to="/register" className="font-semibold text-accent transition hover:opacity-80">Зарегистрироваться</Link>
          </p>
        </GlassPanel>

        <p className="mt-5 flex items-center justify-center gap-2 text-[11px] text-slate-600">
          <ShieldCheck size={14} className="text-emerald-400/70" /> Ваша переписка защищена.
        </p>
      </div>
    </main>
  );
}
