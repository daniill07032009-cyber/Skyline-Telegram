const BLOCKED_STATUSES = new Set(['checking', 'key-mismatch', 'recovery-required', 'temporarily-unavailable']);

export function canSendEncryptedMessages(status: string) {
  return !BLOCKED_STATUSES.has(status);
}
