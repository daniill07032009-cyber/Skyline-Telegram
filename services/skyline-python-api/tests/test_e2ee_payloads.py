import base64
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

import main


SENDER_ID = "507f1f77bcf86cd799439011"
MEMBER_ID = "507f1f77bcf86cd799439012"


def make_envelope(recipient_ids: set[str]) -> str:
    encode = lambda value: base64.b64encode(value).decode("ascii")
    recipient = {
        "ephemeralPublicKey": {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"},
        "salt": encode(b"s" * 16),
        "iv": encode(b"i" * 12),
        "wrappedKey": encode(b"w" * 48),
    }
    envelope = {
        "iv": encode(b"p" * 12),
        "ciphertext": encode(b"c" * 32),
        "recipients": {recipient_id: recipient for recipient_id in recipient_ids},
    }
    return "skyline-e2e:v4:" + json.dumps(envelope)


class EncryptedPayloadTests(unittest.IsolatedAsyncioTestCase):
    def test_envelope_requires_the_exact_group_member_set(self):
        value = make_envelope({SENDER_ID, MEMBER_ID})
        main.validate_v4_envelope(value, 64_000, {SENDER_ID, MEMBER_ID})
        with self.assertRaises(HTTPException):
            main.validate_v4_envelope(value, 64_000, {SENDER_ID})

    async def test_group_message_persists_ciphertext_and_never_emits_plaintext_mentions(self):
        value = make_envelope({SENDER_ID, MEMBER_ID})
        group = {
            "_id": main.ObjectId("507f1f77bcf86cd799439013"),
            "title": "Private group",
            "members": [{"userId": SENDER_ID}, {"userId": MEMBER_ID}],
        }
        messages = Mock()
        messages.insert_one.return_value.inserted_id = main.ObjectId("507f1f77bcf86cd799439014")
        groups = Mock()
        current = {"userId": SENDER_ID, "username": "sender"}

        with (
            patch("main.get_group_for_member", return_value=group),
            patch("main.enforce_message_rate_limit"),
            patch("main.messages_collection", return_value=messages),
            patch("main.groups_collection", return_value=groups),
            patch.object(main.sio, "emit", new_callable=AsyncMock) as emit,
        ):
            await main.send_group_message(
                "507f1f77bcf86cd799439013",
                main.GroupMessageRequest(text=value, mentionUserIds=[MEMBER_ID]),
                current,
            )

        stored = messages.insert_one.call_args.args[0]
        self.assertEqual(stored["text"], value)
        self.assertNotIn("Private message", stored["text"])
        mention_event = next(call.args[1] for call in emit.call_args_list if call.args[0] == "group_mention")
        self.assertNotIn("message", mention_event)
        self.assertEqual(mention_event["groupTitle"], "Private group")

    async def test_group_message_rejects_plaintext(self):
        group = {
            "_id": main.ObjectId("507f1f77bcf86cd799439013"),
            "members": [{"userId": SENDER_ID}],
        }
        with patch("main.get_group_for_member", return_value=group):
            with self.assertRaises(HTTPException) as raised:
                await main.send_group_message(
                    "507f1f77bcf86cd799439013",
                    main.GroupMessageRequest(text="plain text"),
                    {"userId": SENDER_ID},
                )
        self.assertEqual(raised.exception.status_code, 400)

    async def test_direct_message_rejects_plaintext(self):
        with self.assertRaises(HTTPException) as raised:
            await main.send_message(
                main.MessageRequest(receiverId=MEMBER_ID, text="plain text"),
                {"userId": SENDER_ID},
            )
        self.assertEqual(raised.exception.status_code, 400)

    async def test_direct_attachment_requires_encrypted_payload_and_private_metadata(self):
        with self.assertRaises(HTTPException) as plain_attachment:
            await main.send_message(
                main.MessageRequest(
                    receiverId=MEMBER_ID,
                    type="file",
                    fileName="secret.txt",
                    contentType="text/plain",
                    fileData="data:text/plain;base64,aGVsbG8=",
                ),
                {"userId": SENDER_ID},
            )
        self.assertEqual(plain_attachment.exception.status_code, 400)

        with self.assertRaises(HTTPException) as missing_ciphertext:
            await main.send_message(
                main.MessageRequest(receiverId=MEMBER_ID, type="file", fileData="plain data"),
                {"userId": SENDER_ID},
            )
        self.assertEqual(missing_ciphertext.exception.status_code, 400)

    async def test_direct_attachment_stores_only_the_encrypted_payload(self):
        value = make_envelope({SENDER_ID, MEMBER_ID})
        messages = Mock()
        messages.insert_one.return_value.inserted_id = main.ObjectId("507f1f77bcf86cd799439015")
        with (
            patch("main.users_blocked_either_way", return_value=False),
            patch("main.enforce_message_rate_limit"),
            patch("main.messages_collection", return_value=messages),
            patch("main.direct_chat_expiration_minutes", return_value=0),
            patch.object(main.sio, "emit", new_callable=AsyncMock),
        ):
            await main.send_message(
                main.MessageRequest(receiverId=MEMBER_ID, type="file", fileData=value),
                {"userId": SENDER_ID},
            )

        stored = messages.insert_one.call_args.args[0]
        self.assertEqual(stored["type"], "file")
        self.assertEqual(stored["fileData"], value)
        self.assertEqual(stored["fileName"], "")
        self.assertEqual(stored["contentType"], "")


if __name__ == "__main__":
    unittest.main()
