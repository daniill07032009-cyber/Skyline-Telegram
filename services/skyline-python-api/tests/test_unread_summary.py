import unittest
from unittest.mock import Mock, patch

import main


class UnreadSummaryTests(unittest.TestCase):
    def test_unread_counts_exclude_deleted_and_expired_messages(self):
        user_id = "507f1f77bcf86cd799439011"
        group_id = main.ObjectId("507f1f77bcf86cd799439013")
        messages = Mock()
        messages.count_documents.return_value = 0
        groups = Mock()
        joined_at = main.datetime(2026, 1, 1, tzinfo=main.timezone.utc)
        groups.find.return_value = [{
            "_id": group_id,
            "members": [{"userId": user_id, "joinedAt": joined_at}],
        }]
        channels = Mock()
        channels.find.return_value = []
        users = Mock()
        users.find_one.return_value = {}

        with (
            patch("main.messages_collection", return_value=messages),
            patch("main.groups_collection", return_value=groups),
            patch("main.channels_collection", return_value=channels),
            patch("main.channel_posts_collection"),
            patch("main.users_collection", return_value=users),
        ):
            result = main.unread_summary({"userId": user_id})

        self.assertEqual(result, {"chats": 0, "groups": 0, "channels": 0})
        self.assertEqual(messages.count_documents.call_count, 2)
        personal_filter, group_filter = [
            call.args[0] for call in messages.count_documents.call_args_list
        ]
        for query in (personal_filter, group_filter):
            self.assertEqual(query["deletedForAll"], {"$ne": True})
            expiry_clauses = query["$or"]
            self.assertEqual(expiry_clauses[0], {"expiresAt": {"$exists": False}})
            self.assertIn("$gt", expiry_clauses[1]["expiresAt"])
        self.assertEqual(group_filter["groupId"], str(group_id))
        self.assertEqual(group_filter["createdAt"], {"$gte": joined_at})


if __name__ == "__main__":
    unittest.main()

class ContactsUnreadPipelineTests(unittest.TestCase):
    def test_contact_unread_aggregation_excludes_deleted_and_expired_messages(self):
        user_id = "507f1f77bcf86cd799439011"
        users = Mock()
        users.find_one.return_value = {"contacts": [], "hiddenChats": []}
        users.find.return_value = []
        messages = Mock()
        messages.aggregate.return_value = []

        with (
            patch("main.users_collection", return_value=users),
            patch("main.messages_collection", return_value=messages),
        ):
            result = main.get_contacts({"userId": user_id})

        self.assertEqual(result, [])
        match = messages.aggregate.call_args.args[0][0]["$match"]
        self.assertEqual(match["deletedForAll"], {"$ne": True})
        expiry = match["$and"][0]["$or"]
        self.assertEqual(expiry[0], {"expiresAt": {"$exists": False}})
        self.assertIn("$gt", expiry[1]["expiresAt"])

