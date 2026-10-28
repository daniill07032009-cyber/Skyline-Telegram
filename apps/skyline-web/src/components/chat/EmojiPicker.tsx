import { useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

type EmojiEntry = [emoji: string, tags: string];
type EmojiCategory = { id: string; name: string; icon: string; emojis: EmojiEntry[] };

const BASE_CATEGORIES: EmojiCategory[] = [
  { id: 'smileys', name: 'Смайлы', icon: '😀', emojis: [['😀', 'улыбка smile'], ['😄', 'радость happy'], ['😂', 'смех joy'], ['🤣', 'ржака laugh'], ['😊', 'милый blush'], ['😍', 'любовь love heart eyes'], ['😘', 'поцелуй kiss'], ['🥰', 'нежность'], ['😎', 'крутой cool'], ['🤔', 'думаю think'], ['🙃', 'перевернутый upside'], ['😉', 'подмигивание wink'], ['😭', 'плачу cry'], ['😢', 'грустно sad'], ['🤯', 'взрыв mind blown'], ['🥳', 'праздник party'], ['😴', 'сплю sleep'], ['🤗', 'обнимаю hug']] },
  { id: 'gestures', name: 'Жесты', icon: '👋', emojis: [['👍', 'лайк like ok'], ['👎', 'дизлайк'], ['👌', 'окей okay'], ['✌️', 'победа victory'], ['🤞', 'скрещиваю fingers crossed'], ['👏', 'аплодисменты clap'], ['🙌', 'ура raising hands'], ['👋', 'привет hello wave'], ['🤝', 'рукопожатие deal handshake'], ['💪', 'сила strong'], ['🫶', 'сердце руки heart hands'], ['🖐️', 'ладонь five'], ['☝️', 'указатель'], ['👆', 'вверх up'], ['🤙', 'круто shaka'], ['✊', 'кулак fist']] },
  { id: 'animals', name: 'Животные', icon: '🐾', emojis: [['🐱', 'кот cat'], ['🐶', 'собака dog'], ['🐻', 'медведь bear'], ['🦊', 'лиса fox'], ['🐼', 'панда panda'], ['🐨', 'коала koala'], ['🦁', 'лев lion'], ['🐯', 'тигр tiger'], ['🐸', 'лягушка frog'], ['🐵', 'обезьяна monkey'], ['🦄', 'единорог unicorn'], ['🐝', 'пчела bee'], ['🦋', 'бабочка butterfly'], ['🐢', 'черепаха turtle'], ['🐙', 'осьминог octopus'], ['🦉', 'сова owl']] },
  { id: 'food', name: 'Еда', icon: '🍕', emojis: [['🍕', 'пицца pizza'], ['🍔', 'бургер burger'], ['🍟', 'фри fries'], ['🌮', 'тако taco'], ['🍣', 'суши sushi'], ['🍦', 'мороженое ice cream'], ['🎂', 'торт cake'], ['🍰', 'пирожное'], ['☕', 'кофе coffee'], ['🍺', 'пиво beer'], ['🍷', 'вино wine'], ['🍎', 'яблоко apple'], ['🍉', 'арбуз watermelon'], ['🍇', 'виноград grapes'], ['🥑', 'авокадо avocado'], ['🌶️', 'перец chili']] },
  { id: 'activity', name: 'Спорт и активность', icon: '⚽', emojis: [['⚽', 'футбол football'], ['🏀', 'баскетбол basketball'], ['🏈', 'американский футбол'], ['⚾', 'бейсбол'], ['🎾', 'теннис tennis'], ['🏐', 'волейбол'], ['🏓', 'пингпонг'], ['🏸', 'бадминтон'], ['🥊', 'бокс'], ['🏋️', 'качалка gym'], ['🎮', 'геймер games'], ['🎲', 'кости dice'], ['🎯', 'мишень target'], ['🎱', 'бильярд'], ['🏆', 'кубок trophy'], ['🎪', 'цирк circus']] },
  { id: 'symbols', name: 'Символы', icon: '❤️', emojis: [['❤️', 'сердце love red heart'], ['💙', 'синее сердце blue'], ['💚', 'зеленое сердце green'], ['💛', 'желтое сердце yellow'], ['💜', 'фиолетовое сердце purple'], ['🔥', 'огонь fire hot'], ['✨', 'блеск sparkles'], ['🎉', 'праздник tada party'], ['🎊', 'конфетти confetti'], ['💯', '100 сто hundred'], ['✅', 'галочка check done'], ['⭐', 'звезда star'], ['🌙', 'луна moon'], ['☀️', 'солнце sun'], ['🌈', 'радуга rainbow'], ['💤', 'сплю zzz'], ['⚡', 'молния zap'], ['🆒', 'круто cool']] },
];

const isEmojiPresentation = /\p{Emoji_Presentation}/u;
const isEmojiModifierBase = /\p{Emoji_Modifier_Base}/u;
const SKIN_TONES = ['🏻', '🏼', '🏽', '🏾', '🏿'];
const categoryForCodePoint = (cp: number): string => {
  if ((cp >= 0x1F600 && cp <= 0x1F64F) || (cp >= 0x1F910 && cp <= 0x1F92F) || (cp >= 0x1F970 && cp <= 0x1F97A) || (cp >= 0x1FAE0 && cp <= 0x1FAE8)) return 'smileys';
  if ((cp >= 0x1F440 && cp <= 0x1F450) || (cp >= 0x1F90C && cp <= 0x1F9FF) || (cp >= 0x1FAF0 && cp <= 0x1FAF8)) return 'gestures';
  if ((cp >= 0x1F400 && cp <= 0x1F43F) || (cp >= 0x1F980 && cp <= 0x1F9AE) || (cp >= 0x1FAB0 && cp <= 0x1FABB) || (cp >= 0x1FABC && cp <= 0x1FABD)) return 'animals';
  if ((cp >= 0x1F330 && cp <= 0x1F37F) || (cp >= 0x1F950 && cp <= 0x1F96F) || (cp >= 0x1F9C0 && cp <= 0x1F9CB)) return 'food';
  if ((cp >= 0x1F3A0 && cp <= 0x1F3FF) || (cp >= 0x1F680 && cp <= 0x1F6FF) || (cp >= 0x1F947 && cp <= 0x1F94F)) return 'activity';
  if ((cp >= 0x1F1E6 && cp <= 0x1F1FF)) return 'flags';
  return 'symbols';
};

const generatedEntries = new Map<string, EmojiEntry[]>();
const addGeneratedEmoji = (emoji: string, categoryId: string, tags = 'emoji symbol'): void => {
  const list = generatedEntries.get(categoryId) ?? [];
  if (!list.some(([existing]) => existing === emoji)) list.push([emoji, tags]);
  generatedEntries.set(categoryId, list);
};

// Build the full Unicode emoji set supported by the browser's Unicode tables,
// including skin-tone variants, keycaps, and regional-indicator flags.
for (let cp = 0x2300; cp <= 0x1FAFF; cp += 1) {
  const emoji = String.fromCodePoint(cp);
  if (!isEmojiPresentation.test(emoji)) continue;
  // A single regional indicator is a letter, not a complete country flag.
  // Keep regional indicators out of the generated emoji list; valid two-letter
  // flags are added explicitly from FLAG_CODES below.
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) continue;
  const categoryId = categoryForCodePoint(cp);
  addGeneratedEmoji(emoji, categoryId, `emoji ${cp.toString(16)}`);
  if (isEmojiModifierBase.test(emoji)) {
    for (const tone of SKIN_TONES) addGeneratedEmoji(emoji + tone, 'gestures', `emoji skin tone ${cp.toString(16)}`);
  }
}
// Only create real ISO 3166-1 country/territory flags. Generating every
// possible regional-indicator pair creates unsupported combinations that
// appear as two plain letters on many systems.
const FLAG_CODES = (
  'AC AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
  'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CP CR CU CV CW CX CY CZ ' +
  'DE DG DJ DK DM DO DZ EA EC EE EG EH ER ES ET EU FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
  'HK HM HN HR HT HU IC ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY ' +
  'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY ' +
  'MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM ' +
  'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK ' +
  'SL SM SN SO SR SS ST SV SX SY SZ TA TC TD TF TG TH TJ TK TL TM TN ' +
  'TO TR TT TV TW TZ UA UG UM UN US UY UZ VA VC VE VG VI VN VU WF WS ' +
  'XK YE YT ZA ZM ZW'
).split(/\s+/);
for (const code of FLAG_CODES) {
  const points = [...code].map((letter) => 0x1F1E6 + letter.charCodeAt(0) - 65);
  addGeneratedEmoji(String.fromCodePoint(...points), 'flags', `flag ${code.toLowerCase()} country region`);
}

const emojiAssetCode = (emoji: string): string =>
  Array.from(emoji, (character) => character.codePointAt(0)!)
    .filter((codePoint) => codePoint !== 0xFE0F)
    .map((codePoint) => codePoint.toString(16))
    .join('-');

const regionalIndicatorStart = 0x1F1E6;
const flagCountryCode = (emoji: string): string | null => {
  const codePoints = Array.from(emoji, (character) => character.codePointAt(0)!);
  if (codePoints.length !== 2 || codePoints.some((point) => point < regionalIndicatorStart || point > 0x1F1FF)) {
    return null;
  }
  return codePoints.map((point) => String.fromCharCode(point - regionalIndicatorStart + 97)).join('');
};

const emojiImageSource = (emoji: string): string => {
  const countryCode = flagCountryCode(emoji);
  // Country flags use country-specific assets first: platform emoji fonts often
  // render regional indicators as two letters instead of a flag.
  return countryCode
    ? `https://flagcdn.com/w40/${countryCode}.png`
    : `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${emojiAssetCode(emoji)}.svg`;
};

const handleEmojiImageError = (event: React.SyntheticEvent<HTMLImageElement>) => {
  const image = event.currentTarget;
  const countryCode = image.dataset.countryCode;
  const fallback = Number(image.dataset.fallback ?? '0');

  // Use actual image assets for flags; never fall back to platform-rendered
  // regional-indicator characters, which may appear as two letters on Windows.
  if (countryCode && fallback === 0) {
    image.dataset.fallback = '1';
    image.src = `https://cdn.jsdelivr.net/npm/country-flag-icons@1.5.15/3x2/${countryCode.toUpperCase()}.svg`;
    return;
  }
  if (countryCode && fallback === 1) {
    image.dataset.fallback = '2';
    const emoji = image.dataset.emoji ?? '';
    image.src = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${emojiAssetCode(emoji)}.svg`;
    return;
  }
  image.style.visibility = 'hidden';
};
for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '#', '*']) {
  addGeneratedEmoji(key + '\uFE0F\u20E3', 'symbols', `keycap ${key}`);
}
const CATEGORIES: EmojiCategory[] = [
  ...BASE_CATEGORIES.map((category) => ({
    ...category,
    emojis: Array.from(new Map([
      ...category.emojis,
      ...(generatedEntries.get(category.id) ?? []),
    ].map((entry) => [entry[0], entry] as const)).values()),
  })),
  { id: 'flags', name: 'Флаги', icon: '🏳️', emojis: generatedEntries.get('flags') ?? [] },
];

export default function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('skyline-recent-emojis');
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string').slice(0, 15) : [];
    } catch {
      return [];
    }
  });
  const [activeCategory, setActiveCategory] = useState('recent');
  const [categoryScrollLeft, setCategoryScrollLeft] = useState(0);
  const categoryStripRef = useRef<HTMLDivElement>(null);
  const emojiListRef = useRef<HTMLDivElement>(null);
  const categorySectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const dragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number; moved: boolean } | null>(null);

  const allEmojis = useMemo(() => {
    const unique = new Map<string, EmojiEntry>();
    for (const category of CATEGORIES) {
      for (const entry of category.emojis) unique.set(entry[0], entry);
    }
    return Array.from(unique.values());
  }, []);

  const displayedCategories = useMemo<EmojiCategory[]>(() => {
    const tagsByEmoji = new Map(allEmojis.map(([emoji, tags]) => [emoji, tags]));
    return [
      {
        id: 'recent',
        name: 'Недавние',
        icon: '🕒',
        emojis: recentEmojis.map((emoji) => [emoji, tagsByEmoji.get(emoji) ?? 'недавние emoji'] as EmojiEntry),
      },
      ...CATEGORIES,
    ];
  }, [allEmojis, recentEmojis]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allEmojis;
    return allEmojis.filter(([emoji, tags]) => emoji.includes(q) || tags.toLowerCase().includes(q));
  }, [allEmojis, query]);

  const pickEmoji = (emoji: string) => {
    setRecentEmojis((current) => {
      const next = [emoji, ...current.filter((item) => item !== emoji)].slice(0, 15);
      try {
        window.localStorage.setItem('skyline-recent-emojis', JSON.stringify(next));
      } catch {
        // Recent emoji history remains available for this picker session.
      }
      return next;
    });
    onPick(emoji);
  };

  const selectCategory = (categoryId: string) => {
    setActiveCategory(categoryId);
    const list = emojiListRef.current;
    const section = categorySectionRefs.current[categoryId];
    if (list && section) {
      list.scrollTo({ top: section.offsetTop, behavior: 'smooth' });
    }
  };

  const handleEmojiListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (query.trim()) return;

    const activationLine = event.currentTarget.getBoundingClientRect().top + 20;
    let nextCategory = displayedCategories[0]?.id ?? 'recent';

    for (const category of displayedCategories) {
      const section = categorySectionRefs.current[category.id];
      if (!section) continue;
      if (section.getBoundingClientRect().top <= activationLine) {
        nextCategory = category.id;
      } else {
        break;
      }
    }

    setActiveCategory((current) => current === nextCategory ? current : nextCategory);
  };

  const handleCategoryPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !categoryStripRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: categoryStripRef.current.scrollLeft,
      moved: false,
    };
  };

  const handleCategoryPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !categoryStripRef.current) return;
    event.preventDefault();
    const deltaX = event.clientX - drag.startX;
    if (Math.abs(deltaX) > 3) drag.moved = true;
    categoryStripRef.current.scrollLeft = drag.startScrollLeft - deltaX;
  };

  const stopCategoryDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const categoryMaxScroll = categoryStripRef.current
    ? Math.max(0, categoryStripRef.current.scrollWidth - categoryStripRef.current.clientWidth)
    : 0;
  const categoryProgress = categoryMaxScroll > 0
    ? Math.min(100, Math.round((categoryScrollLeft / categoryMaxScroll) * 100))
    : 100;

  return (
    <div className="glass-panel w-[min(25rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl shadow-black/40 backdrop-blur-2xl animate-scale-in" data-emoji-picker>
      <div className="flex items-center gap-2 border-b border-white/[0.08] bg-white/[0.025] px-3 py-3">
        <Search size={14} className="shrink-0 text-t-secondary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск эмодзи"
          className="min-w-0 flex-1 bg-transparent text-sm text-t-primary placeholder-slate-500 focus:outline-none"
        />
        <button type="button" onClick={onClose} aria-label="Закрыть" className="grid h-8 w-8 place-items-center rounded-lg text-t-secondary transition hover:bg-white/10">
          <X size={14} />
        </button>
      </div>
      {!query.trim() && (
        <div className="border-b border-white/[0.08] px-2 pt-2">
          <div
            ref={categoryStripRef}
            onScroll={(event) => setCategoryScrollLeft(event.currentTarget.scrollLeft)}
            onPointerDown={handleCategoryPointerDown}
            onPointerMove={handleCategoryPointerMove}
            onPointerUp={stopCategoryDrag}
            onPointerCancel={stopCategoryDrag}
            onLostPointerCapture={() => { dragRef.current = null; }}
            onAuxClick={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            className={`custom-scrollbar flex gap-1.5 overflow-x-auto overflow-y-hidden pb-2 select-none ${dragRef.current ? 'cursor-grabbing' : 'cursor-grab'}`}
            aria-label="Категории эмодзи. Зажмите среднюю кнопку мыши и двигайте мышь для прокрутки"
            role="tablist"
          >
            {displayedCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                role="tab"
                aria-selected={activeCategory === category.id}
                aria-label={category.name}
                title={category.name}
                onClick={() => selectCategory(category.id)}
                className={`grid h-9 w-10 shrink-0 place-items-center rounded-lg text-lg transition-colors ${activeCategory === category.id ? 'bg-accent/20 text-accent' : 'text-t-secondary hover:bg-white/[0.08] hover:text-t-primary'}`}
              >
                <span aria-hidden="true" className="h-5 w-5 bg-current" style={{ maskImage: `url(/emoji-category-icons/${emojiAssetCode(category.icon)}.svg)`, WebkitMaskImage: `url(/emoji-category-icons/${emojiAssetCode(category.icon)}.svg)`, maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center", maskSize: "contain", WebkitMaskSize: "contain" }} />
              </button>
            ))}
          </div>
          <div className="mb-1 h-0.5 overflow-hidden rounded-full bg-white/[0.07]" aria-hidden="true">
            <div className="h-full rounded-full bg-accent/70 transition-[width] duration-100" style={{ width: categoryMaxScroll > 0 ? '24%' : '100%', marginLeft: categoryMaxScroll > 0 ? `calc(${categoryProgress * 0.76}%)` : '0' }} />
          </div>
        </div>
      )}
      {query.trim() && (
        <div className="border-b border-white/[0.08] px-3 py-2 text-[11px] text-t-secondary">
          Результаты поиска: {filtered.length}
        </div>
      )}
      <div ref={emojiListRef} onScroll={handleEmojiListScroll} className="custom-scrollbar max-h-60 overflow-y-auto p-2.5" aria-label={query.trim() ? 'Результаты поиска эмодзи' : 'Все эмодзи по категориям'}>
        {query.trim() ? (
          <div className="grid grid-cols-8 gap-1" role="list">
            {filtered.map(([emoji, tags]) => (
              <button
                key={emoji}
                type="button"
                role="listitem"
                onClick={() => pickEmoji(emoji)}
                aria-label={tags || emoji}
                title={tags || emoji}
                className="grid h-10 w-10 place-items-center rounded-xl transition-colors duration-150 hover:bg-white/[0.09] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <img src={emojiImageSource(emoji)} data-emoji={emoji} data-country-code={flagCountryCode(emoji) ?? undefined} alt="" aria-hidden="true" onError={handleEmojiImageError} draggable={false} loading="lazy" className="h-[1.45rem] w-[1.45rem] object-contain" />
              </button>
            ))}
            {!filtered.length && <p className="col-span-8 py-4 text-center text-xs text-t-secondary">Ничего не найдено</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {displayedCategories.map((category) => (
              <section key={category.id} ref={(node) => { categorySectionRefs.current[category.id] = node; }} aria-label={category.name}>
                <h3 className="mb-1.5 px-1 text-base" aria-label={category.name} title={category.name}>{category.name}</h3>
                <div className="grid grid-cols-8 gap-1" role="list">
                  {category.emojis.length ? category.emojis.map(([emoji, tags]) => (
                    <button
                      key={emoji}
                      type="button"
                      role="listitem"
                      onClick={() => pickEmoji(emoji)}
                      aria-label={tags || emoji}
                      title={tags || emoji}
                      className="grid h-10 w-10 place-items-center rounded-xl transition-colors duration-150 hover:bg-white/[0.09] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <img src={emojiImageSource(emoji)} data-emoji={emoji} data-country-code={flagCountryCode(emoji) ?? undefined} alt="" aria-hidden="true" onError={handleEmojiImageError} draggable={false} loading="lazy" className="h-[1.45rem] w-[1.45rem] object-contain" />
                    </button>
                  )) : <p className="col-span-8 px-1 py-2 text-xs text-t-secondary">Здесь появятся 15 последних использованных эмодзи</p>}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.08] px-3 py-2 text-[10px] text-t-secondary">
        <span>{query.trim() ? 'Ищите по названию или ключевому слову' : 'Категории — переходы по общему списку'}</span>
        <span>{filtered.length} эмодзи</span>
      </div>
    </div>
  );
}
