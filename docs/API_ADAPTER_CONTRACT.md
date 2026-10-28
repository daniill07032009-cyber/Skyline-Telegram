# Skyline API adapter contract (draft)

Source of truth inspected: `Pisosisosisosisosi/oursocial-network` at `c642e6517c639a0f513d8fea440308413ffd7cb2`.

This document is a client integration map, not a claim that the Telegram Android client already uses these endpoints. The client must be implemented against the running Skyline API's OpenAPI schema and integration tests before endpoint assumptions are frozen.

## Transport and identity

- REST base URL must be injected through a Skyline build configuration; do not hard-code local addresses or Telegram service URLs.
- Authenticated REST calls use `Authorization: Bearer <JWT>`.
- Current Python API JWT payload includes `userId`, `email`, and `username`; the token lifetime defaults to 7 days and `JWT_SECRET` must be configured on the server.
- The app must treat 401 as an expired/invalid session, refresh profile/session state through the Skyline contract, and provide a clear re-login path.
- Never package production signing keys, JWT secrets, database URLs, or other server secrets in the APK.

## Existing REST surface observed in `python-api/main.py`

| Capability | Existing endpoint(s) | Adapter notes |
|---|---|---|
| Health | `GET /health`, `GET /ready` | Used by deployment checks, not client authentication |
| Register | `POST /auth/register` | Current `main` requires a valid `verificationToken`; this conflicts with the previously requested no-mandatory-email-verification experience and must be resolved in backend code before claiming that flow is supported |
| Login / current user | `POST /auth/login`, `GET /auth/me` | Login returns JWT and profile; map Skyline user IDs to native client models |
| Search / contacts | `GET /users/search`, `GET /contacts`, `PUT /contacts`, `DELETE /contacts/{user_id}` | Map search results and contact state |
| Direct messages | `POST /messages`, `GET /messages/{user_id}`, `PATCH /messages/{message_id}`, `DELETE /messages/{user_id}` | Validate request/response schemas, pagination and ownership rules against live OpenAPI |
| Message actions | `POST /messages/{message_id}/reactions`, `POST /messages/{message_id}/pin`, `POST /messages/{message_id}/reply`, `POST /messages/{message_id}/forward`, `POST /messages/{message_id}/delete-for-all` | Native UI actions need explicit adapter methods and error mapping |
| Groups | `GET /groups`, `POST /groups`, `POST /groups/{group_id}/members`, `GET /groups/{group_id}/messages`, `POST /groups/{group_id}/messages` | Confirm all role, admin, invitation and permissions endpoints before mapping advanced group settings |
| Channels | `/channels` router | Read the router's full route contract; do not infer support from the route prefix alone |
| Saved and scheduled | `/saved-messages`, `/drafts`, `/scheduled-messages`, `/quick-replies` | Existing Skyline capabilities to expose only after end-to-end testing |
| Polls and stories | `/polls`, `/stories` | Confirm all list/detail/update endpoints and permissions |
| Settings and sessions | `/settings`, `/auth/sessions`, `/auth/login-history` | Use Skyline's own session and preference data |

## Realtime contract observed in `python-api/realtime.py`

Existing Socket.IO events include:

- Calls: `call_invite`, `call_incoming`, `call_accept`, `call_accepted`, `call_signal`, `call_decline`, `call_declined`, `call_end`, `call_ended`, `call_unavailable`.
- Presence and typing: `get_presence`, `user_online`, `user_offline`, `typing`.
- Message updates emitted by the API include `message_changed`.

Before the Android adapter subscribes, document the authentication payload used at Socket.IO connect, exact event schemas, reconnection behavior, deduplication keys, and whether events are emitted to user rooms or socket IDs. Existing call signaling does not by itself prove that production-ready WebRTC/TURN media transport is deployed.

## First end-to-end milestone

1. Login with a real Skyline account and persist the returned session securely.
2. Load the authenticated profile from `GET /auth/me`.
3. Load the real conversation list using a confirmed endpoint/schema.
4. Open one direct conversation and load its message history.
5. Send a text message from Android and receive it on a second account/device via REST + Socket.IO.
6. Verify read state, reconnect after network loss, and ensure no duplicate messages.
7. Repeat the same test with the browser client to prove both clients share the same Skyline backend.

Do not mark the milestone complete until the test is performed against the deployed Skyline backend and recorded in CI or a reproducible manual test report.
