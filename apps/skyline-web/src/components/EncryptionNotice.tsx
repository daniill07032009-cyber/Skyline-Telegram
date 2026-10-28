import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function EncryptionNotice() {
  const { e2eeStatus, logout } = useAuth();
  const navigate = useNavigate();

  if (e2eeStatus === 'ready' || e2eeStatus === 'checking') return null;

  const details = {
    'backup-needed': 'Чтобы безопасно открыть переписку на других устройствах, выйдите и войдите снова на устройстве, где история читается. Ключ будет сохранён в зашифрованном виде.',
    'key-mismatch': 'Ключ этого устройства не совпадает с ключом переписки. Войдите снова с паролем аккаунта, чтобы восстановить синхронизированный ключ.',
    'recovery-required': 'На устройстве нет ключа от этой истории. Войдите на устройстве, где сообщения читаются, и затем войдите здесь с тем же паролем. Если исходный ключ был утрачен до синхронизации, старые сообщения восстановить нельзя.',
    'temporarily-unavailable': 'Не удалось проверить или сохранить ключ шифрования. Проверьте соединение и перезайдите в аккаунт.',
  }[e2eeStatus];

  return (
    <aside role="status" className="mx-3 mb-3 flex flex-col gap-2 rounded-2xl border border-amber-400/25 bg-amber-500/[0.08] px-4 py-3 text-xs text-t-primary sm:mx-5">
      <p className="font-semibold">Синхронизация защищённой переписки</p>
      <p className="leading-relaxed text-t-secondary">{details}</p>
      {(e2eeStatus === 'backup-needed' || e2eeStatus === 'key-mismatch') && (
        <button type="button" onClick={() => { logout(); navigate('/login', { replace: true }); }} className="min-h-9 self-start rounded-xl bg-amber-400/15 px-3 font-semibold text-amber-100 transition hover:bg-amber-400/25">
          Выйти и войти снова
        </button>
      )}
    </aside>
  );
}
