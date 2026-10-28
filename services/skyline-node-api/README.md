# Backend (Node.js + Express + Socket.IO)

## Установка
npm install

## Запуск
npm run dev

## Переменные окружения
Скопировать `.env.example` в `.env` и заполнить.

## Структура
- `src/index.js` — точка входа
- `src/app.js` — Express (Артём)
- `src/socket.js` — Socket.IO (Дариус)
- `src/routes/` — REST API (Артём)
- `src/middleware/` — middleware (Артём)
- `src/services/db.js` — подключение MongoDB
- `src/services/chats.js` — бизнес-логика чатов (direct, group, unread, enrich)
- `src/services/messages.js` — бизнес-логика сообщений (сохранение, пагинация, редактирование, удаление)

## Документация REST API Чатов

Все эндпоинты чатов защищены JWT-авторизацией (`Authorization: Bearer <TOKEN>`).

### 1. Чаты (`/api/chats`)
- `GET /api/chats` — список чатов текущего пользователя (с превью собеседника, `lastMessage`, счетчиком `unreadCount`).
  - Параметры query: `?q=...` (поиск по названию или собеседнику), `?limit=50`, `?offset=0`.
- `GET /api/chats/unread/total` — общее количество непрочитанных сообщений во всех чатах.
- `POST /api/chats` — создание чата:
  - **Direct**: `{ "participantId": "..." }` — возвращает существующий диалог (200) или создает новый (201).
  - **Group**: `{ "type": "group", "title": "Название", "participantIds": ["..."] }`.
- `GET /api/chats/:id` — детальная информация о чате (проверка членства, 403 при попытке заглянуть в чужой чат).
- `PATCH /api/chats/:id` — обновление названия или аватара чата (`{ "title": "...", "avatar": "..." }`).
- `DELETE /api/chats/:id` — удаление чата и всей истории его сообщений.
- `POST /api/chats/:id/read` — отметка сообщений прочитанными (сброс счетчика `unreadCount` для пользователя).
- `POST /api/chats/:id/participants` — добавление участников в группу (`{ "participantIds": ["..."] }`).
- `DELETE /api/chats/:id/participants/:participantId` — удаление участника или выход из группы.

### 2. Сообщения (`/api/chats/:id/messages` или `/api/messages/:chatId`)
- `GET /api/chats/:id/messages` — история сообщений:
  - Параметры query: `?limit=50`, `?before=<timestamp_or_id>` (скролл назад), `?order=asc|desc`.
- `POST /api/chats/:id/messages` — отправка сообщения:
  - Тело: `{ "encryptedText": "...", "type": "text"|"gift"|"image", "giftId": null }`.
  - Автоматически обновляет `lastMessage` и инкрементирует `unreadCount` у получателей.
  - Транслирует событие `receive_message` в комнату `chat:<chatId>` и `chat_updated` в комнату `user:<userId>`.
- `PATCH /api/chats/:id/messages/:messageId` — редактирование текста сообщения (только автор).
- `DELETE /api/chats/:id/messages/:messageId` — удаление сообщения (автор или админ группы) с пересчетом `lastMessage`.
- `POST /api/chats/:id/messages/read` — отметка сообщений чата как прочитанных.