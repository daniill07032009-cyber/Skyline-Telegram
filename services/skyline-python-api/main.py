from fastapi import FastAPI, HTTPException, Depends, Header, Query, Request
from fastapi.responses import Response, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field, field_validator
from bson import ObjectId
from urllib.parse import quote_plus, urlsplit
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError
from typing import Literal, Optional
import asyncio
import base64
import binascii
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import smtplib
import ssl
import time
from collections import defaultdict, deque
from threading import Lock

from db import (
    users_collection, keys_collection, connect_db, get_db, groups_collection,
    email_verifications_collection, verified_email_tokens_collection,
    messages_collection, stories_collection, channels_collection,
    channel_posts_collection, polls_collection, votes_collection,
    events_collection, friend_requests_collection, blocked_users_collection,
    saved_messages_collection, drafts_collection, scheduled_messages_collection,
    quick_replies_collection, user_settings_collection, chat_settings_collection,
    login_history_collection,
    reports_collection, bots_collection, gifts_collection,
)
from auth import (
    hash_password, verify_password, create_token,
    get_current_user,
)
from crypto import validate_public_key, make_key_document
from realtime import sio, users_blocked_either_way
import socketio as socketio_server
from channels import router as channels_router, channel_by_id, get_member, require_read_access
from premium import router as premium_router, serialize_premium
from group_management import router as group_management_router

app = FastAPI(title="Our Social Network API")
MESSAGE_RATE_LIMIT = 5
MESSAGE_RATE_WINDOW_SECONDS = 1.0
message_send_timestamps: dict[str, deque[float]] = defaultdict(deque)
message_rate_lock = Lock()

# Process-local defense-in-depth for repeated login attempts.
# A shared/distributed limiter should be used when running multiple API instances.
LOGIN_RATE_LIMIT = 20
LOGIN_RATE_WINDOW_SECONDS = 300.0
login_attempt_timestamps: dict[str, deque[float]] = defaultdict(deque)
login_rate_lock = Lock()


def enforce_login_rate_limit(request: Request) -> None:
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with login_rate_lock:
        timestamps = login_attempt_timestamps[client_ip]
        while timestamps and now - timestamps[0] >= LOGIN_RATE_WINDOW_SECONDS:
            timestamps.popleft()
        if len(timestamps) >= LOGIN_RATE_LIMIT:
            retry_after = LOGIN_RATE_WINDOW_SECONDS - (now - timestamps[0])
            raise HTTPException(
                status_code=429,
                detail="Too many login attempts. Please wait before trying again.",
                headers={"Retry-After": str(max(1, int(retry_after) + 1))},
            )
        timestamps.append(now)
        # Bound stale per-IP entries if this process receives many distinct clients.
        if len(login_attempt_timestamps) > 10_000:
            stale_ips = [
                ip for ip, entries in login_attempt_timestamps.items()
                if not entries or now - entries[-1] >= LOGIN_RATE_WINDOW_SECONDS
            ]
            for ip in stale_ips:
                login_attempt_timestamps.pop(ip, None)


DEFAULT_FRONTEND_URL = "https://pisosisosisosisosi.github.io/oursocial-network,https://pipipipipi.3utilities.com"


def get_frontend_base_url() -> str:
    """Return one valid frontend URL for email links and browser redirects."""
    configured = os.getenv("FRONTEND_URL", DEFAULT_FRONTEND_URL)
    for candidate in configured.split(","):
        parsed = urlsplit(candidate.strip())
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"
    return "https://pisosisosisosisosi.github.io/oursocial-network"


configured_frontend_origins = []
for frontend_url in os.getenv("FRONTEND_URL", DEFAULT_FRONTEND_URL).split(","):
    parsed_frontend_url = urlsplit(frontend_url.strip())
    if parsed_frontend_url.scheme and parsed_frontend_url.netloc:
        configured_frontend_origins.append(
            f"{parsed_frontend_url.scheme}://{parsed_frontend_url.netloc}"
        )
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(dict.fromkeys([
        *configured_frontend_origins,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ])),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(channels_router)
app.include_router(premium_router)
app.include_router(group_management_router)


# ---------- Модели ----------

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")
    verificationToken: str = Field(min_length=32, max_length=256)


class SendEmailCodeRequest(BaseModel):
    email: EmailStr


class VerifyEmailCodeRequest(BaseModel):
    email: EmailStr
    code: str = Field(pattern=r"^\d{6}$")


class VerifyEmailTokenRequest(BaseModel):
    email: EmailStr
    token: str = Field(min_length=16, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UploadKeyRequest(BaseModel):
    publicKey: str


class UploadKeyBackupRequest(BaseModel):
    publicKey: str = Field(min_length=32, max_length=8192)
    encryptedPrivateKey: str = Field(min_length=24, max_length=16384)
    salt: str = Field(min_length=24, max_length=24)
    iv: str = Field(min_length=16, max_length=16)


class ExchangeRequest(BaseModel):
    targetUserId: str


class UpdateProfileRequest(BaseModel):
    displayName: str = Field(min_length=2, max_length=32)
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")
    dateOfBirth: date | None = None
    avatarUrl: str = Field(default="", max_length=1_400_000)
    bio: str = Field(default="", max_length=300)
    statusText: str = Field(default="", max_length=80)
    showLastSeen: bool = True

    @field_validator("dateOfBirth")
    @classmethod
    def validate_date_of_birth(cls, value: date | None) -> date | None:
        if value and value > datetime.now(timezone.utc).date():
            raise ValueError("Date of birth cannot be in the future")
        return value


class ContactRequest(BaseModel):
    userId: str = Field(min_length=1, max_length=64)
    nickname: str = Field(min_length=1, max_length=40)


# НОВАЯ МОДЕЛЬ ДЛЯ СООБЩЕНИЙ
class MessageRequest(BaseModel):
    receiverId: str = Field(min_length=1, max_length=64)
    text: str = Field(default="", max_length=524_288)
    type: Literal["text", "image", "file"] = "text"
    fileName: str = Field(default="", max_length=200)
    contentType: str = Field(default="", max_length=100)
    fileData: str = Field(default="", max_length=3_500_000)
    replyTo: Optional[str] = Field(default=None, max_length=64)


class ReactionRequest(BaseModel):
    # Keep the server allowlist aligned with the six reactions shown in the chat UI.
    emoji: Literal["❤️", "👍", "😂", "🔥", "🎉", "😢"]


class PinRequest(BaseModel):
    pinned: bool


class EditMessageRequest(BaseModel):
    text: str = Field(min_length=1, max_length=524_288)


class GroupMessageRequest(BaseModel):
    text: str = Field(min_length=1, max_length=3_500_000)
    type: Literal["text", "file"] = "text"
    mentionUserIds: list[str] = Field(default_factory=list, max_length=100)


class CreateGroupRequest(BaseModel):
    title: str = Field(min_length=2, max_length=64)
    description: str = Field(default="", max_length=500)
    avatarUrl: str = Field(default="", max_length=1_400_000)
    memberIds: list[str] = Field(default_factory=list, max_length=99)

    @field_validator("avatarUrl")
    @classmethod
    def validate_avatar_url(cls, value: str) -> str:
        if value and not re.fullmatch(r"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*", value):
            raise ValueError("Avatar must be a supported base64 image")
        return value


class AddGroupMembersRequest(BaseModel):
    memberIds: list[str] = Field(min_length=1, max_length=100)


class PrivacyRequest(BaseModel):
    hideOnlineStatus: bool
    hideReadReceipts: bool
    hideDateOfBirth: bool | None = None


# ---------- Scheduled message delivery ----------

SCHEDULED_MESSAGE_POLL_SECONDS = 10
SCHEDULED_MESSAGE_CLAIM_TIMEOUT = timedelta(minutes=2)
_scheduled_worker_task: asyncio.Task | None = None

async def deliver_scheduled_message(item: dict) -> None:
    """Deliver one claimed scheduled message, idempotently."""
    scheduled_id = str(item["_id"])
    scheduled = scheduled_messages_collection()
    messages = messages_collection()
    existing = messages.find_one({"scheduledMessageId": scheduled_id})
    if existing:
        # A previous attempt may have inserted the message but stopped before
        # updating the schedule state or notifying connected clients. Recover
        # both side effects without inserting a duplicate message.
        event = {
            "messageId": str(existing["_id"]),
            "senderId": item["senderId"],
            "action": "created",
        }
        if item.get("groupId"):
            group_id = item["groupId"]
            groups_collection().update_one(
                {"_id": ObjectId(group_id)},
                # Recovery may run late; never move the group's activity time backwards.
                {"$max": {"updatedAt": existing["createdAt"]}},
            )
            event["groupId"] = group_id
            for member_id in group_message_recipients(group_id):
                await sio.emit("message_changed", event, to=f"user:{member_id}")
        else:
            receiver_id = item.get("receiverId")
            if receiver_id:
                event["receiverId"] = receiver_id
                await sio.emit("message_changed", event, to=f"user:{item['senderId']}")
                await sio.emit("message_changed", event, to=f"user:{receiver_id}")
        scheduled.update_one({"_id": item["_id"], "status": "processing"},
            {"$set": {"status": "sent", "sentAt": existing["createdAt"]},
             "$unset": {"claimedAt": "", "lastError": ""}})
        return

    sender_id = item["senderId"]
    now = datetime.now(timezone.utc)
    group = None
    if item.get("groupId"):
        group = get_group_for_member(item["groupId"], sender_id)
        recipients = {member["userId"] for member in group.get("members", [])}
        if item.get("type", "text") == "text":
            validate_v4_envelope(item.get("text", ""), 64_000, recipients)
        else:
            validate_v4_envelope(item.get("fileData", ""), MAX_ATTACHMENT_SIZE + 1024, recipients)
        message = {
            "senderId": sender_id, "receiverId": "", "groupId": item["groupId"],
            "text": item.get("text", ""), "type": item.get("type", "text"),
            "fileName": item.get("fileName", ""), "contentType": item.get("contentType", ""),
            "fileData": item.get("fileData", ""), "reactions": [], "readBy": [sender_id],
            "pinned": False, "createdAt": now, "read": False, "scheduledMessageId": scheduled_id,
        }
    else:
        receiver_id = item["receiverId"]
        if not users_collection().find_one({"_id": ObjectId(receiver_id)}, {"_id": 1}):
            raise ValueError("Recipient no longer exists")
        if users_blocked_either_way(sender_id, receiver_id):
            raise ValueError("Messaging is unavailable for this user")
        message = {
            "senderId": sender_id, "receiverId": receiver_id, "text": item.get("text", ""),
            "type": "file" if item.get("type") != "text" else "text",
            "fileName": "", "contentType": "",
            "fileData": item.get("fileData", "") if item.get("type") != "text" else "",
            "reactions": [], "pinned": False, "createdAt": now, "read": False,
            "scheduledMessageId": scheduled_id,
        }

    if not group:
        expire_after = direct_chat_expiration_minutes(sender_id, item["receiverId"])
        if expire_after:
            message["expiresAt"] = now + timedelta(minutes=expire_after)

    try:
        result = messages.insert_one(message)
        message["_id"] = result.inserted_id
    except DuplicateKeyError:
        existing = messages.find_one({"scheduledMessageId": scheduled_id})
        if not existing:
            raise
        message = existing

    event = {"messageId": str(message["_id"]), "senderId": sender_id, "action": "created"}
    if group:
        groups_collection().update_one({"_id": group["_id"]}, {"$max": {"updatedAt": message["createdAt"]}})
        event["groupId"] = item["groupId"]
    else:
        event["receiverId"] = item["receiverId"]
    if group:
        for member in group.get("members", []):
            await sio.emit("message_changed", event, to=f"user:{member['userId']}")
    else:
        await sio.emit("message_changed", event, to=f"user:{sender_id}")
        await sio.emit("message_changed", event, to=f"user:{item['receiverId']}")
    # Mark delivery complete only after realtime notifications succeed. If an
    # emit fails, the worker can retry and the existing-message branch above
    # will re-emit without inserting a duplicate.
    scheduled.update_one({"_id": item["_id"], "status": "processing"},
        {"$set": {"status": "sent", "sentAt": message["createdAt"]},
         "$unset": {"claimedAt": "", "lastError": ""}})

async def scheduled_message_worker() -> None:
    """Poll due messages and recover claims left by a stopped process."""
    while True:
        try:
            now = datetime.now(timezone.utc)
            item = scheduled_messages_collection().find_one_and_update(
                {"sendAt": {"$lte": now}, "$or": [
                    {"status": "pending"},
                    {"status": "processing", "claimedAt": {"$lte": now - SCHEDULED_MESSAGE_CLAIM_TIMEOUT}},
                    {"status": "processing", "claimedAt": {"$exists": False}},
                ]},
                {"$set": {"status": "processing", "claimedAt": now}},
                sort=[("sendAt", 1)], return_document=ReturnDocument.AFTER,
            )
            if not item:
                await asyncio.sleep(SCHEDULED_MESSAGE_POLL_SECONDS)
                continue
            try:
                await deliver_scheduled_message(item)
            except Exception as exc:
                # If the message was already inserted, failures in the remaining
                # delivery steps are retryable: the idempotency key prevents a
                # duplicate insert on the next attempt. Fail only deliveries
                # that never made it into the messages collection.
                existing_delivery = messages_collection().find_one(
                    {"scheduledMessageId": str(item["_id"])}, {"_id": 1}
                )
                next_status = "pending" if existing_delivery else "failed"
                scheduled_messages_collection().update_one(
                    {"_id": item["_id"], "status": "processing"},
                    {"$set": {"status": next_status, "lastError": str(exc)[:300]},
                     "$unset": {"claimedAt": ""}},
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"Scheduled message worker error: {exc}")
            await asyncio.sleep(SCHEDULED_MESSAGE_POLL_SECONDS)

# ---------- Startup ----------

@app.on_event("startup")
async def startup():
    connect_db()
    email_verifications_collection().create_index("email", unique=True)
    email_verifications_collection().create_index("expiresAt", expireAfterSeconds=0)
    verified_email_tokens_collection().create_index("expiresAt", expireAfterSeconds=0)
    stories_collection().create_index("expiresAt", expireAfterSeconds=0)
    # Messages with expiresAt are removed automatically by MongoDB TTL.
    messages_collection().create_index("expiresAt", expireAfterSeconds=0)
    messages_collection().create_index("scheduledMessageId", unique=True, sparse=True)
    friend_requests_collection().create_index([("fromUserId", 1), ("toUserId", 1)])
    blocked_users_collection().create_index("userId")
    saved_messages_collection().create_index("userId")
    scheduled_messages_collection().create_index("sendAt")
    polls_collection().create_index("creatorId")
    vote_index_info = votes_collection().index_information()
    has_unique_vote_index = any(
        index.get("unique") and index.get("key") == [("pollId", 1), ("userId", 1)]
        for index in vote_index_info.values()
    )
    if not has_unique_vote_index:
        # Keep the most recent vote for each user/poll pair before enforcing uniqueness.
        duplicates = votes_collection().aggregate([
            {"$match": {"pollId": {"$type": "string"}, "userId": {"$type": "string"}}},
            {"$sort": {"pollId": 1, "userId": 1, "votedAt": -1, "_id": -1}},
            {"$group": {"_id": {"pollId": "$pollId", "userId": "$userId"}, "ids": {"$push": "$_id"}}},
            {"$match": {"ids.1": {"$exists": True}}},
        ], allowDiskUse=True)
        for duplicate in duplicates:
            votes_collection().delete_many({"_id": {"$in": duplicate["ids"][1:]}})
        if "pollId_1_userId_1" in vote_index_info:
            votes_collection().drop_index("pollId_1_userId_1")
        votes_collection().create_index(
            [("pollId", 1), ("userId", 1)],
            unique=True,
            partialFilterExpression={"pollId": {"$type": "string"}, "userId": {"$type": "string"}},
        )
    user_settings_collection().create_index("userId")
    login_history_collection().create_index("userId")
    login_history_collection().create_index("loginAt", expireAfterSeconds=180 * 24 * 60 * 60)
    reports_collection().create_index("targetId")
    bots_collection().create_index("ownerId")
    gifts_collection().create_index("name")
    global _scheduled_worker_task
    if _scheduled_worker_task is None or _scheduled_worker_task.done():
        _scheduled_worker_task = asyncio.create_task(scheduled_message_worker())
    print("DEBUG startup: MongoDB connected (python-api)")


@app.on_event("shutdown")
async def shutdown_scheduled_message_worker():
    global _scheduled_worker_task
    if _scheduled_worker_task is not None:
        _scheduled_worker_task.cancel()
        try:
            await _scheduled_worker_task
        except asyncio.CancelledError:
            pass
        _scheduled_worker_task = None


# ---------- Health ----------

@app.get("/")
def root():
    return {"status": "ok", "service": "python-api"}


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.get("/ready")
def readiness():
    """Readiness check: report healthy only when MongoDB responds to ping."""
    try:
        get_db().command("ping")
    except PyMongoError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    return {"status": "ready", "database": "connected"}


# ---------- Auth ----------

@app.post("/auth/register")
def register(payload: RegisterRequest):
    users = users_collection()
    email = str(payload.email).lower()
    username = payload.username.lower()

    if users.find_one({"username": {"$regex": f"^{re.escape(username)}$", "$options": "i"}}):
        raise HTTPException(status_code=409, detail="Username already taken")

    registration_token_hash = hashlib.sha256(payload.verificationToken.encode()).hexdigest()
    verified_email_token = verified_email_tokens_collection().find_one_and_delete({
        "email": email,
        "tokenHash": registration_token_hash,
        "expiresAt": {"$gt": datetime.now(timezone.utc)},
    })
    if not verified_email_token:
        raise HTTPException(status_code=400, detail="Подтвердите email перед регистрацией.")
    if users.find_one({"email": email}):
        raise HTTPException(
            status_code=400,
            detail="Не удалось создать аккаунт. Проверьте данные и попробуйте снова.",
        )

    created_at = datetime.now(timezone.utc)
    doc = {
        "email": email,
        "username": username,
        "displayName": username,
        "isEmailVerified": True,
        "passwordHash": hash_password(payload.password),
        "avatarUrl": "",
        "bio": "",
        "statusText": "",
        "showLastSeen": True,
        "hideOnlineStatus": False,
        "hideReadReceipts": False,
        "hideDateOfBirth": False,
        "isPremium": False,
        "premiumUntil": None,
        "coinsBalance": 0,
        "contacts": [],
        "createdAt": created_at,
        "lastSeen": datetime.now(timezone.utc),
    }
    result = users.insert_one(doc)
    user_id = str(result.inserted_id)

    token = create_token(user_id, email, payload.username)

    return {
        "token": token,
        "user": {
            "id": user_id,
            "email": email,
            "username": payload.username,
            "displayName": payload.username,
            "isEmailVerified": True,
            "isPremium": False,
            "premiumUntil": None,
            "coinsBalance": 0,
            "hideDateOfBirth": False,
            "dateOfBirth": None,
            "createdAt": created_at.isoformat(),
        },
    }


def send_email_verification_message(email: str, code: str, verification_link: str = "") -> None:
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com").strip()
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "").strip()
    smtp_password = os.getenv("SMTP_PASSWORD", "").replace(" ", "").strip()
    if not smtp_user or not smtp_password:
        raise RuntimeError("SMTP_USER and SMTP_PASSWORD must be configured in environment")

    message = EmailMessage()
    message["Subject"] = "Код подтверждения OurSocial"
    message["From"] = smtp_user
    message["To"] = email

    plain_content = f"Ваш код подтверждения для Skyline: {code}. Код действителен 10 минут."
    if verification_link:
        plain_content += f"\n\nИли нажмите на ссылку для подтверждения в один клик:\n{verification_link}\n"
    message.set_content(plain_content)

    if verification_link:
        html_content = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 32px 16px; background-color: #0b1120; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f8fafc;">
  <div style="max-width: 480px; margin: 0 auto; background: #131d31; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; padding: 36px 28px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4);">
    <div style="display: inline-block; width: 48px; height: 48px; line-height: 48px; background: linear-gradient(135deg, #6366f1, #38bdf8); border-radius: 14px; font-size: 24px; margin-bottom: 20px;">
      ✨
    </div>
    <h1 style="margin: 0 0 10px 0; font-size: 24px; font-weight: 700; color: #ffffff;">OurSocial</h1>
    <p style="margin: 0 0 28px 0; font-size: 15px; color: #94a3b8; line-height: 1.5;">
      Вы почти зарегистрировались! Нажмите на кнопку ниже, чтобы подтвердить ваш адрес электронной почты в один клик:
    </p>
    <div style="margin: 28px 0;">
      <a href="{verification_link}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #4f46e5); color: #ffffff; text-decoration: none; padding: 16px 36px; border-radius: 14px; font-weight: 700; font-size: 16px; box-shadow: 0 10px 25px rgba(99, 102, 241, 0.35);">
        Подтвердить почту в 1 клик →
      </a>
    </div>
    <div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 18px; margin-top: 26px;">
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #94a3b8;">Или введите 6-значный код подтверждения:</p>
      <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #38bdf8; font-family: monospace;">{code}</div>
    </div>
    <p style="margin: 26px 0 0 0; font-size: 12px; color: #64748b; line-height: 1.5;">
      Код и ссылка действительны в течение 10 минут.<br/>Если вы не создавали аккаунт, просто проигнорируйте это письмо.
    </p>
  </div>
</body>
</html>"""
        message.add_alternative(html_content, subtype="html")

    # Connect via port 465 SSL or port 587 STARTTLS with auto-fallback
    if smtp_port == 465:
        with smtplib.SMTP_SSL(smtp_host, smtp_port, context=ssl.create_default_context(), timeout=15) as smtp_ssl:
            smtp_ssl.login(smtp_user, smtp_password)
            smtp_ssl.send_message(message)
    else:
        try:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as smtp:
                smtp.ehlo()
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
                smtp.login(smtp_user, smtp_password)
                smtp.send_message(message)
        except (TimeoutError, OSError) as port_err:
            print(f"SMTP port {smtp_port} failed ({port_err}), falling back to port 465 SSL...")
            with smtplib.SMTP_SSL(smtp_host, 465, context=ssl.create_default_context(), timeout=15) as smtp_ssl:
                smtp_ssl.login(smtp_user, smtp_password)
                smtp_ssl.send_message(message)


@app.post("/auth/send-email-code")
def send_email_code(payload: SendEmailCodeRequest):
    email = str(payload.email).lower()
    verifications = email_verifications_collection()
    existing = verifications.find_one({"email": email}, {"lastSentAt": 1, "sendWindowStartedAt": 1, "sendCount": 1})
    if not isinstance(existing, dict):
        existing = None
    now = datetime.now(timezone.utc)
    if existing:
        last_sent_at = existing.get("lastSentAt")
        if last_sent_at and (now - last_sent_at.replace(tzinfo=last_sent_at.tzinfo or timezone.utc)).total_seconds() < 60:
            raise HTTPException(status_code=429, detail="Подождите минуту перед повторным запросом кода.")
        window_started_at = existing.get("sendWindowStartedAt")
        if window_started_at:
            window_started_at = window_started_at.replace(tzinfo=window_started_at.tzinfo or timezone.utc)
        if window_started_at and (now - window_started_at).total_seconds() < 3600 and int(existing.get("sendCount", 0)) >= 5:
            raise HTTPException(status_code=429, detail="Превышен лимит запросов кода для этого адреса. Попробуйте позже.")
    window_started_at = existing.get("sendWindowStartedAt") if existing else None
    if not window_started_at or (now - window_started_at.replace(tzinfo=window_started_at.tzinfo or timezone.utc)).total_seconds() >= 3600:
        window_started_at = now
        send_count = 1
    else:
        send_count = int(existing.get("sendCount", 0)) + 1
    code = f"{secrets.randbelow(1_000_000):06d}"
    link_token = secrets.token_urlsafe(32)

    verifications.update_one(
        {"email": email},
        {"$set": {
            "email": email,
            "code": code,
            "token": link_token,
            "expiresAt": now + timedelta(minutes=10),
            "failedAttempts": 0,
            "lastSentAt": now,
            "sendWindowStartedAt": window_started_at,
            "sendCount": send_count,
        }},
        upsert=True,
    )
    verified_email_tokens_collection().delete_many({"email": email})

    frontend_base = get_frontend_base_url()
    verification_link = f"{frontend_base}/#/verify-email?email={quote_plus(email)}&code={code}&token={link_token}"

    try:
        send_email_verification_message(email, code, verification_link)
    except (OSError, smtplib.SMTPException, RuntimeError, ValueError) as error:
        email_verifications_collection().delete_one({"email": email, "token": link_token})
        print(f"Email delivery failed ({type(error).__name__}): {error}")
        raise HTTPException(
            status_code=503,
            detail="Не удалось отправить письмо подтверждения. Попробуйте позже.",
        ) from error

    return {
        "status": "ok",
        "message": "Письмо со ссылкой подтверждения отправлено на вашу почту.",
        "expiresInSeconds": 600,
        "emailSent": True,
    }


@app.get("/auth/verify-link")
def verify_link_get(email: str, token: str):
    email = str(email).lower()
    verifications = email_verifications_collection()
    verification = verifications.find_one({"email": email})
    frontend_base = get_frontend_base_url()

    if not verification:
        return RedirectResponse(f"{frontend_base}/#/register?error=code_not_requested")

    now = datetime.now(timezone.utc)
    expires_at = verification["expiresAt"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now:
        verifications.delete_one({"_id": verification["_id"]})
        return RedirectResponse(f"{frontend_base}/#/register?error=code_expired")

    if not verification.get("token") or not hmac.compare_digest(str(verification["token"]), token):
        return RedirectResponse(f"{frontend_base}/#/register?error=invalid_token")

    verifications.find_one_and_delete({"_id": verification["_id"]})

    registration_token = secrets.token_urlsafe(32)
    registration_token_hash = hashlib.sha256(registration_token.encode()).hexdigest()
    verified_tokens = verified_email_tokens_collection()
    verified_tokens.delete_many({"email": email})
    users_collection().update_one(
        {"email": email},
        {"$set": {"isEmailVerified": True}},
    )
    verified_tokens.insert_one({
        "email": email,
        "tokenHash": registration_token_hash,
        "expiresAt": now + timedelta(minutes=15),
    })

    return RedirectResponse(f"{frontend_base}/#/verify-email?email={quote_plus(email)}&registrationToken={registration_token}&verified=true")


@app.post("/auth/verify-email-token")
def verify_email_token(payload: VerifyEmailTokenRequest):
    email = str(payload.email).lower()
    verifications = email_verifications_collection()
    verification = verifications.find_one({"email": email})
    if not verification:
        raise HTTPException(status_code=400, detail="Код подтверждения не запрошен.")

    now = datetime.now(timezone.utc)
    expires_at = verification["expiresAt"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now:
        verifications.delete_one({"_id": verification["_id"]})
        raise HTTPException(status_code=400, detail="Срок действия ссылки истёк. Запросите новую.")

    if not verification.get("token") or not hmac.compare_digest(str(verification["token"]), payload.token):
        raise HTTPException(status_code=400, detail="Неверная или устаревшая ссылка подтверждения.")

    consumed = verifications.find_one_and_delete({"_id": verification["_id"]})
    if not consumed:
        raise HTTPException(status_code=400, detail="Ссылка уже использована.")

    registration_token = secrets.token_urlsafe(32)
    registration_token_hash = hashlib.sha256(registration_token.encode()).hexdigest()
    verified_tokens = verified_email_tokens_collection()
    verified_tokens.delete_many({"email": email})
    users_collection().update_one(
        {"email": email},
        {"$set": {"isEmailVerified": True}},
    )
    verified_tokens.insert_one({
        "email": email,
        "tokenHash": registration_token_hash,
        "expiresAt": now + timedelta(minutes=15),
    })
    return {
        "status": "ok",
        "message": "Email успешно подтверждён.",
        "registrationToken": registration_token,
    }


@app.post("/auth/verify-email-code")
def verify_email_code(payload: VerifyEmailCodeRequest):
    email = str(payload.email).lower()
    verifications = email_verifications_collection()
    verification = verifications.find_one({"email": email})
    if not verification:
        raise HTTPException(status_code=400, detail="Код не запрошен.")

    now = datetime.now(timezone.utc)
    expires_at = verification["expiresAt"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now:
        verifications.delete_one({"_id": verification["_id"]})
        raise HTTPException(status_code=400, detail="Код истёк. Запросите новый код.")

    failed_attempts = int(verification.get("failedAttempts", 0))
    if failed_attempts >= 5:
        verifications.update_one(
            {"_id": verification["_id"]},
            {"$set": {"failedAttempts": 0}},
        )
        verifications.delete_one({"_id": verification["_id"]})
        raise HTTPException(
            status_code=429,
            detail="Слишком много попыток. Запросите новый код.",
        )

    if not hmac.compare_digest(str(verification["code"]), payload.code):
        updated_verification = verifications.find_one_and_update(
            {"_id": verification["_id"]},
            {"$inc": {"failedAttempts": 1}},
            return_document=ReturnDocument.AFTER,
        )
        if not updated_verification:
            raise HTTPException(status_code=400, detail="Код не запрошен.")
        failed_attempts = int(updated_verification.get("failedAttempts", 0))
        if failed_attempts >= 5:
            verifications.delete_one({"_id": verification["_id"]})
            raise HTTPException(
                status_code=429,
                detail="Слишком много попыток. Запросите новый код.",
            )
        remaining = 5 - failed_attempts
        raise HTTPException(
            status_code=400,
            detail=f"Неверный код. Осталось попыток: {remaining}.",
        )

    consumed_verification = verifications.find_one_and_delete({
        "_id": verification["_id"],
        "code": payload.code,
    })
    if not consumed_verification:
        raise HTTPException(status_code=400, detail="Код не запрошен или уже использован.")

    registration_token = secrets.token_urlsafe(32)
    registration_token_hash = hashlib.sha256(registration_token.encode()).hexdigest()
    verified_tokens = verified_email_tokens_collection()
    verified_tokens.delete_many({"email": email})
    users_collection().update_one(
        {"email": email},
        {"$set": {"isEmailVerified": True}},
    )
    verified_tokens.insert_one({
        "email": email,
        "tokenHash": registration_token_hash,
        "expiresAt": now + timedelta(minutes=15),
    })
    return {
        "status": "ok",
        "message": "Email подтверждён.",
        "registrationToken": registration_token,
    }


@app.post("/auth/login")
def login(payload: LoginRequest, request: Request):
    enforce_login_rate_limit(request)
    users = users_collection()
    user = users.find_one({"email": str(payload.email).lower()})
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not verify_password(payload.password, user["passwordHash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user_id = str(user["_id"])
    token = create_token(user_id, user["email"], user["username"])

    users.update_one(
        {"_id": user["_id"]},
        {"$set": {"lastSeen": datetime.now(timezone.utc)}},
    )

    # Keep a bounded audit trail for the existing login-history endpoint.
    login_history_collection().insert_one({
        "userId": user_id,
        "ipAddress": request.client.host if request.client else "",
        "userAgent": request.headers.get("user-agent", "")[:512],
        "loginAt": datetime.now(timezone.utc),
    })

    return {
        "token": token,
        "user": {
            "id": user_id,
            "email": user["email"],
            "isEmailVerified": user.get("isEmailVerified", False),
            "username": user["username"],
            "displayName": user.get("displayName", user["username"]),
            "avatarUrl": user.get("avatarUrl", ""),
            "bio": user.get("bio", ""),
            "statusText": user.get("statusText", ""),
            "showLastSeen": user.get("showLastSeen", True),
            "hideOnlineStatus": user.get("hideOnlineStatus", False),
            "hideReadReceipts": user.get("hideReadReceipts", False),
            "hideDateOfBirth": user.get("hideDateOfBirth", False),
            "dateOfBirth": user.get("dateOfBirth"),
            "createdAt": user.get("createdAt"),
            **serialize_premium(user),
        },
    }


@app.get("/auth/me")
def me(current=Depends(get_current_user)):
    users = users_collection()
    try:
        user = users.find_one({"_id": ObjectId(current["userId"])})
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid user id")

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return {
        "id": str(user["_id"]),
        "email": user["email"],
        "isEmailVerified": user.get("isEmailVerified", False),
        "username": user["username"],
        "displayName": user.get("displayName", user["username"]),
        "avatarUrl": user.get("avatarUrl", ""),
        "bio": user.get("bio", ""),
        "statusText": user.get("statusText", ""),
        "showLastSeen": user.get("showLastSeen", True),
        "hideOnlineStatus": user.get("hideOnlineStatus", False),
        "hideReadReceipts": user.get("hideReadReceipts", False),
        "hideDateOfBirth": user.get("hideDateOfBirth", False),
        "dateOfBirth": user.get("dateOfBirth"),
        "createdAt": user.get("createdAt"),
        **serialize_premium(user),
    }


@app.patch("/users/me/privacy")
async def update_privacy(payload: PrivacyRequest, current=Depends(get_current_user)):
    users = users_collection()
    privacy_updates = {
        "hideOnlineStatus": payload.hideOnlineStatus,
        "hideReadReceipts": payload.hideReadReceipts,
    }
    if payload.hideDateOfBirth is not None:
        privacy_updates["hideDateOfBirth"] = payload.hideDateOfBirth
    result = users.update_one(
        {"_id": ObjectId(current["userId"])},
        {"$set": privacy_updates},
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=404, detail="User not found")

    from realtime import set_user_online_hidden
    await set_user_online_hidden(current["userId"], payload.hideOnlineStatus)
    return {"status": "ok"}


# ---------- Users ----------

@app.get("/users/search")
def search_users(q: str = "", current=Depends(get_current_user)):
    query = q.strip().lstrip("@").strip()
    if len(query) < 2 or len(query) > 64:
        return []

    # Search by a partial username or display name; escape user input so it
    # cannot change the regular expression's meaning.
    escaped = re.escape(query)
    users = users_collection()
    results = list(users.find(
        {
            "_id": {"$ne": ObjectId(current["userId"])} if ObjectId.is_valid(current.get("userId", "")) else {},
            "$or": [
                {"username": {"$regex": escaped, "$options": "i"}},
                {"displayName": {"$regex": escaped, "$options": "i"}},
            ],
        },
        {"email": 0, "passwordHash": 0},
    ).limit(50))

    # Prefer usernames beginning with the query, then display-name matches.
    normalized = query.casefold()
    results.sort(key=lambda u: (
        0 if str(u.get("username", "")).casefold().startswith(normalized) else
        1 if str(u.get("displayName", "")).casefold().startswith(normalized) else 2,
        str(u.get("username", "")).casefold(),
    ))
    return [
        {
            "id": str(u["_id"]),
            "username": u["username"],
            "displayName": u.get("displayName", u["username"]),
            "avatarUrl": u.get("avatarUrl", ""),
            "bio": u.get("bio", ""),
            "statusText": u.get("statusText", ""),
            "isPremium": serialize_premium(u)["isPremium"],
            **({"lastSeen": u.get("lastSeen")} if u.get("showLastSeen", True) else {}),
        }
        for u in results[:30]
    ]

@app.patch("/users/me/profile")
def update_profile(payload: UpdateProfileRequest, current=Depends(get_current_user)):
    users = users_collection()
    user_id = current["userId"]
    username = payload.username.lower()
    
    existing_user = users.find_one({"username": {"$regex": f"^{re.escape(username)}$", "$options": "i"}})
    if existing_user and str(existing_user["_id"]) != user_id:
        raise HTTPException(status_code=409, detail="Username already taken")

    users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {
            "displayName": payload.displayName,
            "username": username,
            "avatarUrl": payload.avatarUrl,
            "bio": payload.bio,
            "statusText": payload.statusText,
            "showLastSeen": payload.showLastSeen,
            "dateOfBirth": payload.dateOfBirth.isoformat() if payload.dateOfBirth else None,
        }}
    )
    
    return {"status": "ok", "message": "Profile updated"}


@app.get("/unread/summary")
def unread_summary(current=Depends(get_current_user)):
    me = current["userId"]
    now = datetime.now(timezone.utc)
    active_message_filter = {
        "deletedForAll": {"$ne": True},
        "$or": [
            {"expiresAt": {"$exists": False}},
            {"expiresAt": {"$gt": now}},
        ],
    }
    chats_unread = messages_collection().count_documents({
        "receiverId": me,
        "senderId": {"$ne": me},
        "read": False,
        "groupId": {"$exists": False},
        **active_message_filter,
    })
    groups_unread = 0
    member_groups = groups_collection().find(
        {"members.userId": me},
        {"_id": 1, "members": 1},
    )
    for group in member_groups:
        member = next(
            (item for item in group.get("members", []) if item.get("userId") == me),
            None,
        )
        if not member:
            continue
        group_filter = {
            "groupId": str(group["_id"]),
            "senderId": {"$ne": me},
            "readBy": {"$ne": me},
            **active_message_filter,
        }
        joined_at = member.get("joinedAt")
        if joined_at is not None:
            group_filter["createdAt"] = {"$gte": joined_at}
        groups_unread += messages_collection().count_documents(group_filter)
    owner = users_collection().find_one({"_id": ObjectId(me)}, {"channelReads": 1})
    channel_reads = (owner or {}).get("channelReads") or {}
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    channels_unread = 0
    for ch_doc in channels_collection().find({"members.userId": me}, {"_id": 1}):
        cid = str(ch_doc["_id"])
        channels_unread += channel_posts_collection().count_documents({
            "channelId": cid,
            "createdAt": {"$gt": channel_reads.get(cid) or epoch},
        })
    return {"chats": chats_unread, "groups": groups_unread, "channels": channels_unread}


@app.get("/contacts")
def get_contacts(current=Depends(get_current_user)):
    users = users_collection()
    owner = users.find_one(
        {"_id": ObjectId(current["userId"])},
        {"contacts": 1, "hiddenChats": 1},
    )
    if not owner:
        raise HTTPException(status_code=404, detail="User not found")

    contacts = owner.get("contacts", [])
    contact_ids = []
    for contact in contacts:
        try:
            contact_id = contact.get("userId") if isinstance(contact, dict) else contact
            if ObjectId.is_valid(contact_id):
                contact_ids.append(ObjectId(contact_id))
        except (KeyError, TypeError, ValueError):
            continue

    profile_by_id = {
        str(user["_id"]): user
        for user in users.find(
            {"_id": {"$in": contact_ids}},
            {"email": 0, "passwordHash": 0, "contacts": 0},
        )
    }
    hidden_chats = {
        entry.get("userId"): entry.get("hiddenAt")
        for entry in owner.get("hiddenChats", [])
        if isinstance(entry, dict) and isinstance(entry.get("userId"), str)
    }
    current_id = current["userId"]

    # Exclude deleted and expired messages from previews and per-chat unread counts.
    now = datetime.now(timezone.utc)
    chat_pipeline = [
        {"$match": {
            "$or": [{"senderId": current_id}, {"receiverId": current_id}],
            "groupId": {"$exists": False},
            "deletedForAll": {"$ne": True},
            "$and": [{"$or": [
                {"expiresAt": {"$exists": False}},
                {"expiresAt": {"$gt": now}},
            ]}],
        }},
        {"$sort": {"createdAt": 1, "_id": 1}},
        {"$addFields": {
            "partner": {"$cond": [{"$eq": ["$senderId", current_id]}, "$receiverId", "$senderId"]},
            "fromPartner": {"$ne": ["$senderId", current_id]},
        }},
        {"$group": {
            "_id": "$partner",
            "unread": {"$sum": {"$cond": [{"$and": ["$fromPartner", {"$eq": ["$read", False]}]}, 1, 0]}},
            "lastAt": {"$max": "$createdAt"},
            "lastMessageText": {"$last": "$text"},
            "lastMessageType": {"$last": "$type"},
            "lastMessageFileName": {"$last": "$fileName"},
            "lastMessageSenderId": {"$last": "$senderId"},
        }},
    ]
    chat_stats = {
        str(row["_id"]): row
        for row in messages_collection().aggregate(chat_pipeline)
        if str(row["_id"]) != current_id
    }

    result = []
    for contact in contacts:
        contact_id = contact.get("userId") if isinstance(contact, dict) else str(contact)
        # A blocked relationship must not make the former contact reappear in the chat list.
        if users_blocked_either_way(current_id, contact_id):
            continue
        if contact_id not in profile_by_id:
            continue
        hidden_at = hidden_chats.get(contact_id)
        latest_message = None
        if hidden_at:
            latest_message = messages_collection().find_one(
                {
                    "$or": [
                        {"senderId": current_id, "receiverId": contact_id},
                        {"senderId": contact_id, "receiverId": current_id},
                    ]
                },
                {"createdAt": 1},
                sort=[("createdAt", -1), ("_id", -1)],
            )
        profile = profile_by_id[contact_id]
        result.append({
            "id": contact_id,
            "nickname": (contact.get("nickname") or profile.get("username", "Пользователь")) if isinstance(contact, dict) else profile.get("username", "Пользователь"),
            "username": profile["username"],
            "displayName": profile.get("displayName", profile["username"]),
            "avatarUrl": profile.get("avatarUrl", ""),
            "bio": profile.get("bio", ""),
            "statusText": profile.get("statusText", ""),
            "isPremium": serialize_premium(profile)["isPremium"],
            **({"lastSeen": profile.get("lastSeen")} if profile.get("showLastSeen", True) else {}),
            "chatHidden": bool(hidden_at and (
                not latest_message or latest_message["createdAt"] <= hidden_at
            )),
            "unreadCount": chat_stats.get(contact_id, {}).get("unread", 0),
            "lastMessageAt": chat_stats.get(contact_id, {}).get("lastAt").isoformat() if chat_stats.get(contact_id, {}).get("lastAt") else None,
            "lastMessageText": chat_stats.get(contact_id, {}).get("lastMessageText", ""),
            "lastMessageType": chat_stats.get(contact_id, {}).get("lastMessageType", "text"),
            "lastMessageFileName": chat_stats.get(contact_id, {}).get("lastMessageFileName"),
            "lastMessageSenderId": chat_stats.get(contact_id, {}).get("lastMessageSenderId"),
            "isContact": True,
        })

    # Партнёры по переписке, которых нет в контактах (чат появляется сам, как в Telegram)
    known_ids = {str(c) for c in contact_ids}
    for partner_id, stats in chat_stats.items():
        if partner_id in known_ids:
            continue
        # Old message history is retained, but blocked conversations stay out of the chat list.
        if users_blocked_either_way(current_id, partner_id):
            continue
        profile = users.find_one(
            {"_id": ObjectId(partner_id)},
            {"email": 0, "passwordHash": 0, "contacts": 0},
        )
        if not profile:
            continue
        hidden_at = hidden_chats.get(partner_id)
        if hidden_at and stats.get("lastAt", datetime.min.replace(tzinfo=timezone.utc)) <= hidden_at:
            continue
        result.append({
            "id": partner_id,
            "nickname": profile["username"],
            "username": profile["username"],
            "displayName": profile.get("displayName", profile["username"]),
            "avatarUrl": profile.get("avatarUrl", ""),
            "bio": profile.get("bio", ""),
            "statusText": profile.get("statusText", ""),
            "isPremium": serialize_premium(profile)["isPremium"],
            **({"lastSeen": profile.get("lastSeen")} if profile.get("showLastSeen", True) else {}),
            "chatHidden": False,
            "unreadCount": stats.get("unread", 0),
            "lastMessageAt": stats.get("lastAt").isoformat() if stats.get("lastAt") else None,
            "lastMessageText": stats.get("lastMessageText", ""),
            "lastMessageType": stats.get("lastMessageType", "text"),
            "lastMessageFileName": stats.get("lastMessageFileName"),
            "lastMessageSenderId": stats.get("lastMessageSenderId"),
            "isContact": False,
        })

    epoch = datetime.min.replace(tzinfo=timezone.utc)
    result.sort(key=lambda item: chat_stats.get(item["id"], {}).get("lastAt") or epoch, reverse=True)
    return result


@app.put("/contacts")
def add_or_update_contact(payload: ContactRequest, current=Depends(get_current_user)):
    if not ObjectId.is_valid(payload.userId):
        raise HTTPException(status_code=400, detail="Invalid user id")

    owner_id = ObjectId(current["userId"])
    target_id = ObjectId(payload.userId)
    if owner_id == target_id:
        raise HTTPException(status_code=400, detail="Cannot add yourself to contacts")

    users = users_collection()
    target = users.find_one({"_id": target_id}, {"_id": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    owner = users.find_one({"_id": owner_id}, {"_id": 1})
    if not owner:
        raise HTTPException(status_code=404, detail="User not found")

    contact = {"userId": payload.userId, "nickname": payload.nickname.strip()}
    updated = users.update_one(
        {"_id": owner_id, "contacts.userId": payload.userId},
        {"$set": {"contacts.$.nickname": contact["nickname"]}},
    )
    if not updated.matched_count:
        users.update_one({"_id": owner_id}, {"$push": {"contacts": contact}})

    return {"status": "ok", "contact": contact}


@app.delete("/contacts/{user_id}")
def remove_contact(user_id: str, current=Depends(get_current_user)):
    if not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=400, detail="Invalid user id")

    users = users_collection()
    result = users.update_one(
        {"_id": ObjectId(current["userId"])},
        {"$pull": {"contacts": {"userId": user_id}}},
    )
    if not result.matched_count:
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "ok"}


@app.delete("/chats/{user_id}")
def delete_chat(user_id: str, current=Depends(get_current_user)):
    if not ObjectId.is_valid(user_id) or user_id == current["userId"]:
        raise HTTPException(status_code=400, detail="Invalid chat user id")

    users = users_collection()
    owner_id = ObjectId(current["userId"])
    owner = users.find_one({"_id": owner_id}, {"hiddenChats": 1})
    if not owner:
        raise HTTPException(status_code=404, detail="User not found")

    hidden_at = datetime.now(timezone.utc)
    updated = users.update_one(
        {"_id": owner_id, "hiddenChats.userId": user_id},
        {"$set": {"hiddenChats.$.hiddenAt": hidden_at}},
    )
    if not updated.matched_count:
        users.update_one(
            {"_id": owner_id},
            {"$push": {"hiddenChats": {"userId": user_id, "hiddenAt": hidden_at}}},
        )
    return {"status": "ok"}


@app.get("/users/{user_id}")
def get_user(user_id: str, current=Depends(get_current_user)):
    if not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=400, detail="Invalid user id")

    users = users_collection()
    user = users.find_one(
        {"_id": ObjectId(user_id)},
        {"email": 0, "passwordHash": 0, "contacts": 0},
    )

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    profile = {
        "id": str(user["_id"]),
        "username": user["username"],
        "displayName": user.get("displayName", user["username"]),
        "avatarUrl": user.get("avatarUrl", ""),
        "bio": user.get("bio", ""),
        "statusText": user.get("statusText", ""),
        "createdAt": user.get("createdAt"),
        "isPremium": serialize_premium(user)["isPremium"],
    }
    if str(user["_id"]) == current["userId"] or not user.get("hideDateOfBirth", False):
        profile["dateOfBirth"] = user.get("dateOfBirth")
    if str(user["_id"]) == current["userId"] or user.get("showLastSeen", True):
        profile["lastSeen"] = user.get("lastSeen")
    return profile


# ---------- Messages (НОВЫЙ РАЗДЕЛ) ----------

MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024
HYBRID_ENVELOPE_PREFIX = "skyline-e2e:v4:"


def validate_v4_envelope(value: str, max_ciphertext_bytes: int, expected_recipients: set[str] | None = None) -> None:
    if not value.startswith(HYBRID_ENVELOPE_PREFIX):
        raise HTTPException(status_code=400, detail="Message must use the supported end-to-end encrypted format")
    try:
        envelope = json.loads(value[len(HYBRID_ENVELOPE_PREFIX):])
        recipients = envelope["recipients"]
        ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
        payload_iv = base64.b64decode(envelope["iv"], validate=True)
        if not isinstance(recipients, dict) or not recipients or len(recipients) > 100:
            raise ValueError("invalid recipients")
        if expected_recipients is not None and set(recipients) != expected_recipients:
            raise ValueError("recipient set mismatch")
        if len(ciphertext) < 16 or len(ciphertext) > max_ciphertext_bytes or len(payload_iv) != 12:
            raise ValueError("invalid payload size")
        for recipient in recipients.values():
            salt = base64.b64decode(recipient["salt"], validate=True)
            iv = base64.b64decode(recipient["iv"], validate=True)
            wrapped_key = base64.b64decode(recipient["wrappedKey"], validate=True)
            if len(salt) != 16 or len(iv) != 12 or len(wrapped_key) != 48:
                raise ValueError("invalid wrapped key")
            ephemeral_key = recipient["ephemeralPublicKey"]
            if not isinstance(ephemeral_key, dict) or ephemeral_key.get("kty") != "EC" or not validate_public_key(json.dumps(ephemeral_key)):
                raise ValueError("invalid ephemeral key")
    except (KeyError, TypeError, ValueError, binascii.Error, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="Invalid encrypted message envelope")


def serialize_message(message):
    deleted_for_all = message.get("deletedForAll", False)
    return {
        "id": str(message["_id"]),
        "senderId": message["senderId"],
        "receiverId": message["receiverId"],
        "text": "Сообщение удалено" if deleted_for_all else message.get("text", ""),
        "type": "text" if deleted_for_all else message.get("type", "text"),
        "fileName": "" if deleted_for_all else message.get("fileName", ""),
        "contentType": "" if deleted_for_all else message.get("contentType", ""),
        "fileData": "" if deleted_for_all else message.get("fileData", ""),
        "reactions": message.get("reactions", []),
        "pinned": message.get("pinned", False),
        "pinnedAt": message.get("pinnedAt").isoformat() if message.get("pinnedAt") else None,
        "createdAt": message["createdAt"].isoformat(),
        "read": message.get("read", False),
        "groupId": message.get("groupId"),
        "edited": message.get("edited", False),
        "replyTo": message.get("replyTo"),
        "forwardedFrom": message.get("forwardedFrom"),
    }


def serialize_message_update(message):
    serialized = serialize_message(message)
    serialized.pop("fileData", None)
    return serialized


def find_message_for_user(message_id: str, user_id: str):
    if not ObjectId.is_valid(message_id):
        raise HTTPException(status_code=400, detail="Invalid message id")
    message = messages_collection().find_one({"_id": ObjectId(message_id)})
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if message.get("deletedForAll"):
        raise HTTPException(status_code=404, detail="Message not found")
    expires_at = message.get("expiresAt")
    if expires_at:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= datetime.now(timezone.utc):
            raise HTTPException(status_code=404, detail="Message not found")
    group_id = message.get("groupId")
    if group_id:
        # Group messages must always pass current membership checks, even when
        # the requester is the original sender (group messages use receiverId="").
        if not ObjectId.is_valid(group_id):
            raise HTTPException(status_code=404, detail="Message not found")
        group = groups_collection().find_one(
            {"_id": ObjectId(group_id), "members.userId": user_id},
            {"members.$": 1},
        )
        membership = (group or {}).get("members", [])
        if not membership or message["createdAt"] < membership[0]["joinedAt"]:
            raise HTTPException(status_code=404, detail="Message not found")
    elif user_id in (message.get("senderId"), message.get("receiverId")):
        other_id = message["receiverId"] if message["senderId"] == user_id else message["senderId"]
        owner = users_collection().find_one({"_id": ObjectId(user_id)}, {"hiddenChats": 1}) or {}
        hidden_entry = next(
            (
                entry for entry in owner.get("hiddenChats", [])
                if isinstance(entry, dict) and entry.get("userId") == other_id
            ),
            None,
        )
        if hidden_entry and message["createdAt"] <= hidden_entry["hiddenAt"]:
            raise HTTPException(status_code=404, detail="Message not found")
    else:
        raise HTTPException(status_code=404, detail="Message not found")
    return message


def get_group_for_member(group_id: str, user_id: str):
    if not ObjectId.is_valid(group_id):
        raise HTTPException(status_code=400, detail="Invalid group id")
    group = groups_collection().find_one(
        {"_id": ObjectId(group_id), "members.userId": user_id}
    )
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


def group_message_recipients(group_id: str) -> list[str]:
    group = groups_collection().find_one({"_id": ObjectId(group_id)}, {"members.userId": 1})
    return [member["userId"] for member in (group or {}).get("members", []) if member.get("userId")]


def direct_chat_expiration_minutes(user_a: str, user_b: str) -> int:
    participants = sorted([str(user_a), str(user_b)])
    settings = chat_settings_collection().find_one({"kind": "direct", "participants": participants}, {"disappearingMessages": 1}) or {}
    disappearing = settings.get("disappearingMessages", {})
    if not disappearing.get("enabled"):
        return 0
    try:
        minutes = int(disappearing.get("expireAfterMinutes", 0))
    except (TypeError, ValueError):
        return 0
    return minutes if 1 <= minutes <= 43200 else 0


def enforce_message_rate_limit(user_id: str) -> None:
    now = time.monotonic()
    with message_rate_lock:
        timestamps = message_send_timestamps[user_id]
        while timestamps and now - timestamps[0] >= MESSAGE_RATE_WINDOW_SECONDS:
            timestamps.popleft()
        if len(timestamps) >= MESSAGE_RATE_LIMIT:
            retry_after = MESSAGE_RATE_WINDOW_SECONDS - (now - timestamps[0])
            raise HTTPException(
                status_code=429,
                detail="Too many messages. Please wait before sending again.",
                headers={"Retry-After": f"{retry_after:.2f}"},
            )
        timestamps.append(now)


@app.post("/messages")
async def send_message(payload: MessageRequest, current=Depends(get_current_user)):
    if not ObjectId.is_valid(payload.receiverId):
        raise HTTPException(status_code=400, detail="Invalid receiver id")
    if payload.receiverId == current["userId"]:
        raise HTTPException(status_code=400, detail="Cannot send a message to yourself")
    file_name = ""
    content_type = ""
    file_data = ""
    reply_to = None
    if payload.replyTo:
        original = find_message_for_user(payload.replyTo, current["userId"])
        if original.get("groupId") or {
            str(original.get("senderId")), str(original.get("receiverId"))
        } != {current["userId"], payload.receiverId}:
            raise HTTPException(status_code=400, detail="Reply target must be in this conversation")
        reply_to = str(original["_id"])
    if payload.type == "text":
        if not payload.text.strip():
            raise HTTPException(status_code=400, detail="Message text cannot be empty")
        if not payload.text.startswith(("skyline-e2e:v3:", HYBRID_ENVELOPE_PREFIX)):
            raise HTTPException(status_code=400, detail="Messages must use the supported end-to-end encrypted format")
    else:
        if payload.fileName or payload.contentType:
            raise HTTPException(status_code=400, detail="Attachment metadata must be encrypted on the client")
        validate_v4_envelope(payload.fileData, MAX_ATTACHMENT_SIZE + 1024, {current["userId"], payload.receiverId})
        file_data = payload.fileData

    if users_blocked_either_way(current["userId"], payload.receiverId):
        raise HTTPException(status_code=403, detail="Messaging is unavailable for this user")

    enforce_message_rate_limit(current["userId"])

    messages = messages_collection()
    now = datetime.now(timezone.utc)
    doc = {
        "senderId": current["userId"],
        "receiverId": payload.receiverId,
        "text": payload.text,
        # Store only a generic attachment type. The actual MIME type and name are encrypted.
        "type": "file" if payload.type != "text" else "text",
        "fileName": file_name,
        "contentType": content_type,
        "fileData": file_data,
        "reactions": [],
        "pinned": False,
        "createdAt": now,
        "read": False,
        "replyTo": reply_to,
    }
    expire_after = direct_chat_expiration_minutes(current["userId"], payload.receiverId)
    if expire_after:
        doc["expiresAt"] = now + timedelta(minutes=expire_after)
    result = messages.insert_one(doc)
    doc["_id"] = result.inserted_id
    await sio.emit(
        "message_changed",
        {
            "messageId": str(result.inserted_id),
            "senderId": current["userId"],
            "receiverId": payload.receiverId,
            "action": "created",
        },
        to=f"user:{payload.receiverId}",
    )
    await sio.emit(
        "message_changed",
        {
            "messageId": str(result.inserted_id),
            "senderId": current["userId"],
            "receiverId": payload.receiverId,
            "action": "created",
        },
        to=f"user:{current['userId']}",
    )
    return serialize_message(doc)


@app.get("/messages/{user_id}")
async def get_messages(
    user_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    before: str | None = None,
    current=Depends(get_current_user),
):
    if not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=400, detail="Invalid user id")
    messages = messages_collection()
    my_id = current["userId"]

    participant_filter = {
        "$and": [
            {"$or": [
                {"senderId": my_id, "receiverId": user_id},
                {"senderId": user_id, "receiverId": my_id},
            ]},
            {"$or": [
                {"expiresAt": {"$exists": False}},
                {"expiresAt": {"$gt": datetime.now(timezone.utc)}},
            ]},
        ]
    }
    owner = users_collection().find_one(
        {"_id": ObjectId(my_id)},
        {"hiddenChats": 1, "hideReadReceipts": 1},
    ) or {}
    hidden_entry = next(
        (
            entry for entry in owner.get("hiddenChats", [])
            if isinstance(entry, dict) and entry.get("userId") == user_id
        ),
        None,
    )
    hidden_filter = {"createdAt": {"$gt": hidden_entry["hiddenAt"]}} if hidden_entry else None
    if not before:
        read_filter = {"senderId": user_id, "receiverId": my_id, "read": False}
        if hidden_filter:
            read_filter["createdAt"] = hidden_filter["createdAt"]
        if not owner.get("hideReadReceipts", False):
            newest_unread = messages.find_one(
                read_filter,
                {"_id": 1},
                sort=[("createdAt", -1), ("_id", -1)],
            )
            marked_read = messages.update_many(
                read_filter,
                {"$set": {"read": True}},
            )
            if marked_read.modified_count and newest_unread:
                read_message = messages.find_one({"_id": newest_unread["_id"]})
                await sio.emit(
                    "message_changed",
                    {
                        "messageId": str(newest_unread["_id"]),
                        "action": "read",
                        "senderId": user_id,
                        "receiverId": my_id,
                        "message": serialize_message_update(read_message) if read_message else None,
                    },
                    to=f"user:{user_id}",
                )
        page_filter = {"$and": [participant_filter, hidden_filter]} if hidden_filter else participant_filter
    else:
        if not ObjectId.is_valid(before):
            raise HTTPException(status_code=400, detail="Invalid message cursor")
        cursor_message = messages.find_one(
            {
                "$and": [
                    {"_id": ObjectId(before)},
                    participant_filter,
                    *([hidden_filter] if hidden_filter else []),
                ]
            },
            {"createdAt": 1},
        )
        if not cursor_message:
            raise HTTPException(status_code=400, detail="Message cursor not found in this chat")
        cursor_filter = {
            "$or": [
                {"createdAt": {"$lt": cursor_message["createdAt"]}},
                {
                    "createdAt": cursor_message["createdAt"],
                    "_id": {"$lt": cursor_message["_id"]},
                },
            ]
        }
        page_filter = {"$and": [participant_filter, cursor_filter, *([hidden_filter] if hidden_filter else [])]}

    chat = list(
        messages.find(page_filter)
        .sort([("createdAt", -1), ("_id", -1)])
        .limit(limit)
    )
    chat.reverse()
    return [serialize_message(message) for message in chat]


@app.get("/messages/{message_id}/preview")
def get_message_preview(message_id: str, current=Depends(get_current_user)):
    """Load a reply target without requiring the client to page through older history."""
    message = find_message_for_user(message_id, current["userId"])
    return serialize_message(message)


@app.delete("/messages/{user_id}")
async def delete_message(user_id: str, current=Depends(get_current_user)):
    message = find_message_for_user(user_id, current["userId"])
    if message["senderId"] != current["userId"]:
        raise HTTPException(status_code=403, detail="You can only delete your own messages")

    messages_collection().delete_one({"_id": message["_id"], "senderId": current["userId"]})
    event = {
        "messageId": user_id,
        "action": "deleted",
        "groupId": message.get("groupId"),
        "senderId": message["senderId"],
        "receiverId": message["receiverId"],
    }
    recipients = group_message_recipients(message["groupId"]) if message.get("groupId") else [
        message["receiverId"], message["senderId"]
    ]
    for recipient_id in set(recipients):
        await sio.emit("message_changed", event, to=f"user:{recipient_id}")
    return {"status": "ok"}


@app.post("/messages/{message_id}/reactions")
async def toggle_reaction(
    message_id: str,
    payload: ReactionRequest,
    current=Depends(get_current_user),
):
    message = find_message_for_user(message_id, current["userId"])
    reaction = {"userId": current["userId"], "emoji": payload.emoji}
    messages = messages_collection()
    if reaction in message.get("reactions", []):
        messages.update_one({"_id": message["_id"]}, {"$pull": {"reactions": reaction}})
    else:
        messages.update_one({"_id": message["_id"]}, {"$addToSet": {"reactions": reaction}})

    updated_message = messages.find_one({"_id": message["_id"]})
    event = {
        "messageId": message_id,
        "action": "reaction",
        "groupId": message.get("groupId"),
        "senderId": message["senderId"],
        "receiverId": message["receiverId"],
        "message": serialize_message_update(updated_message) if updated_message else None,
    }
    recipients = group_message_recipients(message["groupId"]) if message.get("groupId") else [
        message["receiverId"], message["senderId"]
    ]
    for recipient_id in set(recipients):
        await sio.emit("message_changed", event, to=f"user:{recipient_id}")
    return {"status": "ok"}


@app.post("/messages/{message_id}/pin")
async def set_message_pin(
    message_id: str,
    payload: PinRequest,
    current=Depends(get_current_user),
):
    message = find_message_for_user(message_id, current["userId"])
    update: dict[str, dict[str, object]] = {"$set": {"pinned": payload.pinned}}
    if payload.pinned:
        update["$set"].update({
            "pinnedAt": datetime.now(timezone.utc),
            "pinnedBy": current["userId"],
        })
    else:
        update["$unset"] = {"pinnedAt": "", "pinnedBy": ""}

    update_result = messages_collection().update_one({"_id": message["_id"]}, update)
    if update_result.matched_count != 1:
        raise HTTPException(status_code=404, detail="Message not found")

    updated_message = find_message_for_user(message_id, current["userId"])
    if updated_message.get("pinned", False) != payload.pinned:
        raise HTTPException(status_code=500, detail="Message pin was not persisted")

    event = {
        "messageId": message_id,
        "action": "pin",
        "groupId": message.get("groupId"),
        "senderId": message["senderId"],
        "receiverId": message["receiverId"],
        "message": serialize_message_update(updated_message),
    }
    recipients = group_message_recipients(message["groupId"]) if message.get("groupId") else [
        message["receiverId"], message["senderId"]
    ]
    for recipient_id in set(recipients):
        await sio.emit("message_changed", event, to=f"user:{recipient_id}")
    return {"status": "ok", "pinned": updated_message["pinned"]}


@app.patch("/messages/{message_id}")
async def edit_message(
    message_id: str,
    payload: EditMessageRequest,
    current=Depends(get_current_user),
):
    message = find_message_for_user(message_id, current["userId"])
    if message["senderId"] != current["userId"]:
        raise HTTPException(status_code=403, detail="You can only edit your own messages")
    if message.get("type", "text") != "text":
        raise HTTPException(status_code=400, detail="Only text messages can be edited")
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message text cannot be empty")
    if message.get("groupId"):
        group = get_group_for_member(message["groupId"], current["userId"])
        validate_v4_envelope(
            text,
            64_000,
            {member["userId"] for member in group.get("members", [])},
        )
    elif not text.startswith(("skyline-e2e:v3:", HYBRID_ENVELOPE_PREFIX)):
        raise HTTPException(status_code=400, detail="Messages must use the supported end-to-end encrypted format")

    messages_collection().update_one(
        {"_id": message["_id"], "senderId": current["userId"]},
        {"$set": {"text": text, "edited": True, "updatedAt": datetime.now(timezone.utc)}},
    )
    updated_message = messages_collection().find_one({"_id": message["_id"]})
    event = {
        "messageId": message_id,
        "action": "edited",
        "groupId": message.get("groupId"),
        "senderId": message["senderId"],
        "receiverId": message["receiverId"],
        "message": serialize_message_update(updated_message),
    }
    recipients = group_message_recipients(message["groupId"]) if message.get("groupId") else [
        message["receiverId"], message["senderId"]
    ]
    for recipient_id in set(recipients):
        await sio.emit("message_changed", event, to=f"user:{recipient_id}")
    return serialize_message(updated_message)


@app.get("/groups")
def list_groups(current=Depends(get_current_user)):
    user_id = current["userId"]
    groups = list(groups_collection().find({"members.userId": user_id}).sort("updatedAt", -1))
    for group in groups:
        if not group.get("inviteCode"):
            group["inviteCode"] = secrets.token_urlsafe(24)
            group.setdefault("isPublic", False)
            groups_collection().update_one(
                {"_id": group["_id"]},
                {"$set": {"inviteCode": group["inviteCode"], "isPublic": bool(group.get("isPublic", False))}},
            )
    group_ids = [str(group["_id"]) for group in groups]
    last_message_by_group = {
        row["_id"]: row.get("lastMessageAt")
        for row in messages_collection().aggregate([
            {"$match": {"groupId": {"$in": group_ids}}},
            {"$group": {"_id": "$groupId", "lastMessageAt": {"$max": "$createdAt"}}},
        ])
    } if group_ids else {}
    groups.sort(
        key=lambda group: last_message_by_group.get(str(group["_id"])) or group.get("updatedAt") or group.get("createdAt"),
        reverse=True,
    )
    user_ids = {
        member["userId"]
        for group in groups
        for member in group.get("members", [])
    }
    profile_by_id = {
        str(user["_id"]): user
        for user in users_collection().find(
            {"_id": {"$in": [ObjectId(value) for value in user_ids if ObjectId.is_valid(value)]}},
            {"username": 1, "displayName": 1, "avatarUrl": 1},
        )
    }
    public_keys = {
        key["userId"]: key["publicKey"]
        for key in keys_collection().find(
            {"userId": {"$in": list(user_ids)}},
            {"userId": 1, "publicKey": 1},
        )
    }
    return [
        {
            "id": str(group["_id"]),
            "title": group["title"],
            "description": group.get("description", ""),
            "avatarUrl": group.get("avatarUrl", ""),
            "createdAt": group["createdAt"].isoformat(),
            "updatedAt": group.get("updatedAt", group["createdAt"]).isoformat(),
            "lastMessageAt": last_message_by_group[str(group["_id"])].isoformat() if last_message_by_group.get(str(group["_id"])) else None,
            "memberCount": len(group.get("members", [])),
            "ownerId": group.get("createdBy") or next((member["userId"] for member in group.get("members", []) if member.get("role") == "owner"), ""),
            "isPublic": bool(group.get("isPublic", False)),
            "inviteCode": group.get("inviteCode", ""),
            "currentUserRole": "owner" if group.get("createdBy") == user_id else next((member.get("role", "member") for member in group.get("members", []) if member.get("userId") == user_id), "member"),
            "members": [
                {
                    "userId": member["userId"],
                    "username": profile_by_id.get(member["userId"], {}).get("username", ""),
                    "displayName": profile_by_id.get(member["userId"], {}).get("displayName", ""),
                    "avatarUrl": profile_by_id.get(member["userId"], {}).get("avatarUrl", ""),
                    "publicKey": public_keys.get(member["userId"], ""),
                    "joinedAt": member["joinedAt"].isoformat(),
                    "role": "owner" if member.get("role") == "owner" or group.get("createdBy") == member.get("userId") else member.get("role", "member"),
                }
                for member in group.get("members", [])
            ],
        }
        for group in groups
    ]


@app.post("/groups")
async def create_group(payload: CreateGroupRequest, current=Depends(get_current_user)):
    member_ids = list(dict.fromkeys([current["userId"], *payload.memberIds]))
    if len(member_ids) > 100:
        raise HTTPException(status_code=422, detail="A group can have up to 100 members")
    if any(not ObjectId.is_valid(value) for value in member_ids):
        raise HTTPException(status_code=400, detail="Invalid member id")
    user_docs = list(users_collection().find(
        {"_id": {"$in": [ObjectId(value) for value in member_ids]}},
        {"_id": 1},
    ))
    if len(user_docs) != len(member_ids):
        raise HTTPException(status_code=404, detail="One or more users were not found")

    now = datetime.now(timezone.utc)
    group = {
        "title": payload.title.strip(),
        "description": payload.description.strip(),
        "avatarUrl": payload.avatarUrl,
        "createdBy": current["userId"],
        "isPublic": False,
        "inviteCode": secrets.token_urlsafe(24),
        "createdAt": now,
        "updatedAt": now,
        "members": [
            {"userId": member_id, "joinedAt": now, "role": "owner" if member_id == current["userId"] else "member"}
            for member_id in member_ids
        ],
    }
    if len(group["title"]) < 2:
        raise HTTPException(status_code=422, detail="Group name must contain at least 2 characters")
    result = groups_collection().insert_one(group)
    group["_id"] = result.inserted_id
    for member_id in member_ids:
        await sio.emit(
            "group_changed",
            {"groupId": str(result.inserted_id), "action": "created"},
            to=f"user:{member_id}",
        )
    return {"id": str(result.inserted_id), "title": group["title"], "memberCount": len(member_ids)}


@app.post("/groups/{group_id}/members")
async def add_group_members(
    group_id: str,
    payload: AddGroupMembersRequest,
    current=Depends(get_current_user),
):
    group = get_group_for_member(group_id, current["userId"])
    current_user_id = current["userId"]
    current_member = next(
        (member for member in group.get("members", []) if member.get("userId") == current_user_id),
        {},
    )
    current_role = (
        "owner"
        if group.get("createdBy") == current_user_id or current_member.get("role") == "owner"
        else current_member.get("role", "member")
    )
    if current_role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Only group admins can add members")

    member_ids = list(dict.fromkeys(payload.memberIds))
    if any(not ObjectId.is_valid(value) for value in member_ids):
        raise HTTPException(status_code=400, detail="Invalid member id")
    existing_ids = {member["userId"] for member in group.get("members", [])}
    new_ids = [value for value in member_ids if value not in existing_ids]
    if len(existing_ids) + len(new_ids) > 100:
        raise HTTPException(status_code=422, detail="A group can have up to 100 members")
    if not new_ids:
        return {"status": "ok", "added": []}
    user_docs = list(users_collection().find(
        {"_id": {"$in": [ObjectId(value) for value in new_ids]}},
        {"_id": 1},
    ))
    if len(user_docs) != len(new_ids):
        raise HTTPException(status_code=404, detail="One or more users were not found")

    now = datetime.now(timezone.utc)
    joined_at = now + timedelta(milliseconds=1)
    new_members = [{"userId": value, "joinedAt": joined_at, "role": "member"} for value in new_ids]
    update_result = groups_collection().update_one(
        {
            "_id": group["_id"],
            # Re-check admin privileges and member capacity at write time.
            "$or": [
                {"createdBy": current_user_id},
                {"members": {"$elemMatch": {
                    "userId": current_user_id,
                    "role": {"$in": ["owner", "admin"]},
                }}},
            ],
            # Reject if any requested user was added concurrently.
            "members.userId": {"$nin": new_ids},
            "$expr": {
                "$lte": [
                    {
                        "$add": [
                            {"$size": {"$ifNull": ["$members", []]}},
                            len(new_ids),
                        ]
                    },
                    100,
                ]
            },
        },
        {"$push": {"members": {"$each": new_members}}, "$set": {"updatedAt": now}},
    )
    if update_result.matched_count != 1:
        raise HTTPException(
            status_code=409,
            detail="Group membership or permissions changed; refresh and retry",
        )

    updated_group = groups_collection().find_one({"_id": group["_id"]})
    for member in updated_group.get("members", []):
        await sio.emit(
            "group_changed",
            {"groupId": group_id, "action": "members"},
            to=f"user:{member['userId']}",
        )
    return {"status": "ok", "added": new_ids}


@app.get("/groups/{group_id}/export")
def export_group(
    group_id: str,
    format: Literal["json", "html"] = Query(default="json"),
    current=Depends(get_current_user),
):
    group = get_group_for_member(group_id, current["userId"])
    member = next(item for item in group["members"] if item["userId"] == current["userId"])
    messages = [
        serialize_message(message)
        for message in messages_collection().find(
            {"groupId": group_id, "createdAt": {"$gte": member["joinedAt"]}}
        ).sort([("createdAt", 1), ("_id", 1)])
    ]
    file_name = f"pulse-group-{group_id}"
    if format == "json":
        return Response(
            content=json.dumps(messages, ensure_ascii=False),
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{file_name}.json"'},
        )
    rows = "".join(
        "<article><time>" + html.escape(message["createdAt"]) + "</time>"
        + "<b>" + html.escape(message["senderId"]) + "</b>"
        + "<p>" + html.escape(message["text"] or message["fileName"] or "Вложение") + "</p></article>"
        for message in messages
    )
    document = (
        "<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><title>Экспорт группы Skyline</title>"
        "<style>body{font:15px system-ui;max-width:760px;margin:32px auto;padding:0 16px;background:#0b1020;color:#e2e8f0}"
        "article{padding:14px;margin:10px 0;border:1px solid #334155;border-radius:14px}time{color:#94a3b8;font-size:12px;margin-right:12px}"
        "p{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>" + html.escape(group["title"]) + "</h1>" + rows + "</html>"
    )
    return Response(
        content=document,
        media_type="text/html; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{file_name}.html"'},
    )


@app.get("/groups/{group_id}/messages")
def get_group_messages(
    group_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    before: str | None = None,
    current=Depends(get_current_user),
):
    group = get_group_for_member(group_id, current["userId"])
    member = next(member for member in group["members"] if member["userId"] == current["userId"])
    messages_collection().update_many(
        {"groupId": group_id, "readBy": {"$ne": current["userId"]}},
        {"$push": {"readBy": current["userId"]}},
    )
    query: dict = {
        "groupId": group_id,
        "createdAt": {"$gte": member["joinedAt"]},
        "$and": [{
            "$or": [
                {"expiresAt": {"$exists": False}},
                {"expiresAt": {"$gt": datetime.now(timezone.utc)}},
            ]
        }],
    }
    if before:
        if not ObjectId.is_valid(before):
            raise HTTPException(status_code=400, detail="Invalid message cursor")
        cursor = messages_collection().find_one(
            {"_id": ObjectId(before), "groupId": group_id, "createdAt": {"$gte": member["joinedAt"]}},
            {"createdAt": 1},
        )
        if not cursor:
            raise HTTPException(status_code=400, detail="Message cursor not found in this group")
        query["$and"].append({
            "$or": [
                {"createdAt": {"$lt": cursor["createdAt"], "$gte": member["joinedAt"]}},
                {"createdAt": cursor["createdAt"], "_id": {"$lt": cursor["_id"]}},
            ]
        })
    page = list(messages_collection().find(query).sort([("createdAt", -1), ("_id", -1)]).limit(limit))
    page.reverse()
    return [serialize_message(message) for message in page]


@app.get("/messages/{user_id}/export")
def export_messages(
    user_id: str,
    format: Literal["json", "html"] = Query(default="json"),
    current=Depends(get_current_user),
):
    if not ObjectId.is_valid(user_id) or user_id == current["userId"]:
        raise HTTPException(status_code=400, detail="Invalid chat user id")
    owner = users_collection().find_one(
        {"_id": ObjectId(current["userId"])},
        {"hiddenChats": 1},
    ) or {}
    hidden_entry = next(
        (
            entry for entry in owner.get("hiddenChats", [])
            if isinstance(entry, dict) and entry.get("userId") == user_id
        ),
        None,
    )
    query: dict = {
        "$or": [
            {"senderId": current["userId"], "receiverId": user_id},
            {"senderId": user_id, "receiverId": current["userId"]},
        ]
    }
    if hidden_entry:
        query = {"$and": [query, {"createdAt": {"$gt": hidden_entry["hiddenAt"]}}]}
    messages = [
        serialize_message(message)
        for message in messages_collection().find(query).sort([("createdAt", 1), ("_id", 1)])
    ]
    if format == "json":
        return Response(
            content=json.dumps(messages, ensure_ascii=False),
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="pulse-chat-{user_id}.json"'},
        )

    rows = "".join(
        "<article><time>" + html.escape(message["createdAt"]) + "</time>"
        + "<b>" + html.escape("Вы" if message["senderId"] == current["userId"] else "Собеседник") + "</b>"
        + "<p>" + html.escape(message["text"] or message["fileName"] or "Вложение") + "</p></article>"
        for message in messages
    )
    document = (
        "<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><title>Экспорт Skyline</title>"
        "<style>body{font:15px system-ui;max-width:760px;margin:32px auto;padding:0 16px;background:#0b1020;color:#e2e8f0}"
        "article{padding:14px;margin:10px 0;border:1px solid #334155;border-radius:14px}time{color:#94a3b8;font-size:12px;margin-right:12px}"
        "p{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>История чата Skyline</h1>" + rows + "</html>"
    )
    return Response(
        content=document,
        media_type="text/html; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="pulse-chat-{user_id}.html"'},
    )


@app.post("/groups/{group_id}/messages")
async def send_group_message(
    group_id: str,
    payload: GroupMessageRequest,
    current=Depends(get_current_user),
):
    group = get_group_for_member(group_id, current["userId"])
    text = payload.text
    member_ids = {member["userId"] for member in group.get("members", [])}
    max_ciphertext = MAX_ATTACHMENT_SIZE + 1024 if payload.type == "file" else 64_000
    validate_v4_envelope(text, max_ciphertext, member_ids)
    mentioned_ids = set(payload.mentionUserIds)
    if not mentioned_ids.issubset(member_ids):
        raise HTTPException(status_code=400, detail="Mention recipients must be group members")
    enforce_message_rate_limit(current["userId"])
    now = datetime.now(timezone.utc)
    doc = {
        "groupId": group_id,
        "senderId": current["userId"],
        "receiverId": "",
        "text": text,
        "type": payload.type,
        "reactions": [],
        "readBy": [current["userId"]],
        "pinned": False,
        "createdAt": now,
        "read": False,
    }
    disappearing = group.get("disappearingMessages", {})
    if disappearing.get("enabled") and disappearing.get("expireAfterMinutes"):
        # TTL cleanup is handled by MongoDB; only messages sent after the timer
        # is enabled receive an expiry timestamp.
        doc["expiresAt"] = now + timedelta(minutes=int(disappearing["expireAfterMinutes"]))
    result = messages_collection().insert_one(doc)
    doc["_id"] = result.inserted_id
    groups_collection().update_one({"_id": group["_id"]}, {"$set": {"updatedAt": now}})
    event = {
        "messageId": str(result.inserted_id),
        "groupId": group_id,
        "senderId": current["userId"],
        "action": "created",
    }
    for member in group.get("members", []):
        await sio.emit("message_changed", event, to=f"user:{member['userId']}")

    for mentioned_id in mentioned_ids - {current["userId"]}:
        await sio.emit(
            "group_mention",
            {
                "groupId": group_id,
                "groupTitle": group["title"],
                "senderId": current["userId"],
                "senderUsername": current.get("username", "Пользователь"),
            },
            to=f"user:{mentioned_id}",
        )
    return serialize_message(doc)


# ---------- Encryption keys ----------

@app.post("/keys/upload")
def upload_key(payload: UploadKeyRequest, current=Depends(get_current_user)):
    if not validate_public_key(payload.publicKey):
        raise HTTPException(status_code=400, detail="Invalid public key")

    keys = keys_collection()
    user_id = current["userId"]

    keys.update_one(
        {"userId": user_id},
        {"$set": make_key_document(user_id, payload.publicKey)},
        upsert=True,
    )
    return {"status": "ok"}


@app.get("/keys/me")
def get_my_key(current=Depends(get_current_user)):
    keys = keys_collection()
    user_id = current["userId"]

    doc = keys.find_one({"userId": user_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Key not found for userId=" + str(user_id))
    return {
        "userId": doc["userId"],
        "publicKey": doc["publicKey"],
        "createdAt": doc.get("createdAt"),
    }


@app.post("/keys/backup")
def upload_key_backup(payload: UploadKeyBackupRequest, current=Depends(get_current_user)):
    """Store a client-encrypted private-key backup; the server never receives plaintext key material."""
    if not validate_public_key(payload.publicKey):
        raise HTTPException(status_code=400, detail="Invalid public key")
    try:
        encrypted_private_key = base64.b64decode(payload.encryptedPrivateKey, validate=True)
        salt = base64.b64decode(payload.salt, validate=True)
        iv = base64.b64decode(payload.iv, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Invalid key backup encoding")
    if not 16 <= len(encrypted_private_key) <= 12_288 or len(salt) != 16 or len(iv) != 12:
        raise HTTPException(status_code=400, detail="Invalid key backup parameters")

    user_id = current["userId"]
    keys_collection().update_one(
        {"userId": user_id},
        {"$set": {
            **make_key_document(user_id, payload.publicKey),
            "encryptedPrivateKey": payload.encryptedPrivateKey,
            "backupSalt": payload.salt,
            "backupIv": payload.iv,
            "backupVersion": 1,
        }},
        upsert=True,
    )
    return {"status": "ok"}


@app.get("/keys/backup")
def get_key_backup(current=Depends(get_current_user)):
    doc = keys_collection().find_one(
        {"userId": current["userId"]},
        {"publicKey": 1, "encryptedPrivateKey": 1, "backupSalt": 1, "backupIv": 1, "backupVersion": 1},
    )
    if not doc or doc.get("backupVersion") != 1:
        raise HTTPException(status_code=404, detail="Encrypted key backup not found")
    return {
        "publicKey": doc["publicKey"],
        "encryptedPrivateKey": doc["encryptedPrivateKey"],
        "salt": doc["backupSalt"],
        "iv": doc["backupIv"],
    }


@app.post("/keys/exchange")
def exchange_keys(payload: ExchangeRequest, current=Depends(get_current_user)):
    target_user_id = payload.targetUserId
    if not target_user_id:
        raise HTTPException(status_code=400, detail="targetUserId required")
    if target_user_id == current["userId"]:
        raise HTTPException(status_code=400, detail="Cannot exchange with yourself")

    keys = keys_collection()

    my_key = keys.find_one({"userId": current["userId"]})
    if not my_key:
        raise HTTPException(status_code=404, detail="Your key not found. Upload it first.")

    target_key = keys.find_one({"userId": target_user_id})
    if not target_key:
        raise HTTPException(status_code=404, detail="Target user has no public key")

    return {
        "myKey": my_key["publicKey"],
        "targetKey": target_key["publicKey"],
    }


@app.get("/keys/{user_id}")
def get_key(user_id: str, current=Depends(get_current_user)):
    keys = keys_collection()
    doc = keys.find_one({"userId": user_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Key not found")
    return {"userId": doc["userId"], "publicKey": doc["publicKey"]}


# ============================================================================
# НОВЫЕ МОДЕЛИ ДЛЯ ФУНКЦИЙ SKYLINE (1-10: Сообщения)
# ============================================================================

class MessageDeleteForAllRequest(BaseModel):
    messageId: str = Field(min_length=1, max_length=64)

class MessageForwardRequest(BaseModel):
    targetUserId: Optional[str] = Field(default=None, max_length=64)
    targetGroupId: Optional[str] = Field(default=None, max_length=64)
    text: str = Field(default="", max_length=524_288)
    type: Literal["text", "image", "file"] = "text"
    fileData: str = Field(default="", max_length=3_500_000)

class MessageReplyRequest(BaseModel):
    text: str = Field(default="", max_length=524_288)
    type: Literal["text", "image", "file"] = "text"
    fileName: str = Field(default="", max_length=200)
    contentType: str = Field(default="", max_length=100)
    fileData: str = Field(default="", max_length=3_500_000)
    mentionUserIds: list[str] = Field(default_factory=list, max_length=100)

class DisappearingMessagesRequest(BaseModel):
    chatId: str = Field(min_length=1, max_length=64)
    # Zero disables the timer; positive values expire messages after that many minutes.
    expireAfterMinutes: int = Field(ge=0, le=43200)

class SavedMessageRequest(BaseModel):
    messageId: str = Field(min_length=1, max_length=64)

class DraftMessageRequest(BaseModel):
    chatId: str = Field(min_length=1, max_length=64)
    text: str = Field(default="", max_length=4000)

class ScheduledMessageRequest(BaseModel):
    receiverId: Optional[str] = Field(default=None, max_length=64)
    groupId: Optional[str] = Field(default=None, max_length=64)
    text: str = Field(default="", max_length=4000)
    type: Literal["text", "image", "file"] = "text"
    fileName: str = Field(default="", max_length=200)
    contentType: str = Field(default="", max_length=100)
    fileData: str = Field(default="", max_length=2_800_000)
    sendAt: str

class QuickReplyRequest(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=2000)
    emoji: Optional[str] = Field(default=None, max_length=10)

# ============================================================================
# НОВЫЕ МОДЕЛИ (11-20: Пользователи)
# ============================================================================

class FriendRequestRequest(BaseModel):
    targetUserId: str = Field(min_length=1, max_length=64)

class FriendRequestActionRequest(BaseModel):
    requestId: str = Field(min_length=1, max_length=64)
    accept: bool

class BlockUserRequest(BaseModel):
    targetUserId: str = Field(min_length=1, max_length=64)

class ProfileBannerRequest(BaseModel):
    bannerUrl: str = Field(default="", max_length=1_400_000)

class VerificationRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)

# ============================================================================
# НОВЫЕ МОДЕЛИ (21-30: Медиа и контент)
# ============================================================================

class PollCreateRequest(BaseModel):
    question: str = Field(min_length=1, max_length=300)
    options: list[str] = Field(min_length=2, max_length=10)
    chatId: Optional[str] = Field(default=None, max_length=64)
    groupId: Optional[str] = Field(default=None, max_length=64)
    channelId: Optional[str] = Field(default=None, max_length=64)

class PollVoteRequest(BaseModel):
    pollId: str = Field(min_length=1, max_length=64)
    optionIndex: int = Field(ge=0)

# ============================================================================
# НОВЫЕ МОДЕЛИ (31-40: Социальные функции)
# ============================================================================

class StoryCreateRequest(BaseModel):
    mediaType: Literal["image", "video"] = "image"
    mediaData: str = Field(default="", max_length=5_600_000)
    caption: str = Field(default="", max_length=500)

class EventCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    eventDate: str
    location: str = Field(default="", max_length=200)
    participants: list[str] = Field(default_factory=list, max_length=100)

class ReportRequest(BaseModel):
    targetType: Literal["user", "message", "channel", "group"]
    targetId: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=1, max_length=500)

# ============================================================================
# НОВЫЕ МОДЕЛИ (41-50: Кастомизация)
# ============================================================================

class UserSettingsRequest(BaseModel):
    theme: Optional[Literal["light", "dark"]] = None
    accentColor: Optional[str] = Field(default=None, max_length=20)
    chatBackground: Optional[str] = Field(default=None, max_length=1_400_000)
    fontSize: Optional[Literal["small", "medium", "large"]] = None
    messageDensity: Optional[Literal["compact", "comfortable"]] = None
    animationsEnabled: Optional[bool] = None
    pinnedChatIds: Optional[list[str]] = Field(default=None, max_length=20)
    quickActionButtons: Optional[list[str]] = Field(default=None, max_length=10)

# ============================================================================
# НОВЫЕ МОДЕЛИ (51-60: Безопасность)
# ============================================================================

class TwoFactorRequest(BaseModel):
    enable: bool
    code: Optional[str] = Field(default=None, max_length=10)

class PinCodeRequest(BaseModel):
    pin: Optional[str] = Field(default=None, min_length=4, max_length=10)
    enable: Optional[bool] = None

class AutoDeleteAccountRequest(BaseModel):
    months: int = Field(ge=1, le=60)

# ============================================================================
# НОВЫЕ МОДЕЛИ (61-70: Продвинутые)
# ============================================================================

class BotCommandRequest(BaseModel):
    command: str = Field(min_length=1, max_length=100)
    response: str = Field(min_length=1, max_length=2000)

class GiftSendRequest(BaseModel):
    giftId: str = Field(min_length=1, max_length=64)
    targetUserId: str = Field(min_length=1, max_length=64)


@app.post("/messages/disappearing")
def set_disappearing_messages(
    payload: DisappearingMessagesRequest,
    current=Depends(get_current_user),
):
    """Установить таймер исчезновения сообщений в чате"""
    if not ObjectId.is_valid(payload.chatId):
        raise HTTPException(status_code=400, detail="Invalid chat id")
    chats = groups_collection()
    chat = chats.find_one({
        "_id": ObjectId(payload.chatId),
        "$or": [
            {"members.userId": current["userId"]},
            {"createdBy": current["userId"]},
        ]
    })
    enabled = payload.expireAfterMinutes > 0
    if chat:
        chats.update_one(
            {"_id": ObjectId(payload.chatId)},
            {"$set": {"disappearingMessages": {"expireAfterMinutes": payload.expireAfterMinutes, "enabled": enabled}}}
        )
        return {"status": "ok", "enabled": enabled, "expireAfterMinutes": payload.expireAfterMinutes}
    if payload.chatId == current["userId"] or not users_collection().find_one({"_id": ObjectId(payload.chatId)}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Chat not found")
    if users_blocked_either_way(current["userId"], payload.chatId):
        raise HTTPException(status_code=403, detail="Messaging is unavailable for this user")
    participants = sorted([current["userId"], payload.chatId])
    chat_settings_collection().update_one(
        {"kind": "direct", "participants": participants},
        {"$set": {"disappearingMessages": {"expireAfterMinutes": payload.expireAfterMinutes, "enabled": enabled}, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"status": "ok", "enabled": enabled, "expireAfterMinutes": payload.expireAfterMinutes}


@app.post("/messages/{message_id}/delete-for-all")
async def delete_message_for_all(
    message_id: str,
    current=Depends(get_current_user),
):
    """Удалить сообщение у всех участников чата"""
    message = find_message_for_user(message_id, current["userId"])
    if message["senderId"] != current["userId"]:
        raise HTTPException(status_code=403, detail="Only sender can delete for everyone")
    update_result = messages_collection().update_one(
        {"_id": message["_id"], "senderId": current["userId"], "deletedForAll": {"$ne": True}},
        {"$set": {"deletedForAll": True, "deletedAt": datetime.now(timezone.utc), "deletedBy": current["userId"]}},
    )
    if update_result.matched_count != 1:
        raise HTTPException(status_code=404, detail="Message not found")
    if message.get("groupId"):
        recipients = group_message_recipients(message["groupId"])
    else:
        recipients = [message["senderId"], message["receiverId"]]
    event = {
        "messageId": message_id,
        "chatId": message.get("chatId") or message.get("groupId"),
        "groupId": message.get("groupId"),
        "senderId": current["userId"],
        "receiverId": message.get("receiverId"),
        "action": "deleted_for_all",
    }
    for uid in set(recipients):
        await sio.emit("message_deleted_for_all", event, to=f"user:{uid}")
    return {"status": "ok"}


@app.post("/messages/{message_id}/forward")
async def forward_message(
    message_id: str,
    payload: MessageForwardRequest,
    current=Depends(get_current_user),
):
    """Save a client-reencrypted message copy; the server never decrypts the source."""
    original = find_message_for_user(message_id, current["userId"])
    if bool(payload.targetUserId) == bool(payload.targetGroupId):
        raise HTTPException(status_code=400, detail="Choose exactly one forwarding destination")

    group = None
    if payload.targetGroupId:
        group = get_group_for_member(payload.targetGroupId, current["userId"])
        recipient_ids = {member["userId"] for member in group.get("members", [])}
        receiver_id = ""
        group_id = payload.targetGroupId
        if payload.type == "text":
            validate_v4_envelope(payload.text, 64_000, recipient_ids)
            text = payload.text
            file_data = ""
        else:
            validate_v4_envelope(payload.fileData, MAX_ATTACHMENT_SIZE + 1024, recipient_ids)
            text = payload.fileData
            file_data = ""
    else:
        target_user_id = payload.targetUserId
        if not target_user_id or not ObjectId.is_valid(target_user_id) or target_user_id == current["userId"]:
            raise HTTPException(status_code=400, detail="Invalid forwarding recipient")
        if users_blocked_either_way(current["userId"], target_user_id):
            raise HTTPException(status_code=403, detail="Messaging is unavailable for this user")
        if not users_collection().find_one({"_id": ObjectId(target_user_id)}, {"_id": 1}):
            raise HTTPException(status_code=404, detail="Forwarding recipient not found")
        recipient_ids = {current["userId"], target_user_id}
        receiver_id = target_user_id
        group_id = None
        if payload.type == "text":
            text = payload.text.strip()
            if not text.startswith("skyline-e2e:v3:"):
                raise HTTPException(status_code=400, detail="Messages must use the supported end-to-end encrypted format")
            file_data = ""
        else:
            validate_v4_envelope(payload.fileData, MAX_ATTACHMENT_SIZE + 1024, recipient_ids)
            text = ""
            file_data = payload.fileData

    enforce_message_rate_limit(current["userId"])
    now = datetime.now(timezone.utc)
    forwarded_doc = {
        "chatId": group_id,
        "groupId": group_id,
        "senderId": current["userId"],
        "senderName": current.get("username", "Пользователь"),
        "receiverId": receiver_id,
        "text": text,
        "type": "text" if payload.type == "text" else "file",
        "fileName": "",
        "contentType": "",
        "fileData": file_data,
        "forwardedFrom": str(original["_id"]),
        "replyTo": None,
        "reactions": [],
        "pinned": False,
        "createdAt": now,
        "read": False,
        "readBy": [current["userId"]],
        "deliveredTo": [current["userId"]],
        "deleted": False,
        "isEdited": False,
    }
    if not group_id:
        expire_after = direct_chat_expiration_minutes(current["userId"], receiver_id)
        if expire_after:
            forwarded_doc["expiresAt"] = now + timedelta(minutes=expire_after)
    inserted = messages_collection().insert_one(forwarded_doc)
    forwarded_doc["_id"] = inserted.inserted_id
    if group:
        groups_collection().update_one({"_id": group["_id"]}, {"$set": {"updatedAt": now}})
        event = {
            "messageId": str(inserted.inserted_id),
            "groupId": group_id,
            "senderId": current["userId"],
            "action": "created",
        }
    else:
        event = {
            "messageId": str(inserted.inserted_id),
            "senderId": current["userId"],
            "receiverId": receiver_id,
            "action": "created",
        }
    for recipient_id in recipient_ids:
        try:
            await sio.emit("message_changed", event, to=f"user:{recipient_id}")
        except Exception as exc:
            print(f"Failed to notify forwarded message recipient {recipient_id}: {exc}")
    return serialize_message(forwarded_doc)


@app.post("/messages/{message_id}/reply")
async def reply_to_message(
    message_id: str,
    payload: MessageReplyRequest,
    current=Depends(get_current_user),
):
    """Ответить на конкретное сообщение (цитирование)"""
    original = find_message_for_user(message_id, current["userId"])
    group_id = original.get("groupId")
    if group_id:
        group = get_group_for_member(group_id, current["userId"])
        receiver_id = ""
        recipient_ids = {member["userId"] for member in group.get("members", [])}
        mentioned_ids = set(payload.mentionUserIds)
        if not mentioned_ids.issubset(recipient_ids):
            raise HTTPException(status_code=400, detail="Mention recipients must be group members")
    else:
        if payload.mentionUserIds:
            raise HTTPException(status_code=400, detail="Mentions are only available in groups")
        participants = {str(original.get("senderId")), str(original.get("receiverId"))}
        if len(participants) != 2 or current["userId"] not in participants:
            raise HTTPException(status_code=404, detail="Message not found")
        receiver_id = next(participant for participant in participants if participant != current["userId"])
        if users_blocked_either_way(current["userId"], receiver_id):
            raise HTTPException(status_code=403, detail="Messaging is unavailable for this user")
        recipient_ids = participants

    if payload.fileName or payload.contentType:
        raise HTTPException(status_code=400, detail="Attachment metadata must be encrypted on the client")
    if payload.type == "text":
        text = payload.text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="Reply text cannot be empty")
        if group_id:
            validate_v4_envelope(text, 64_000, recipient_ids)
        elif not text.startswith(("skyline-e2e:v3:", HYBRID_ENVELOPE_PREFIX)):
            raise HTTPException(status_code=400, detail="Messages must use the supported end-to-end encrypted format")
        file_data = ""
    else:
        validate_v4_envelope(payload.fileData, MAX_ATTACHMENT_SIZE + 1024, recipient_ids)
        if group_id:
            text = payload.fileData
            file_data = ""
        else:
            text = ""
            file_data = payload.fileData
    enforce_message_rate_limit(current["userId"])

    now = datetime.now(timezone.utc)
    reply_doc = {
        "chatId": group_id,
        "senderId": current["userId"],
        "senderName": current.get("username", "Пользователь"),
        "receiverId": receiver_id,
        "groupId": group_id,
        "text": text,
        "type": "text" if payload.type == "text" else "file",
        "fileName": "",
        "contentType": "",
        "fileData": file_data,
        "replyTo": message_id,
        "createdAt": now,
        "readBy": [current["userId"]],
        "deliveredTo": [current["userId"]],
        "deleted": False,
        "isEdited": False,
    }
    if not group_id:
        expire_after = direct_chat_expiration_minutes(current["userId"], receiver_id)
        if expire_after:
            reply_doc["expiresAt"] = now + timedelta(minutes=expire_after)
    result = messages_collection().insert_one(reply_doc)
    reply_doc["_id"] = result.inserted_id
    if group_id:
        groups_collection().update_one({"_id": group["_id"]}, {"$set": {"updatedAt": now}})
    event = {
        "messageId": str(result.inserted_id),
        "replyTo": message_id,
        "senderId": current["userId"],
        "receiverId": receiver_id,
        "groupId": group_id,
        "action": "created",
    }
    for recipient_id in recipient_ids:
        try:
            await sio.emit("message_changed", event, to=f"user:{recipient_id}")
        except Exception as exc:
            print(f"Failed to notify message reply recipient {recipient_id}: {exc}")
    if group_id:
        for mentioned_id in mentioned_ids - {current["userId"]}:
            try:
                await sio.emit("group_mention", {
                    "groupId": group_id,
                    "groupTitle": group["title"],
                    "senderId": current["userId"],
                    "senderUsername": current.get("username", "Пользователь"),
                }, to=f"user:{mentioned_id}")
            except Exception as exc:
                print(f"Failed to notify mentioned group member {mentioned_id}: {exc}")
    return serialize_message(reply_doc)


@app.get("/messages/disappearing/{chat_id}")
def get_disappearing_settings(
    chat_id: str,
    current=Depends(get_current_user),
):
    """Получить настройки исчезающих сообщений для чата"""
    if not ObjectId.is_valid(chat_id):
        raise HTTPException(status_code=400, detail="Invalid chat id")
    chat = groups_collection().find_one({
        "_id": ObjectId(chat_id),
        "$or": [
            {"members.userId": current["userId"]},
            {"createdBy": current["userId"]},
        ],
    })
    if chat:
        dm = chat.get("disappearingMessages", {})
        return {"enabled": dm.get("enabled", False), "expireAfterMinutes": dm.get("expireAfterMinutes", 0)}
    if chat_id == current["userId"] or not users_collection().find_one({"_id": ObjectId(chat_id)}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Chat not found")
    if users_blocked_either_way(current["userId"], chat_id):
        raise HTTPException(status_code=403, detail="Messaging is unavailable for this user")
    settings = chat_settings_collection().find_one({"kind": "direct", "participants": sorted([current["userId"], chat_id])}) or {}
    dm = settings.get("disappearingMessages", {})
    return {"enabled": dm.get("enabled", False), "expireAfterMinutes": dm.get("expireAfterMinutes", 0)}


@app.post("/drafts")
def save_draft(
    payload: DraftMessageRequest,
    current=Depends(get_current_user),
):
    """Сохранить черновик сообщения в чате"""
    drafts_collection().update_one(
        {"chatId": payload.chatId, "userId": current["userId"]},
        {"$set": {"text": payload.text, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"status": "ok"}


@app.get("/drafts/{chat_id}")
def get_draft(
    chat_id: str,
    current=Depends(get_current_user),
):
    """Получить черновик для чата"""
    draft = drafts_collection().find_one({"chatId": chat_id, "userId": current["userId"]})
    if not draft:
        return {"text": ""}
    return {"text": draft.get("text", "")}


@app.post("/saved-messages")
def save_message_to_bookmarks(
    payload: SavedMessageRequest,
    current=Depends(get_current_user),
):
    """Сохранить сообщение в закладки (личное хранилище)"""
    find_message_for_user(payload.messageId, current["userId"])
    saved_messages_collection().update_one(
        {"messageId": payload.messageId, "userId": current["userId"]},
        {"$set": {"savedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"status": "ok"}


@app.get("/saved-messages")
def list_saved_messages(
    current=Depends(get_current_user),
    limit: int = 50,
    skip: int = 0,
):
    """Список сохранённых сообщений"""
    saved = list(saved_messages_collection().find(
        {"userId": current["userId"]}
    ).sort("savedAt", -1).skip(skip).limit(min(limit, 100)))
    message_ids = [ObjectId(s["messageId"]) for s in saved if ObjectId.is_valid(s.get("messageId", ""))]
    messages = {}
    if message_ids:
        for m in messages_collection().find({"_id": {"$in": message_ids}}):
            try:
                find_message_for_user(str(m["_id"]), current["userId"])
            except HTTPException:
                continue
            messages[str(m["_id"])] = serialize_message(m)
    return {
        "items": [
            {
                "savedId": str(s["_id"]),
                "savedAt": s["savedAt"].isoformat(),
                "message": messages.get(s["messageId"], {}),
            }
            for s in saved
        ],
        "count": len(saved),
    }


@app.post("/scheduled-messages")
def create_scheduled_message(
    payload: ScheduledMessageRequest,
    current=Depends(get_current_user),
):
    """Запланировать отправку сообщения на определённое время"""
    has_receiver = bool(payload.receiverId)
    has_group = bool(payload.groupId)
    if has_receiver == has_group:
        raise HTTPException(status_code=400, detail="Choose exactly one message destination")

    scheduled_group = None
    if has_group:
        # Scheduling is only available to current group members.
        scheduled_group = get_group_for_member(payload.groupId, current["userId"])
    else:
        if not ObjectId.is_valid(payload.receiverId):
            raise HTTPException(status_code=400, detail="Invalid receiver id")
        if payload.receiverId == current["userId"]:
            raise HTTPException(status_code=400, detail="Cannot schedule a message to yourself")
        if not users_collection().find_one({"_id": ObjectId(payload.receiverId)}, {"_id": 1}):
            raise HTTPException(status_code=404, detail="Recipient not found")
        if users_blocked_either_way(current["userId"], payload.receiverId):
            raise HTTPException(status_code=403, detail="Messaging is unavailable for this user")

    try:
        send_at = datetime.fromisoformat(payload.sendAt.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="Invalid sendAt datetime")
    if send_at.tzinfo is None or send_at.utcoffset() is None:
        raise HTTPException(status_code=422, detail="sendAt must include a timezone")
    send_at = send_at.astimezone(timezone.utc)
    if send_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Send time must be in the future")
    recipients = (
        {member["userId"] for member in scheduled_group.get("members", [])}
        if scheduled_group else {current["userId"], payload.receiverId}
    )
    if payload.type == "text":
        if not payload.text.strip():
            raise HTTPException(status_code=400, detail="Message text cannot be empty")
        if scheduled_group:
            validate_v4_envelope(payload.text, 64_000, recipients)
        elif not payload.text.startswith(("skyline-e2e:v3:", HYBRID_ENVELOPE_PREFIX)):
            raise HTTPException(status_code=400, detail="Messages must use the supported end-to-end encrypted format")
    else:
        if payload.fileName or payload.contentType:
            raise HTTPException(status_code=400, detail="Attachment metadata must be encrypted on the client")
        validate_v4_envelope(payload.fileData, MAX_ATTACHMENT_SIZE + 1024, recipients)
    doc = {
        "senderId": current["userId"],
        "senderName": current.get("username", "Пользователь"),
        "receiverId": payload.receiverId,
        "groupId": payload.groupId,
        "text": payload.text,
        "type": payload.type,
        "fileName": payload.fileName,
        "contentType": payload.contentType,
        "fileData": payload.fileData,
        "sendAt": send_at,
        "status": "pending",
        "createdAt": datetime.now(timezone.utc),
    }
    result = scheduled_messages_collection().insert_one(doc)
    return {"status": "ok", "scheduledId": str(result.inserted_id)}


@app.get("/scheduled-messages")
def list_scheduled_messages(current=Depends(get_current_user)):
    """Список запланированных сообщений"""
    items = list(scheduled_messages_collection().find(
        {"senderId": current["userId"], "status": "pending"}
    ).sort("sendAt", 1))
    return {
        "items": [
            {
                "id": str(i["_id"]),
                "receiverId": i.get("receiverId"),
                "groupId": i.get("groupId"),
                "text": i.get("text", ""),
                "sendAt": i["sendAt"].isoformat(),
                "status": i.get("status", "pending"),
            }
            for i in items
        ]
    }


@app.delete("/scheduled-messages/{scheduledId}")
def cancel_scheduled_message(
    scheduledId: str,
    current=Depends(get_current_user),
):
    """Cancel a message only while it is pending and owned by the caller."""
    if not ObjectId.is_valid(scheduledId):
        raise HTTPException(status_code=400, detail="Invalid scheduled message id")
    result = scheduled_messages_collection().delete_one({
        "_id": ObjectId(scheduledId),
        "senderId": current["userId"],
        "status": "pending",
    })
    if result.deleted_count != 1:
        raise HTTPException(status_code=404, detail="Pending scheduled message not found")
    return {"status": "ok"}

@app.post("/quick-replies")
def create_quick_reply(
    payload: QuickReplyRequest,
    current=Depends(get_current_user),
):
    """Создать шаблон быстрого ответа"""
    doc = {
        "userId": current["userId"],
        "title": payload.title,
        "text": payload.text,
        "emoji": payload.emoji,
        "createdAt": datetime.now(timezone.utc),
    }
    result = quick_replies_collection().insert_one(doc)
    return {"status": "ok", "id": str(result.inserted_id)}


@app.get("/quick-replies")
def list_quick_replies(current=Depends(get_current_user)):
    """Список быстрых ответов пользователя"""
    items = list(quick_replies_collection().find(
        {"userId": current["userId"]}
    ).sort("createdAt", -1))
    return {
        "items": [
            {
                "id": str(i["_id"]),
                "title": i["title"],
                "text": i["text"],
                "emoji": i.get("emoji"),
            }
            for i in items
        ]
    }


@app.post("/friend-requests")
async def send_friend_request(
    payload: FriendRequestRequest,
    current=Depends(get_current_user),
):
    """Отправить заявку в друзья"""
    target_id = payload.targetUserId
    if target_id == current["userId"]:
        raise HTTPException(status_code=400, detail="Cannot send request to yourself")
    if not ObjectId.is_valid(target_id):
        raise HTTPException(status_code=400, detail="Invalid user id")
    if users_blocked_either_way(current["userId"], target_id):
        raise HTTPException(status_code=403, detail="Friend requests are unavailable for this user")
    target = users_collection().find_one({"_id": ObjectId(target_id)})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    existing = friend_requests_collection().find_one({
        "fromUserId": current["userId"],
        "toUserId": target_id,
        "status": "pending",
    })
    if existing:
        raise HTTPException(status_code=409, detail="Friend request already sent")
    reverse = friend_requests_collection().find_one({
        "fromUserId": target_id,
        "toUserId": current["userId"],
        "status": "pending",
    })
    if reverse:
        raise HTTPException(status_code=409, detail="User already sent you a request")
    doc = {
        "fromUserId": current["userId"],
        "toUserId": target_id,
        "status": "pending",
        "createdAt": datetime.now(timezone.utc),
    }
    result = friend_requests_collection().insert_one(doc)
    try:
        await sio.emit("friend_request_received", {
            "requestId": str(result.inserted_id),
            "fromUserId": current["userId"],
            "fromUsername": current.get("username", "Пользователь"),
        }, to=f"user:{target_id}")
    except Exception:
        pass
    return {"status": "ok", "requestId": str(result.inserted_id)}


@app.get("/friend-requests")
def list_friend_requests(current=Depends(get_current_user)):
    """Входящие и исходящие заявки в друзья"""
    incoming = list(friend_requests_collection().find(
        {"toUserId": current["userId"], "status": "pending"}
    ).sort("createdAt", -1))
    outgoing = list(friend_requests_collection().find(
        {"fromUserId": current["userId"], "status": "pending"}
    ).sort("createdAt", -1))
    return {
        "incoming": [
            {
                "id": str(r["_id"]),
                "fromUserId": r["fromUserId"],
                "fromUsername": users_collection().find_one({"_id": ObjectId(r["fromUserId"])}, {"username": 1}).get("username", "Пользователь") if ObjectId.is_valid(r["fromUserId"]) else "Пользователь",
                "createdAt": r["createdAt"].isoformat(),
            }
            for r in incoming
        ],
        "outgoing": [
            {
                "id": str(r["_id"]),
                "toUserId": r["toUserId"],
                "toUsername": users_collection().find_one({"_id": ObjectId(r["toUserId"])}, {"username": 1}).get("username", "Пользователь") if ObjectId.is_valid(r["toUserId"]) else "Пользователь",
                "createdAt": r["createdAt"].isoformat(),
            }
            for r in outgoing
        ],
    }


@app.post("/friend-requests/{request_id}/respond")
async def respond_to_friend_request(
    request_id: str,
    payload: FriendRequestActionRequest,
    current=Depends(get_current_user),
):
    """Принять или отклонить только активную заявку в друзья"""
    if not ObjectId.is_valid(request_id):
        raise HTTPException(status_code=400, detail="Invalid request id")
    request_object_id = ObjectId(request_id)
    requests = friend_requests_collection()
    req = requests.find_one({"_id": request_object_id, "toUserId": current["userId"]})
    if not req:
        raise HTTPException(status_code=404, detail="Friend request not found")
    if req.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Friend request is no longer pending")

    if payload.accept and users_blocked_either_way(current["userId"], req["fromUserId"]):
        raise HTTPException(status_code=403, detail="Cannot accept a friend request while either user has blocked the other")

    # Conditional transition prevents stale or concurrently handled requests from being processed twice.
    new_status = "accepted" if payload.accept else "rejected"
    updated_request = requests.update_one(
        {"_id": request_object_id, "toUserId": current["userId"], "status": "pending"},
        {"$set": {"status": new_status, "respondedAt": datetime.now(timezone.utc)}},
    )
    if updated_request.matched_count != 1:
        raise HTTPException(status_code=409, detail="Friend request is no longer pending")

    if payload.accept:
        current_user = users_collection().find_one({"_id": ObjectId(current["userId"])}, {"username": 1}) or {}
        requester = users_collection().find_one({"_id": ObjectId(req["fromUserId"])}, {"username": 1}) or {}
        for owner_id, contact_id, nickname in (
            (current["userId"], req["fromUserId"], requester.get("username", "Пользователь")),
            (req["fromUserId"], current["userId"], current_user.get("username", "Пользователь")),
        ):
            owner_object_id = ObjectId(owner_id)
            contact_filter = {"_id": owner_object_id, "contacts.userId": contact_id}
            updated = users_collection().update_one(
                contact_filter,
                {"$set": {"contacts.$.nickname": nickname}},
            )
            if not updated.matched_count:
                users_collection().update_one(
                    {"_id": owner_object_id},
                    {"$pull": {"contacts": contact_id}},
                )
                users_collection().update_one(
                    {"_id": owner_object_id},
                    {"$addToSet": {"contacts": {"userId": contact_id, "nickname": nickname}}},
                )
        try:
            await sio.emit("friend_request_accepted", {
                "requestId": request_id,
                "acceptedBy": current["userId"],
            }, to=f"user:{req['fromUserId']}")
        except Exception:
            pass
    return {"status": "ok", "accepted": payload.accept}


@app.post("/block-user")
def block_user(
    payload: BlockUserRequest,
    current=Depends(get_current_user),
):
    """Заблокировать пользователя"""
    target_id = payload.targetUserId
    if target_id == current["userId"]:
        raise HTTPException(status_code=400, detail="Cannot block yourself")
    if not ObjectId.is_valid(target_id):
        raise HTTPException(status_code=400, detail="Invalid user id")
    blocked_users_collection().update_one(
        {"userId": current["userId"], "blockedUserId": target_id},
        {"$set": {"blockedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    owner_filter = {"_id": ObjectId(current["userId"])}
    # Contacts are normally embedded documents; also clean up legacy scalar IDs.
    users_collection().update_one(
        owner_filter,
        {"$pull": {"contacts": {"userId": target_id}}},
    )
    users_collection().update_one(
        owner_filter,
        {"$pull": {"contacts": target_id}},
    )
    return {"status": "ok"}


@app.get("/blocked-users")
def list_blocked_users(current=Depends(get_current_user)):
    """Список заблокированных пользователей (чёрный список)"""
    blocked = list(blocked_users_collection().find({"userId": current["userId"]}))
    result = []
    for b in blocked:
        target = users_collection().find_one(
            {"_id": ObjectId(b["blockedUserId"])},
            {"username": 1, "displayName": 1, "avatarUrl": 1}
        ) if ObjectId.is_valid(b.get("blockedUserId", "")) else None
        result.append({
            "id": str(b["_id"]),
            "blockedUserId": b["blockedUserId"],
            "username": target.get("username", "Пользователь") if target else "Пользователь",
            "displayName": target.get("displayName", "") if target else "",
            "avatarUrl": target.get("avatarUrl", "") if target else "",
            "blockedAt": b["blockedAt"].isoformat(),
        })
    return {"blocked": result}


@app.post("/profile/banner")
def set_profile_banner(
    payload: ProfileBannerRequest,
    current=Depends(get_current_user),
):
    """Установить баннер профиля"""
    users_collection().update_one(
        {"_id": ObjectId(current["userId"])},
        {"$set": {"bannerUrl": payload.bannerUrl}}
    )
    return {"status": "ok", "bannerUrl": payload.bannerUrl}


@app.post("/profile/verification")
def request_verification(
    payload: VerificationRequest,
    current=Depends(get_current_user),
):
    """Запросить верификацию (галочку) для аккаунта"""
    users_collection().update_one(
        {"_id": ObjectId(current["userId"])},
        {"$set": {
            "verificationRequested": True,
            "verificationReason": payload.reason,
            "verificationRequestedAt": datetime.now(timezone.utc),
        }}
    )
    return {"status": "ok", "message": "Заявка на верификацию отправлена на модерацию"}


def require_poll_access(poll: dict, user_id: str) -> None:
    if poll.get("groupId"):
        get_group_for_member(poll["groupId"], user_id)
        return
    if poll.get("channelId"):
        channel = channel_by_id(poll["channelId"])
        require_read_access(channel, user_id)
        if not get_member(channel, user_id):
            raise HTTPException(status_code=403, detail="Subscribe to this channel to access its poll")
        return
    chat_id = poll.get("chatId")
    if chat_id and ObjectId.is_valid(chat_id):
        has_conversation = messages_collection().find_one({
            "$or": [
                {"senderId": user_id, "receiverId": chat_id},
                {"senderId": chat_id, "receiverId": user_id},
            ]
        }, {"_id": 1})
        is_contact = users_collection().find_one({
            "_id": ObjectId(user_id),
            "contacts.userId": chat_id,
        }, {"_id": 1})
        if has_conversation or is_contact:
            return
    raise HTTPException(status_code=404, detail="Poll not found")


@app.post("/polls")
def create_poll(
    payload: PollCreateRequest,
    current=Depends(get_current_user),
):
    """Создать опрос (в чате, группе или канале)"""
    destinations = sum(bool(value) for value in (payload.chatId, payload.groupId, payload.channelId))
    if destinations != 1:
        raise HTTPException(status_code=400, detail="Choose exactly one poll destination")
    if payload.groupId:
        get_group_for_member(payload.groupId, current["userId"])
    elif payload.channelId:
        channel = channel_by_id(payload.channelId)
        require_read_access(channel, current["userId"])
        if not get_member(channel, current["userId"]):
            raise HTTPException(status_code=403, detail="Subscribe to this channel to create a poll")
    else:
        if not ObjectId.is_valid(payload.chatId):
            raise HTTPException(status_code=400, detail="Invalid chat id")
        has_conversation = messages_collection().find_one({
            "$or": [
                {"senderId": current["userId"], "receiverId": payload.chatId},
                {"senderId": payload.chatId, "receiverId": current["userId"]},
            ]
        }, {"_id": 1})
        is_contact = users_collection().find_one({
            "_id": ObjectId(current["userId"]),
            "contacts.userId": payload.chatId,
        }, {"_id": 1})
        if not has_conversation and not is_contact:
            raise HTTPException(status_code=403, detail="You cannot create a poll in this chat")
    doc = {
        "creatorId": current["userId"],
        "question": payload.question,
        "options": [{"text": o, "votes": 0} for o in payload.options],
        "chatId": payload.chatId,
        "groupId": payload.groupId,
        "channelId": payload.channelId,
        "createdAt": datetime.now(timezone.utc),
        "isActive": True,
    }
    result = polls_collection().insert_one(doc)
    return {"status": "ok", "pollId": str(result.inserted_id)}


@app.post("/polls/{pollId}/vote")
def vote_poll(
    pollId: str,
    payload: PollVoteRequest,
    current=Depends(get_current_user),
):
    """Record a user vote atomically; counts are derived from vote records."""
    if not ObjectId.is_valid(pollId):
        raise HTTPException(status_code=400, detail="Invalid poll id")
    poll = polls_collection().find_one({"_id": ObjectId(pollId)})
    if not poll:
        raise HTTPException(status_code=404, detail="Poll not found")
    if not poll.get("isActive", True):
        raise HTTPException(status_code=400, detail="Poll is closed")
    require_poll_access(poll, current["userId"])
    if payload.optionIndex < 0 or payload.optionIndex >= len(poll["options"]):
        raise HTTPException(status_code=400, detail="Invalid option index")
    votes_collection().update_one(
        {"pollId": pollId, "userId": current["userId"]},
        {"$set": {"optionIndex": payload.optionIndex, "votedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"status": "ok"}


@app.get("/polls/{pollId}")
def get_poll(pollId: str, current=Depends(get_current_user)):
    """Get poll results from the vote records, avoiding stale cached counters."""
    if not ObjectId.is_valid(pollId):
        raise HTTPException(status_code=400, detail="Invalid poll id")
    poll = polls_collection().find_one({"_id": ObjectId(pollId)})
    if not poll:
        raise HTTPException(status_code=404, detail="Poll not found")
    require_poll_access(poll, current["userId"])
    user_vote = votes_collection().find_one({"pollId": pollId, "userId": current["userId"]})
    options = [dict(option) for option in poll["options"]]
    counts = votes_collection().aggregate([
        {"$match": {"pollId": pollId}},
        {"$group": {"_id": "$optionIndex", "count": {"$sum": 1}}},
    ])
    counts_by_option = {row["_id"]: row["count"] for row in counts}
    for index, option in enumerate(options):
        option["votes"] = counts_by_option.get(index, 0)
    return {
        "id": str(poll["_id"]),
        "question": poll["question"],
        "options": options,
        "userVote": user_vote["optionIndex"] if user_vote else None,
        "isActive": poll.get("isActive", True),
        "createdAt": poll["createdAt"].isoformat(),
    }

@app.post("/stories")
def create_story(
    payload: StoryCreateRequest,
    current=Depends(get_current_user),
):
    """Создать историю (доступна 24 часа)"""
    expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
    doc = {
        "userId": current["userId"],
        "mediaType": payload.mediaType,
        "mediaData": payload.mediaData,
        "caption": payload.caption,
        "createdAt": datetime.now(timezone.utc),
        "expiresAt": expires_at,
        "views": [],
    }
    result = stories_collection().insert_one(doc)
    stories_collection().create_index("expiresAt", expireAfterSeconds=0)
    return {"status": "ok", "storyId": str(result.inserted_id)}


@app.get("/stories")
def list_stories(current=Depends(get_current_user)):
    """Список активных историй"""
    now = datetime.now(timezone.utc)
    stories = list(stories_collection().find(
        {"expiresAt": {"$gt": now}}
    ).sort("createdAt", -1))
    result = []
    for s in stories:
        viewer = current["userId"] in s.get("views", [])
        user = users_collection().find_one(
            {"_id": ObjectId(s["userId"])},
            {"username": 1, "displayName": 1, "avatarUrl": 1}
        ) if ObjectId.is_valid(s["userId"]) else None
        result.append({
            "id": str(s["_id"]),
            "userId": s["userId"],
            "username": user.get("username", "Пользователь") if user else "Пользователь",
            "displayName": user.get("displayName", "") if user else "",
            "avatarUrl": user.get("avatarUrl", "") if user else "",
            "mediaType": s["mediaType"],
            "mediaData": s["mediaData"],
            "caption": s.get("caption", ""),
            "createdAt": s["createdAt"].isoformat(),
            "expiresAt": s["expiresAt"].isoformat(),
            "viewed": viewer,
        })
    return {"stories": result}


@app.post("/stories/{storyId}/view")
def view_story(storyId: str, current=Depends(get_current_user)):
    """Отметить просмотр истории"""
    if not ObjectId.is_valid(storyId):
        raise HTTPException(status_code=400, detail="Invalid story id")
    result = stories_collection().update_one(
        {"_id": ObjectId(storyId), "expiresAt": {"$gt": datetime.now(timezone.utc)}},
        {"$addToSet": {"views": current["userId"]}}
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=404, detail="Story not found or expired")
    return {"status": "ok"}


@app.post("/events")
def create_event(
    payload: EventCreateRequest,
    current=Depends(get_current_user),
):
    """Создать событие (встречу с датой и местом)"""
    try:
        event_date = datetime.fromisoformat(payload.eventDate.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="Invalid event date")
    if event_date.tzinfo is None or event_date.utcoffset() is None:
        event_date = event_date.replace(tzinfo=timezone.utc)
    event_date = event_date.astimezone(timezone.utc)

    participant_ids = list(dict.fromkeys(payload.participants))
    if current["userId"] in participant_ids:
        participant_ids.remove(current["userId"])
    if any(not ObjectId.is_valid(user_id) for user_id in participant_ids):
        raise HTTPException(status_code=400, detail="Invalid participant id")
    if participant_ids:
        existing_users = users_collection().count_documents({
            "_id": {"$in": [ObjectId(user_id) for user_id in participant_ids]}
        })
        if existing_users != len(participant_ids):
            raise HTTPException(status_code=404, detail="One or more participants were not found")
        creator = users_collection().find_one(
            {"_id": ObjectId(current["userId"])},
            {"contacts.userId": 1},
        ) or {}
        contact_ids = {
            str(contact.get("userId"))
            for contact in creator.get("contacts", [])
            if isinstance(contact, dict) and contact.get("userId")
        }
        if any(user_id not in contact_ids for user_id in participant_ids):
            raise HTTPException(status_code=403, detail="Events can only invite your contacts")

    doc = {
        "creatorId": current["userId"],
        "title": payload.title,
        "description": payload.description,
        "eventDate": event_date,
        "location": payload.location,
        "participants": [current["userId"], *participant_ids],
        "createdAt": datetime.now(timezone.utc),
    }
    result = events_collection().insert_one(doc)
    return {"status": "ok", "eventId": str(result.inserted_id)}


@app.get("/events")
def list_events(current=Depends(get_current_user)):
    """Список событий пользователя"""
    events = list(events_collection().find(
        {"participants": current["userId"]}
    ).sort("eventDate", 1))
    return {
        "items": [
            {
                "id": str(e["_id"]),
                "title": e["title"],
                "description": e.get("description", ""),
                "eventDate": e["eventDate"].isoformat(),
                "location": e.get("location", ""),
                "participants": e.get("participants", []),
                "creatorId": e["creatorId"],
                "createdAt": e["createdAt"].isoformat(),
            }
            for e in events
        ]
    }


@app.post("/reports")
def create_report(
    payload: ReportRequest,
    current=Depends(get_current_user),
):
    """Пожаловаться на пользователя, сообщение, канал или группу"""
    if not ObjectId.is_valid(payload.targetId):
        raise HTTPException(status_code=400, detail="Invalid report target id")
    target_oid = ObjectId(payload.targetId)
    target_collections = {
        "user": users_collection,
        "message": messages_collection,
        "channel": channels_collection,
        "group": groups_collection,
    }
    target = target_collections[payload.targetType]().find_one({"_id": target_oid}, {"_id": 1})
    if not target:
        raise HTTPException(status_code=404, detail="Report target not found")
    doc = {
        "reporterId": current["userId"],
        "targetType": payload.targetType,
        "targetId": payload.targetId,
        "reason": payload.reason,
        "status": "pending",
        "createdAt": datetime.now(timezone.utc),
    }
    result = reports_collection().insert_one(doc)
    return {"status": "ok", "reportId": str(result.inserted_id)}


@app.get("/settings")
def get_user_settings(current=Depends(get_current_user)):
    """Получить настройки оформления и поведения пользователя"""
    settings = user_settings_collection().find_one({"userId": current["userId"]})
    if not settings:
        return {
            "theme": "dark",
            "accentColor": "#3b82f6",
            "chatBackground": "",
            "fontSize": "medium",
            "messageDensity": "comfortable",
            "animationsEnabled": True,
            "pinnedChatIds": [],
            "quickActionButtons": [],
        }
    return {
        "theme": settings.get("theme", "dark"),
        "accentColor": settings.get("accentColor", "#3b82f6"),
        "chatBackground": settings.get("chatBackground", ""),
        "fontSize": settings.get("fontSize", "medium"),
        "messageDensity": settings.get("messageDensity", "comfortable"),
        "animationsEnabled": settings.get("animationsEnabled", True),
        "pinnedChatIds": settings.get("pinnedChatIds", []),
        "quickActionButtons": settings.get("quickActionButtons", []),
    }


@app.post("/settings")
def save_user_settings(
    payload: UserSettingsRequest,
    current=Depends(get_current_user),
):
    """Сохранить настройки оформления"""
    update = {k: v for k, v in payload.model_dump().items() if v is not None}
    user_settings_collection().update_one(
        {"userId": current["userId"]},
        {"$set": update, "$setOnInsert": {"createdAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"status": "ok"}


@app.post("/auth/2fa")
def toggle_two_factor(
    payload: TwoFactorRequest,
    current=Depends(get_current_user),
):
    """Fail closed until login-time TOTP verification is implemented."""
    raise HTTPException(
        status_code=501,
        detail="Two-factor authentication is not available yet.",
    )


@app.get("/auth/sessions")
def list_user_sessions(current=Depends(get_current_user)):
    """Session inventory is unavailable until tokens can be revoked."""
    raise HTTPException(
        status_code=501,
        detail="Session management is not available yet.",
    )


@app.get("/auth/login-history")
def get_login_history(current=Depends(get_current_user)):
    """История входов в аккаунт"""
    history = list(login_history_collection().find(
        {"userId": current["userId"]}
    ).sort("loginAt", -1).limit(50))
    return {
        "items": [
            {
                "id": str(h["_id"]),
                "ipAddress": h.get("ipAddress", ""),
                "userAgent": h.get("userAgent", ""),
                "loginAt": h["loginAt"].isoformat(),
                "location": h.get("location", ""),
            }
            for h in history
        ]
    }


@app.post("/auth/pin-code")
def set_app_pin_code(
    payload: PinCodeRequest,
    current=Depends(get_current_user),
):
    """A server-side PIN would not lock the local app, so fail closed."""
    raise HTTPException(
        status_code=501,
        detail="App PIN protection is not available yet.",
    )


@app.post("/auth/auto-delete-account")
def request_auto_delete_account(
    payload: AutoDeleteAccountRequest,
    current=Depends(get_current_user),
):
    """Do not claim deletion is scheduled when no deletion worker exists."""
    raise HTTPException(
        status_code=501,
        detail="Automatic account deletion is not available yet.",
    )


@app.post("/bots/{bot_id}/commands")
def add_bot_command(bot_id: str, payload: BotCommandRequest, current=Depends(get_current_user)):
    """Добавить команду для бота"""
    if not ObjectId.is_valid(bot_id):
        raise HTTPException(status_code=400, detail="Invalid bot id")
    result = bots_collection().update_one(
        {"_id": ObjectId(bot_id), "ownerId": current["userId"]},
        {"$push": {"commands": {"command": payload.command, "response": payload.response, "addedAt": datetime.now(timezone.utc)}}}
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=404, detail="Bot not found")
    return {"status": "ok"}


@app.post("/gifts/send")
async def send_gift(
    payload: GiftSendRequest,
    current=Depends(get_current_user),
):
    """Отправить анимированный подарок (Lottie) пользователю"""
    if not ObjectId.is_valid(payload.giftId):
        raise HTTPException(status_code=400, detail="Invalid gift id")
    if not ObjectId.is_valid(payload.targetUserId):
        raise HTTPException(status_code=400, detail="Invalid recipient id")
    if payload.targetUserId == current["userId"]:
        raise HTTPException(status_code=400, detail="Cannot send a gift to yourself")
    recipient = users_collection().find_one({"_id": ObjectId(payload.targetUserId)}, {"_id": 1})
    if not recipient:
        raise HTTPException(status_code=404, detail="Recipient not found")
    if users_blocked_either_way(current["userId"], payload.targetUserId):
        raise HTTPException(status_code=403, detail="Cannot send a gift to this user")
    gift = gifts_collection().find_one({"_id": ObjectId(payload.giftId)})
    if not gift:
        raise HTTPException(status_code=404, detail="Gift not found")
    doc = {
        "senderId": current["userId"],
        "receiverId": payload.targetUserId,
        "giftId": payload.giftId,
        "giftName": gift.get("name", "Подарок"),
        "sentAt": datetime.now(timezone.utc),
    }
    from db import get_db
    get_db()["sent_gifts"].insert_one(doc)
    try:
        await sio.emit("gift_received", {
            "giftId": payload.giftId,
            "giftName": gift.get("name", "Подарок"),
            "senderId": current["userId"],
        }, to=f"user:{payload.targetUserId}")
    except Exception:
        pass
    return {"status": "ok"}


@app.get("/gifts")
def list_available_gifts():
    """Список доступных подарков"""
    gifts = list(gifts_collection().find({}, {"name": 1, "emoji": 1, "priceCoins": 1, "imageUrl": 1}))
    return {
        "gifts": [
            {
                "id": str(g["_id"]),
                "name": g.get("name", "Подарок"),
                "emoji": g.get("emoji", "🎁"),
                "priceCoins": g.get("priceCoins", 0),
                "imageUrl": g.get("imageUrl", ""),
            }
            for g in gifts
        ]
    }


# Keep the FastAPI app separately available, but make the conventional `main:app`
# entry point serve Socket.IO as well as HTTP requests.
fastapi_app = app
socket_app = socketio_server.ASGIApp(sio, other_asgi_app=fastapi_app)
app = socket_app
