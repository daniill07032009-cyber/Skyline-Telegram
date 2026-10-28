/**
 * E2EE message encryption with ephemeral ECDH P-256 and AES-GCM-256.
 */

import { loadLegacyPrivateKey, loadPrivateKey } from './keys';

const ECDH_ALGO = {
  name: 'ECDH',
  namedCurve: 'P-256',
} as const;
const AES_ALGO = {
  name: 'AES-GCM',
  length: 256,
} as const;
const HKDF_ALGO = 'HKDF';
const HYBRID_ENVELOPE_PREFIX = 'skyline-e2e:v4:';
const ENVELOPE_PREFIX = 'skyline-e2e:v3:';
const LEGACY_ENVELOPE_PREFIX = 'oursocial-e2e:v2:';
const LEGACY_RSA_ALGO = {
  name: 'RSA-OAEP',
  hash: 'SHA-256',
} as const;
const DECRYPTION_FAILURE = '[Зашифрованное сообщение]';

export interface RecipientPublicKey {
  userId: string;
  publicKey: string;
}

interface RecipientEnvelope {
  ephemeralPublicKey: JsonWebKey;
  salt: string;
  iv: string;
  ciphertext: string;
}

interface EncryptedEnvelope {
  recipients: Record<string, RecipientEnvelope>;
}

interface HybridRecipientEnvelope {
  ephemeralPublicKey: JsonWebKey;
  salt: string;
  iv: string;
  wrappedKey: string;
}

interface HybridEnvelope {
  iv: string;
  ciphertext: string;
  recipients: Record<string, HybridRecipientEnvelope>;
}

export interface AttachmentMetadata {
  fileName: string;
  contentType: string;
}

const ATTACHMENT_MAGIC = new TextEncoder().encode('SKYATT1:');

function hasUnsafeFileNameCharacters(fileName: string): boolean {
  return fileName.includes('/') || fileName.includes('\\')
    || Array.from(fileName).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

export function isEncryptedMessage(text: string): boolean {
  if (text.startsWith(HYBRID_ENVELOPE_PREFIX) || text.startsWith(ENVELOPE_PREFIX) || text.startsWith(LEGACY_ENVELOPE_PREFIX)) return true;
  try {
    return base64ToArrayBuffer(text).byteLength === 256;
  } catch {
    return false;
  }
}

/** Encrypt arbitrary bytes once, then wrap the small content key for each recipient. */
export async function encryptBytes(
  plaintext: Uint8Array,
  recipients: RecipientPublicKey[],
): Promise<string> {
  if (!recipients.length) throw new Error('At least one encryption recipient is required.');
  const uniqueRecipients = [...new Map(recipients.map((recipient) => [recipient.userId, recipient])).values()];
  if (uniqueRecipients.some((recipient) => !recipient.userId || !recipient.publicKey)) {
    throw new Error('Every encryption recipient must have a public key.');
  }

  const contentKey = await window.crypto.subtle.generateKey(AES_ALGO, true, ['encrypt', 'decrypt']);
  const rawContentKey = await window.crypto.subtle.exportKey('raw', contentKey);
  const payloadIv = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: payloadIv },
    contentKey,
    toArrayBuffer(plaintext),
  );

  const encryptedRecipients = await Promise.all(uniqueRecipients.map(async ({ userId, publicKey }) => {
    const recipientKey = await window.crypto.subtle.importKey('jwk', JSON.parse(publicKey) as JsonWebKey, ECDH_ALGO, false, []);
    const ephemeralKeyPair = await window.crypto.subtle.generateKey(ECDH_ALGO, true, ['deriveBits']);
    const sharedSecret = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: recipientKey }, ephemeralKeyPair.privateKey, 256,
    );
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const wrapIv = window.crypto.getRandomValues(new Uint8Array(12));
    const wrappingKey = await deriveAesKey(sharedSecret, salt.buffer, userId, `skyline-e2e:v4:wrap:${userId}`);
    const wrappedKey = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: wrapIv }, wrappingKey, rawContentKey,
    );
    const ephemeralPublicKey = await window.crypto.subtle.exportKey('jwk', ephemeralKeyPair.publicKey);
    return [userId, {
      ephemeralPublicKey,
      salt: arrayBufferToBase64(salt.buffer),
      iv: arrayBufferToBase64(wrapIv.buffer),
      wrappedKey: arrayBufferToBase64(wrappedKey),
    }] as const;
  }));

  const envelope: HybridEnvelope = {
    iv: arrayBufferToBase64(payloadIv.buffer),
    ciphertext: arrayBufferToBase64(ciphertext),
    recipients: Object.fromEntries(encryptedRecipients),
  };
  return `${HYBRID_ENVELOPE_PREFIX}${JSON.stringify(envelope)}`;
}

export async function decryptBytes(encryptedText: string, userId?: string): Promise<Uint8Array> {
  if (!encryptedText.startsWith(HYBRID_ENVELOPE_PREFIX)) throw new Error('Unsupported encrypted payload.');
  const envelope = JSON.parse(encryptedText.slice(HYBRID_ENVELOPE_PREFIX.length)) as HybridEnvelope;
  if (!envelope.recipients || !envelope.iv || !envelope.ciphertext) throw new Error('Invalid encrypted payload.');

  let selectedUserId = userId && envelope.recipients[userId] ? userId : undefined;
  if (!selectedUserId) {
    for (const candidateId of Object.keys(envelope.recipients)) {
      if (await loadPrivateKey(candidateId)) {
        selectedUserId = candidateId;
        break;
      }
    }
  }
  if (!selectedUserId) throw new Error('No private key for this encrypted payload.');
  const privateKey = await loadPrivateKey(selectedUserId);
  const recipientEnvelope = envelope.recipients[selectedUserId];
  if (!privateKey || !recipientEnvelope) throw new Error('No private key for this encrypted payload.');

  const ephemeralPublicKey = await window.crypto.subtle.importKey(
    'jwk', recipientEnvelope.ephemeralPublicKey, ECDH_ALGO, false, [],
  );
  const sharedSecret = await window.crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephemeralPublicKey }, privateKey, 256,
  );
  const wrappingKey = await deriveAesKey(
    sharedSecret,
    base64ToArrayBuffer(recipientEnvelope.salt),
    selectedUserId,
    `skyline-e2e:v4:wrap:${selectedUserId}`,
  );
  const rawContentKey = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(recipientEnvelope.iv) },
    wrappingKey,
    base64ToArrayBuffer(recipientEnvelope.wrappedKey),
  );
  const contentKey = await window.crypto.subtle.importKey('raw', rawContentKey, AES_ALGO, false, ['decrypt']);
  const plaintext = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(envelope.iv) },
    contentKey,
    base64ToArrayBuffer(envelope.ciphertext),
  );
  return new Uint8Array(plaintext);
}

export function packAttachmentPayload(data: Uint8Array, metadata: AttachmentMetadata): Uint8Array {
  if (!metadata.fileName.trim() || metadata.fileName.length > 200 || hasUnsafeFileNameCharacters(metadata.fileName)) {
    throw new Error('Attachment filename is invalid.');
  }
  if (!metadata.contentType || metadata.contentType.length > 100) {
    throw new Error('Attachment content type is invalid.');
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const header = new Uint8Array(ATTACHMENT_MAGIC.length + 4 + metadataBytes.length);
  header.set(ATTACHMENT_MAGIC, 0);
  new DataView(header.buffer).setUint32(ATTACHMENT_MAGIC.length, metadataBytes.length);
  header.set(metadataBytes, ATTACHMENT_MAGIC.length + 4);
  const packed = new Uint8Array(header.length + data.length);
  packed.set(header);
  packed.set(data, header.length);
  return packed;
}

export function unpackAttachmentPayload(payload: Uint8Array): { metadata: AttachmentMetadata; data: Uint8Array } | null {
  if (payload.length < ATTACHMENT_MAGIC.length + 4
    || !ATTACHMENT_MAGIC.every((byte, index) => payload[index] === byte)) return null;
  const metadataLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    .getUint32(ATTACHMENT_MAGIC.length);
  const metadataStart = ATTACHMENT_MAGIC.length + 4;
  const dataStart = metadataStart + metadataLength;
  if (!metadataLength || dataStart > payload.length) throw new Error('Invalid attachment payload.');
  const metadata = JSON.parse(new TextDecoder().decode(payload.subarray(metadataStart, dataStart))) as AttachmentMetadata;
  if (typeof metadata.fileName !== 'string' || !metadata.fileName.trim() || metadata.fileName.length > 200
    || hasUnsafeFileNameCharacters(metadata.fileName)
    || typeof metadata.contentType !== 'string' || !metadata.contentType || metadata.contentType.length > 100) {
    throw new Error('Invalid attachment metadata.');
  }
  return { metadata, data: payload.slice(dataStart) };
}

export async function encryptMessage(
  text: string,
  recipients: string | RecipientPublicKey[],
): Promise<string> {
  if (!text) return '';

  try {
    if (typeof recipients === 'string') {
      if (!recipients.trim()) throw new Error('Encryption recipient key is missing.');
      const jwk = JSON.parse(recipients) as JsonWebKey;
      if (jwk.kty === 'EC' || jwk.crv) {
        return await encryptMessage(text, [{ userId: 'recipient', publicKey: recipients }]);
      }
      return await encryptLegacyMessage(text, recipients);
    }

    if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('At least one encryption recipient is required.');

    const validRecipients = recipients.filter(
      (r) => r && r.userId && r.publicKey && typeof r.publicKey === 'string' && r.publicKey.trim().length > 10,
    );

    if (validRecipients.length !== recipients.length) throw new Error('Every encryption recipient must have a public key.');

    const encryptedRecipients = await Promise.all(
      validRecipients.map(async ({ userId, publicKey }) => {
        const jwk = JSON.parse(publicKey) as JsonWebKey;
        const recipientKey = await window.crypto.subtle.importKey(
          'jwk',
          jwk,
          ECDH_ALGO,
          false,
          [],
        );
        const ephemeralKeyPair = await window.crypto.subtle.generateKey(
          ECDH_ALGO,
          true,
          ['deriveBits'],
        );
        const sharedSecret = await window.crypto.subtle.deriveBits(
          { name: 'ECDH', public: recipientKey },
          ephemeralKeyPair.privateKey,
          256,
        );
        const salt = window.crypto.getRandomValues(new Uint8Array(16));
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const aesKey = await deriveAesKey(sharedSecret, salt.buffer, userId);
        const ciphertext = await window.crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          aesKey,
          new TextEncoder().encode(text),
        );
        const ephemeralPublicKey = await window.crypto.subtle.exportKey(
          'jwk',
          ephemeralKeyPair.publicKey,
        );

        return [userId, {
          ephemeralPublicKey,
          salt: arrayBufferToBase64(salt.buffer),
          iv: arrayBufferToBase64(iv.buffer),
          ciphertext: arrayBufferToBase64(ciphertext),
        }] as const;
      }),
    );

    const envelope: EncryptedEnvelope = { recipients: Object.fromEntries(encryptedRecipients) };
    return `${ENVELOPE_PREFIX}${JSON.stringify(envelope)}`;
  } catch (err) {
    console.error('End-to-end encryption failed.', err);
    throw new Error('End-to-end encryption failed; message was not sent.');
  }
}

export async function decryptMessage(encryptedText: string, userId?: string): Promise<string> {
  if (!encryptedText) return '';

  if (encryptedText.startsWith(HYBRID_ENVELOPE_PREFIX)) {
    try {
      return new TextDecoder().decode(await decryptBytes(encryptedText, userId));
    } catch {
      return DECRYPTION_FAILURE;
    }
  }

  if (!isEncryptedMessage(encryptedText)) return encryptedText;

  if (encryptedText.startsWith(ENVELOPE_PREFIX)) {
    try {
      const envelope = JSON.parse(encryptedText.slice(ENVELOPE_PREFIX.length)) as EncryptedEnvelope;
      let recipientEnvelope = userId ? envelope.recipients[userId] : null;
      let effectiveUserId = userId;

      if (!recipientEnvelope) {
        for (const candidateId of Object.keys(envelope.recipients)) {
          const key = await loadPrivateKey(candidateId);
          if (key) {
            recipientEnvelope = envelope.recipients[candidateId];
            effectiveUserId = candidateId;
            break;
          }
        }
      }

      if (!recipientEnvelope || !effectiveUserId) return DECRYPTION_FAILURE;
      const privateKey = await loadPrivateKey(effectiveUserId);
      if (!privateKey) return DECRYPTION_FAILURE;

      const ephemeralPublicKey = await window.crypto.subtle.importKey(
        'jwk',
        recipientEnvelope.ephemeralPublicKey,
        ECDH_ALGO,
        false,
        [],
      );
      const sharedSecret = await window.crypto.subtle.deriveBits(
        { name: 'ECDH', public: ephemeralPublicKey },
        privateKey,
        256,
      );
      const aesKey = await deriveAesKey(
        sharedSecret,
        base64ToArrayBuffer(recipientEnvelope.salt),
        effectiveUserId,
      );
      const plaintext = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToArrayBuffer(recipientEnvelope.iv) },
        aesKey,
        base64ToArrayBuffer(recipientEnvelope.ciphertext),
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      return DECRYPTION_FAILURE;
    }
  }

  if (encryptedText.startsWith(LEGACY_ENVELOPE_PREFIX)) {
    try {
      const privateKey = await loadLegacyPrivateKey();
      if (!privateKey) return DECRYPTION_FAILURE;
      const envelope = JSON.parse(encryptedText.slice(LEGACY_ENVELOPE_PREFIX.length)) as {
        iv: string;
        ciphertext: string;
        keys: Record<string, string>;
      };
      const wrappedKey = userId
        ? envelope.keys[userId]
        : Object.values(envelope.keys)[0];
      if (!wrappedKey) return DECRYPTION_FAILURE;

      const rawKey = await window.crypto.subtle.decrypt(
        LEGACY_RSA_ALGO,
        privateKey,
        base64ToArrayBuffer(wrappedKey),
      );
      const aesKey = await window.crypto.subtle.importKey(
        'raw',
        rawKey,
        AES_ALGO,
        false,
        ['decrypt'],
      );
      const plaintext = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToArrayBuffer(envelope.iv) },
        aesKey,
        base64ToArrayBuffer(envelope.ciphertext),
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      return DECRYPTION_FAILURE;
    }
  }

  if (!isEncryptedMessage(encryptedText)) return encryptedText;
  try {
    const privateKey = await loadLegacyPrivateKey();
    if (!privateKey) return DECRYPTION_FAILURE;
    const decrypted = await window.crypto.subtle.decrypt(
      LEGACY_RSA_ALGO,
      privateKey,
      base64ToArrayBuffer(encryptedText),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return DECRYPTION_FAILURE;
  }
}

async function deriveAesKey(
  sharedSecret: ArrayBuffer,
  salt: ArrayBuffer,
  userId: string,
  context = `skyline-e2e:v3:${userId}`,
): Promise<CryptoKey> {
  const hkdfKey = await window.crypto.subtle.importKey(
    'raw',
    sharedSecret,
    HKDF_ALGO,
    false,
    ['deriveKey'],
  );
  return window.crypto.subtle.deriveKey(
    {
      name: HKDF_ALGO,
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode(context),
    },
    hkdfKey,
    AES_ALGO,
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptLegacyMessage(text: string, publicKeyJwk: string): Promise<string> {
  const publicKey = await window.crypto.subtle.importKey(
    'jwk',
    JSON.parse(publicKeyJwk) as JsonWebKey,
    LEGACY_RSA_ALGO,
    true,
    ['encrypt'],
  );
  const ciphertext = await window.crypto.subtle.encrypt(
    LEGACY_RSA_ALGO,
    publicKey,
    new TextEncoder().encode(text),
  );
  return arrayBufferToBase64(ciphertext);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
