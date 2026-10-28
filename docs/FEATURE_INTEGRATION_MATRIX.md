# Telegram-to-Skyline integration matrix

This is the implementation checklist. Status is **Not started** until code is connected to Skyline and verified.

| Area | Required Skyline integration | Status |
|---|---|---|
| Account and sessions | Skyline registration/login, token/session persistence, logout, multi-device sessions | Not started |
| Chat list | Direct/group/channel conversations, ordering, unread counts, drafts, archive and pinned chats | Not started |
| Text messages | Send/receive, history pagination, edits, deletes, replies, forwarding, reactions and read state | Not started |
| Realtime | Authenticated socket connection, reconnect, event deduplication and offline recovery | Not started |
| Media | Upload/download, image/video/document previews, progress, retry and storage permissions | Not started |
| Voice/video messages | Recording, cancellation, upload, playback, duration and waveform metadata | Not started |
| Groups | Creation, membership, roles, moderation, invite links and permissions | Not started |
| Channels | Creation, publishing, editing/deleting posts, subscribers, reactions and comments | Not started |
| Search | User, conversation and message search with server-side pagination | Not started |
| Notifications | Skyline push registration, device tokens, notification routing and per-chat preferences | Not started |
| Calls | Call signaling, TURN/STUN/media infrastructure, permissions, lifecycle and reconnect | Not started |
| Contacts and profile | Skyline user IDs, usernames, avatars, privacy and blocking | Not started |
| Bots and automation | Skyline-owned bot API/runtime; do not point Telegram bot functions at Telegram servers | Not started |
| Secret chats | Separate cryptographic protocol, key lifecycle, identity verification and security review | Not started |
| Web parity | Shared Skyline identity and data contracts; verify browser and Android sessions against the same backend | Not started |

## Scope rule

Standard Telegram functionality is the target. Skyline-only additions are excluded until the product owner explicitly approves them. Telegram-specific paid services, Telegram accounts, and Telegram production servers are not part of Skyline.
