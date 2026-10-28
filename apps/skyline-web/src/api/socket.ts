import { io, type Socket } from 'socket.io-client';

const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL?.trim();
const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
// Never send Skyline realtime credentials to a legacy deployment by default.
const SOCKET_URL = configuredSocketUrl || configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8000' : '');

let socket: Socket | null = null;
let socketToken: string | null = null;

export function connectSocket(token?: string): Socket {
  if (!SOCKET_URL) {
    throw new Error('Skyline realtime API is not configured. Set VITE_SOCKET_URL or VITE_API_URL to the HTTPS URL of the Skyline backend.');
  }
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
