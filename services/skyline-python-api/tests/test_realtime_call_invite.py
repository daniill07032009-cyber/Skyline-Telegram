import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from bson import ObjectId

import realtime


CALLER_ID = "507f1f77bcf86cd799439011"
TARGET_ID = "507f1f77bcf86cd799439012"
CALL_ID = "call-test-123"


class CallInviteAvailabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_offline_invitee_is_rejected_without_reserving_call_state(self):
        with (
            patch.dict(realtime.sid_users, {"caller-sid": CALLER_ID}),
            patch.object(realtime, "users_collection") as users_collection,
            patch.object(realtime, "users_blocked_either_way", return_value=False),
            patch.object(realtime, "online_users", {}),
            patch.object(realtime, "active_calls", {}) as active_calls,
            patch.object(realtime, "call_invitees", {}) as call_invitees,
            patch.object(realtime.sio, "emit", new_callable=AsyncMock) as emit,
        ):
            users_collection.return_value.find_one.return_value = {"_id": ObjectId(TARGET_ID)}

            result = await realtime.call_invite(
                "caller-sid",
                {"callId": CALL_ID, "targetUserId": TARGET_ID, "video": False},
            )

        self.assertEqual(result, {"status": "error", "error": "User is offline"})
        self.assertEqual(active_calls, {})
        self.assertEqual(call_invitees, {})
        emit.assert_not_awaited()

    async def test_online_invitee_receives_invitation_and_call_state_is_created(self):
        with (
            patch.dict(realtime.sid_users, {"caller-sid": CALLER_ID}),
            patch.object(realtime, "users_collection") as users_collection,
            patch.object(realtime, "users_blocked_either_way", return_value=False),
            patch.object(realtime, "online_users", {TARGET_ID: {"target-sid"}}),
            patch.object(realtime, "active_calls", {}) as active_calls,
            patch.object(realtime, "call_invitees", {}) as call_invitees,
            patch.object(realtime.sio, "get_session", new_callable=AsyncMock) as get_session,
            patch.object(realtime.sio, "emit", new_callable=AsyncMock) as emit,
        ):
            users_collection.return_value.find_one.side_effect = [
                {"_id": ObjectId(TARGET_ID)},
                {"displayName": "Caller", "username": "caller", "avatarUrl": ""},
            ]
            get_session.return_value = {"username": "caller"}

            result = await realtime.call_invite(
                "caller-sid",
                {"callId": CALL_ID, "targetUserId": TARGET_ID, "video": False},
            )

        self.assertEqual(result, {"status": "ok"})
        self.assertEqual(active_calls[CALL_ID], {CALLER_ID, TARGET_ID})
        self.assertEqual(call_invitees[CALL_ID], TARGET_ID)
        emit.assert_awaited_once()
        self.assertEqual(emit.await_args.kwargs["to"], f"user:{TARGET_ID}")
