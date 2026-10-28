# Skyline Secret Chats: E2EE Design

## Product decision
Secret chats are a separate conversation type. Ordinary chats continue to use the existing Skyline messaging flow. Phone-number sign-in and phone-number identifiers are out of scope for this phase.

## Security requirements
- End-to-end encryption must be implemented by audited cryptographic protocol/library code, not custom cryptography.
- The backend must never receive plaintext messages, attachment plaintext, private identity keys, or session keys for secret chats.
- The server may store and route ciphertext, public identity/prekey material, delivery metadata, and encrypted attachment blobs.
- Web and Android clients must interoperate using the same protocol and canonical serialization.
- Authentication to Skyline and E2EE identity verification are separate concerns. A valid Skyline login must not silently imply that a contact's E2EE identity is trusted.
- Display a safety-number/QR verification flow and notify users when a contact identity key changes.
- Secret-chat history must not silently sync as plaintext to new devices. Device linking and encrypted history transfer require a separate explicit protocol.
- Do not claim perfect forward secrecy, post-compromise security, or verified identity until those properties are provided by the selected protocol and tested.

## Protocol selection gate
Before implementation, select and pin a maintained, audited protocol/library with compatible Android and browser support (prefer a Signal-protocol implementation where licensing and platform compatibility permit). Record exact library versions, licenses, threat model, supported algorithms, and interoperability vectors. Do not invent a bespoke X25519/AES scheme as a substitute for a reviewed messaging protocol.

## Proposed flow
1. Each client creates its identity key material locally; private keys are stored using platform-appropriate secure storage.
2. Clients publish only protocol-approved public identity/prekey bundles through authenticated API endpoints.
3. The sender establishes or resumes a session locally, encrypts message content and attachment keys, and sends ciphertext.
4. The API authorizes conversation membership and persists/routes opaque ciphertext. It cannot decrypt message bodies.
5. The recipient decrypts locally and updates local session state. Retries must be idempotent and must not reuse nonces or message keys incorrectly.
6. Clients expose identity verification, key-change warnings, session reset/recovery behavior, and clear error states.

## API contract sketch
- `GET /api/secret-chats/:id/messages` returns encrypted envelopes and delivery metadata only.
- `POST /api/secret-chats/:id/messages` accepts a protocol-versioned ciphertext envelope, client-generated message ID, and bounded metadata.
- `GET /api/secret-chats/:id/participants/:userId/keys` returns public identity/prekey material only.
- `POST /api/secret-chats/:id/keys` uploads protocol-approved public prekeys; private material is rejected and never stored.
- `POST /api/secret-chats/:id/receipts` records delivery/read state without message plaintext.
These paths are proposals, not existing endpoints; align them with the real backend router before coding.

## Required tests before release
- Known-answer vectors from the chosen protocol.
- Android-to-web and web-to-Android encrypt/decrypt interoperability.
- Wrong-recipient, modified-ciphertext, replay, duplicate-delivery, expired-prekey, and key-change tests.
- Authorization tests proving users outside a secret chat cannot fetch ciphertext or key bundles.
- Backend/log inspection proving plaintext and private keys are never logged or persisted.
- Build, lint, migration, API integration, and real-device smoke tests.
- Security review before describing the feature as production-ready.

## Non-goals for this phase
- Phone-number registration or discovery.
- Secret-chat cloud plaintext history or automatic plaintext multi-device synchronization.
- Advertising E2EE for ordinary chats unless they separately adopt a reviewed encryption design.
