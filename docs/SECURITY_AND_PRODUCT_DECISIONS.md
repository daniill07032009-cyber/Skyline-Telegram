# Skyline product decisions and security baseline

## Confirmed product decisions (2026-10-28)

- Phone numbers: **defer implementation**. Do not require a phone number for registration or login. Do not add a phone-number field or phone-based recovery flow until separately approved.
- Secret chats: **implement as a separate end-to-end encrypted (E2E) chat mode**. Ordinary chats remain ordinary server-managed chats; secret-chat messages must not silently fall back to plaintext or be uploaded as server-readable content.
- Account identity: use Skyline-owned accounts and a shared Skyline identity/session model across Android and web.
- Registration: no mandatory email or phone verification. Keep abuse controls, password policy, rate limits, and secure session handling.
- Infrastructure: use Skyline-owned APIs, storage, push infrastructure, and call signaling/media services. Do not route application data through Telegram production servers.

## Secret-chat security requirements

This is the acceptance baseline, not a claim that E2E is already implemented or audited.

1. Separate secret-chat records from ordinary chat/message records and clearly identify their encryption mode in both clients.
2. Encrypt message content and attachments on the sender's device before upload. The server may store and relay ciphertext and routing metadata, but must not receive message plaintext or private keys.
3. Use a reviewed, established cryptographic protocol/library; do not invent cryptographic primitives. Protocol choice and supported platforms must be recorded before implementation.
4. Use per-device identity keys and authenticated session establishment. Support key-change warnings and a user-visible identity/safety-number verification flow.
5. Define replay protection, message ordering, nonce/associated-data rules, key rotation, device removal, and recovery behavior before enabling production use.
6. Never log plaintext, passwords, access tokens, private keys, or decrypted attachment data. Do not put secret-chat plaintext into analytics, push previews, server-side search, or server-side backups.
7. Push notifications for secret chats should use generic content by default; message previews must not leak plaintext through push providers.
8. Secret chats must fail closed when encryption/session state is invalid. Do not downgrade to ordinary chat automatically.
9. Add cross-platform test vectors and tests for tampering, wrong keys, replay, membership changes, and corrupted ciphertext. Commission independent security review before claiming the feature is production-secure.

## Implementation order

- Establish the cross-platform protocol and threat model.
- Add backend metadata/key-directory and ciphertext-relay contracts with strict participant authorization; backend must never hold private keys or decrypt messages.
- Implement Android and web cryptographic adapters using the same protocol and versioned message envelope.
- Add user-facing creation, verification, safety warnings, and failure states.
- Test two independent accounts across web and Android, including reconnects and key changes.
- Keep the feature marked incomplete until those checks and a security review are complete.

## Release and build integrity

- A successful upstream-source import proves only that files were copied, not that Skyline integration works.
- A successful compile proves buildability, not runtime compatibility or feature parity.
- Never publish a release APK until Skyline API routing, account login, cross-client sync, and the applicable security checks have been verified.
- Keep signing keys and production secrets out of Git; use CI-only ephemeral debug signing for test builds.
