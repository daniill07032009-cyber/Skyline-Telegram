# Source audit — initial integration

Audit date: 2026-10-28

## Repositories inspected

- Android UI/feature baseline: https://github.com/TelegramOrg/Telegram-Android
- Skyline application and backend: https://github.com/Pisosisosisosisosi/oursocial-network
- Integration target: https://github.com/daniill07032009-cyber/Skyline-Telegram

## Pinned upstream snapshots

- Telegram Android: `3de37c8cfb039452be7398909461da6288babf15` (upstream master at audit time; upstream message: update to 13.1.1 (7237)).
- Skyline main: `c642e6517c639a0f513d8fea440308413ffd7cb2`.

These are audit references, not claims that the source trees have already been copied into this repository.

## Skyline layout observations

- `frontend/`: Vite + React + TypeScript; uses Axios and Socket.IO client.
- `backend/`: Node.js backend with chat, message, authentication and Socket.IO modules.
- `python-api/`: Python API containing authentication and channel functionality.
- The existing project has both web/backend and Python API surfaces. Before the Android adapter is implemented, the canonical API base URL, auth contract, message schema, media endpoints, and realtime events must be confirmed against the deployed backend and tests.

## Android source observations

- The official Android repository is a complete Android application, not a UI component library.
- It contains numerous native/JNI dependencies and Git submodules (including call/media-related components). A full clone must include recursive submodules.
- The source has Telegram-specific networking, account, push, billing and service assumptions. Changing only the base URL will not turn its Telegram protocol into Skyline's API.
- Upstream Android is GPL-2.0-or-later. Preserve copyright/license notices and review source-publication obligations before distributing modified binaries.

## Known blockers before a usable APK

1. Import the complete source and its required submodules into the integration checkout.
2. Establish a Skyline Android API adapter and map each screen/action to real Skyline endpoints/events.
3. Replace Telegram service assumptions only where appropriate; do not remove upstream code blindly.
4. Provide Skyline-specific application ID, Firebase configuration, signing configuration and non-production credentials. Never commit private signing keys or secrets.
5. Build on GitHub Actions using the upstream-required Android SDK/NDK and verify the generated APK artifact.
6. Test on a real device against the Skyline backend.

## Completion standard

A feature is not marked complete because a screen exists. It must call Skyline infrastructure, handle loading/error/offline states, and pass an appropriate automated or manual integration test.
