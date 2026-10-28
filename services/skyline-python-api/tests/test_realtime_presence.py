import unittest
from datetime import timezone
from unittest.mock import AsyncMock, Mock, patch

from bson import ObjectId

import realtime


USER_ID = "507f1f77bcf86cd799439011"


class RealtimePresenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_persists_and_broadcasts_last_seen(self) -> None:
        users = Mock()
        users.find_one.return_value = {"showLastSeen": True}
        session_id = "session-1"
        with (
            patch.dict(realtime.sid_users, {session_id: USER_ID}),
            patch.dict(realtime.online_users, {USER_ID: {session_id}}),
            patch("realtime.users_collection", return_value=users),
            patch.object(realtime.sio, "emit", new_callable=AsyncMock) as emit,
        ):
            await realtime.disconnect(session_id)

            users.update_one.assert_called_once()
            self.assertEqual(users.update_one.call_args.args[0], {"_id": ObjectId(USER_ID)})
            last_seen = users.update_one.call_args.args[1]["$set"]["lastSeen"]
            self.assertEqual(last_seen.utcoffset(), timezone.utc.utcoffset(last_seen))
            emit.assert_awaited_once()
            self.assertEqual(emit.call_args.args[0], "user_offline")
            self.assertEqual(emit.call_args.args[1]["userId"], USER_ID)
            self.assertEqual(emit.call_args.args[1]["lastSeen"], last_seen.isoformat())


if __name__ == "__main__":
    unittest.main()
