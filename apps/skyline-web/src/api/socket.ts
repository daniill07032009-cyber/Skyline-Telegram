import { io, type Socket } from 'socket.io-client';

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  import.meta.env.VITE_API_URL ||
  'https://oursocial-python.onrender.com';

let socket: Socket | null = null;
let socketToken: string | null = null;

export function connectSocket(token?: string): Socket {
  const authToken = token || localStorage.getItem('token') || '';

  if (socket && socketToken !== authToken) {
    socket.disconnect();
    socket = null;
  }

  if (!socket) {
    socketToken = authToken;
    socket = io(SOCKET_URL, {
      auth: { token: authToken },
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.on('connect_error', (error) => {
      console.error('Socket.IO connection failed:', error.message);
    });
  } else if (!socket.connected) {
    socket.connect();
  }

  return socket;
}

export function getSocket(): Socket | null {
  if (!socket) {
    const token = localStorage.getItem('token');
    if (token) return connectSocket(token);
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
    socketToken = null;
  }
}
