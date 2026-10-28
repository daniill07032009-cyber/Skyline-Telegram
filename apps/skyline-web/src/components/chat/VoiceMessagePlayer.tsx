import { useEffect, useRef, useState } from 'react';
import { AudioLines, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';

interface VoiceMessagePlayerProps {
  src: string;
  fileName?: string;
  mine?: boolean;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const WAVEFORM = [7,12,17,9,22,14,8,26,16,11,20,29,13,8,23,32,17,12,25,16,8,20,30,13,24,35,18,10,27,16,8,21,31,14,24,12,28,17,9,21,33,16,11,25,18,8,22,14,29,17,9,23,14,7];

/** Compact Telegram-inspired voice-note player with a seekable waveform. */
export default function VoiceMessagePlayer({ src, fileName, mine = false }: VoiceMessagePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [failed, setFailed] = useState(false);
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);

  /* oxlint-disable react-hooks/set-state-in-effect -- Reset playback state when the media source changes. */
  useEffect(() => {
    setPlaying(false);
    setDuration(0);
    setCurrentTime(0);
    setFailed(false);
    setSpeed(1);
  }, [src]);
  /* oxlint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    if (audio.paused) {
      try { await audio.play(); } catch { setFailed(true); }
    } else audio.pause();
  };

  const seekBy = (delta: number) => {
    const audio = audioRef.current;
    if (!audio || !duration || failed) return;
    const next = Math.max(0, Math.min(duration, audio.currentTime + delta));
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const title = failed ? 'Аудио недоступно' : fileName?.startsWith('voice-message') || !fileName ? 'Голосовое сообщение' : fileName;

  return (
    <div className={`my-1 w-full min-w-[220px] max-w-[340px] rounded-[18px] px-3 py-2.5 transition-colors ${mine ? 'bg-white/[0.10]' : 'bg-slate-950/45'}`}>
      <audio key={src} ref={audioRef} src={src} preload="metadata"
        onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentTime(0); if (audioRef.current) audioRef.current.currentTime = 0; }}
        onError={() => setFailed(true)} className="hidden" />
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void togglePlayback()} disabled={failed}
          aria-label={playing ? 'Приостановить голосовое сообщение' : 'Воспроизвести голосовое сообщение'}
          title={playing ? 'Пауза' : 'Воспроизвести'}
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-full shadow-md transition duration-200 hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${mine ? 'bg-white text-slate-950' : 'bg-accent text-white'}`}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <AudioLines size={14} className={`shrink-0 ${mine ? 'text-white/75' : 'text-accent'}`} />
            <span className="truncate text-xs font-semibold text-t-primary">{title}</span>
          </div>
          <div className="relative mt-1.5 flex h-7 items-center gap-[2px]" aria-label="Волновая форма аудио">
            {WAVEFORM.map((height, index) => {
              const played = (index / WAVEFORM.length) * 100 <= progress;
              return <span key={index} className={`min-w-[2px] flex-1 rounded-full transition-colors duration-100 ${played ? (mine ? 'bg-white' : 'bg-accent') : 'bg-current opacity-25'}`} style={{ height: `${height}px` }} />;
            })}
            <input type="range" min={0} max={duration || 1} step={0.1} value={Math.min(currentTime, duration || 0)} disabled={!duration || failed}
              onChange={(event) => { const next = Number(event.target.value); if (audioRef.current) audioRef.current.currentTime = next; setCurrentTime(next); }}
              aria-label="Позиция воспроизведения" title="Переместиться по голосовому сообщению"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-[0.015] disabled:cursor-default" />
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-t-secondary">
            <span className="font-mono tabular-nums">{formatDuration(currentTime)} / {formatDuration(duration)}</span>
            <button type="button" onClick={() => setSpeed((value) => value === 1 ? 1.5 : value === 1.5 ? 2 : 1)} disabled={failed}
              aria-label="Изменить скорость воспроизведения" title="Скорость воспроизведения"
              className={`rounded-full px-2 py-0.5 font-bold transition hover:bg-white/[0.08] disabled:opacity-30 ${mine ? 'text-white/80' : 'text-accent'}`}>{speed}×</button>
          </div>
        </div>
      </div>
      <div className="mt-1 flex justify-end gap-1">
        <button type="button" onClick={() => seekBy(-10)} disabled={!duration || failed} aria-label="Назад на 10 секунд" title="Назад на 10 секунд" className="rounded-lg px-2 py-1 text-[10px] text-t-secondary transition hover:bg-white/[0.07] hover:text-t-primary disabled:opacity-30"><RotateCcw size={12} /></button>
        <button type="button" onClick={() => seekBy(10)} disabled={!duration || failed} aria-label="Вперёд на 10 секунд" title="Вперёд на 10 секунд" className="rounded-lg px-2 py-1 text-[10px] text-t-secondary transition hover:bg-white/[0.07] hover:text-t-primary disabled:opacity-30"><RotateCw size={12} /></button>
      </div>
    </div>
  );
}
