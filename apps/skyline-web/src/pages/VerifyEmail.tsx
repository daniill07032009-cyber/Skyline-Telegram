import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, CheckCircle2, CloudLightning } from 'lucide-react';
import { authApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import GlassPanel from '../components/ui/GlassPanel';
import Button from '../components/ui/Button';
import Spinner from '../components/ui/Spinner';

export default function VerifyEmail() {
  const location = useLocation();
  const navigate = useNavigate();
  const { register } = useAuth();

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Подтверждаем ваш адрес электронной почты…');

  useEffect(() => {
    const runVerification = async () => {
      try {
        const searchParams = new URLSearchParams(location.search);
        let email = searchParams.get('email') || '';
        const code = searchParams.get('code') || '';
        const token = searchParams.get('token') || '';
        const registrationTokenParam = searchParams.get('registrationToken') || '';

        if (!email && location.hash.includes('?')) {
          const hashParams = new URLSearchParams(location.hash.split('?')[1]);
          email = hashParams.get('email') || email;
        }

        let registrationToken = registrationTokenParam;
        if (!registrationToken) {
          if (token && email) {
            const res = await authApi.verifyEmailToken(email, token);
            registrationToken = res.data.registrationToken;
          } else if (code && email) {
            const res = await authApi.verifyEmailCode(email, code);
            registrationToken = res.data.registrationToken;
          } else {
            setStatus('error');
            setMessage('В ссылке подтверждения отсутствуют необходимые параметры.');
            return;
          }
        }

        const saved = sessionStorage.getItem('pendingRegistration');
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            if (parsed.email && parsed.password && parsed.username && registrationToken) {
              await register(parsed.email, parsed.password, parsed.username, registrationToken);
              sessionStorage.removeItem('pendingRegistration');
              setStatus('success');
              setMessage('Почта успешно подтверждена! Входим в аккаунт…');
              window.setTimeout(() => navigate('/', { replace: true }), 1200);
              return;
            }
          } catch {
            // ignore JSON parse error
          }
        }

        if (registrationToken && email) {
          sessionStorage.setItem('verifiedEmailToken', registrationToken);
          sessionStorage.setItem('verifiedEmailAddress', email);
          setStatus('success');
          setMessage('Email успешно подтверждён в 1 клик! Завершите ввод имени и пароля.');
          window.setTimeout(() => navigate('/register', { replace: true }), 1800);
          return;
        }

        setStatus('success');
        setMessage('Email успешно подтверждён!');
      } catch (err: unknown) {
        console.error('Email verification error:', err);
        const data = (err as { response?: { data?: { detail?: string; error?: string } } })?.response?.data;
        setStatus('error');
        setMessage(data?.detail || data?.error || 'Срок действия ссылки истёк или она уже была использована.');
      }
    };

    void runVerification();
  }, [location, navigate, register]);

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

        <GlassPanel className="p-8 text-center animate-scale-in">
          {status === 'loading' && (
            <div className="flex flex-col items-center py-6">
              <Spinner size={44} className="mb-4" />
              <h1 className="mb-2 text-xl font-semibold tracking-tight">Подтверждение в 1 клик</h1>
              <p className="text-sm text-t-secondary">{message}</p>
            </div>
          )}

          {status === 'success' && (
            <div className="flex flex-col items-center py-6">
              <span className="mb-4 grid h-14 w-14 place-items-center rounded-3xl bg-emerald-400/15 text-emerald-300">
                <CheckCircle2 size={30} />
              </span>
              <h1 className="mb-2 text-xl font-semibold tracking-tight">Успешно!</h1>
              <p className="mb-6 text-sm leading-relaxed text-t-secondary">{message}</p>
              <Button onClick={() => navigate('/')}>
                Перейти в мессенджер <ArrowRight size={16} />
              </Button>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center py-6">
              <span className="mb-4 grid h-14 w-14 place-items-center rounded-3xl bg-rose-400/15 text-rose-300">
                <AlertCircle size={30} />
              </span>
              <h1 className="mb-2 text-xl font-semibold tracking-tight">Ошибка подтверждения</h1>
              <p className="mb-6 text-sm leading-relaxed text-rose-200">{message}</p>
              <Link to="/register" className="btn-glow flex h-12 w-full items-center justify-center gap-2 rounded-xl glass-panel text-sm font-semibold text-t-primary">
                Вернуться к регистрации
              </Link>
            </div>
          )}
        </GlassPanel>
      </div>
    </main>
  );
}
