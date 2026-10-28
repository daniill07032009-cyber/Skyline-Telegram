from datetime import datetime, timedelta, timezone
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_current_user
from db import users_collection


router = APIRouter(tags=["premium and coins"])

COIN_PACKAGES = {
    100: {"priceRub": 99},
    500: {"priceRub": 449},
    1000: {"priceRub": 799},
}


class BuyCoinsRequest(BaseModel):
    coins: Literal[100, 500, 1000]


def get_user_document(user_id: str) -> dict:
    if not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=401, detail="Invalid user id")
    user = users_collection().find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


def premium_expiry(user: dict) -> datetime | None:
    expires_at = user.get("premiumUntil")
    if expires_at is None:
        return None
    if expires_at.tzinfo is None:
        return expires_at.replace(tzinfo=timezone.utc)
    return expires_at.astimezone(timezone.utc)


def is_premium_active(user: dict, now: datetime | None = None) -> bool:
    expires_at = premium_expiry(user)
    current_time = now or datetime.now(timezone.utc)
    return bool(user.get("isPremium", False) and expires_at and expires_at > current_time)


def serialize_premium(user: dict) -> dict:
    active = is_premium_active(user)
    return {
        "isPremium": active,
        "premiumUntil": premium_expiry(user).isoformat() if active else None,
        "coinsBalance": max(0, int(user.get("coinsBalance", 0))),
    }


@router.get("/premium/status")
def premium_status(current=Depends(get_current_user)):
    user = get_user_document(current["userId"])
    status = serialize_premium(user)
    if not status["isPremium"] and user.get("isPremium"):
        users_collection().update_one(
            {"_id": user["_id"]},
            {"$set": {"isPremium": False}},
        )
    return status


@router.post("/premium/buy")
def buy_premium(current=Depends(get_current_user)):
    user = get_user_document(current["userId"])
    now = datetime.now(timezone.utc)
    current_expiry = premium_expiry(user)
    starts_at = current_expiry if is_premium_active(user, now) and current_expiry else now
    expires_at = starts_at + timedelta(days=30)
    result = users_collection().update_one(
        {"_id": user["_id"]},
        {"$set": {"isPremium": True, "premiumUntil": expires_at}},
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "status": "ok",
        "isPremium": True,
        "premiumUntil": expires_at.isoformat(),
        "durationDays": 30,
        "simulated": True,
    }


@router.get("/coins/balance")
def get_coins_balance(current=Depends(get_current_user)):
    user = get_user_document(current["userId"])
    return {"coinsBalance": max(0, int(user.get("coinsBalance", 0)))}


@router.post("/coins/buy")
def buy_coins(payload: BuyCoinsRequest, current=Depends(get_current_user)):
    user = get_user_document(current["userId"])
    package = COIN_PACKAGES[payload.coins]
    result = users_collection().update_one(
        {"_id": user["_id"]},
        {"$inc": {"coinsBalance": payload.coins}},
    )
    if result.matched_count != 1:
        raise HTTPException(status_code=404, detail="User not found")
    balance = max(0, int(user.get("coinsBalance", 0))) + payload.coins
    return {
        "status": "ok",
        "coinsAdded": payload.coins,
        "priceRub": package["priceRub"],
        "coinsBalance": balance,
        "simulated": True,
    }
