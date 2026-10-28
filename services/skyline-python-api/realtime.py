from collections import defaultdict
from datetime import datetime, timezone
import json
import os
from urllib.parse import urlsplit
import re
from typing import Any

import socketio
from bson import ObjectId
from fastapi import HTTPException

from auth import decode_token
from db import blocked_users_collection, users_collection


DEFAULT_FRONTEND_URL = "https://pisosisosisosisosi.github.io/oursocial-network,https://pipipipipi.3utilities.com"
configured_frontend_origins = []
for frontend_url in os.getenv("FRONTEND_URL", DEFAULT_FRONTEND_URL).split(","):
    parsed_frontend_url = urlsplit(frontend_url.strip())
    if parsed_frontend_url.scheme and parsed_frontend_url.netloc:
        configured_frontend_origins.append(
            f"{parsed_frontend_url.scheme}://{parsed_frontend_url.netloc}"
        )
socket_origins = list(dict.fromkeys([
    *configured_frontend_origins,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]))

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=socket_origins,
    logger=False,
    engineio_logger=False,
)

online_users: dict[str, set[str]] = defaultdict(set)
sid_users: dict[str, str] = {}
hidden_online_users: set[str] = set()
active_calls: dict[str, set[str]] = {}
accepted_calls: set[str] = set()
call_invitees: dict[str, str] = {}


def users_blocked_either_way(user_id: str, target_id: str) -> bool:
    """Return True when either participant has blocked the other."""
    blocked = blocked_users_collection()
    return bool(
        blocked.find_one({"userId": user_id, "blockedUserId": target_id}, {"_id": 1})
        or blocked.find_one({"userId": target_id, "blockedUserId": user_id}, {"_id": 1})
    )


def _valid_call_id(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= 64 and re.fullmatch(r"[A-Za-z0-9-]+", value) is not None


def _call_peer(call_id: str, user_id: str) -> str | None:
    participants = active_calls.get(call_id)
    if not participants or user_id not in participants:
        return None
    return next((participant for participant in participants if participant != user_id), None)


@sio.on("call_invite")
async def call_invite(sid: str, data: dict[str, Any] | None = None) -> dict[str, str]:
    caller_id = sid_users.get(sid)
    if not caller_id or not isinstance(data, dict):
        return {"status": "error", "error": "Not authenticated"}
    call_id = data.get("callId")
    target_id = data.get("targetUserId")
    video = data.get("video", False)
    if not _valid_call_id(call_id) or not isinstance(target_id, str) or not ObjectId.is_valid(target_id) or target_id == caller_id or not isinstance(video, bool):
        return {"status": "error", "error": "Invalid call invitation"}
    users = users_collection()
    if not users.find_one({"_id": ObjectId(target_id)}, {"_id": 1}):
        return {"status": "error", "error": "User not found"}
    if users_blocked_either_way(caller_id, target_id):
        return {"status": "error", "error": "Calls are unavailable for this user"}
    # Do not reserve a call ID or lock either participant when the invitee has
    # no connected Socket.IO session to receive the incoming-call event.
    if not online_users.get(target_id):
        return {"status": "error", "error": "User is offline"}
    if call_id in active_calls:
        return {"status": "error", "error": "Call identifier already exists"}
    if any({caller_id, target_id} & participants for participants in active_calls.values()):
        return {"status": "error", "error": "A participant is already in a call"}
    session = await sio.get_session(sid)
    caller = users.find_one({"_id": ObjectId(caller_id)}, {"displayName": 1, "username": 1, "avatarUrl": 1}) or {}
    active_calls[call_id] = {caller_id, target_id}
    call_invitees[call_id] = target_id
    await sio.emit("call_incoming", {
        "callId": call_id,
        "callerId": caller_id,
        "callerName": caller.get("displayName") or caller.get("username") or session.get("username", "Пользователь"),
        "callerAvatarUrl": caller.get("avatarUrl", ""),
        "video": video,
    }, to=f"user:{target_id}")
    return {"status": "ok"}


@sio.on("call_accept")
async def call_accept(sid: str, data: dict[str, Any] | None = None) -> None:
    user_id = sid_users.get(sid)
    call_id = data.get("callId") if isinstance(data, dict) else None
    if not user_id or not _valid_call_id(call_id):
        return
    if call_invitees.get(call_id) != user_id:
        return
    peer_id = _call_peer(call_id, user_id)
    if not peer_id:
        return
    if call_id in accepted_calls:
        await sio.emit("call_unavailable", {"callId": call_id}, to=sid)
        return
    accepted_calls.add(call_id)
    await sio.emit("call_unavailable", {"callId": call_id}, to=f"user:{user_id}", skip_sid=sid)
    await sio.emit("call_accepted", {"callId": call_id, "userId": user_id}, to=f"user:{peer_id}")


@sio.on("call_signal")
async def call_signal(sid: str, data: dict[str, Any] | None = None) -> None:
    user_id = sid_users.get(sid)
    if not user_id or not isinstance(data, dict):
        return
    call_id = data.get("callId")
    signal = data.get("signal")
    if not _valid_call_id(call_id) or not isinstance(signal, dict) or call_id not in accepted_calls:
        return
    try:
        if len(json.dumps(signal, separators=(",", ":"))) > 128_000:
            return
    except (TypeError, ValueError):
        return
    peer_id = _call_peer(call_id, user_id)
    if peer_id:
        await sio.emit("call_signal", {"callId": call_id, "senderId": user_id, "signal": signal}, to=f"user:{peer_id}")


@sio.on("call_decline")
async def call_decline(sid: str, data: dict[str, Any] | None = None) -> None:
    user_id = sid_users.get(sid)
    call_id = data.get("callId") if isinstance(data, dict) else None
    if not user_id or not _valid_call_id(call_id):
        return
    if call_invitees.get(call_id) != user_id:
        return
    peer_id = _call_peer(call_id, user_id)
    if peer_id:
        active_calls.pop(call_id, None)
        accepted_calls.discard(call_id)
        call_invitees.pop(call_id, None)
        await sio.emit("call_declined", {"callId": call_id, "userId": user_id}, to=f"user:{peer_id}")


@sio.on("call_end")
async def call_end(sid: str, data: dict[str, Any] | None = None) -> None:
    user_id = sid_users.get(sid)
    call_id = data.get("callId") if isinstance(data, dict) else None
    if not user_id or not _valid_call_id(call_id):
        return
    peer_id = _call_peer(call_id, user_id)
    if peer_id:
        active_calls.pop(call_id, None)
        accepted_calls.discard(call_id)
        call_invitees.pop(call_id, None)
        await sio.emit("call_ended", {"callId": call_id, "userId": user_id}, to=f"user:{peer_id}")


@sio.event
async def connect(sid: str, environ: dict[str, Any], auth_data: dict[str, Any] | None = None) -> bool:
    token = auth_data.get("token") if isinstance(auth_data, dict) else None
    if not token:
        authorization = environ.get("HTTP_AUTHORIZATION", "")
        if authorization.lower().startswith("bearer "):
            token = authorization.split(" ", 1)[1]
    if not isinstance(token, str) or not token:
        return False

    try:
        payload = decode_token(token)
        user_id = str(payload["userId"])
        username = str(payload.get("username", "Пользователь"))
    except (HTTPException, KeyError, TypeError):
        return False

    # Do not establish a Socket.IO session for malformed IDs or tokens belonging
    # to deleted/nonexistent accounts. Validate before mutating connection state.
    if not ObjectId.is_valid(user_id):
        return False
    user = users_collection().find_one(
        {"_id": ObjectId(user_id)},
        {"hideOnlineStatus": 1},
    )
    if not user:
        return False

    sid_users[sid] = user_id
    await sio.save_session(sid, {"user_id": user_id, "username": username})
    await sio.enter_room(sid, f"user:{user_id}")
    if user.get("hideOnlineStatus", False):
        hidden_online_users.add(user_id)
    else:
        hidden_online_users.discard(user_id)
    was_offline = not online_users[user_id]
    online_users[user_id].add(sid)

    await sio.emit(
        "presence_snapshot",
        {"userIds": sorted((set(online_users.keys()) - hidden_online_users) | {user_id})},
        to=sid,
    )
    if was_offline and user_id not in hidden_online_users:
        await sio.emit(
            "user_online",
            {"userId": user_id, "username": username},
            skip_sid=sid,
        )
    return True


@sio.on("get_presence")
async def get_presence(sid: str) -> None:
    user_id = sid_users.get(sid)
    visible_ids = set(online_users.keys()) - hidden_online_users
    if user_id:
        visible_ids.add(user_id)
    await sio.emit(
        "presence_snapshot",
        {"userIds": sorted(visible_ids)},
        to=sid,
    )


async def set_user_online_hidden(user_id: str, hidden: bool) -> None:
    was_hidden = user_id in hidden_online_users
    if hidden:
        hidden_online_users.add(user_id)
        if not was_hidden and online_users.get(user_id):
            await sio.emit("user_offline", {"userId": user_id})
            await sio.emit(
                "presence_snapshot",
                {"userIds": sorted((set(online_users.keys()) - hidden_online_users) | {user_id})},
                to=f"user:{user_id}",
            )
    else:
        hidden_online_users.discard(user_id)
        if was_hidden and online_users.get(user_id):
            await sio.emit("user_online", {"userId": user_id})


@sio.on("typing")
async def typing(sid: str, data: dict[str, Any] | None = None) -> None:
    user_id = sid_users.get(sid)
    if user_id is None or not isinstance(data, dict):
        return

    recipient_id = data.get("recipientId")
    is_typing = data.get("isTyping")
    if (
        not isinstance(recipient_id, str)
        or not ObjectId.is_valid(recipient_id)
        or recipient_id == user_id
        or not isinstance(is_typing, bool)
    ):
        return
    if users_blocked_either_way(user_id, recipient_id):
        return

    session = await sio.get_session(sid)
    await sio.emit(
        "user_typing",
        {
            "userId": user_id,
            "username": session.get("username", "Пользователь"),
            "isTyping": is_typing,
        },
        to=f"user:{recipient_id}",
    )


@sio.event
async def disconnect(sid: str, _reason: str | None = None) -> None:
    del _reason
    user_id = sid_users.pop(sid, None)
    if user_id is None:
        return

    sessions = online_users.get(user_id)
    if sessions is None:
        return
    sessions.discard(sid)
    if not sessions:
        online_users.pop(user_id, None)
        hidden_online_users.discard(user_id)
        for call_id, participants in list(active_calls.items()):
            if user_id in participants:
                peer_id = next((participant for participant in participants if participant != user_id), None)
                active_calls.pop(call_id, None)
                accepted_calls.discard(call_id)
                call_invitees.pop(call_id, None)
                if peer_id:
                    await sio.emit("call_ended", {"callId": call_id, "userId": user_id}, to=f"user:{peer_id}")
        last_seen = datetime.now(timezone.utc)
        users = users_collection()
        user = users.find_one({"_id": ObjectId(user_id)}, {"showLastSeen": 1}) or {}
        users.update_one(
            {"_id": ObjectId(user_id)},
            {"$set": {"lastSeen": last_seen}},
        )
        event = {"userId": user_id}
        if user.get("showLastSeen", True):
            event["lastSeen"] = last_seen.isoformat()
        await sio.emit(
            "user_offline",
            event,
        )
