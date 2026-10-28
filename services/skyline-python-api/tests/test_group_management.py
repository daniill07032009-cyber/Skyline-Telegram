import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, Mock, patch

from bson import ObjectId
from fastapi import HTTPException

import group_management


OWNER_ID = "507f1f77bcf86cd799439011"
JOINER_ID = "507f1f77bcf86cd799439012"
GROUP_ID = ObjectId("507f1f77bcf86cd799439013")
INVITE_TOKEN = "a-valid-invite-token-12345"


def make_group(*, is_public=True, members=None):
    now = datetime.now(timezone.utc)
    return {
        "_id": GROUP_ID,
        "title": "Test group",
        "isPublic": is_public,
        "inviteCode": INVITE_TOKEN,
        "createdBy": OWNER_ID,
        "members": members or [{"userId": OWNER_ID, "role": "owner", "joinedAt": now}],
        "createdAt": now,
        "updatedAt": now,
    }


class GroupJoinConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_transfer_ownership_updates_roles_without_replacing_members_snapshot(self):
        new_owner_id = "507f1f77bcf86cd799439014"
        before = make_group(members=[
            {"userId": OWNER_ID, "role": "owner", "joinedAt": datetime.now(timezone.utc)},
            {"userId": new_owner_id, "role": "member", "joinedAt": datetime.now(timezone.utc)},
        ])
        after = make_group(members=[
            {"userId": OWNER_ID, "role": "admin", "joinedAt": before["members"][0]["joinedAt"]},
            {"userId": new_owner_id, "role": "owner", "joinedAt": before["members"][1]["joinedAt"]},
        ])
        collection = Mock()
        collection.update_one.return_value.matched_count = 1
        collection.find_one.return_value = after

        with (
            patch("group_management.groups_collection", return_value=collection),
            patch("group_management._notify_members", new_callable=AsyncMock) as notify,
        ):
            response = await group_management.transfer_group_ownership(
                str(GROUP_ID),
                group_management.TransferOwnershipRequest(userId=new_owner_id),
                {"userId": OWNER_ID},
            )

        self.assertEqual(response["ownerId"], new_owner_id)
        query, update = collection.update_one.call_args.args[:2]
        self.assertEqual(
            query["$and"],
            [
                {"members": {"$elemMatch": {"userId": OWNER_ID}}},
                {"members": {"$elemMatch": {"userId": new_owner_id}}},
            ],
        )
        self.assertNotIn("members", update["$set"])
        self.assertEqual(
            collection.update_one.call_args.kwargs["array_filters"],
            [
                {"old_owner.userId": OWNER_ID},
                {"new_owner.userId": new_owner_id},
            ],
        )
        notify.assert_awaited_once()

    async def test_invite_join_race_returns_already_member_without_duplicate_notification(self):
        before = make_group()
        after = make_group(members=[
            *before["members"],
            {"userId": JOINER_ID, "role": "member", "joinedAt": datetime.now(timezone.utc)},
        ])
        collection = Mock()
        collection.update_one.return_value.modified_count = 0
        collection.find_one.side_effect = [before, after]

        with (
            patch("group_management.groups_collection", return_value=collection),
            patch("group_management._notify_members", new_callable=AsyncMock) as notify,
        ):
            response = await group_management.join_group_by_invite(
                group_management.JoinInviteRequest(token=INVITE_TOKEN),
                {"userId": JOINER_ID},
            )

        self.assertTrue(response["alreadyMember"])
        self.assertEqual(response["id"], str(GROUP_ID))
        notify.assert_not_awaited()

    async def test_public_join_race_returns_already_member_without_duplicate_notification(self):
        before = make_group(is_public=True)
        after = make_group(is_public=True, members=[
            *before["members"],
            {"userId": JOINER_ID, "role": "member", "joinedAt": datetime.now(timezone.utc)},
        ])
        collection = Mock()
        collection.update_one.return_value.modified_count = 0
        collection.find_one.side_effect = [before, after]

        with (
            patch("group_management.groups_collection", return_value=collection),
            patch("group_management._notify_members", new_callable=AsyncMock) as notify,
        ):
            response = await group_management.join_public_group(
                str(GROUP_ID),
                {"userId": JOINER_ID},
            )

        self.assertTrue(response["alreadyMember"])
        self.assertEqual(response["id"], str(GROUP_ID))
        notify.assert_not_awaited()

    async def test_invite_join_enforces_member_limit_in_atomic_update(self):
        before = make_group()
        after = make_group(members=[
            *before["members"],
            {"userId": JOINER_ID, "role": "member", "joinedAt": datetime.now(timezone.utc)},
        ])
        collection = Mock()
        collection.update_one.return_value.modified_count = 1
        collection.find_one.side_effect = [before, after]

        with (
            patch("group_management.groups_collection", return_value=collection),
            patch("group_management._notify_members", new_callable=AsyncMock),
        ):
            response = await group_management.join_group_by_invite(
                group_management.JoinInviteRequest(token=INVITE_TOKEN),
                {"userId": JOINER_ID},
            )

        self.assertFalse(response["alreadyMember"])
        query = collection.update_one.call_args.args[0]
        self.assertEqual(query["inviteCode"], INVITE_TOKEN)
        self.assertEqual(
            query["$expr"],
            {"$lt": [{"$size": {"$ifNull": ["$members", []]}}, 100]},
        )

    async def test_public_join_enforces_member_limit_in_atomic_update(self):
        before = make_group(is_public=True)
        after = make_group(is_public=True, members=[
            *before["members"],
            {"userId": JOINER_ID, "role": "member", "joinedAt": datetime.now(timezone.utc)},
        ])
        collection = Mock()
        collection.update_one.return_value.modified_count = 1
        collection.find_one.side_effect = [before, after]

        with (
            patch("group_management.groups_collection", return_value=collection),
            patch("group_management._notify_members", new_callable=AsyncMock),
        ):
            response = await group_management.join_public_group(
                str(GROUP_ID),
                {"userId": JOINER_ID},
            )

        self.assertFalse(response["alreadyMember"])
        query = collection.update_one.call_args.args[0]
        self.assertTrue(query["isPublic"])
        self.assertEqual(
            query["$expr"],
            {"$lt": [{"$size": {"$ifNull": ["$members", []]}}, 100]},
        )

    async def test_public_join_rejects_group_that_became_private_during_join(self):
        before = make_group(is_public=True)
        after = make_group(is_public=False)
        collection = Mock()
        collection.update_one.return_value.modified_count = 0
        collection.find_one.side_effect = [before, after]

        with (
            patch("group_management.groups_collection", return_value=collection),
            patch("group_management._notify_members", new_callable=AsyncMock) as notify,
        ):
            with self.assertRaises(HTTPException) as error:
                await group_management.join_public_group(
                    str(GROUP_ID),
                    {"userId": JOINER_ID},
                )

        self.assertEqual(error.exception.status_code, 404)
        notify.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
