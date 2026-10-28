import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, Mock, patch

from bson import ObjectId
from fastapi import HTTPException

import channels


OWNER_ID = "507f1f77bcf86cd799439011"
SUBSCRIBER_ID = "507f1f77bcf86cd799439012"
CHANNEL_ID = ObjectId("507f1f77bcf86cd799439013")
POST_ID = ObjectId("507f1f77bcf86cd799439014")


def make_channel(visibility: str = "public") -> dict:
    now = datetime.now(timezone.utc)
    return {
        "_id": CHANNEL_ID,
        "title": "Skyline новости",
        "description": "Новости проекта",
        "visibility": visibility,
        "ownerId": OWNER_ID,
        "members": [
            {"userId": OWNER_ID, "role": "owner", "joinedAt": now},
            {"userId": SUBSCRIBER_ID, "role": "subscriber", "joinedAt": now},
        ],
        "createdAt": now,
        "updatedAt": now,
    }


class ChannelTests(unittest.IsolatedAsyncioTestCase):
    def test_channel_reaction_schema_accepts_all_supported_reactions(self) -> None:
        for emoji in ("❤️", "👍", "😂", "🔥", "🎉", "😢"):
            with self.subTest(emoji=emoji):
                self.assertEqual(channels.ChannelReactionRequest(emoji=emoji).emoji, emoji)

    def test_private_channel_is_hidden_from_non_members(self) -> None:
        with self.assertRaises(HTTPException) as error:
            channels.require_read_access(make_channel("private"), "507f1f77bcf86cd799439015")
        self.assertEqual(error.exception.status_code, 404)

    def test_only_owner_can_manage_channel(self) -> None:
        with self.assertRaises(HTTPException) as error:
            channels.require_owner(make_channel(), SUBSCRIBER_ID)
        self.assertEqual(error.exception.status_code, 403)

    async def test_create_private_channel_returns_invite(self) -> None:
        collection = Mock()
        collection.insert_one.return_value.inserted_id = CHANNEL_ID
        users = Mock()
        users.find_one.return_value = {"username": "owner", "displayName": "Owner"}

        with (
            patch("channels.channels_collection", return_value=collection),
            patch("channels.users_collection", return_value=users),
            patch("channels.notify_members", new_callable=AsyncMock),
        ):
            response = await channels.create_channel(
                channels.CreateChannelRequest(
                    title="  Private room  ",
                    description=" Updates ",
                    visibility="private",
                ),
                {"userId": OWNER_ID},
            )

        self.assertEqual(response["title"], "Private room")
        self.assertEqual(response["description"], "Updates")
        self.assertEqual(response["visibility"], "private")
        self.assertTrue(response["isOwner"])
        self.assertTrue(response["inviteCode"])

    async def test_subscribers_cannot_publish_posts(self) -> None:
        with patch("channels.channel_by_id", return_value=make_channel()):
            with self.assertRaises(HTTPException) as error:
                await channels.create_channel_post(
                    str(CHANNEL_ID),
                    channels.ChannelPostRequest(text="Subscriber post"),
                    {"userId": SUBSCRIBER_ID},
                )
        self.assertEqual(error.exception.status_code, 403)

    async def test_owner_post_is_saved_and_broadcast(self) -> None:
        channel = make_channel()
        posts = Mock()
        posts.insert_one.return_value.inserted_id = POST_ID
        channels_collection = Mock()

        with (
            patch("channels.channel_by_id", return_value=channel),
            patch("channels.channel_posts_collection", return_value=posts),
            patch("channels.channels_collection", return_value=channels_collection),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            response = await channels.create_channel_post(
                str(CHANNEL_ID),
                channels.ChannelPostRequest(text="  New post  "),
                {"userId": OWNER_ID},
            )

        self.assertEqual(response["id"], str(POST_ID))
        self.assertEqual(response["text"], "New post")
        self.assertEqual(response["reactions"], [])
        notify.assert_awaited_once()
        self.assertEqual(notify.await_args.args[1]["action"], "post_created")

    async def test_owner_can_edit_post_text_and_broadcast_update(self):
        post = {
            "_id": POST_ID,
            "channelId": str(CHANNEL_ID),
            "senderId": OWNER_ID,
            "text": "Old announcement",
            "fileData": None,
            "reactions": [],
            "pinned": False,
            "pinnedAt": None,
            "createdAt": datetime.now(timezone.utc),
        }
        posts = Mock()
        posts.update_one.return_value.matched_count = 1
        with (
            patch("channels.channel_by_id", return_value=make_channel()),
            patch("channels.find_channel_post", return_value=post),
            patch("channels.channel_posts_collection", return_value=posts),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            response = await channels.edit_channel_post(
                str(CHANNEL_ID),
                str(POST_ID),
                channels.ChannelPostEditRequest(text="  Corrected announcement  "),
                {"userId": OWNER_ID},
            )
        self.assertEqual(response["text"], "Corrected announcement")
        posts.update_one.assert_called_once_with(
            {"_id": POST_ID, "channelId": str(CHANNEL_ID)},
            {"$set": {"text": "Corrected announcement"}},
        )
        notify.assert_awaited_once()
        self.assertEqual(notify.await_args.args[1]["action"], "post_updated")

    async def test_subscriber_cannot_edit_channel_post(self):
        with patch("channels.channel_by_id", return_value=make_channel()):
            with self.assertRaises(HTTPException) as error:
                await channels.edit_channel_post(
                    str(CHANNEL_ID),
                    str(POST_ID),
                    channels.ChannelPostEditRequest(text="Unauthorized"),
                    {"userId": SUBSCRIBER_ID},
                )
        self.assertEqual(error.exception.status_code, 403)

    async def test_subscriber_can_toggle_a_reaction_atomically(self):
        post = {
            "_id": POST_ID,
            "channelId": str(CHANNEL_ID),
            "senderId": OWNER_ID,
            "text": "Announcement",
            "reactions": [],
            "pinned": False,
            "createdAt": datetime.now(timezone.utc),
        }
        added_post = {**post, "reactions": [{"userId": SUBSCRIBER_ID, "emoji": "❤️"}]}
        posts = Mock()
        posts.find_one.side_effect = [post, added_post, added_post, post]
        posts.update_one.return_value.matched_count = 1

        with (
            patch("channels.channel_by_id", return_value=make_channel()),
            patch("channels.channel_posts_collection", return_value=posts),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            added = await channels.toggle_channel_post_reaction(
                str(CHANNEL_ID),
                str(POST_ID),
                channels.ChannelReactionRequest(emoji="❤️"),
                {"userId": SUBSCRIBER_ID},
            )
            removed = await channels.toggle_channel_post_reaction(
                str(CHANNEL_ID),
                str(POST_ID),
                channels.ChannelReactionRequest(emoji="❤️"),
                {"userId": SUBSCRIBER_ID},
            )

        self.assertEqual(added["reactions"], [{"userId": SUBSCRIBER_ID, "emoji": "❤️"}])
        self.assertEqual(removed["reactions"], [])
        self.assertEqual(posts.update_one.call_count, 2)
        for call in posts.update_one.call_args_list:
            self.assertIsInstance(call.args[1], list)
            self.assertIn("$set", call.args[1][0])
        self.assertEqual(notify.await_count, 2)

    async def test_delete_channel_rejects_stale_owner(self) -> None:
        collection = Mock()
        collection.delete_one.return_value.deleted_count = 0
        posts = Mock()

        with (
            patch("channels.channel_by_id", return_value=make_channel()),
            patch("channels.channels_collection", return_value=collection),
            patch("channels.channel_posts_collection", return_value=posts),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            with self.assertRaises(HTTPException) as error:
                await channels.delete_channel(
                    str(CHANNEL_ID), {"userId": OWNER_ID}
                )

        self.assertEqual(error.exception.status_code, 409)
        collection.delete_one.assert_called_once_with(
            {"_id": CHANNEL_ID, "ownerId": OWNER_ID}
        )
        posts.delete_many.assert_not_called()
        notify.assert_not_awaited()

    async def test_update_channel_rejects_stale_owner(self) -> None:
        collection = Mock()
        collection.update_one.return_value.matched_count = 0

        with (
            patch("channels.channel_by_id", return_value=make_channel()),
            patch("channels.channels_collection", return_value=collection),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            with self.assertRaises(HTTPException) as error:
                await channels.update_channel(
                    str(CHANNEL_ID),
                    channels.UpdateChannelRequest(title="Updated title"),
                    {"userId": OWNER_ID},
                )

        self.assertEqual(error.exception.status_code, 409)
        collection.update_one.assert_called_once()
        notify.assert_not_awaited()

    async def test_public_subscribe_race_returns_persisted_membership(self):
        channel_before = make_channel("public")
        channel_before["members"] = [{
            "userId": OWNER_ID,
            "role": "owner",
            "joinedAt": channel_before["createdAt"],
        }]
        channel_after = make_channel("public")
        collection = Mock()
        collection.update_one.return_value.modified_count = 0
        collection.find_one.return_value = channel_after
        users = Mock()
        users.find_one.return_value = {"username": "owner", "displayName": "Owner"}

        with (
            patch("channels.channel_by_id", return_value=channel_before),
            patch("channels.channels_collection", return_value=collection),
            patch("channels.users_collection", return_value=users),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            response = await channels.subscribe_channel(
                str(CHANNEL_ID), {"userId": SUBSCRIBER_ID}
            )

        self.assertTrue(response["isSubscribed"])
        self.assertEqual(response["memberCount"], 2)
        notify.assert_not_awaited()
        collection.find_one.assert_called_once_with({"_id": CHANNEL_ID})

    async def test_invite_join_race_returns_persisted_membership(self):
        channel_before = make_channel("private")
        channel_before["members"] = [{"userId": OWNER_ID, "role": "owner", "joinedAt": channel_before["createdAt"]}]
        channel_after = make_channel("private")
        channel_after["members"] = channel_before["members"] + [{
            "userId": SUBSCRIBER_ID,
            "role": "subscriber",
            "joinedAt": datetime.now(timezone.utc),
        }]
        collection = Mock()
        collection.find_one.side_effect = [channel_before, channel_after]
        collection.update_one.return_value.modified_count = 0
        users = Mock()
        users.find_one.return_value = {"username": "owner", "displayName": "Owner"}

        with (
            patch("channels.channels_collection", return_value=collection),
            patch("channels.users_collection", return_value=users),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            response = await channels.join_channel_by_invite(
                "invite-code", {"userId": SUBSCRIBER_ID}
            )

        self.assertTrue(response["isSubscribed"])
        self.assertEqual(response["memberCount"], 2)
        notify.assert_not_awaited()
        self.assertEqual(collection.find_one.call_count, 2)

    async def test_unsubscribe_rejects_failed_update_while_membership_persists(self) -> None:
        channel = make_channel("public")
        collection = Mock()
        collection.update_one.return_value.modified_count = 0
        collection.find_one.return_value = channel

        with (
            patch("channels.channel_by_id", return_value=channel),
            patch("channels.channels_collection", return_value=collection),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            with self.assertRaises(HTTPException) as error:
                await channels.unsubscribe_channel(
                    str(CHANNEL_ID), {"userId": SUBSCRIBER_ID}
                )

        self.assertEqual(error.exception.status_code, 409)
        collection.update_one.assert_called_once()
        notify.assert_not_awaited()

    async def test_unsubscribe_race_does_not_broadcast_duplicate_leave(self) -> None:
        channel_before = make_channel("public")
        channel_after = make_channel("public")
        channel_after["members"] = [
            member for member in channel_after["members"]
            if member["userId"] != SUBSCRIBER_ID
        ]
        collection = Mock()
        collection.update_one.return_value.modified_count = 0
        collection.find_one.return_value = channel_after

        with (
            patch("channels.channel_by_id", return_value=channel_before),
            patch("channels.channels_collection", return_value=collection),
            patch("channels.notify_members", new_callable=AsyncMock) as notify,
        ):
            response = await channels.unsubscribe_channel(
                str(CHANNEL_ID), {"userId": SUBSCRIBER_ID}
            )

        self.assertEqual(response, {"status": "unsubscribed"})
        notify.assert_not_awaited()

    def test_avatar_rejects_active_content_data_urls(self) -> None:
        with self.assertRaises(ValueError):
            channels.UpdateChannelRequest(avatarUrl="data:image/svg+xml,<svg></svg>")


if __name__ == "__main__":
    unittest.main()
