from datetime import datetime, timezone
import re
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from auth import get_current_user
from db import groups_collection, users_collection
from realtime import sio

router = APIRouter()


def _group_for_member(group_id: str, user_id: str):
    if not ObjectId.is_valid(group_id):
        raise HTTPException(status_code=400, detail="Invalid group id")
    group = groups_collection().find_one({"_id": ObjectId(group_id), "members.userId": user_id})
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


def _role(group: dict, user_id: str) -> str:
    member = next((item for item in group.get("members", []) if item.get("userId") == user_id), None)
    if not member:
        raise HTTPException(status_code=403, detail="Not a group member")
    if member.get("role") == "owner" or group.get("createdBy") == user_id:
        return "owner"
    return member.get("role", "member")


def _require_admin(group: dict, user_id: str) -> str:
    role = _role(group, user_id)
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Only group admins can change settings")
    return role


async def _notify_members(group: dict, group_id: str, action: str):
    for member in group.get("members", []):
        try:
            await sio.emit("group_changed", {"groupId": group_id, "action": action}, to=f"user:{member['userId']}")
        except Exception as exc:
            print(f"Failed to notify group member: {exc}")


class GroupSettingsRequest(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=64)
    description: str | None = Field(default=None, max_length=500)
    avatarUrl: str | None = Field(default=None, max_length=1_400_000)
    isPublic: bool | None = None

    @field_validator("avatarUrl")
    @classmethod
    def validate_avatar_url(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return value
        if not re.fullmatch(r"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*", value):
            raise ValueError("Avatar must be a supported base64 image")
        return value


class GroupRoleRequest(BaseModel):
    role: str = Field(pattern=r"^(admin|member)$")


class TransferOwnershipRequest(BaseModel):
    userId: str = Field(min_length=1, max_length=64)


class JoinInviteRequest(BaseModel):
    token: str = Field(min_length=16, max_length=256)


@router.patch("/groups/{group_id}/settings")
async def update_group_settings(group_id: str, payload: GroupSettingsRequest, current=Depends(get_current_user)):
    group = _group_for_member(group_id, current["userId"])
    _require_admin(group, current["userId"])
    changes = payload.model_dump(exclude_unset=True)
    if "title" in changes:
        changes["title"] = changes["title"].strip()
        if len(changes["title"]) < 2:
            raise HTTPException(status_code=422, detail="Group name must contain at least 2 characters")
    if not changes:
        return {"status": "ok"}
    changes["updatedAt"] = datetime.now(timezone.utc)
    update_result = groups_collection().update_one(
        {
            "_id": group["_id"],
            "$or": [
                {"createdBy": current["userId"]},
                {"members": {"$elemMatch": {
                    "userId": current["userId"],
                    "role": {"$in": ["owner", "admin"]},
                }}},
            ],
        },
        {"$set": changes},
    )
    if update_result.matched_count != 1:
        raise HTTPException(status_code=409, detail="Group permissions changed; refresh and try again")
    updated = groups_collection().find_one({"_id": group["_id"]})
    await _notify_members(updated, group_id, "settings")
    return {"status": "ok", "title": updated["title"], "isPublic": bool(updated.get("isPublic", False))}


@router.patch("/groups/{group_id}/members/{member_id}/role")
async def update_group_member_role(group_id: str, member_id: str, payload: GroupRoleRequest, current=Depends(get_current_user)):
    group = _group_for_member(group_id, current["userId"])
    if _role(group, current["userId"]) != "owner":
        raise HTTPException(status_code=403, detail="Only the group owner can manage administrator roles")
    if not any(member.get("userId") == member_id for member in group.get("members", [])):
        raise HTTPException(status_code=404, detail="Group member not found")
    if member_id == current["userId"] or member_id == group.get("createdBy"):
        raise HTTPException(status_code=400, detail="The owner role cannot be changed here")
    update_result = groups_collection().update_one(
        {
            "_id": group["_id"],
            "members.userId": member_id,
            "$or": [
                {"createdBy": current["userId"]},
                {"members": {"$elemMatch": {"userId": current["userId"], "role": "owner"}}},
            ],
        },
        {"$set": {"members.$.role": payload.role, "updatedAt": datetime.now(timezone.utc)}},
    )
    if update_result.matched_count != 1:
        raise HTTPException(status_code=409, detail="Group ownership changed; refresh and try again")
    updated = groups_collection().find_one({"_id": group["_id"]})
    await _notify_members(updated, group_id, "members")
    return {"status": "ok", "userId": member_id, "role": payload.role}


@router.delete("/groups/{group_id}/members/{member_id}")
async def remove_group_member(group_id: str, member_id: str, current=Depends(get_current_user)):
    group = _group_for_member(group_id, current["userId"])
    current_user_id = current["userId"]
    current_role = _role(group, current_user_id)
    target = next((member for member in group.get("members", []) if member.get("userId") == member_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Group member not found")
    if member_id == group.get("createdBy") or target.get("role") == "owner":
        raise HTTPException(status_code=400, detail="The group owner cannot be removed")
    leaving = member_id == current_user_id
    if not leaving and current_role != "owner":
        raise HTTPException(status_code=403, detail="Only the group owner can remove other members")
    if leaving and current_role == "owner":
        raise HTTPException(status_code=400, detail="Transfer ownership before leaving the group")
    now = datetime.now(timezone.utc)
    membership_conditions = [
        {"members": {"$elemMatch": {"userId": current_user_id}}},
        {"members": {"$elemMatch": {"userId": member_id, "role": {"$ne": "owner"}}}},
    ]
    if not leaving:
        membership_conditions.append({
            "$or": [
                {"createdBy": current_user_id},
                {"members": {"$elemMatch": {"userId": current_user_id, "role": "owner"}}},
            ]
        })
    result = groups_collection().update_one(
        {"_id": group["_id"], "$and": membership_conditions},
        {"$pull": {"members": {"userId": member_id}}, "$set": {"updatedAt": now}},
    )
    if result.modified_count != 1:
        raise HTTPException(status_code=409, detail="Group membership changed; refresh and retry")
    updated = groups_collection().find_one({"_id": group["_id"]})
    await _notify_members(updated, group_id, "members")
    try:
        await sio.emit("group_changed", {"groupId": group_id, "action": "member_removed", "userId": member_id}, to=f"user:{member_id}")
    except Exception as exc:
        print(f"Failed to notify removed group member: {exc}")
    return {"status": "removed", "userId": member_id, "left": leaving}


@router.post("/groups/{group_id}/transfer-ownership")
async def transfer_group_ownership(group_id: str, payload: TransferOwnershipRequest, current=Depends(get_current_user)):
    group = _group_for_member(group_id, current["userId"])
    if _role(group, current["userId"]) != "owner":
        raise HTTPException(status_code=403, detail="Only the group owner can transfer ownership")
    if payload.userId == current["userId"]:
        raise HTTPException(status_code=400, detail="You already own this group")
    if not any(member.get("userId") == payload.userId for member in group.get("members", [])):
        raise HTTPException(status_code=404, detail="The new owner must already be a group member")
    now = datetime.now(timezone.utc)
    update_result = groups_collection().update_one(
        {
            "_id": group["_id"],
            # Re-check both members and ownership at write time.
            "$and": [
                {"members": {"$elemMatch": {"userId": current["userId"]}}},
                {"members": {"$elemMatch": {"userId": payload.userId}}},
            ],
            "$or": [
                {"createdBy": current["userId"]},
                {"members": {"$elemMatch": {"userId": current["userId"], "role": "owner"}}},
            ],
        },
        {
            "$set": {
                "members.$[old_owner].role": "admin",
                "members.$[new_owner].role": "owner",
                "createdBy": payload.userId,
                "updatedAt": now,
            }
        },
        array_filters=[
            {"old_owner.userId": current["userId"]},
            {"new_owner.userId": payload.userId},
        ],
    )
    if update_result.matched_count != 1:
        raise HTTPException(status_code=409, detail="Group ownership changed; refresh and try again")
    updated = groups_collection().find_one({"_id": group["_id"]})
    await _notify_members(updated, group_id, "ownership")
    return {"status": "ok", "ownerId": payload.userId}


@router.post("/groups/join-by-invite")
async def join_group_by_invite(payload: JoinInviteRequest, current=Depends(get_current_user)):
    group = groups_collection().find_one({"inviteCode": payload.token})
    if not group:
        raise HTTPException(status_code=404, detail="Invitation link is invalid or has expired")
    user_id = current["userId"]
    if any(member.get("userId") == user_id for member in group.get("members", [])):
        return {"status": "ok", "id": str(group["_id"]), "alreadyMember": True}
    if len(group.get("members", [])) >= 100:
        raise HTTPException(status_code=409, detail="This group has reached its member limit")
    now = datetime.now(timezone.utc)
    update_result = groups_collection().update_one(
        {
            "_id": group["_id"],
            "inviteCode": payload.token,
            "members.userId": {"$ne": user_id},
            # Enforce the member limit atomically so concurrent joins cannot exceed 100.
            "$expr": {"$lt": [{"$size": {"$ifNull": ["$members", []]}}, 100]},
        },
        {"$push": {"members": {"userId": user_id, "joinedAt": now, "role": "member"}}, "$set": {"updatedAt": now}},
    )
    if update_result.modified_count == 1:
        updated = groups_collection().find_one({"_id": group["_id"]})
        await _notify_members(updated, str(group["_id"]), "members")
        return {"status": "ok", "id": str(group["_id"]), "alreadyMember": False}

    # Another request may have joined this user concurrently; return persisted state.
    updated = groups_collection().find_one({"_id": group["_id"]})
    if not updated:
        raise HTTPException(status_code=404, detail="Group not found")
    if not any(member.get("userId") == user_id for member in updated.get("members", [])):
        raise HTTPException(status_code=409, detail="Could not join group; please retry")
    return {"status": "ok", "id": str(group["_id"]), "alreadyMember": True}


@router.post("/groups/{group_id}/join")
async def join_public_group(group_id: str, current=Depends(get_current_user)):
    if not ObjectId.is_valid(group_id):
        raise HTTPException(status_code=400, detail="Invalid group id")
    group = groups_collection().find_one({"_id": ObjectId(group_id), "isPublic": True})
    if not group:
        raise HTTPException(status_code=404, detail="Public group not found")
    user_id = current["userId"]
    if any(member.get("userId") == user_id for member in group.get("members", [])):
        return {"status": "ok", "id": group_id, "alreadyMember": True}
    if len(group.get("members", [])) >= 100:
        raise HTTPException(status_code=409, detail="This group has reached its member limit")
    now = datetime.now(timezone.utc)
    update_result = groups_collection().update_one(
        {
            "_id": group["_id"],
            "isPublic": True,
            "members.userId": {"$ne": user_id},
            # Enforce the member limit atomically so concurrent joins cannot exceed 100.
            "$expr": {"$lt": [{"$size": {"$ifNull": ["$members", []]}}, 100]},
        },
        {"$push": {"members": {"userId": user_id, "joinedAt": now, "role": "member"}}, "$set": {"updatedAt": now}},
    )
    if update_result.modified_count == 1:
        updated = groups_collection().find_one({"_id": group["_id"]})
        await _notify_members(updated, group_id, "members")
        return {"status": "ok", "id": group_id, "alreadyMember": False}

    # Another request may have joined this user or the group may have become private.
    updated = groups_collection().find_one({"_id": group["_id"]})
    if not updated:
        raise HTTPException(status_code=404, detail="Public group not found")
    if not updated.get("isPublic", False):
        raise HTTPException(status_code=404, detail="Public group not found")
    if not any(member.get("userId") == user_id for member in updated.get("members", [])):
        raise HTTPException(status_code=409, detail="Could not join group; please retry")
    return {"status": "ok", "id": group_id, "alreadyMember": True}


@router.get("/groups/discover")
def discover_public_groups(current=Depends(get_current_user)):
    groups = list(groups_collection().find(
        {"isPublic": True, "members.userId": {"$ne": current["userId"]}},
        {"title": 1, "members": 1, "createdAt": 1},
    ).sort("updatedAt", -1).limit(100))
    owner_ids = [group.get("createdBy") for group in groups if group.get("createdBy")]
    owners = {
        str(item["_id"]): item.get("username", "Пользователь")
        for item in users_collection().find({"_id": {"$in": [ObjectId(value) for value in owner_ids if ObjectId.is_valid(value)]}}, {"username": 1})
    }
    return [
        {"id": str(group["_id"]), "title": group.get("title", "Группа"), "memberCount": len(group.get("members", [])),
         "ownerUsername": owners.get(group.get("createdBy", ""), "Пользователь")}
        for group in groups
    ]
