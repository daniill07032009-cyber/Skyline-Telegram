# Native Android migration: Telegram Android -> Skyline

Status: discovery complete; the official client has not yet been imported or connected to Skyline APIs.

## Current verified architecture

- Existing Android artifact workflow builds a Capacitor preview shell, not a native messenger.
- Existing API service: `https://oursocial-python.onrender.com`, Render service `oursocial-python`, source repository `Pisosisosisosisosi/oursocial-network`, root `python-api/`.
- The API is FastAPI wrapped with Socket.IO. Its Python data layer uses PyMongo and reads `MONGO_URI` (defaulting to local MongoDB if unset).
- A Render PostgreSQL instance named `skyline-messenger-db` exists, but the inspected backend uses MongoDB collections; PostgreSQL is not automatically connected just because it exists.
- Existing backend routes include authentication, direct messages, groups, channels, settings and other features, but each route and event still needs a client-side mapping and device testing.

## Important protocol boundary

The upstream Telegram Android app is a Telegram MTProto client. It does not become a Skyline client by changing the API base URL: REST/Socket.IO and Telegram MTProto are different protocols. Connecting this fork to Telegram's production MTProto services would create a Telegram client, not a Skyline messenger.

The Skyline fork must replace or abstract the relevant Telegram-specific service calls and implement a Skyline networking layer for:
- authentication and token/session handling;
- contacts and profiles;
- direct and group messages;
- channels and permissions;
- attachments and media;
- Socket.IO realtime events;
- push notifications;
- secret chats only after a separate, reviewed E2E protocol design.

## Upstream build and configuration

The upstream README calls for Android Studio 2025.1.4, Android SDK 36, NDK 27.2.12479018 and CMake 3.22.1, and says to clone recursively because submodules are required. Its BuildVars contains Telegram-specific API settings; do not treat those as Skyline server credentials. Before any distributable build, use Skyline application/package IDs, app-owned Firebase configuration, and a separate signing key. Never commit private signing keys or service secrets.

## Licensing

The inspected upstream repository includes GPL-2.0. If we distribute a modified client, preserve copyright and license notices, mark modified files appropriately, and publish the corresponding source and build scripts under compatible terms. Do not reuse Telegram branding/logo as Skyline branding.

## Migration sequence

1. Import the upstream source with its submodules and record the exact upstream commit.
2. Make a reproducible Android build in CI before making functional changes.
3. Change application identity, name, icons and Firebase configuration without removing required notices.
4. Define an Android API client for the existing FastAPI/Socket.IO backend.
5. Replace Telegram account/session and MTProto-dependent flows incrementally with Skyline API calls; do not do a blind global rename.
6. Add tests for authentication, one-to-one messaging, group/channel flows, reconnects and push notifications.
7. Produce an APK only after CI succeeds; describe it as a test build until real-device tests pass.

## Current blockers

- No native Android source has been imported into this repository yet.
- The backend's actual `MONGO_URI` and API health response have not been verified from this environment.
- The existing Render PostgreSQL instance has an expiry date and is not the database used by the inspected Python code.
- No Skyline-specific Firebase project configuration or release signing key has been provided.
- Android-to-backend behavior is not yet proven on a real device.
