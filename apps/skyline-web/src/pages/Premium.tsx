import { useState } from 'react';
import { ArrowLeft, BadgeCheck, Check, Coins, Crown, Gem, LockKeyhole, Sparkles, WandSparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/useToast';
import { applyAppPreferences } from '../preferences';
import { formatAppDate } from '../time';
import GlassPanel from '../components/ui/GlassPanel';

const coinPackages = [
  { coins: 100, price: 99, popular: false },
  { coins: 500, price: 449, popular: true },
  { coins: 1000, price: 799, popular: false },
];

const premiumThemes = [
  { id: 'cyber', name: 'Неоновый киберпанк', description: 'Ночной город и электрические акценты', swatches: ['#0b1221', '#4338ca', '#22d3ee'] },
  { id: 'cosmos', name: 'Космос', description: 'Глубокие оттенки галактики', swatches: ['#100d21', '#7c3aed', '#f472b6'] },
  { id: 'sakura', name: 'Сакура', description: 'Мягкие розовые и лавандовые тона', swatches: ['#1b1120', '#db2777', '#c4b5fd'] },
] as const;

export default function Premium() {
  const navigate = useNavigate();
  const { user, updateUser } = useAuth();
  const showToast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedTheme, setSelectedTheme] = useState(() => localStorage.getItem('skylinePremiumTheme') || 'cyber');

  const buyPremium = async () => {
    setBusy('premium');
    try {
      const response = await api.post<{ isPremium: boolean; premiumUntil: string }>('/premium/buy');
      updateUser({ isPremium: response.data.isPremium, premiumUntil: response.data.premiumUntil });
      applyAppPreferences(response.data.isPremium);
      showToast('Skyline Premium активирован на 30 дней.', 'success');
    } catch (error) {
      console.error('Не удалось активировать Premium:', error);
      showToast('Не удалось активировать Premium. Попробуйте позже.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const buyCoins = async (amount: number, price: number) => {
    setBusy(`coins-${amount}`);
    try {
      const response = await api.post<{ coinsBalance: number }>('/coins/buy', { coins: amount });
      updateUser({ coinsBalance: response.data.coinsBalance });
      showToast(`Добавлено ${amount} Coins. Баланс: ${response.data.coinsBalance}.`, 'success');
    } catch (error) {
      console.error('Не удалось пополнить Coins:', error);
      showToast(`Не удалось пополнить баланс на ${price} ₽.`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const chooseTheme = (theme: string) => {
    if (!user?.isPremium) {
      showToast('Эксклюзивные темы доступны с Skyline Premium.', 'info');
      return;
    }
    setSelectedTheme(theme);
    localStorage.setItem('skylinePremiumTheme', theme);
    localStorage.setItem('skylineAppTheme', theme);
    applyAppPreferences(true);
    showToast('Премиум-тема применена.', 'success');
  };

  return (
    <main className="relative h-full overflow-y-auto bg-bg-base px-4 py-6 text-t-primary sm:px-8 sm:py-9 animate-fade-in">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(251,191,36,0.12),transparent_55%)]" />
      <div className="relative mx-auto max-w-5xl">
        <button type="button" onClick={() => navigate('/profile')} className="mb-6 inline-flex min-h-[44px] items-center gap-2 text-xs font-medium text-t-secondary transition hover:text-t-primary">
          <ArrowLeft size={15} /> Назад в профиль
        </button>

        <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.22em] text-amber-300"><Sparkles size={13} /> Skyline</p>
            <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">Подписки и монеты <Crown size={25} className="fill-amber-300/20 text-amber-300" /></h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-t-secondary">Откройте дополнительные возможности, настройте оформление и поддержите развитие Skyline.</p>
          </div>
          <div className="glass-panel flex items-center gap-2 rounded-2xl px-4 py-3">
            <Coins size={19} className="text-amber-300" />
            <span><span className="block text-[10px] text-t-secondary">Баланс</span><span className="text-sm font-bold text-amber-100">{user?.coinsBalance ?? 0} Coins</span></span>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-3">
          <section className="glass-panel relative flex flex-col overflow-hidden rounded-3xl p-5 shadow-[0_0_40px_rgba(251,191,36,0.10)] transition-all duration-300 hover:shadow-[0_0_60px_rgba(251,191,36,0.22)] hover:-translate-y-1 sm:p-6">
            <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-gradient-to-br from-amber-300/20 to-emerald-400/10 blur-2xl" />
            <div className="relative flex h-full flex-col">
              <div className="flex items-start justify-between">
                <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-amber-300/20 to-emerald-400/10 text-amber-200"><Crown size={21} /></div>
                {user?.isPremium && <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/15 bg-emerald-300/[0.08] px-2.5 py-1 text-[10px] font-semibold text-emerald-200"><Check size={12} /> Активен</span>}
              </div>
              <h2 className="mt-5 text-xl font-bold">Skyline Premium</h2>
              <p className="mt-1 text-xs text-t-secondary">Больше возможностей для вашего аккаунта.</p>
              <p className="mt-5 text-3xl font-bold">150 ₽<span className="ml-1 text-xs font-medium text-t-secondary">/ 30 дней</span></p>
              <p className="mt-1 text-[10px] text-slate-600">Годовой план за 1 200 ₽ пока недоступен в симуляции.</p>
              <ul className="my-5 flex-1 space-y-2.5 text-xs text-t-primary/90">
                {['Золотой значок Premium в профиле и чатах', 'Эксклюзивные темы оформления', 'Статус подписки в профиле', 'Новые привилегии будут добавляться'].map((feature) => <li key={feature} className="flex items-center gap-2"><BadgeCheck size={14} className="shrink-0 text-amber-300" />{feature}</li>)}
              </ul>
              {user?.isPremium && user.premiumUntil && <p className="mb-3 text-[10px] text-t-secondary">Действует до {formatAppDate(user.premiumUntil)}</p>}
              <button type="button" disabled={busy !== null} onClick={() => void buyPremium()} className="btn-glow flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 via-yellow-300 to-emerald-400 px-4 text-sm font-bold text-slate-950 disabled:cursor-wait disabled:opacity-60">
                <Crown size={16} />{busy === 'premium' ? 'Активируем…' : user?.isPremium ? 'Продлить на 30 дней' : 'Купить Premium'}
              </button>
            </div>
          </section>

          <section className="glass-panel flex flex-col rounded-3xl p-5 transition-all duration-300 hover:-translate-y-1 sm:p-6">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/10 text-accent"><Coins size={21} /></div>
            <h2 className="mt-5 text-xl font-bold">Skyline Coins</h2>
            <p className="mt-1 text-xs text-t-secondary">Виртуальная валюта для подарков и других функций.</p>
            <div className="mt-5 flex-1 space-y-2.5">
              {coinPackages.map((pack) => (
                <div key={pack.coins} className={`flex items-center justify-between gap-2 rounded-2xl border p-3 transition ${pack.popular ? 'border-accent/30 bg-accent/[0.08]' : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'}`}>
                  <span><span className="block text-sm font-semibold">{pack.coins} <span className="text-amber-200">Coins</span></span><span className="text-[10px] text-t-secondary">{pack.price} ₽ · симуляция</span></span>
                  <button type="button" disabled={busy !== null} onClick={() => void buyCoins(pack.coins, pack.price)} className="btn-glow min-h-[44px] rounded-xl bg-accent/15 px-4 text-[11px] font-semibold text-t-primary disabled:opacity-50">{busy === `coins-${pack.coins}` ? '…' : 'Выбрать'}</button>
                </div>
              ))}
            </div>
            <p className="mt-4 text-[10px] leading-4 text-slate-600">Покупка демонстрационная. Тратить монеты на подарки и дополнения пока нельзя.</p>
          </section>

          <section className="glass-panel flex flex-col rounded-3xl p-5 transition-all duration-300 hover:-translate-y-1 sm:p-6">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-200"><Gem size={21} /></div>
            <h2 className="mt-5 text-xl font-bold">Skyline Business</h2>
            <p className="mt-1 text-xs text-t-secondary">Инструменты для больших каналов и команд.</p>
            <p className="mt-5 text-3xl font-bold">500 ₽<span className="ml-1 text-xs font-medium text-t-secondary">/ месяц за канал</span></p>
            <ul className="my-5 flex-1 space-y-2.5 text-xs text-t-primary/90">
              {['Статистика канала', 'До 5 администраторов', 'Автопостинг через API', 'Верификация канала'].map((feature) => <li key={feature} className="flex items-center gap-2"><Check size={14} className="shrink-0 text-cyan-300" />{feature}</li>)}
            </ul>
            <div className="mt-auto flex items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-xs font-semibold text-t-secondary"><LockKeyhole size={14} /> Скоро</div>
          </section>
        </div>

        <GlassPanel className="mt-6 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold"><WandSparkles size={18} className="text-accent" /> Эксклюзивные темы</h2>
              <p className="mt-1 text-xs text-t-secondary">Выберите оформление для Skyline. Премиум-темы доступны подписчикам.</p>
            </div>
            {!user?.isPremium && <button type="button" onClick={() => void buyPremium()} className="btn-glow min-h-[44px] rounded-xl border border-amber-300/20 bg-amber-300/[0.07] px-4 text-xs font-semibold text-amber-200 transition hover:bg-amber-300/[0.12]">Открыть Premium</button>}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {premiumThemes.map((theme) => {
              const isSelected = selectedTheme === theme.id && user?.isPremium;
              return <button key={theme.id} type="button" onClick={() => chooseTheme(theme.id)} className={`relative overflow-hidden rounded-2xl border p-3 text-left transition-all duration-200 ${isSelected ? 'border-accent/40 bg-accent/[0.08] shadow-[0_0_20px_var(--glow)]' : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04] hover:-translate-y-0.5'}`}>
                <div className="mb-3 flex h-16 items-end gap-1 overflow-hidden rounded-xl p-2" style={{ background: `linear-gradient(135deg, ${theme.swatches[0]}, ${theme.swatches[1]})` }}>
                  <span className="h-5 w-1/3 rounded-md opacity-80" style={{ backgroundColor: theme.swatches[2] }} />
                  <span className="mb-2 h-4 w-1/2 rounded-md opacity-50" style={{ backgroundColor: theme.swatches[2] }} />
                </div>
                <span className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{theme.name}</span>{!user?.isPremium && <LockKeyhole size={13} className="text-slate-600" />}{isSelected && <Check size={14} className="text-accent" />}</span>
                <span className="mt-1 block text-[10px] text-t-secondary">{theme.description}</span>
              </button>;
            })}
          </div>
          <p className="mt-4 text-[10px] text-slate-600">Все покупки на этой странице демонстрационные: реальные платежи не выполняются.</p>
        </GlassPanel>
      </div>
    </main>
  );
}
