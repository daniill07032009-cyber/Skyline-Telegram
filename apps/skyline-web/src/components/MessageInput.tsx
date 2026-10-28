import { useState, type FormEvent, useRef } from 'react';
import { keysApi } from '../api/client';
import { encryptMessage } from '../crypto/encrypt';
import { getSocket } from '../api/socket';
import { useAuth } from '../context/AuthContext';

interface Props {
  chatId: string;
  recipientId: string;
}

export default function MessageInput({ chatId, recipientId }: Props) {
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Отправка картинки
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Проверка на размер (максимум 1 МБ, чтобы не перегружать базу)
    if (file.size > 1024 * 1024) {
      return setError('Файл слишком большой (максимум 1 МБ)');
    }

    const socket = getSocket();
    if (!socket) return setError('Socket не подключён');

    setSending(true);
    setError('');

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64Image = reader.result as string;

      socket.emit(
        'send_message',
        {
          chatId,
          encryptedText: base64Image, // Отправляем картинку как текст
          type: 'image',
          moderationEnabled: false,   // Картинки не фильтруем матом
        },
        (response: any) => {
          setSending(false);
          if (response?.status !== 'ok') {
            setError('Ошибка отправки фото');
          }
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      );
    };
    reader.readAsDataURL(file);
  };

  // Отправка текста
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;

    const socket = getSocket();
    if (!socket) return setError('Socket не подключён');

    setSending(true);
    setError('');

    try {
      let encrypted = trimmed;
      if (recipientId) {
        try {
          const [recipientKeyRes, ownKeyRes] = await Promise.allSettled([
            keysApi.get(recipientId),
            keysApi.me(),
          ]);

          const recipientKey = recipientKeyRes.status === 'fulfilled' ? recipientKeyRes.value.data.publicKey : '';
          const ownKey = ownKeyRes.status === 'fulfilled' ? ownKeyRes.value.data.publicKey : '';

          const recipients = [
            { userId: recipientId, publicKey: recipientKey },
            ...(user?.id ? [{ userId: user.id, publicKey: ownKey }] : []),
          ].filter((r) => !!r.publicKey);

          if (recipients.length > 0) {
            encrypted = await encryptMessage(trimmed, recipients);
          }
        } catch (keyErr) {
          console.warn('Crypto encryption failed, falling back to plaintext:', keyErr);
          encrypted = trimmed;
        }
      }

      const moderationEnabled = localStorage.getItem('moderationEnabled') !== 'false';

      socket.emit(
        'send_message',
        {
          chatId,
          encryptedText: encrypted,
          type: 'text',
          moderationEnabled,
        },
        (response: any) => {
          setSending(false);
          if (response?.status === 'ok') {
            setText('');
          } else {
            setError('Ошибка отправки: ' + (response?.error || 'unknown'));
          }
        }
      );
    } catch (err: any) {
      setSending(false);
      setError(err?.message || 'Ошибка отправки');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border-t bg-white p-3 flex flex-col gap-2">
      {error && <div className="bg-red-100 text-red-700 p-2 rounded text-sm">{error}</div>}
      
      <div className="flex gap-2 items-center">
        {/* Кнопка прикрепления файла */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-gray-500 hover:text-blue-500 p-2 rounded-full transition"
          title="Прикрепить фото"
          disabled={sending}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        <input type="file" accept="image/*" ref={fileInputRef} onChange={handleFileChange} className="hidden" />

        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Введите сообщение..."
          className="flex-1 px-4 py-2 border rounded-full focus:outline-none focus:ring-2 focus:ring-blue-400"
          disabled={sending}
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="bg-blue-500 text-white px-6 py-2 rounded-full hover:bg-blue-600 disabled:opacity-50"
        >
          {sending ? '...' : 'Отправить'}
        </button>
      </div>
    </form>
  );
}