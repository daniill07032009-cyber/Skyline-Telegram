import { useEffect, useRef } from 'react';
import { formatAppTime } from '../time';

export interface Message {
  _id?: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  encryptedText: string;
  type: string;
  giftId?: string | null;
  createdAt?: string;
}

interface Props {
  messages: Message[];
  currentUserId: string;
}

export default function MessageList({ messages, currentUserId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        Нет сообщений. Начните переписку!
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((msg, i) => {
        const isMine = msg.senderId === currentUserId;

        return (
          <div
            key={msg._id || i}
            className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-xs md:max-w-md rounded-lg overflow-hidden ${
                isMine
                  ? 'bg-blue-500 text-white'
                  : 'bg-white text-gray-800 shadow'
              }`}
            >
              {!isMine && (
                <div className="text-xs font-semibold text-gray-500 px-3 pt-2">
                  {msg.senderName || msg.senderId.slice(0, 6)}
                </div>
              )}
              
              {/* ЕСЛИ КАРТИНКА */}
              {msg.type === 'image' ? (
                <img 
                  src={msg.encryptedText} 
                  alt="Фото" 
                  className="max-w-full h-auto object-cover cursor-pointer"
                  onClick={() => window.open(msg.encryptedText, '_blank')} // Клик открывает в новой вкладке
                />
              ) : (
                /* ЕСЛИ ТЕКСТ */
                <div className="px-4 py-2 break-words">
                  {typeof msg.encryptedText === 'string' ? msg.encryptedText : '[Ошибка]'}
                </div>
              )}

              {msg.createdAt && (
                <div
                  className={`text-xs px-3 pb-2 mt-1 ${
                    isMine ? 'text-blue-100 text-right' : 'text-gray-400 text-left'
                  }`}
                >
                  {formatAppTime(msg.createdAt)}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
