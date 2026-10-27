# Skyline-Telegram

A monorepo for adapting Telegram's Android client UI and interaction patterns to the Skyline messenger backend.

## Product direction

- Use the official Telegram Android source as the primary reference and starting point for Android UI, layouts, animations, navigation, and interaction patterns.
- Keep Skyline as a separate messenger service. Do not connect this client to Telegram's production services or imply interoperability with Telegram accounts.
- Skyline web, Android, and backend should share Skyline accounts and use the Skyline API.
- Preserve upstream license and copyright notices. Telegram Android is distributed under GPL-2.0; review the upstream license and required source/distribution obligations before distributing modified builds.

## Planned monorepo layout

- `apps/telegram-android/` — official Telegram Android client source, adapted for Skyline.
- `apps/skyline-web/` — Skyline browser client.
- `services/skyline-api/` — Skyline backend/API.
- `docs/` — architecture, API mapping, build and release instructions.

The initial integration must be staged and verified; do not claim a feature is implemented until it has been connected to the Skyline API and tested.

## Integration phases

1. Import the upstream Android source with its history/licensing notices and record the upstream commit.
2. Import the Skyline web and backend source without overwriting the original Skyline repository.
3. Map Telegram UI flows to Skyline API contracts (authentication, conversations, media, groups/channels, realtime and calls).
4. Replace Telegram-specific service/network dependencies only where needed; do not perform a blind global rename.
5. Add CI for Android and web builds, then produce a test APK after a successful build.
6. Track proposed Skyline-only features separately and ask the product owner before adding them.

## Sources

- Skyline: https://github.com/Pisosisosisosisosi/oursocial-network
- Official Telegram Android source: https://github.com/TelegramOrg/Telegram-Android
