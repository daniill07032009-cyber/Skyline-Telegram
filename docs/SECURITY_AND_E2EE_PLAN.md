# Skyline security decisions and secret-chat design

## Product decisions (2026-10-28)

- Phone-number support is deferred. Username + password is the initial account identifier.
- Email and phone verification must not be mandatory for registration. Apply abuse controls independently of verification.
- Secret chats with end-to-end encryption (E2EE) are in scope as a distinct chat mode.
- Regular chats and secret chats must be visibly distinguished. Do not imply regular chats are E2EE.

## Critical security rule

Do not ship a custom cryptographic protocol based only on a public-key upload endpoint. The currently imported Node API has a basic `keys` route, but that is not a complete E2EE protocol: it does not establish identity verification, key transparency, multi-device key management, forward secrecy, recovery, or audited ratcheting.

## Proposed secret-chat architecture

1. Use a reviewed, established protocol and maintained cryptographic implementation where licensing/platform compatibility permits; do not invent primitives or a home-grown ratchet.
2. Establish per-device identity keys and signed prekeys. Keep private keys on-device in platform-protected storage; never upload them.
3. Authenticate and bind public keys to Skyline account + device identity. Support key rotation, revocation, and visible identity-key change warnings.
4. Encrypt message content and attachment keys on sender devices. Servers store and route ciphertext and minimal delivery metadata only for secret chats.
5. Provide safety-number/QR verification and document what metadata remains visible to the service.
6. Define multi-device behavior explicitly. A new device must not silently gain access to existing secret-chat history.
7. Use authenticated encryption, replay protection, nonce discipline, and test vectors from the selected protocol implementation.
8. Add negative tests for tampered ciphertext, wrong keys, replayed messages, revoked devices, key changes, and attachment access.
9. Obtain independent security review before calling the feature production-ready.

## Implementation gates

- Gate 1: threat model and protocol/library decision recorded.
- Gate 2: client-side key lifecycle prototype on Android and web.
- Gate 3: encrypted text exchange between two real accounts; server database inspection confirms plaintext is absent.
- Gate 4: identity verification, device revocation, and tamper/replay tests pass.
- Gate 5: attachments, offline delivery, and multi-device behavior pass.
- Gate 6: independent review and documented limitations before public release.

## Registration abuse controls

Because email/phone verification is optional, implement request throttling, password hashing with a modern cost, username uniqueness enforced by a database constraint, generic authentication errors, suspicious-registration controls, and session revocation. Never log passwords, bearer tokens, private keys, or plaintext secret-chat content.

## Status

This document records scope and acceptance gates. It does not claim E2EE has been implemented or security-reviewed.
