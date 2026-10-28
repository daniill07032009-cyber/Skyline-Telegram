import axios from 'axios';

// ЕДИНСТВЕННЫЙ СЕРВЕР (PYTHON)
const PYTHON_API_URL = import.meta.env.VITE_API_URL || 'https://oursocial-python.onrender.com';

export const api = axios.create({
  baseURL: PYTHON_API_URL,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface User {
  id: string;
  email?: string;
  isEmailVerified?: boolean;
  username: string;
  displayName?: string;
  name?: string;
  avatarUrl?: string;
  bio?: string;
  statusText?: string;
  showLastSeen?: boolean;
  dateOfBirth?: string | null;
  createdAt?: string | null;
  hideOnlineStatus?: boolean;
  hideReadReceipts?: boolean;
  hideDateOfBirth?: boolean;
  lastSeen?: string | null;
  isPremium?: boolean;
  premiumUntil?: string | null;
  coinsBalance?: number;
}

export interface Contact extends User {
  nickname: string;
  unreadCount?: number;
  lastMessageAt?: string | null;
  lastMessageText?: string;
  lastMessageType?: 'text' | 'image' | 'file';
  lastMessageFileName?: string | null;
  lastMessageSenderId?: string | null;
  isContact?: boolean;
  chatHidden?: boolean;
}

export interface AuthResponse {
  status?: string;
  token: string;
  user: User;
}

export const authApi = {
  register: (email: string, password: string, username: string, verificationToken: string) =>
    api.post<AuthResponse>('/auth/register', { email, password, username, verificationToken }),
  sendEmailCode: (email: string) =>
    api.post<{
      status: string;
      message: string;
      expiresInSeconds: number;
      emailSent: boolean;
    }>('/auth/send-email-code', { email }),
  verifyEmailCode: (email: string, code: string) =>
    api.post<{ status: string; message: string; registrationToken: string }>('/auth/verify-email-code', { email, code }),
  verifyEmailToken: (email: string, token: string) =>
    api.post<{ status: string; message: string; registrationToken: string }>('/auth/verify-email-token', { email, token }),
  login: (email: string, password: string) =>
    api.post<AuthResponse>('/auth/login', { email, password }),
  me: () => api.get<User>('/auth/me'),
  searchUsers: (q: string) =>
    api.get<User[]>(`/users/search`, { params: { q } }),
};

export const keysApi = {
  upload: (publicKey: string) => api.post('/keys/upload', { publicKey }),
  uploadBackup: (backup: { publicKey: string; encryptedPrivateKey: string; salt: string; iv: string }) =>
    api.post('/keys/backup', backup),
  getBackup: async () => {
    try {
      return await api.get<{ publicKey: string; encryptedPrivateKey: string; salt: string; iv: string }>('/keys/backup');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return null;
      throw error;
    }
  },
  getOwn: () => api.get<{ userId: string; publicKey: string }>('/keys/me'),
  me: async () => {
    try {
      return await api.get<{ userId: string; publicKey: string }>('/keys/me');
    } catch {
      return { data: { userId: '', publicKey: '' } };
    }
  },
  get: async (userId: string) => {
    try {
      return await api.get<{ userId: string; publicKey: string }>(`/keys/${userId}`);
    } catch {
      return { data: { userId, publicKey: '' } };
    }
  },
  exchange: (targetUserId: string) => api.post<{ myKey: string; targetKey: string }>('/keys/exchange', { targetUserId }),
};

// ============================================================================
// 1-10: Сообщения
// ============================================================================

export interface DisappearingMessagesRequest {
  chatId: string;
  expireAfterMinutes: number;
}

export interface MessageForwardRequest {
  messageId: string;
  targetChatId?: string;
  targetUserId?: string;
}

export interface MessageReplyRequest {
  text?: string;
  type?: "text" | "image" | "file";
  fileName?: string;
  contentType?: string;
  fileData?: string;
}

export interface SavedMessageItem {
  savedId: string;
  savedAt: string;
  message: any;
}

export interface DraftMessage {
  chatId: string;
  text: string;
}

export interface ScheduledMessage {
  id: string;
  receiverId?: string;
  groupId?: string;
  text: string;
  sendAt: string;
  status: string;
}

export interface QuickReply {
  id: string;
  title: string;
  text: string;
  emoji?: string;
}

export const messagesApi = {
  setDisappearing: (chatId: string, expireAfterMinutes: number) =>
    api.post('/messages/disappearing', { chatId, expireAfterMinutes }),
  getDisappearing: (chatId: string) =>
    api.get(`/messages/disappearing/${chatId}`),
  deleteForAll: (messageId: string) =>
    api.post(`/messages/${messageId}/delete-for-all`),
  forward: (messageId: string, targetChatId?: string, targetUserId?: string) =>
    api.post(`/messages/${messageId}/forward`, { messageId, targetChatId, targetUserId }),
  reply: (messageId: string, payload: MessageReplyRequest) =>
    api.post(`/messages/${messageId}/reply`, payload),
  saveDraft: (chatId: string, text: string) =>
    api.post('/drafts', { chatId, text }),
  getDraft: (chatId: string) => api.get<{ text: string }>(`/drafts/${chatId}`),
  saveToBookmarks: (messageId: string) =>
    api.post('/saved-messages', { messageId }),
  getSavedMessages: (limit?: number, skip?: number) =>
    api.get<{ items: SavedMessageItem[]; count: number }>('/saved-messages', { params: { limit, skip } }),
  scheduleMessage: (payload: any) => api.post('/scheduled-messages', payload),
  getScheduledMessages: () => api.get<{ items: ScheduledMessage[] }>('/scheduled-messages'),
  cancelScheduledMessage: (scheduledId: string) => api.delete(`/scheduled-messages/${scheduledId}`),
  createQuickReply: (title: string, text: string, emoji?: string) =>
    api.post('/quick-replies', { title, text, emoji }),
  getQuickReplies: () => api.get<{ items: QuickReply[] }>('/quick-replies'),
};

// ============================================================================
// 11-20: Пользователи
// ============================================================================

export interface FriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  fromUsername: string;
  createdAt: string;
}

export interface BlockedUser {
  id: string;
  blockedUserId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  blockedAt: string;
}

export const usersApi = {
  sendFriendRequest: (targetUserId: string) =>
    api.post('/friend-requests', { targetUserId }),
  getFriendRequests: () =>
    api.get<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>('/friend-requests'),
  respondFriendRequest: (requestId: string, accept: boolean) =>
    api.post(`/friend-requests/${requestId}/respond`, { accept }),
  blockUser: (targetUserId: string) =>
    api.post('/block-user', { targetUserId }),
  getBlockedUsers: () => api.get<{ blocked: BlockedUser[] }>('/blocked-users'),
  setProfileBanner: (bannerUrl: string) =>
    api.post('/profile/banner', { bannerUrl }),
  requestVerification: (reason: string) =>
    api.post('/profile/verification', { reason }),
};

// ============================================================================
// 21-30: Медиа и контент
// ============================================================================

export interface PollOption {
  text: string;
  votes: number;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  userVote?: number;
  isActive: boolean;
  createdAt: string;
}

export interface Story {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  mediaType: "image" | "video";
  mediaData: string;
  caption: string;
  createdAt: string;
  expiresAt: string;
  viewed: boolean;
}

export interface Event {
  id: string;
  title: string;
  description: string;
  eventDate: string;
  location: string;
  participants: string[];
  creatorId: string;
  createdAt: string;
}

export interface Gift {
  id: string;
  name: string;
  emoji: string;
  priceCoins: number;
  imageUrl: string;
}

export const mediaApi = {
  createPoll: (question: string, options: string[], chatId?: string, groupId?: string, channelId?: string) =>
    api.post('/polls', { question, options, chatId, groupId, channelId }),
  votePoll: (pollId: string, optionIndex: number) =>
    api.post(`/polls/${pollId}/vote`, { optionIndex }),
  getPoll: (pollId: string) => api.get<Poll>(`/polls/${pollId}`),
  createStory: (mediaType: "image" | "video", mediaData: string, caption?: string) =>
    api.post('/stories', { mediaType, mediaData, caption: caption || "" }),
  getStories: () => api.get<{ stories: Story[] }>('/stories'),
  viewStory: (storyId: string) => api.post(`/stories/${storyId}/view`),
  createEvent: (title: string, description: string, eventDate: string, location: string, participants: string[]) =>
    api.post('/events', { title, description, eventDate, location, participants }),
  getEvents: () => api.get<{ items: Event[] }>('/events'),
  sendGift: (giftId: string, targetUserId: string) =>
    api.post('/gifts/send', { giftId, targetUserId }),
  getGifts: () => api.get<{ gifts: Gift[] }>('/gifts'),
};

// ============================================================================
// 31-40: Социальные функции
// ============================================================================

export const socialApi = {
  report: (targetType: "user" | "message" | "channel" | "group", targetId: string, reason: string) =>
    api.post('/reports', { targetType, targetId, reason }),
};

// ============================================================================
// 41-50: Кастомизация
// ============================================================================

export interface UserSettings {
  theme: "light" | "dark";
  accentColor: string;
  chatBackground: string;
  fontSize: "small" | "medium" | "large";
  messageDensity: "compact" | "comfortable";
  animationsEnabled: boolean;
  pinnedChatIds: string[];
  quickActionButtons: string[];
}

export const settingsApi = {
  getSettings: () => api.get<UserSettings>('/settings'),
  saveSettings: (settings: Partial<UserSettings>) => api.post('/settings', settings),
};

// ============================================================================
// 61-70: Продвинутые (боты, подарки уже в mediaApi)
// ============================================================================

export const advancedApi = {
  addBotCommand: (botId: string, command: string, response: string) =>
    api.post(`/bots/${botId}/commands`, { command, response }),
};
