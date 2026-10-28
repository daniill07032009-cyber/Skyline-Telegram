export const APP_THEMES = [
  { id: 'skyline', name: 'Skyline', desc: 'Индиго → изумруд (по умолчанию)' },
  { id: 'cyber', name: 'Киберпанк', desc: 'Неоновый циан → фиолетовый' },
  { id: 'cosmos', name: 'Космос', desc: 'Глубокий фиолет → розовый' },
  { id: 'sakura', name: 'Сакура', desc: 'Нежно-розовый' },
  { id: 'midnight', name: 'Полночь', desc: 'Тёмно-синий → голубой' },
  { id: 'ocean', name: 'Океан', desc: 'Бирюзово-глубокий' },
  { id: 'sunset', name: 'Закат', desc: 'Оранжево-красный' },
  { id: 'forest', name: 'Лес', desc: 'Глубокая зелень' },
  { id: 'royal', name: 'Роскошь', desc: 'Золотой градиент' },
  { id: 'rose', name: 'Роза', desc: 'Тёплый розово-рубиновый' },
  { id: 'violet', name: 'Фиалка', desc: 'Светло-фиолетовый' },
  { id: 'mono', name: 'Монохром', desc: 'Строгий серый' },
  { id: 'matrix', name: 'Матрица', desc: 'Неоновая зелень' },
  { id: 'arctic', name: 'Арктика', desc: 'Ледяной голубой' },
  { id: 'mocha', name: 'Мокко', desc: 'Тёплый кофейный' },
  { id: 'aurora', name: 'Северное сияние', desc: 'Бирюза и небесный фиолет' },
  { id: 'lagoon', name: 'Лагуна', desc: 'Свежий морской бриз' },
  { id: 'crimson', name: 'Рубин', desc: 'Глубокий красный и гранат' },
  { id: 'candy', name: 'Конфета', desc: 'Яркая фуксия и голубой' },
  { id: 'cobalt', name: 'Кобальт', desc: 'Насыщенный синий и лёд' },
  { id: 'copper', name: 'Медь', desc: 'Тёплая медь и песок' },
  { id: 'lavender', name: 'Лавандовое поле', desc: 'Спокойный сиреневый' },
  { id: 'glacier', name: 'Ледник', desc: 'Холодная бирюза и индиго' },
  { id: 'ember', name: 'Уголь и пламя', desc: 'Контрастный огненный акцент' },
  { id: 'jade', name: 'Нефрит', desc: 'Глубокий зелёный и мята' },
  { id: 'orchid', name: 'Орхидея', desc: 'Пурпурный и розовый' },
  { id: 'sand', name: 'Песчаный берег', desc: 'Мягкие янтарные оттенки' },
] as const;
export type AppTheme = typeof APP_THEMES[number]['id'];

export const CHAT_STYLE_DEFAULTS = {
  text: '#f8fafc',
  border: '#475569',
  ownMessage: '#4f46e5',
  otherMessage: '#1e293b',
} as const;

export type WallpaperFit = 'cover' | 'contain' | 'repeat';

const WALLPAPER_DB = 'skyline-preferences';
const WALLPAPER_STORE = 'images';
const WALLPAPER_KEY = 'chat-wallpaper';
let wallpaperObjectUrl: string | null = null;
let wallpaperApplyRevision = 0;
let wallpaperPaletteCache: { url: string; rgb: [number, number, number] } | null = null;

function wallpaperColor(url: string): Promise<[number, number, number] | null> {
  if (wallpaperPaletteCache?.url === url) return Promise.resolve(wallpaperPaletteCache.rgb);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 48;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const buckets = new Map<string, { score: number; rgb: [number, number, number] }>();
        for (let index = 0; index < pixels.length; index += 16) {
          const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const saturation = max === 0 ? 0 : (max - min) / max;
          const luminance = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
          if (luminance < 0.06 || luminance > 0.96) continue;
          const key = `${r >> 5},${g >> 5},${b >> 5}`;
          const score = 0.4 + saturation;
          const bucket = buckets.get(key);
          if (bucket) bucket.score += score;
          else buckets.set(key, { score, rgb: [r, g, b] });
        }
        const dominant = [...buckets.values()].sort((a, b) => b.score - a.score)[0]?.rgb;
        if (dominant) wallpaperPaletteCache = { url, rgb: dominant };
        resolve(dominant || null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function hsl(h: number, s: number, l: number) {
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${Math.round(hue)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

function setWallpaperPalette(root: HTMLElement, rgb: [number, number, number] | null) {
  const properties = ['--bg-base', '--panel', '--text-primary', '--text-secondary', '--accent', '--accent-from', '--accent-to', '--accent-rgb', '--border-subtle', '--glow', '--chat-text-color', '--chat-border-color', '--chat-own-message-color', '--chat-other-message-color'];
  if (!rgb) {
    root.dataset.wallpaperTheme = 'false';
    properties.forEach((property) => root.style.removeProperty(property));
    applyChatColorPreferences(root);
    return;
  }

  const [r, g, b] = rgb;
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r / 255) hue = 60 * (((g - b) / 255 / delta) % 6);
    else if (max === g / 255) hue = 60 * ((b - r) / 255 / delta + 2);
    else hue = 60 * ((r - g) / 255 / delta + 4);
  }
  const saturation = Math.max(38, Math.min(78, max ? delta / max * 100 : 48));
  const isLight = root.dataset.theme === 'light';
  const accent = hsl(hue, saturation, isLight ? 43 : 68);
  const accentFrom = hsl(hue, saturation, isLight ? 43 : 59);
  const accentTo = hsl(hue + 34, saturation, isLight ? 48 : 67);
  const accentRgb = ` ${r}, ${g}, ${b} `;
  const values: Record<string, string> = {
    '--bg-base': hsl(hue, Math.min(38, saturation * 0.48), isLight ? 97 : 8),
    '--panel': hsl(hue, Math.min(34, saturation * 0.4), isLight ? 100 : 13),
    '--text-primary': isLight ? '#172033' : '#f8fafc',
    '--text-secondary': isLight ? hsl(hue, 18, 38) : hsl(hue, 18, 70),
    '--accent': accent,
    '--accent-from': accentFrom,
    '--accent-to': accentTo,
    '--accent-rgb': accentRgb,
    '--border-subtle': isLight ? hsl(hue, 24, 85) : hsl(hue, 22, 30),
    '--glow': `rgba(${r}, ${g}, ${b}, ${isLight ? 0.17 : 0.3})`,
    '--chat-text-color': isLight ? '#172033' : '#f8fafc',
    '--chat-border-color': hsl(hue, saturation, isLight ? 72 : 43),
    '--chat-own-message-color': hsl(hue, saturation, isLight ? 83 : 43),
    '--chat-other-message-color': hsl(hue + 28, Math.max(20, saturation - 12), isLight ? 94 : 24),
  };
  Object.entries(values).forEach(([property, value]) => root.style.setProperty(property, value));
  root.dataset.wallpaperTheme = 'true';
}

function applyChatColorPreferences(root: HTMLElement) {
  root.style.setProperty('--chat-text-color', readColorPreference('skylineChatTextColor', CHAT_STYLE_DEFAULTS.text));
  root.style.setProperty('--chat-border-color', readColorPreference('skylineChatBorderColor', CHAT_STYLE_DEFAULTS.border));
  root.style.setProperty('--chat-own-message-color', readColorPreference('skylineChatOwnMessageColor', CHAT_STYLE_DEFAULTS.ownMessage));
  root.style.setProperty('--chat-other-message-color', readColorPreference('skylineChatOtherMessageColor', CHAT_STYLE_DEFAULTS.otherMessage));
}

function openWallpaperDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WALLPAPER_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(WALLPAPER_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Не удалось открыть хранилище обоев.'));
  });
}

function writeWallpaperBlob(db: IDBDatabase, blob: Blob | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(WALLPAPER_STORE, 'readwrite');
    const store = transaction.objectStore(WALLPAPER_STORE);
    if (blob) store.put(blob, WALLPAPER_KEY);
    else store.delete(WALLPAPER_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Не удалось сохранить обои.'));
    transaction.onabort = () => reject(transaction.error || new Error('Сохранение обоев отменено.'));
  });
}

export async function storeChatWallpaper(file: Blob | null): Promise<string> {
  const db = await openWallpaperDatabase();
  try {
    await writeWallpaperBlob(db, file);
  } finally {
    db.close();
  }

  localStorage.removeItem('skylineChatWallpaper');
  if (wallpaperObjectUrl) URL.revokeObjectURL(wallpaperObjectUrl);
  wallpaperObjectUrl = file ? URL.createObjectURL(file) : null;
  wallpaperPaletteCache = null;
  wallpaperApplyRevision += 1;
  return wallpaperObjectUrl || '';
}

export async function getStoredChatWallpaperUrl(): Promise<string> {
  if (wallpaperObjectUrl) return wallpaperObjectUrl;
  try {
    const db = await openWallpaperDatabase();
    let blob: Blob | undefined;
    try {
      blob = await new Promise<Blob | undefined>((resolve, reject) => {
        const request = db.transaction(WALLPAPER_STORE, 'readonly').objectStore(WALLPAPER_STORE).get(WALLPAPER_KEY);
        request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : undefined);
        request.onerror = () => reject(request.error || new Error('Не удалось загрузить обои.'));
      });
    } finally {
      db.close();
    }
    if (blob) {
      wallpaperObjectUrl = URL.createObjectURL(blob);
      return wallpaperObjectUrl;
    }
  } catch (error) {
    console.warn('Не удалось прочитать обои чата из локального хранилища:', error);
  }

  const legacyWallpaper = localStorage.getItem('skylineChatWallpaper') || '';
  return legacyWallpaper.length <= 7_000_000
    && /^data:image\/(?:png|jpeg|webp|gif);base64,[\da-z+/]+=*$/i.test(legacyWallpaper)
    ? legacyWallpaper
    : '';
}

function readColorPreference(key: string, fallback: string) {
  const value = localStorage.getItem(key);
  return value && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
}

function applyChatPreferences(root: HTMLElement) {
  applyChatColorPreferences(root);

  const fit = localStorage.getItem('skylineChatWallpaperFit');
  const wallpaperFit: WallpaperFit = fit === 'contain' || fit === 'repeat' ? fit : 'cover';
  const revision = ++wallpaperApplyRevision;
  root.style.setProperty('--chat-wallpaper-image', 'none');
  root.style.setProperty('--chat-wallpaper-shade', 'transparent');
  root.style.setProperty('--chat-wallpaper-size', wallpaperFit === 'repeat' ? '180px auto' : wallpaperFit);
  root.style.setProperty('--chat-wallpaper-repeat', wallpaperFit === 'repeat' ? 'repeat' : 'no-repeat');
  void getStoredChatWallpaperUrl().then(async (wallpaper) => {
    if (revision !== wallpaperApplyRevision || !root.isConnected) return;
    const palette = wallpaper ? await wallpaperColor(wallpaper) : null;
    if (revision !== wallpaperApplyRevision || !root.isConnected) return;
    setWallpaperPalette(root, palette);
    root.style.setProperty('--chat-wallpaper-image', wallpaper ? `url("${wallpaper}")` : 'none');
    const wallpaperShade = root.dataset.theme === 'light' ? 'rgba(255, 255, 255, 0.32)' : 'rgba(4, 8, 16, 0.38)';
    root.style.setProperty('--chat-wallpaper-shade', wallpaper ? wallpaperShade : 'transparent');
  });
}

export function applyAppPreferences(isPremium = false) {
  const root = document.documentElement;
  root.dataset.theme = localStorage.getItem('skylineTheme') === 'light' ? 'light' : 'dark';
  const appTheme = localStorage.getItem('skylineAppTheme');
  root.dataset.appTheme = APP_THEMES.some((t) => t.id === appTheme) ? appTheme! : 'skyline';
  const premiumTheme = localStorage.getItem('skylinePremiumTheme');
  root.dataset.premiumTheme = isPremium && ['cyber', 'cosmos', 'sakura'].includes(premiumTheme || '')
    ? premiumTheme!
    : 'default';
  root.dataset.compact = localStorage.getItem('skylineCompactMode') === 'true' ? 'true' : 'false';
  root.dataset.reduceMotion = localStorage.getItem('skylineReduceMotion') === 'true' ? 'true' : 'false';
  const messageSize = localStorage.getItem('skylineMessageSize');
  root.dataset.messageSize = messageSize === 'small' || messageSize === 'large' ? messageSize : 'medium';
  const bubbleStyle = localStorage.getItem('skylineChatBubbleStyle');
  root.dataset.chatBubbleStyle = bubbleStyle === 'outlined' || bubbleStyle === 'glass' || bubbleStyle === 'none' ? bubbleStyle : 'soft';
  const textStyle = localStorage.getItem('skylineChatTextStyle');
  root.dataset.chatTextStyle = textStyle === 'glow' || textStyle === 'bold' ? textStyle : 'normal';
  applyChatPreferences(root);
  root.style.colorScheme = root.dataset.theme;
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = root.dataset.theme === 'light' ? '#f3f6fb' : '#090d16';
}
