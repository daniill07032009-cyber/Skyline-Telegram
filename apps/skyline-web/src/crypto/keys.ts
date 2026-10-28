/**
 * Client-side ECDH P-256 keys. Private keys remain in this browser.
 */

const ECDH_ALGO = {
  name: 'ECDH',
  namedCurve: 'P-256',
} as const;
const RSA_ALGO = {
  name: 'RSA-OAEP',
  hash: 'SHA-256',
} as const;

const STORAGE_KEY_PREFIX = 'e2e_p256_private_key';
const PUBLIC_KEY_STORAGE_PREFIX = 'e2e_p256_public_key';
const LEGACY_STORAGE_KEY = 'e2e_private_key';
const BACKUP_ITERATIONS = 310_000;
const BACKUP_ALGORITHM = 'skyline-e2e-key-backup:v1';

export interface EncryptedKeyBackup {
  publicKey: string;
  encryptedPrivateKey: string;
  salt: string;
  iv: string;
}

export async function generateKeyPair(userId: string): Promise<{ publicKeyJwk: string; privateKey: CryptoKey }> {
  const keyPair = await window.crypto.subtle.generateKey(ECDH_ALGO, true, ['deriveBits']);
  const publicJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const publicKeyJwk = JSON.stringify(publicJwk);
  const privateJwk = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);

  localStorage.setItem(privateStorageKey(userId), JSON.stringify(privateJwk));
  localStorage.setItem(publicStorageKey(userId), publicKeyJwk);

  return { publicKeyJwk, privateKey: keyPair.privateKey };
}

export async function loadPrivateKey(userId?: string): Promise<CryptoKey | null> {
  if (!userId) return null;
  const stored = localStorage.getItem(privateStorageKey(userId));
  if (!stored) return null;

  try {
    return await window.crypto.subtle.importKey(
      'jwk',
      JSON.parse(stored),
      ECDH_ALGO,
      true,
      ['deriveBits'],
    );
  } catch (error) {
    console.error('Failed to load ECDH private key:', error);
    return null;
  }
}

export async function loadLegacyPrivateKey(): Promise<CryptoKey | null> {
  const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!stored) return null;

  try {
    return await window.crypto.subtle.importKey(
      'jwk',
      JSON.parse(stored),
      RSA_ALGO,
      true,
      ['decrypt'],
    );
  } catch (error) {
    console.error('Failed to load legacy RSA private key:', error);
    return null;
  }
}

export async function getOrCreateKeyPair(userId: string): Promise<{ publicKeyJwk: string; privateKey: CryptoKey }> {
  const privateKey = await loadPrivateKey(userId);
  const publicKeyJwk = localStorage.getItem(publicStorageKey(userId));
  if (privateKey && publicKeyJwk) return { publicKeyJwk, privateKey };

  const unscopedPrivateKey = localStorage.getItem(STORAGE_KEY_PREFIX);
  const unscopedPublicKey = localStorage.getItem(PUBLIC_KEY_STORAGE_PREFIX);
  if (unscopedPrivateKey && unscopedPublicKey) {
    localStorage.setItem(privateStorageKey(userId), unscopedPrivateKey);
    localStorage.setItem(publicStorageKey(userId), unscopedPublicKey);
    localStorage.removeItem(STORAGE_KEY_PREFIX);
    localStorage.removeItem(PUBLIC_KEY_STORAGE_PREFIX);
    const migratedPrivateKey = await loadPrivateKey(userId);
    if (migratedPrivateKey) return { publicKeyJwk: unscopedPublicKey, privateKey: migratedPrivateKey };
  }

  return generateKeyPair(userId);
}

export function getStoredPublicKey(userId: string): string | null {
  return localStorage.getItem(publicStorageKey(userId));
}

export async function hasStoredPrivateKey(userId: string): Promise<boolean> {
  return Boolean(await loadPrivateKey(userId));
}

export async function encryptStoredPrivateKeyBackup(userId: string, password: string): Promise<EncryptedKeyBackup> {
  const privateJwk = localStorage.getItem(privateStorageKey(userId));
  const publicKey = getStoredPublicKey(userId);
  if (!privateJwk || !publicKey) throw new Error('На этом устройстве нет ключа шифрования для синхронизации.');

  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveBackupKey(password, salt, ['encrypt']);
  const encrypted = await window.crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(`${BACKUP_ALGORITHM}:${userId}`),
  }, wrappingKey, new TextEncoder().encode(privateJwk));

  return {
    publicKey,
    encryptedPrivateKey: toBase64(encrypted),
    salt: toBase64(salt.buffer),
    iv: toBase64(iv.buffer),
  };
}

export async function restorePrivateKeyBackup(
  userId: string,
  password: string,
  backup: EncryptedKeyBackup,
): Promise<void> {
  const salt = fromBase64(backup.salt);
  const iv = fromBase64(backup.iv);
  if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error('Резервная копия ключа повреждена.');

  const wrappingKey = await deriveBackupKey(password, salt, ['decrypt']);
  const plaintext = await window.crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(`${BACKUP_ALGORITHM}:${userId}`),
  }, wrappingKey, fromBase64(backup.encryptedPrivateKey));
  const privateJwk = JSON.parse(new TextDecoder().decode(plaintext)) as JsonWebKey;
  const publicJwk = JSON.parse(backup.publicKey) as JsonWebKey;
  if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || !privateJwk.d
    || privateJwk.x !== publicJwk.x || privateJwk.y !== publicJwk.y
    || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || publicJwk.d) {
    throw new Error('Резервная копия содержит несовместимую пару ключей.');
  }

  await window.crypto.subtle.importKey('jwk', privateJwk, ECDH_ALGO, true, ['deriveBits']);
  await window.crypto.subtle.importKey('jwk', publicJwk, ECDH_ALGO, true, []);
  localStorage.setItem(privateStorageKey(userId), JSON.stringify(privateJwk));
  localStorage.setItem(publicStorageKey(userId), backup.publicKey);
}

async function deriveBackupKey(password: string, salt: Uint8Array<ArrayBuffer>, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await window.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return window.crypto.subtle.deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations: BACKUP_ITERATIONS,
  }, material, { name: 'AES-GCM', length: 256 }, false, usage);
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function privateStorageKey(userId: string) {
  return `${STORAGE_KEY_PREFIX}:${encodeURIComponent(userId)}`;
}

function publicStorageKey(userId: string) {
  return `${PUBLIC_KEY_STORAGE_PREFIX}:${encodeURIComponent(userId)}`;
}
