import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

_client = None
_db = None

def connect_db():
    global _client, _db
    if _db is not None:
        return _db

    uri = os.getenv("MONGO_URI", "mongodb://localhost:27017/oursocial")
    _client = MongoClient(uri)
    _db = _client.get_database()
    return _db

def get_db():
    if _db is None:
        return connect_db()
    return _db

def users_collection():
    return get_db()["users"]

def keys_collection():
    return get_db()["keys"]

def messages_collection():
    return get_db()["messages"]

def groups_collection():
    return get_db()["groups"]

def channels_collection():
    return get_db()["channels"]

def channel_posts_collection():
    return get_db()["channel_posts"]

def email_verifications_collection():
    return get_db()["email_verifications"]

def verified_email_tokens_collection():
    return get_db()["verified_email_tokens"]


def friend_requests_collection():
    return get_db()["friend_requests"]


def blocked_users_collection():
    return get_db()["blocked_users"]


def saved_messages_collection():
    return get_db()["saved_messages"]


def drafts_collection():
    return get_db()["drafts"]


def scheduled_messages_collection():
    return get_db()["scheduled_messages"]


def quick_replies_collection():
    return get_db()["quick_replies"]


def stories_collection():
    return get_db()["stories"]


def polls_collection():
    return get_db()["polls"]


def votes_collection():
    return get_db()["votes"]


def events_collection():
    return get_db()["events"]


def user_sessions_collection():
    return get_db()["user_sessions"]


def login_history_collection():
    return get_db()["login_history"]


def reports_collection():
    return get_db()["reports"]


def bots_collection():
    return get_db()["bots"]


def gifts_collection():
    return get_db()["gifts"]


def user_settings_collection():
    return get_db()["user_settings"]


def chat_settings_collection():
    return get_db()["chat_settings"]
