/* oxlint-disable react/only-export-components -- Context modules intentionally export the provider and its hook together. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Mic, MicOff, Minus, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { getSocket } from '../api/socket';
import Avatar from '../components/ui/Avatar';
import { useAuth } from './AuthContext';
import { useToast } from './useToast';

type CallPhase = 'incoming' | 'outgoing' | 'connecting' | 'active';
interface CallState {
  id: string;
  peerId: string;
  peerName: string;
  peerAvatarUrl?: string;
  video: boolean;
  phase: CallPhase;
  initiator: boolean;
}
interface CallActions {
  startCall: (peer: { id: string; name: string; avatarUrl?: string }, video: boolean) => void;
}

const CallContext = createContext<CallActions | null>(null);

export function useCallActions() {
  const value = useContext(CallContext);
  if (!value) throw new Error('useCallActions must be used inside CallProvider');
  return value;
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const showToast = useToast();
  const [call, setCall] = useState<CallState | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const callRef = useRef<CallState | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    peerConnectionRef.current?.close();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const updateCall = useCallback((value: CallState | null) => {
    callRef.current = value;
    setCall(value);
  }, []);

  const closeMedia = useCallback(() => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    pendingCandidatesRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setMuted(false);
    setCameraOff(false);
    updateCall(null);
    setMinimized(false);
  }, [updateCall]);

  const sendSignal = useCallback((state: CallState, signal: Record<string, unknown>) => {
    getSocket()?.emit('call_signal', { callId: state.id, signal });
  }, []);

  const createPeerConnection = useCallback((state: CallState, stream: MediaStream) => {
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    peerConnectionRef.current = connection;
    stream.getTracks().forEach((track) => connection.addTrack(track, stream));
    connection.onicecandidate = (event) => {
      if (event.candidate) sendSignal(state, { candidate: event.candidate.toJSON() });
    };
    connection.ontrack = (event) => {
      const incoming = event.streams[0];
      if (incoming) {
        remoteStreamRef.current = incoming;
        setRemoteStream(incoming);
      }
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') updateCall({ ...state, phase: 'active' });
      if (connection.connectionState === 'failed') {
        showToast('Не удалось установить связь. Попробуйте ещё раз.', 'error');
        getSocket()?.emit('call_end', { callId: state.id });
        closeMedia();
      }
    };
    return connection;
  }, [closeMedia, sendSignal, showToast, updateCall]);

  const beginLocalMedia = useCallback(async (state: CallState) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не поддерживает доступ к микрофону и камере.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: state.video });
    if (callRef.current?.id !== state.id) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Звонок уже завершён.');
    }
    localStreamRef.current = stream;
    setLocalStream(stream);
    return createPeerConnection(state, stream);
  }, [createPeerConnection]);

  const startCall = useCallback((peer: { id: string; name: string; avatarUrl?: string }, video: boolean) => {
    if (!user?.id) return;
    const socket = getSocket();
    if (!socket?.connected) {
      showToast('Нет соединения для звонка. Попробуйте после переподключения.', 'error');
      return;
    }
    if (callRef.current) {
      showToast('Сначала завершите текущий звонок.', 'info');
      return;
    }
    const state: CallState = {
      id: crypto.randomUUID(),
      peerId: peer.id,
      peerName: peer.name,
      peerAvatarUrl: peer.avatarUrl,
      video,
      phase: 'outgoing',
      initiator: true,
    };
    updateCall(state);
    socket.emit('call_invite', { callId: state.id, targetUserId: state.peerId, video }, (response: { status?: string; error?: string }) => {
      if (response?.status !== 'ok' && callRef.current?.id === state.id) {
        showToast(response?.error || 'Не удалось начать звонок.', 'error');
        closeMedia();
      }
    });
    timeoutRef.current = window.setTimeout(() => {
      if (callRef.current?.id === state.id && callRef.current.phase === 'outgoing') {
        showToast('Нет ответа. Звонок завершён.', 'info');
        socket.emit('call_end', { callId: state.id });
        closeMedia();
      }
    }, 45_000);
  }, [closeMedia, showToast, updateCall, user?.id]);

  const acceptCall = useCallback(async () => {
    const state = callRef.current;
    if (!state || state.phase !== 'incoming') return;
    try {
      await beginLocalMedia({ ...state, phase: 'connecting' });
      updateCall({ ...state, phase: 'connecting' });
      getSocket()?.emit('call_accept', { callId: state.id });
      timeoutRef.current = window.setTimeout(() => {
        if (callRef.current?.id === state.id && callRef.current.phase === 'connecting') {
          showToast('Вызов не подключился. Попробуйте ещё раз.', 'error');
          getSocket()?.emit('call_end', { callId: state.id });
          closeMedia();
        }
      }, 45_000);
    } catch (error) {
      getSocket()?.emit('call_decline', { callId: state.id });
      showToast(error instanceof Error ? error.message : 'Не удалось включить микрофон или камеру.', 'error');
      closeMedia();
    }
  }, [beginLocalMedia, closeMedia, showToast, updateCall]);

  const endCall = useCallback((decline = false) => {
    const state = callRef.current;
    if (state) getSocket()?.emit(decline ? 'call_decline' : 'call_end', { callId: state.id });
    closeMedia();
  }, [closeMedia]);

  useEffect(() => {
    if (!user?.id && callRef.current) endCall();
  }, [endCall, user?.id]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !user?.id) return;
    const onIncoming = (event: { callId: string; callerId: string; callerName?: string; callerAvatarUrl?: string; video?: boolean }) => {
      if (callRef.current) {
        socket.emit('call_decline', { callId: event.callId });
        return;
      }
      updateCall({
        id: event.callId,
        peerId: event.callerId,
        peerName: event.callerName || 'Пользователь',
        peerAvatarUrl: event.callerAvatarUrl,
        video: Boolean(event.video),
        phase: 'incoming',
        initiator: false,
      });
      setMinimized(false);
    };
    const onAccepted = async (event: { callId: string }) => {
      const state = callRef.current;
      if (!state || state.id !== event.callId || !state.initiator) return;
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      try {
        const connecting = { ...state, phase: 'connecting' as const };
        const connection = await beginLocalMedia(connecting);
        updateCall(connecting);
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        sendSignal(connecting, { description: connection.localDescription?.toJSON() });
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Не удалось включить микрофон или камеру.', 'error');
        socket.emit('call_end', { callId: state.id });
        closeMedia();
      }
    };
    const onSignal = async (event: { callId: string; signal?: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
      const state = callRef.current;
      const connection = peerConnectionRef.current;
      const signal = event.signal;
      if (!state || state.id !== event.callId || !connection || !signal) return;
      try {
        if (signal.description) {
          await connection.setRemoteDescription(signal.description);
          for (const candidate of pendingCandidatesRef.current.splice(0)) await connection.addIceCandidate(candidate);
          if (signal.description.type === 'offer' && !state.initiator) {
            const answer = await connection.createAnswer();
            await connection.setLocalDescription(answer);
            sendSignal(state, { description: connection.localDescription?.toJSON() });
          }
        } else if (signal.candidate) {
          if (connection.remoteDescription) await connection.addIceCandidate(signal.candidate);
          else pendingCandidatesRef.current.push(signal.candidate);
        }
      } catch (error) {
        console.error('WebRTC signaling failed:', error);
        showToast('Ошибка установления соединения. Завершите звонок и попробуйте снова.', 'error');
      }
    };
    const onDeclined = (event: { callId: string }) => {
      if (callRef.current?.id !== event.callId) return;
      showToast('Собеседник отклонил звонок.', 'info');
      closeMedia();
    };
    const onUnavailable = (event: { callId: string }) => {
      if (callRef.current?.id !== event.callId) return;
      showToast('Вызов уже принят в другом окне Skyline.', 'info');
      closeMedia();
    };
    const onEnded = (event: { callId: string }) => {
      if (callRef.current?.id !== event.callId) return;
      closeMedia();
    };
    socket.on('call_incoming', onIncoming);
    socket.on('call_accepted', onAccepted);
    socket.on('call_signal', onSignal);
    socket.on('call_declined', onDeclined);
    socket.on('call_unavailable', onUnavailable);
    socket.on('call_ended', onEnded);
    return () => {
      socket.off('call_incoming', onIncoming);
      socket.off('call_accepted', onAccepted);
      socket.off('call_signal', onSignal);
      socket.off('call_declined', onDeclined);
      socket.off('call_unavailable', onUnavailable);
      socket.off('call_ended', onEnded);
    };
  }, [beginLocalMedia, closeMedia, sendSignal, showToast, updateCall, user?.id]);

  const toggleMuted = () => {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
  };
  const toggleCamera = () => {
    const next = !cameraOff;
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = !next; });
    setCameraOff(next);
  };

  return (
    <CallContext.Provider value={{ startCall }}>
      {children}
      {call && minimized && <div className="fixed bottom-4 right-4 z-[220] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-white/10 bg-panel p-3 shadow-2xl">
        <Avatar src={call.peerAvatarUrl} name={call.peerName} size={42} />
        <button type="button" onClick={() => setMinimized(false)} className="min-w-0 text-left" aria-label="Вернуться к звонку">
          <span className="block truncate text-sm font-semibold text-t-primary">{call.peerName}</span>
          <span className="block text-xs text-t-secondary">{call.phase === 'active' ? 'На связи · Вернуться' : call.phase === 'incoming' ? 'Входящий вызов · Открыть' : 'Звонок · Вернуться'}</span>
        </button>
        <button type="button" onClick={() => endCall()} aria-label="Завершить звонок" title="Завершить звонок" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-600 text-white hover:bg-rose-500"><PhoneOff size={17} /></button>
      </div>}
      {call && !minimized && <div className="fixed inset-0 z-[220] grid place-items-center bg-black/75 p-4 backdrop-blur-sm">
        <section role="dialog" aria-modal="true" aria-labelledby="skyline-call-title" className="w-full max-w-xl overflow-hidden rounded-3xl border border-white/10 bg-panel shadow-2xl">
          <header className="flex items-center justify-between border-b border-white/10 px-5 py-4"><div className="flex min-w-0 items-center gap-3"><Avatar src={call.peerAvatarUrl} name={call.peerName} size={44} /><div className="min-w-0"><h2 id="skyline-call-title" className="truncate text-sm font-semibold">{call.video ? 'Видеозвонок' : 'Голосовой звонок'}</h2><p className="mt-1 truncate text-xs text-t-secondary">{call.peerName} · {call.phase === 'incoming' ? 'Входящий вызов' : call.phase === 'outgoing' ? 'Вызов…' : call.phase === 'active' ? 'На связи' : 'Подключение…'}</p></div></div><button type="button" onClick={() => setMinimized(true)} aria-label="Свернуть окно звонка" title="Свернуть звонок, разговор продолжится" className="ml-3 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-t-secondary hover:bg-white/10 hover:text-t-primary"><Minus size={18} /></button></header>
          {call.video && <div className="relative grid aspect-video place-items-center bg-slate-950"><video className="h-full max-h-[55vh] w-full object-contain" autoPlay playsInline ref={(element) => { if (element && remoteStream) element.srcObject = remoteStream; }} />{!remoteStream && <span className="absolute text-xs text-slate-500">Ожидаем видео…</span>}<video muted className="absolute bottom-3 right-3 aspect-video w-28 rounded-xl border border-white/20 bg-slate-900 object-cover" autoPlay playsInline ref={(element) => { if (element && localStream) element.srcObject = localStream; }} />{cameraOff && <span className="absolute bottom-3 right-3 grid aspect-video w-28 place-items-center rounded-xl bg-slate-800 text-slate-400"><VideoOff size={18} /></span>}</div>}
          {!call.video && <div className="flex flex-col items-center gap-3 px-4 pt-7"><Avatar src={call.peerAvatarUrl} name={call.peerName} size={104} className="rounded-full ring-4 ring-white/10 [&>img]:!rounded-full [&>span]:!rounded-full" /><p className="text-sm font-medium text-t-primary">{call.peerName}</p></div>}
          {!call.video && remoteStream && <audio autoPlay ref={(element) => { if (element && remoteStream) element.srcObject = remoteStream; }} />}
          <div className="flex items-center justify-center gap-3 p-5">
            {call.phase === 'incoming' ? <><button type="button" onClick={() => void acceptCall()} className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-500"><Phone size={17} /> Ответить</button><button type="button" onClick={() => endCall(true)} className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-rose-600 px-5 text-sm font-semibold text-white hover:bg-rose-500"><PhoneOff size={17} /> Отклонить</button></> : <>
              {call.phase === 'active' && <><button type="button" onClick={toggleMuted} aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'} className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 text-t-primary hover:bg-white/10">{muted ? <MicOff size={18} /> : <Mic size={18} />}</button>{call.video && <button type="button" onClick={toggleCamera} aria-label={cameraOff ? 'Включить камеру' : 'Выключить камеру'} className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 text-t-primary hover:bg-white/10">{cameraOff ? <VideoOff size={18} /> : <Video size={18} />}</button>}</>}
              <button type="button" onClick={() => endCall()} className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-rose-600 px-5 text-sm font-semibold text-white hover:bg-rose-500"><PhoneOff size={17} /> Завершить</button>
            </>}
          </div>
        </section>
      </div>}
    </CallContext.Provider>
  );
}
