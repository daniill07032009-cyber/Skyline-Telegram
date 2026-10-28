import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException, Request

import main
import group_management
import realtime
import auth


class SecurityEndpointTests(unittest.TestCase):
    def test_block_user_removes_embedded_and_legacy_contact_entries(self):
        user_id = "507f1f77bcf86cd799439011"
        target_id = "507f1f77bcf86cd799439012"
        payload = main.BlockUserRequest(targetUserId=target_id)
        with (
            patch("main.blocked_users_collection") as blocked,
            patch("main.users_collection") as users,
        ):
            result = main.block_user(payload, {"userId": user_id})
        self.assertEqual(result, {"status": "ok"})
        blocked.return_value.update_one.assert_called_once()
        self.assertEqual(users.return_value.update_one.call_count, 2)
        calls = users.return_value.update_one.call_args_list
        self.assertEqual(calls[0].args[1], {"$pull": {"contacts": {"userId": target_id}}})
        self.assertEqual(calls[1].args[1], {"$pull": {"contacts": target_id}})

    def test_expired_group_message_is_not_accessible_even_before_ttl_cleanup(self):
        message_id = "507f1f77bcf86cd799439014"
        message = {
            "_id": main.ObjectId(message_id),
            "senderId": "507f1f77bcf86cd799439011",
            "receiverId": "",
            "groupId": "507f1f77bcf86cd799439013",
            "createdAt": main.datetime.now(main.timezone.utc) - main.timedelta(hours=1),
            "expiresAt": main.datetime.now(main.timezone.utc) - main.timedelta(seconds=1),
        }
        with patch("main.messages_collection") as messages:
            messages.return_value.find_one.return_value = message
            with self.assertRaises(HTTPException) as raised:
                main.find_message_for_user(message_id, message["senderId"])
        self.assertEqual(raised.exception.status_code, 404)
        messages.return_value.find_one.assert_called_once_with({"_id": main.ObjectId(message_id)})

    def test_group_message_gets_expiry_when_disappearing_messages_enabled(self):
        user_id = "507f1f77bcf86cd799439011"
        group_id = "507f1f77bcf86cd799439013"
        group = {
            "_id": main.ObjectId(group_id),
            "title": "Test group",
            "members": [{"userId": user_id, "role": "owner"}],
            "disappearingMessages": {"enabled": True, "expireAfterMinutes": 30},
        }
        messages = Mock()
        messages.insert_one.return_value.inserted_id = main.ObjectId("507f1f77bcf86cd799439014")
        groups = Mock()

        with (
            patch("main.get_group_for_member", return_value=group),
            patch("main.validate_v4_envelope"),
            patch("main.enforce_message_rate_limit"),
            patch("main.messages_collection", return_value=messages),
            patch("main.groups_collection", return_value=groups),
            patch("main.sio.emit", new_callable=AsyncMock),
        ):
            result = asyncio.run(
                main.send_group_message(
                    group_id,
                    main.GroupMessageRequest(text="skyline-e2e:v4:test"),
                    {"userId": user_id, "username": "tester"},
                )
            )

        self.assertEqual(result["id"], "507f1f77bcf86cd799439014")
        stored_message = messages.insert_one.call_args.args[0]
        self.assertEqual(
            (stored_message["expiresAt"] - stored_message["createdAt"]).total_seconds(),
            30 * 60,
        )

    def test_group_message_without_expiry_setting_has_no_expiration(self):
        user_id = "507f1f77bcf86cd799439011"
        group_id = "507f1f77bcf86cd799439013"
        group = {
            "_id": main.ObjectId(group_id),
            "title": "Test group",
            "members": [{"userId": user_id, "role": "owner"}],
        }
        messages = Mock()
        messages.insert_one.return_value.inserted_id = main.ObjectId("507f1f77bcf86cd799439014")

        with (
            patch("main.get_group_for_member", return_value=group),
            patch("main.validate_v4_envelope"),
            patch("main.enforce_message_rate_limit"),
            patch("main.messages_collection", return_value=messages),
            patch("main.groups_collection"),
            patch("main.sio.emit", new_callable=AsyncMock),
        ):
            asyncio.run(
                main.send_group_message(
                    group_id,
                    main.GroupMessageRequest(text="skyline-e2e:v4:test"),
                    {"userId": user_id, "username": "tester"},
                )
            )

        self.assertNotIn("expiresAt", messages.insert_one.call_args.args[0])

    def test_cancel_scheduled_message_only_deletes_own_pending_message(self):
        scheduled_id = "507f1f77bcf86cd799439014"
        user_id = "507f1f77bcf86cd799439011"
        with patch("main.scheduled_messages_collection") as scheduled:
            scheduled.return_value.delete_one.return_value.deleted_count = 1
            result = main.cancel_scheduled_message(scheduled_id, {"userId": user_id})
        self.assertEqual(result, {"status": "ok"})
        scheduled.return_value.delete_one.assert_called_once_with({
            "_id": main.ObjectId(scheduled_id), "senderId": user_id, "status": "pending"
        })

    def test_cancel_scheduled_message_rejects_already_processing_or_missing(self):
        scheduled_id = "507f1f77bcf86cd799439014"
        with patch("main.scheduled_messages_collection") as scheduled:
            scheduled.return_value.delete_one.return_value.deleted_count = 0
            with self.assertRaises(HTTPException) as raised:
                main.cancel_scheduled_message(scheduled_id, {"userId": "507f1f77bcf86cd799439011"})
        self.assertEqual(raised.exception.status_code, 404)

    def test_poll_vote_updates_one_user_record_without_counter_deltas(self):
        poll_id = "507f1f77bcf86cd799439014"
        user_id = "507f1f77bcf86cd799439011"
        poll = {"_id": main.ObjectId(poll_id), "options": [{"text": "A", "votes": 9}, {"text": "B", "votes": 3}], "isActive": True}
        with (
            patch("main.polls_collection") as polls,
            patch("main.require_poll_access"),
            patch("main.votes_collection") as votes,
        ):
            polls.return_value.find_one.return_value = poll
            result = main.vote_poll(poll_id, main.PollVoteRequest(pollId=poll_id, optionIndex=1), {"userId": user_id})
        self.assertEqual(result, {"status": "ok"})
        votes.return_value.update_one.assert_called_once()
        args, kwargs = votes.return_value.update_one.call_args
        self.assertEqual(args[0], {"pollId": poll_id, "userId": user_id})
        self.assertEqual(args[1]["$set"]["optionIndex"], 1)
        self.assertTrue(kwargs["upsert"])
        polls.return_value.update_one.assert_not_called()

    def test_poll_results_recompute_counts_from_vote_records(self):
        poll_id = "507f1f77bcf86cd799439014"
        poll = {"_id": main.ObjectId(poll_id), "question": "Q", "options": [{"text": "A", "votes": 88}, {"text": "B", "votes": 2}], "createdAt": main.datetime.now(main.timezone.utc)}
        with (
            patch("main.polls_collection") as polls,
            patch("main.require_poll_access"),
            patch("main.votes_collection") as votes,
        ):
            polls.return_value.find_one.return_value = poll
            votes.return_value.find_one.return_value = {"optionIndex": 1}
            votes.return_value.aggregate.return_value = [{"_id": 0, "count": 4}, {"_id": 1, "count": 6}]
            result = main.get_poll(poll_id, {"userId": "507f1f77bcf86cd799439011"})
        self.assertEqual([o["votes"] for o in result["options"]], [4, 6])
        self.assertEqual(result["userVote"], 1)

    def test_scheduled_message_worker_delivers_due_personal_message(self):
        scheduled_id = "507f1f77bcf86cd799439014"
        sender_id = "507f1f77bcf86cd799439011"
        receiver_id = "507f1f77bcf86cd799439012"
        item = {
            "_id": main.ObjectId(scheduled_id), "senderId": sender_id,
            "receiverId": receiver_id, "text": "skyline-e2e:v3:payload",
            "type": "text", "sendAt": main.datetime.now(main.timezone.utc),
        }
        messages = Mock()
        messages.find_one.return_value = None
        messages.insert_one.return_value.inserted_id = main.ObjectId("507f1f77bcf86cd799439015")
        with (
            patch("main.scheduled_messages_collection") as scheduled,
            patch("main.messages_collection", return_value=messages),
            patch("main.users_collection") as users,
            patch("main.users_blocked_either_way", return_value=False),
            patch("main.direct_chat_expiration_minutes", return_value=0),
            patch("main.sio.emit", new_callable=AsyncMock) as emit,
        ):
            users.return_value.find_one.return_value = {"_id": main.ObjectId(receiver_id)}
            asyncio.run(main.deliver_scheduled_message(item))

        stored = messages.insert_one.call_args.args[0]
        self.assertEqual(stored["scheduledMessageId"], scheduled_id)
        self.assertEqual(stored["senderId"], sender_id)
        self.assertEqual(stored["receiverId"], receiver_id)
        self.assertEqual(scheduled.return_value.update_one.call_args.args[1]["$set"]["status"], "sent")
        self.assertEqual(emit.await_count, 2)

    def test_scheduled_message_worker_recovers_existing_delivery_without_duplicate(self):
        scheduled_id = "507f1f77bcf86cd799439014"
        sender_id = "507f1f77bcf86cd799439011"
        receiver_id = "507f1f77bcf86cd799439012"
        item = {"_id": main.ObjectId(scheduled_id), "senderId": sender_id, "receiverId": receiver_id}
        existing = {"_id": main.ObjectId("507f1f77bcf86cd799439015"), "createdAt": main.datetime.now(main.timezone.utc)}
        messages = Mock()
        messages.find_one.return_value = existing
        with (
            patch("main.scheduled_messages_collection") as scheduled,
            patch("main.messages_collection", return_value=messages),
            patch("main.sio.emit", new_callable=AsyncMock) as emit,
        ):
            asyncio.run(main.deliver_scheduled_message(item))
        messages.insert_one.assert_not_called()
        self.assertEqual(scheduled.return_value.update_one.call_args.args[1]["$set"]["status"], "sent")
        self.assertEqual(emit.await_count, 2)
        self.assertEqual(emit.await_args_list[0].args[1]["messageId"], str(existing["_id"]))

    def test_scheduled_group_message_recovery_notifies_current_members(self):
        scheduled_id = "507f1f77bcf86cd799439014"
        group_id = "507f1f77bcf86cd799439013"
        sender_id = "507f1f77bcf86cd799439011"
        item = {
            "_id": main.ObjectId(scheduled_id), "senderId": sender_id,
            "groupId": group_id,
        }
        existing = {
            "_id": main.ObjectId("507f1f77bcf86cd799439015"),
            "createdAt": main.datetime.now(main.timezone.utc),
        }
        messages = Mock()
        messages.find_one.return_value = existing
        members = [sender_id, "507f1f77bcf86cd799439012"]
        with (
            patch("main.scheduled_messages_collection") as scheduled,
            patch("main.messages_collection", return_value=messages),
            patch("main.groups_collection") as groups,
            patch("main.group_message_recipients", return_value=members),
            patch("main.sio.emit", new_callable=AsyncMock) as emit,
        ):
            asyncio.run(main.deliver_scheduled_message(item))
        messages.insert_one.assert_not_called()
        groups.return_value.update_one.assert_called_once()
        group_update_filter, group_update = groups.return_value.update_one.call_args.args[:2]
        self.assertEqual(group_update_filter, {"_id": main.ObjectId(group_id)})
        self.assertEqual(group_update, {"$max": {"updatedAt": existing["createdAt"]}})
        self.assertNotIn("$set", group_update)
        self.assertEqual(emit.await_count, 2)
        self.assertEqual(emit.await_args_list[0].args[1]["groupId"], group_id)

    def test_scheduled_group_delivery_never_rewinds_group_activity(self):
        scheduled_id = "507f1f77bcf86cd799439014"
        group_id = "507f1f77bcf86cd799439013"
        sender_id = "507f1f77bcf86cd799439011"
        member_id = "507f1f77bcf86cd799439012"
        item = {
            "_id": main.ObjectId(scheduled_id), "senderId": sender_id,
            "groupId": group_id, "text": "skyline-e2e:v3:payload", "type": "text",
        }
        group = {
            "_id": main.ObjectId(group_id),
            "members": [{"userId": sender_id}, {"userId": member_id}],
        }
        messages = Mock()
        messages.find_one.return_value = None
        messages.insert_one.return_value.inserted_id = main.ObjectId("507f1f77bcf86cd799439015")
        with (
            patch("main.scheduled_messages_collection") as scheduled,
            patch("main.messages_collection", return_value=messages),
            patch("main.get_group_for_member", return_value=group),
            patch("main.validate_v4_envelope"),
            patch("main.groups_collection") as groups,
            patch("main.sio.emit", new_callable=AsyncMock) as emit,
        ):
            asyncio.run(main.deliver_scheduled_message(item))

        group_update_filter, group_update = groups.return_value.update_one.call_args.args[:2]
        self.assertEqual(group_update_filter, {"_id": group["_id"]})
        self.assertEqual(group_update, {"$max": {"updatedAt": messages.insert_one.call_args.args[0]["createdAt"]}})
        self.assertNotIn("$set", group_update)
        self.assertEqual(emit.await_count, 2)
        self.assertEqual(scheduled.return_value.update_one.call_args.args[1]["$set"]["status"], "sent")

    def test_scheduled_delivery_stays_retryable_when_realtime_emit_fails(self):
        scheduled_id = "507f1f77bcf86cd799439014"
        sender_id = "507f1f77bcf86cd799439011"
        receiver_id = "507f1f77bcf86cd799439012"
        item = {
            "_id": main.ObjectId(scheduled_id), "senderId": sender_id,
            "receiverId": receiver_id, "text": "skyline-e2e:v3:payload",
            "type": "text",
        }
        messages = Mock()
        messages.find_one.return_value = None
        messages.insert_one.return_value.inserted_id = main.ObjectId("507f1f77bcf86cd799439015")
        with (
            patch("main.scheduled_messages_collection") as scheduled,
            patch("main.messages_collection", return_value=messages),
            patch("main.users_collection") as users,
            patch("main.users_blocked_either_way", return_value=False),
            patch("main.direct_chat_expiration_minutes", return_value=0),
            patch("main.sio.emit", new_callable=AsyncMock, side_effect=RuntimeError("socket unavailable")),
        ):
            users.return_value.find_one.return_value = {"_id": main.ObjectId(receiver_id)}
            with self.assertRaises(RuntimeError):
                asyncio.run(main.deliver_scheduled_message(item))
        self.assertEqual(messages.insert_one.call_count, 1)
        scheduled.return_value.update_one.assert_not_called()

    def test_scheduled_worker_requeues_message_after_post_insert_failure(self):
        scheduled_id = "507f1f77bcf86cd799439014"
        item = {"_id": main.ObjectId(scheduled_id), "senderId": "507f1f77bcf86cd799439011"}
        scheduled_collection = Mock()
        scheduled_collection.find_one_and_update.side_effect = [item, asyncio.CancelledError()]
        messages = Mock()
        messages.find_one.return_value = {"_id": main.ObjectId("507f1f77bcf86cd799439015")}
        with (
            patch("main.scheduled_messages_collection", return_value=scheduled_collection),
            patch("main.messages_collection", return_value=messages),
            patch("main.deliver_scheduled_message", new_callable=AsyncMock, side_effect=RuntimeError("socket unavailable")),
        ):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(main.scheduled_message_worker())
        self.assertEqual(
            scheduled_collection.update_one.call_args.args[1]["$set"]["status"],
            "pending",
        )
        self.assertIn("socket unavailable", scheduled_collection.update_one.call_args.args[1]["$set"]["lastError"])

    def test_scheduled_message_requires_exactly_one_destination(self):
        payload = main.ScheduledMessageRequest(
            receiverId="507f1f77bcf86cd799439012",
            groupId="507f1f77bcf86cd799439013",
            text="skyline-e2e:v3:test",
            sendAt="2099-01-01T12:00:00+00:00",
        )
        with patch("main.scheduled_messages_collection") as scheduled:
            with self.assertRaises(HTTPException) as raised:
                main.create_scheduled_message(payload, {"userId": "507f1f77bcf86cd799439011"})
        self.assertEqual(raised.exception.status_code, 400)
        scheduled.return_value.insert_one.assert_not_called()

    def test_scheduled_message_respects_user_blocks(self):
        user_id = "507f1f77bcf86cd799439011"
        target_id = "507f1f77bcf86cd799439012"
        payload = main.ScheduledMessageRequest(
            receiverId=target_id,
            text="skyline-e2e:v3:test",
            sendAt="2099-01-01T12:00:00+00:00",
        )
        with (
            patch("main.users_collection") as users,
            patch("main.users_blocked_either_way", return_value=True),
            patch("main.scheduled_messages_collection") as scheduled,
        ):
            users.return_value.find_one.return_value = {"_id": main.ObjectId(target_id)}
            with self.assertRaises(HTTPException) as raised:
                main.create_scheduled_message(payload, {"userId": user_id})
        self.assertEqual(raised.exception.status_code, 403)
        scheduled.return_value.insert_one.assert_not_called()

    def test_scheduled_message_rejects_timezone_naive_datetime(self):
        payload = main.ScheduledMessageRequest(
            receiverId="507f1f77bcf86cd799439012",
            text="skyline-e2e:v3:test",
            sendAt="2099-01-01T12:00:00",
        )
        with (
            patch("main.users_collection") as users,
            patch("main.users_blocked_either_way", return_value=False),
        ):
            users.return_value.find_one.return_value = {"_id": main.ObjectId("507f1f77bcf86cd799439012")}
            with self.assertRaises(HTTPException) as raised:
                main.create_scheduled_message(payload, {"userId": "507f1f77bcf86cd799439011"})
        self.assertEqual(raised.exception.status_code, 422)

    def test_gift_rejects_invalid_recipient_id(self):
        payload = main.GiftSendRequest(
            giftId="507f1f77bcf86cd799439013",
            targetUserId="not-an-object-id",
        )
        with patch("main.gifts_collection") as gifts:
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.send_gift(payload, {"userId": "507f1f77bcf86cd799439011"}))
        self.assertEqual(raised.exception.status_code, 400)
        gifts.return_value.find_one.assert_not_called()

    def test_gift_respects_block_relationships(self):
        user_id = "507f1f77bcf86cd799439011"
        target_id = "507f1f77bcf86cd799439012"
        payload = main.GiftSendRequest(
            giftId="507f1f77bcf86cd799439013",
            targetUserId=target_id,
        )
        with (
            patch("main.users_collection") as users,
            patch("main.users_blocked_either_way", return_value=True),
            patch("main.gifts_collection") as gifts,
        ):
            users.return_value.find_one.return_value = {"_id": main.ObjectId(target_id)}
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.send_gift(payload, {"userId": user_id}))
        self.assertEqual(raised.exception.status_code, 403)
        gifts.return_value.find_one.assert_not_called()

    def test_event_rejects_invalid_participant_ids(self):
        payload = main.EventCreateRequest(
            title="Meeting",
            eventDate="2099-01-01T12:00:00Z",
            participants=["not-an-object-id"],
        )
        with patch("main.events_collection") as events:
            with self.assertRaises(HTTPException) as raised:
                main.create_event(payload, {"userId": "507f1f77bcf86cd799439011"})
        self.assertEqual(raised.exception.status_code, 400)
        events.return_value.insert_one.assert_not_called()

    def test_event_normalizes_datetime_and_deduplicates_participants(self):
        user_id = "507f1f77bcf86cd799439011"
        participant_id = "507f1f77bcf86cd799439012"
        payload = main.EventCreateRequest(
            title="Meeting",
            eventDate="2099-01-01T12:00:00",
            participants=[participant_id, participant_id, user_id],
        )
        with (
            patch("main.users_collection") as users,
            patch("main.events_collection") as events,
        ):
            users.return_value.count_documents.return_value = 1
            users.return_value.find_one.return_value = {"contacts": [{"userId": participant_id}]}
            events.return_value.insert_one.return_value.inserted_id = main.ObjectId("507f1f77bcf86cd799439013")
            result = main.create_event(payload, {"userId": user_id})
        self.assertEqual(result["status"], "ok")
        saved = events.return_value.insert_one.call_args.args[0]
        self.assertEqual(saved["participants"], [user_id, participant_id])
        self.assertEqual(saved["eventDate"].utcoffset(), main.timedelta(0))

    def test_event_rejects_non_contact_participant(self):
        user_id = "507f1f77bcf86cd799439011"
        participant_id = "507f1f77bcf86cd799439012"
        payload = main.EventCreateRequest(
            title="Meeting",
            eventDate="2099-01-01T12:00:00Z",
            participants=[participant_id],
        )
        with (
            patch("main.users_collection") as users,
            patch("main.events_collection") as events,
        ):
            users.return_value.count_documents.return_value = 1
            users.return_value.find_one.return_value = {"contacts": []}
            with self.assertRaises(HTTPException) as raised:
                main.create_event(payload, {"userId": user_id})
        self.assertEqual(raised.exception.status_code, 403)
        events.return_value.insert_one.assert_not_called()

    def test_friend_request_cannot_be_accepted_when_either_user_blocked(self):
        request_id = "507f1f77bcf86cd799439013"
        user_id = "507f1f77bcf86cd799439011"
        sender_id = "507f1f77bcf86cd799439012"
        request = {"_id": main.ObjectId(request_id), "fromUserId": sender_id, "toUserId": user_id, "status": "pending"}
        payload = main.FriendRequestActionRequest(requestId=request_id, accept=True)
        with (
            patch("main.friend_requests_collection") as requests,
            patch("main.users_blocked_either_way", return_value=True),
            patch("main.users_collection") as users,
        ):
            requests.return_value.find_one.return_value = request
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.respond_to_friend_request(request_id, payload, {"userId": user_id}))
        self.assertEqual(raised.exception.status_code, 403)
        requests.return_value.update_one.assert_not_called()
        users.return_value.update_one.assert_not_called()

    def test_friend_request_already_processed_cannot_be_replayed(self):
        request_id = "507f1f77bcf86cd799439013"
        user_id = "507f1f77bcf86cd799439011"
        sender_id = "507f1f77bcf86cd799439012"
        request = {"_id": main.ObjectId(request_id), "fromUserId": sender_id, "toUserId": user_id, "status": "accepted"}
        payload = main.FriendRequestActionRequest(requestId=request_id, accept=True)
        with (
            patch("main.friend_requests_collection") as requests,
            patch("main.users_blocked_either_way", return_value=False),
            patch("main.users_collection") as users,
        ):
            requests.return_value.find_one.return_value = request
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.respond_to_friend_request(request_id, payload, {"userId": user_id}))
        self.assertEqual(raised.exception.status_code, 409)
        requests.return_value.update_one.assert_not_called()
        users.return_value.update_one.assert_not_called()

    def test_story_view_rejects_expired_or_missing_story(self):
        with patch("main.stories_collection") as stories:
            stories.return_value.update_one.return_value.matched_count = 0
            with self.assertRaises(HTTPException) as raised:
                main.view_story("507f1f77bcf86cd799439011", {"userId": "507f1f77bcf86cd799439012"})
        self.assertEqual(raised.exception.status_code, 404)

    def test_report_rejects_missing_target(self):
        payload = main.ReportRequest(
            targetType="user",
            targetId="507f1f77bcf86cd799439013",
            reason="Test report",
        )
        with (
            patch("main.users_collection") as users,
            patch("main.reports_collection") as reports,
        ):
            users.return_value.find_one.return_value = None
            with self.assertRaises(HTTPException) as raised:
                main.create_report(payload, {"userId": "507f1f77bcf86cd799439011"})
        self.assertEqual(raised.exception.status_code, 404)
        reports.return_value.insert_one.assert_not_called()

    def test_api_auth_rejects_token_with_malformed_user_id(self):
        with (
            patch("auth.decode_token", return_value={"userId": "not-an-object-id"}),
            patch("auth.users_collection") as users,
        ):
            with self.assertRaises(HTTPException) as raised:
                auth.get_current_user("Bearer valid-looking-token")

        self.assertEqual(raised.exception.status_code, 401)
        users.return_value.find_one.assert_not_called()

    def test_api_auth_rejects_deleted_user(self):
        with (
            patch("auth.decode_token", return_value={"userId": "507f1f77bcf86cd799439011"}),
            patch("auth.users_collection") as users,
        ):
            users.return_value.find_one.return_value = None
            with self.assertRaises(HTTPException) as raised:
                auth.get_current_user("Bearer valid-looking-token")

        self.assertEqual(raised.exception.status_code, 401)

    def test_socket_rejects_token_with_malformed_user_id(self):
        with (
            patch("realtime.decode_token", return_value={"userId": "not-an-object-id"}),
            patch("realtime.users_collection") as users,
        ):
            accepted = asyncio.run(
                realtime.connect("test-invalid-sid", {}, {"token": "valid-looking-token"})
            )

        self.assertFalse(accepted)
        users.return_value.find_one.assert_not_called()
        self.assertNotIn("test-invalid-sid", realtime.sid_users)

    def test_socket_rejects_token_for_deleted_user(self):
        with (
            patch("realtime.decode_token", return_value={"userId": "507f1f77bcf86cd799439011"}),
            patch("realtime.users_collection") as users,
        ):
            users.return_value.find_one.return_value = None
            accepted = asyncio.run(
                realtime.connect("test-deleted-sid", {}, {"token": "valid-looking-token"})
            )

        self.assertFalse(accepted)
        self.assertNotIn("test-deleted-sid", realtime.sid_users)

    def test_removed_group_member_cannot_access_own_old_group_message(self):
        user_id = "507f1f77bcf86cd799439011"
        group_id = "507f1f77bcf86cd799439012"
        message = {
            "_id": main.ObjectId("507f1f77bcf86cd799439013"),
            "senderId": user_id,
            "receiverId": "",
            "groupId": group_id,
            "createdAt": main.datetime.now(main.timezone.utc),
        }
        with (
            patch("main.messages_collection") as messages,
            patch("main.groups_collection") as groups,
        ):
            messages.return_value.find_one.return_value = message
            groups.return_value.find_one.return_value = None
            with self.assertRaises(HTTPException) as raised:
                main.find_message_for_user(str(message["_id"]), user_id)

        self.assertEqual(raised.exception.status_code, 404)

    def test_removed_group_member_cannot_delete_group_message_for_all(self):
        user_id = "507f1f77bcf86cd799439011"
        group_id = "507f1f77bcf86cd799439012"
        message = {
            "_id": main.ObjectId("507f1f77bcf86cd799439013"),
            "senderId": user_id,
            "receiverId": "",
            "groupId": group_id,
            "createdAt": main.datetime.now(main.timezone.utc),
        }
        with (
            patch("main.messages_collection") as messages,
            patch("main.groups_collection") as groups,
        ):
            messages.return_value.find_one.return_value = message
            groups.return_value.find_one.return_value = None
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.delete_message_for_all(str(message["_id"]), {"userId": user_id}))

        self.assertEqual(raised.exception.status_code, 404)
        messages.return_value.update_one.assert_not_called()

    def test_current_group_member_can_access_group_message(self):
        user_id = "507f1f77bcf86cd799439011"
        group_id = "507f1f77bcf86cd799439012"
        message = {
            "_id": main.ObjectId("507f1f77bcf86cd799439013"),
            "senderId": user_id,
            "receiverId": "",
            "groupId": group_id,
            "createdAt": main.datetime.now(main.timezone.utc),
        }
        joined_at = message["createdAt"] - main.timedelta(seconds=1)
        with (
            patch("main.messages_collection") as messages,
            patch("main.groups_collection") as groups,
        ):
            messages.return_value.find_one.return_value = message
            groups.return_value.find_one.return_value = {
                "members": [{"userId": user_id, "joinedAt": joined_at}]
            }
            found = main.find_message_for_user(str(message["_id"]), user_id)

        self.assertEqual(found, message)

    def test_unimplemented_security_controls_fail_instead_of_claiming_success(self):
        current = {"userId": "507f1f77bcf86cd799439011"}
        cases = [
            (main.toggle_two_factor, (main.TwoFactorRequest(enable=True, code="123456"), current)),
            (main.list_user_sessions, (current,)),
            (main.set_app_pin_code, (main.PinCodeRequest(pin="1234", enable=True), current)),
            (main.request_auto_delete_account, (main.AutoDeleteAccountRequest(months=12), current)),
        ]
        for handler, args in cases:
            with self.subTest(handler=handler.__name__), self.assertRaises(HTTPException) as raised:
                handler(*args)
            self.assertEqual(raised.exception.status_code, 501)

    def test_blocked_user_cannot_send_direct_message(self):
        user_id = "507f1f77bcf86cd799439011"
        target_id = "507f1f77bcf86cd799439012"
        with patch("main.users_blocked_either_way", return_value=True):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    main.send_message(
                        main.MessageRequest(receiverId=target_id, text="skyline-e2e:v3:test"),
                        {"userId": user_id},
                    )
                )
        self.assertEqual(raised.exception.status_code, 403)

    def test_blocked_user_cannot_send_friend_request(self):
        user_id = "507f1f77bcf86cd799439011"
        target_id = "507f1f77bcf86cd799439012"
        with patch("main.users_blocked_either_way", return_value=True):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    main.send_friend_request(
                        main.FriendRequestRequest(targetUserId=target_id),
                        {"userId": user_id},
                    )
                )
        self.assertEqual(raised.exception.status_code, 403)

    def test_blocked_user_cannot_forward_to_direct_chat(self):
        user_id = "507f1f77bcf86cd799439011"
        target_id = "507f1f77bcf86cd799439012"
        original = {
            "_id": main.ObjectId("507f1f77bcf86cd799439013"),
            "senderId": user_id,
            "receiverId": "507f1f77bcf86cd799439014",
            "createdAt": main.datetime.now(main.timezone.utc),
        }
        with (
            patch("main.find_message_for_user", return_value=original),
            patch("main.users_blocked_either_way", return_value=True),
        ):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    main.forward_message(
                        str(original["_id"]),
                        main.MessageForwardRequest(targetUserId=target_id, text="skyline-e2e:v3:test"),
                        {"userId": user_id},
                    )
                )
        self.assertEqual(raised.exception.status_code, 403)

    def test_blocked_user_cannot_reply_in_direct_chat(self):
        user_id = "507f1f77bcf86cd799439011"
        target_id = "507f1f77bcf86cd799439012"
        original = {
            "_id": main.ObjectId("507f1f77bcf86cd799439013"),
            "senderId": target_id,
            "receiverId": user_id,
            "createdAt": main.datetime.now(main.timezone.utc),
        }
        with (
            patch("main.find_message_for_user", return_value=original),
            patch("main.users_blocked_either_way", return_value=True),
        ):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    main.reply_to_message(
                        str(original["_id"]),
                        main.MessageReplyRequest(text="skyline-e2e:v3:test"),
                        {"userId": user_id},
                    )
                )
        self.assertEqual(raised.exception.status_code, 403)

    def test_non_admin_cannot_add_group_members(self):
        user_id = "507f1f77bcf86cd799439011"
        owner_id = "507f1f77bcf86cd799439012"
        group_id = "507f1f77bcf86cd799439013"
        target_id = "507f1f77bcf86cd799439014"
        group = {
            "_id": main.ObjectId(group_id),
            "createdBy": owner_id,
            "members": [{"userId": user_id, "role": "member"}],
        }

        with (
            patch("main.get_group_for_member", return_value=group),
            patch("main.groups_collection") as groups,
        ):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    main.add_group_members(
                        group_id,
                        main.AddGroupMembersRequest(memberIds=[target_id]),
                        {"userId": user_id},
                    )
                )

        self.assertEqual(raised.exception.status_code, 403)
        groups.assert_not_called()

    def test_admin_member_add_checks_capacity_and_permissions_atomically(self):
        owner_id = "507f1f77bcf86cd799439011"
        admin_id = "507f1f77bcf86cd799439012"
        group_id = "507f1f77bcf86cd799439013"
        target_ids = [
            "507f1f77bcf86cd799439014",
            "507f1f77bcf86cd799439015",
        ]
        members = [
            {"userId": owner_id, "role": "owner"},
            {"userId": admin_id, "role": "admin"},
        ]
        members.extend(
            {"userId": f"member-{index}", "role": "member"}
            for index in range(96)
        )
        group = {
            "_id": main.ObjectId(group_id),
            "createdBy": owner_id,
            "members": members,
        }
        collection = Mock()
        collection.update_one.return_value.matched_count = 1
        collection.find_one.return_value = {
            **group,
            "members": members + [
                {"userId": target_id, "role": "member"}
                for target_id in target_ids
            ],
        }
        users = Mock()
        users.find.return_value = [{"_id": main.ObjectId(value)} for value in target_ids]

        with (
            patch("main.get_group_for_member", return_value=group),
            patch("main.groups_collection", return_value=collection),
            patch("main.users_collection", return_value=users),
            patch("main.sio.emit", new_callable=AsyncMock),
        ):
            result = asyncio.run(
                main.add_group_members(
                    group_id,
                    main.AddGroupMembersRequest(memberIds=target_ids),
                    {"userId": admin_id},
                )
            )

        self.assertEqual(result["added"], target_ids)
        query, update = collection.update_one.call_args.args[:2]
        self.assertEqual(query["members.userId"], {"$nin": target_ids})
        self.assertEqual(
            query["$expr"],
            {
                "$lte": [
                    {
                        "$add": [
                            {"$size": {"$ifNull": ["$members", []]}},
                            2,
                        ]
                    },
                    100,
                ]
            },
        )
        self.assertIn("$or", query)
        self.assertIn("$push", update)

    def test_group_settings_reject_if_admin_permission_changes_during_update(self):
        user_id = "507f1f77bcf86cd799439011"
        group_id = "507f1f77bcf86cd799439013"
        group = {
            "_id": main.ObjectId(group_id),
            "createdBy": "507f1f77bcf86cd799439012",
            "members": [
                {"userId": user_id, "role": "admin"},
                {"userId": "507f1f77bcf86cd799439014", "role": "owner"},
            ],
        }
        with (
            patch("group_management._group_for_member", return_value=group),
            patch("group_management.groups_collection") as groups,
        ):
            groups.return_value.update_one.return_value.matched_count = 0
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    group_management.update_group_settings(
                        group_id,
                        group_management.GroupSettingsRequest(title="Updated group"),
                        {"userId": user_id},
                    )
                )

        self.assertEqual(raised.exception.status_code, 409)

    def test_ownership_transfer_reports_stale_owner_instead_of_success(self):
        user_id = "507f1f77bcf86cd799439011"
        target_id = "507f1f77bcf86cd799439012"
        group_id = "507f1f77bcf86cd799439013"
        legacy_group = {
            "_id": main.ObjectId(group_id),
            "members": [
                {"userId": user_id, "role": "owner"},
                {"userId": target_id, "role": "member"},
            ],
        }

        with (
            patch("group_management._group_for_member", return_value=legacy_group),
            patch("group_management.groups_collection") as groups,
        ):
            groups.return_value.update_one.return_value.matched_count = 0
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    group_management.transfer_group_ownership(
                        group_id,
                        group_management.TransferOwnershipRequest(userId=target_id),
                        {"userId": user_id},
                    )
                )

        self.assertEqual(raised.exception.status_code, 409)

    def test_group_avatar_validation_accepts_supported_data_uri(self):
        settings = group_management.GroupSettingsRequest(
            avatarUrl="data:image/png;base64,AAAA"
        )
        self.assertEqual(settings.avatarUrl, "data:image/png;base64,AAAA")

    def test_group_avatar_validation_rejects_unsupported_data_uri(self):
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            group_management.GroupSettingsRequest(avatarUrl="javascript:alert(1)")

    def test_login_records_bounded_device_metadata_in_history(self):
        user = {
            "_id": main.ObjectId("507f1f77bcf86cd799439011"),
            "email": "person@example.com",
            "username": "person",
            "passwordHash": "hashed",
        }
        users = Mock()
        users.find_one.return_value = user
        history = Mock()
        request = Request({
            "type": "http",
            "method": "POST",
            "path": "/auth/login",
            "headers": [(b"user-agent", b"test-client")],
            "client": ("192.0.2.10", 1234),
            "server": ("testserver", 80),
            "scheme": "http",
            "query_string": b"",
        })
        with (
            patch("main.users_collection", return_value=users),
            patch("main.login_history_collection", return_value=history),
            patch("main.verify_password", return_value=True),
            patch("main.create_token", return_value="token"),
            patch("main.serialize_premium", return_value={}),
        ):
            result = main.login(main.LoginRequest(email="person@example.com", password="secret"), request)

        self.assertEqual(result["token"], "token")
        record = history.insert_one.call_args.args[0]
        self.assertEqual(record["userId"], str(user["_id"]))
        self.assertEqual(record["ipAddress"], "192.0.2.10")
        self.assertEqual(record["userAgent"], "test-client")
        self.assertIn("loginAt", record)


    def test_readiness_reports_database_connected(self):
        database = Mock()
        with patch("main.get_db", return_value=database):
            result = main.readiness()
        self.assertEqual(result, {"status": "ready", "database": "connected"})
        database.command.assert_called_once_with("ping")

    def test_readiness_returns_service_unavailable_when_database_ping_fails(self):
        database = Mock()
        database.command.side_effect = main.PyMongoError("database unavailable")
        with patch("main.get_db", return_value=database):
            with self.assertRaises(HTTPException) as raised:
                main.readiness()
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, "Database unavailable")


class DeleteForAllRealtimeEventTests(unittest.TestCase):
    def test_personal_delete_for_all_event_includes_both_chat_participants(self):
        sender_id = "507f1f77bcf86cd799439011"
        receiver_id = "507f1f77bcf86cd799439012"
        message_id = "507f1f77bcf86cd799439013"
        message = {
            "_id": main.ObjectId(message_id),
            "senderId": sender_id,
            "receiverId": receiver_id,
            "createdAt": main.datetime.now(main.timezone.utc),
        }
        with (
            patch("main.find_message_for_user", return_value=message),
            patch("main.messages_collection") as messages,
            patch("main.sio.emit", new_callable=AsyncMock) as emit,
        ):
            messages.return_value.update_one.return_value.matched_count = 1
            result = asyncio.run(main.delete_message_for_all(message_id, {"userId": sender_id}))

        self.assertEqual(result, {"status": "ok"})
        self.assertEqual(emit.await_count, 2)
        event = emit.await_args_list[0].args[1]
        self.assertEqual(event["senderId"], sender_id)
        self.assertEqual(event["receiverId"], receiver_id)
        self.assertEqual(event["action"], "deleted_for_all")

    def test_group_delete_for_all_event_is_sent_to_group_members(self):
        sender_id = "507f1f77bcf86cd799439011"
        member_id = "507f1f77bcf86cd799439012"
        group_id = "507f1f77bcf86cd799439014"
        message_id = "507f1f77bcf86cd799439013"
        message = {
            "_id": main.ObjectId(message_id),
            "senderId": sender_id,
            "groupId": group_id,
            "createdAt": main.datetime.now(main.timezone.utc),
        }
        with (
            patch("main.find_message_for_user", return_value=message),
            patch("main.messages_collection") as messages,
            patch("main.group_message_recipients", return_value=[sender_id, member_id]),
            patch("main.sio.emit", new_callable=AsyncMock) as emit,
        ):
            messages.return_value.update_one.return_value.matched_count = 1
            result = asyncio.run(main.delete_message_for_all(message_id, {"userId": sender_id}))

        self.assertEqual(result, {"status": "ok"})
        self.assertEqual(emit.await_count, 2)
        event = emit.await_args_list[0].args[1]
        self.assertEqual(event["groupId"], group_id)
        self.assertEqual(event["senderId"], sender_id)
        self.assertEqual(event["action"], "deleted_for_all")
        self.assertEqual(
            {call.kwargs["to"] for call in emit.await_args_list},
            {f"user:{sender_id}", f"user:{member_id}"},
        )


    def test_login_rate_limit_blocks_repeated_attempts_per_ip(self):
        main.login_attempt_timestamps.clear()
        request = Request({
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/auth/login",
            "raw_path": b"/auth/login",
            "query_string": b"",
            "headers": [],
            "client": ("203.0.113.10", 12345),
            "server": ("testserver", 80),
        })
        try:
            for _ in range(main.LOGIN_RATE_LIMIT):
                main.enforce_login_rate_limit(request)
            with self.assertRaises(HTTPException) as raised:
                main.enforce_login_rate_limit(request)
            self.assertEqual(raised.exception.status_code, 429)
            self.assertIn("Retry-After", raised.exception.headers)

            other_ip_request = Request({
                "type": "http",
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": "/auth/login",
                "raw_path": b"/auth/login",
                "query_string": b"",
                "headers": [],
                "client": ("203.0.113.11", 12345),
                "server": ("testserver", 80),
            })
            main.enforce_login_rate_limit(other_ip_request)
        finally:
            main.login_attempt_timestamps.clear()


    def test_login_rate_limit_expires_attempts_after_window(self):
        main.login_attempt_timestamps.clear()
        request = Request({
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/auth/login",
            "raw_path": b"/auth/login",
            "query_string": b"",
            "headers": [],
            "client": ("203.0.113.13", 12345),
            "server": ("testserver", 80),
        })
        try:
            with patch("main.time.monotonic", side_effect=[100.0, 100.0 + main.LOGIN_RATE_WINDOW_SECONDS]):
                main.enforce_login_rate_limit(request)
                # The first attempt is exactly outside the rolling window now.
                main.enforce_login_rate_limit(request)

            self.assertEqual(len(main.login_attempt_timestamps["203.0.113.13"]), 1)
        finally:
            main.login_attempt_timestamps.clear()


    def test_login_route_enforces_rate_limit_before_database_access(self):
        request = Request({
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/auth/login",
            "raw_path": b"/auth/login",
            "query_string": b"",
            "headers": [],
            "client": ("203.0.113.12", 12345),
            "server": ("testserver", 80),
        })
        with (
            patch("main.enforce_login_rate_limit", side_effect=HTTPException(
                status_code=429,
                detail="Too many login attempts",
                headers={"Retry-After": "60"},
            )) as limiter,
            patch("main.users_collection") as users,
        ):
            with self.assertRaises(HTTPException) as raised:
                main.login(main.LoginRequest(email="user@example.com", password="incorrect"), request)

        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(raised.exception.headers["Retry-After"], "60")
        limiter.assert_called_once_with(request)
        users.assert_not_called()


if __name__ == "__main__":
    unittest.main()
