/* oxlint-disable react/only-export-components -- Context modules intentionally export the provider and its hook together. */
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { authApi, type User } from '../api/client';
import { connectSocket, disconnectSocket } from '../api/socket';
import { keysApi } from '../api/client';
import {
  encryptStoredPrivateKeyBackup,
  generateKeyPair,
  getStoredPublicKey,
  hasStoredPrivateKey,
  restorePrivateKeyBackup,
} from '../crypto/keys';

export type E2EEStatus = 'checking' | 'ready' | 'backup-needed' | 'key-mismatch' | 'recovery-required' | 'temporarily-unavailable';

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  e2eeStatus: E2EEStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, username: string, verificationToken: string) => Promise<void>;
  updateUser: (updates: Partial<User>) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function inspectE2EEStatus(userId: string): Promise<E2EEStatus> {
  const [backup, localHasPrivateKey] = await Promise.all([
    keysApi.getBackup(),
    hasStoredPrivateKey(userId),
  ]);
  const localPublicKey = getStoredPublicKey(userId);
  if (backup) {
    return localHasPrivateKey && localPublicKey === backup.data.publicKey ? 'ready' : 'recovery-required';
  }
  if (!localHasPrivateKey || !localPublicKey) {
    try {
      await keysApi.getOwn();
      return 'recovery-required';
    } catch (error) {
      if ((error as { response?: { status?: number } })?.response?.status === 404) {
        const generated = await generateKeyPair(userId);
        await keysApi.upload(generated.publicKeyJwk);
        return 'backup-needed';
      }
      throw error;
    }
  }
  try {
    const remote = await keysApi.getOwn();
    return remote.data.publicKey === localPublicKey ? 'backup-needed' : 'key-mismatch';
  } catch (error) {
    if ((error as { response?: { status?: number } })?.response?.status === 404) {
      await keysApi.upload(localPublicKey);
      return 'backup-needed';
    }
    throw error;
  }
}

async function synchronizeE2EEKey(userId: string, password: string): Promise<E2EEStatus> {
  const backup = await keysApi.getBackup();
  if (backup) {
    try {
      await restorePrivateKeyBackup(userId, password, backup.data);
    } catch {
      const localKeyMatchesBackup = await hasStoredPrivateKey(userId)
        && getStoredPublicKey(userId) === backup.data.publicKey;
      if (!localKeyMatchesBackup) return 'recovery-required';
    }
    await keysApi.uploadBackup(await encryptStoredPrivateKeyBackup(userId, password));
    return 'ready';
  }

  if (await hasStoredPrivateKey(userId) && getStoredPublicKey(userId)) {
    await keysApi.uploadBackup(await encryptStoredPrivateKeyBackup(userId, password));
    return 'ready';
  }

  try {
    await keysApi.getOwn();
    return 'recovery-required';
  } catch (error) {
    if ((error as { response?: { status?: number } })?.response?.status !== 404) throw error;
  }

  await generateKeyPair(userId);
  await keysApi.uploadBackup(await encryptStoredPrivateKeyBackup(userId, password));
  return 'ready';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [e2eeStatus, setE2eeStatus] = useState<E2EEStatus>('checking');

  useEffect(() => {
    const init = async () => {
      const savedToken = localStorage.getItem('token');
      if (savedToken) {
        try {
          const res = await authApi.me();
          const userData = (res.data as any)?.user || res.data;
          setUser(userData);
          setToken(savedToken);
          connectSocket(savedToken);
          try { setE2eeStatus(await inspectE2EEStatus(userData.id)); }
          catch (error) { console.error('Failed to check E2EE key status:', error); setE2eeStatus('temporarily-unavailable'); }
        } catch {
          localStorage.removeItem('token');
          setToken(null);
          setE2eeStatus('recovery-required');
        }
      }
      setLoading(false);
    };
    init();
  }, []);

  const login = async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    const token = res.data.token;
    const userData = res.data.user || (res.data as any);
    localStorage.setItem('token', token);
    setToken(token);
    setUser(userData);
    connectSocket(token);

    try {
      setE2eeStatus(await synchronizeE2EEKey(userData.id, password));
    } catch (err) {
      console.error('Failed to synchronize E2EE key:', err);
      setE2eeStatus('temporarily-unavailable');
    }
  };

  const register = async (email: string, password: string, username: string, verificationToken: string) => {
    const res = await authApi.register(email, password, username, verificationToken);
    const token = res.data.token;
    const userData = res.data.user || (res.data as any);
    localStorage.setItem('token', token);
    setToken(token);
    setUser(userData);
    connectSocket(token);

    try {
      setE2eeStatus(await synchronizeE2EEKey(userData.id, password));
    } catch (err) {
      console.error('Failed to synchronize E2EE key:', err);
      setE2eeStatus('temporarily-unavailable');
    }
  };

  const updateUser = (updates: Partial<User>) => {
    setUser((currentUser) => currentUser ? { ...currentUser, ...updates } : currentUser);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setE2eeStatus('checking');
    disconnectSocket();
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, e2eeStatus, login, register, updateUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
