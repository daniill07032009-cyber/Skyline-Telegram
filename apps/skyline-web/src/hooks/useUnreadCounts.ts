import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { getSocket } from '../api/socket';

export interface UnreadCounts {
  chats: number;
  groups: number;
  channels: number;
}

export function useUnreadCounts(): UnreadCounts {
  const location = useLocation();
  const [counts, setCounts] = useState<UnreadCounts>({ chats: 0, groups: 0, channels: 0 });

  const load = useCallback(() => {
    api.get<UnreadCounts>('/unread/summary')
      .then((res) => setCounts(res.data))
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    socket.on('message_changed', load);
    return () => { socket.off('message_changed', load); };
  }, [load]);
  useEffect(() => {
    const timer = window.setTimeout(load, 350);
    return () => window.clearTimeout(timer);
  }, [location.pathname, load]);

  return counts;
}
