import hashlib
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, Mock, patch

from bson import ObjectId
from fastapi import HTTPException
from pydantic import ValidationError

import main


USER_ID = "507f1f77bcf86cd799439011"


class EmailVerificationTests(unittest.TestCase):
    def test_send_code_uses_six_digits_and_generic_success_response(self) -> None:
        verifications = Mock()
        tokens = Mock()

        with (
            patch("main.secrets.randbelow", return_value=42),
            patch("main.send_email_verification_message") as send_email,
            patch("main.email_verifications_collection", return_value=verifications),
            patch("main.verified_email_tokens_collection", return_value=tokens),
        ):
            response = main.send_email_code(main.SendEmailCodeRequest(email="Person@Example.com"))

        send_email.assert_called_once()
        sent_email, sent_code, sent_link = send_email.call_args.args
        self.assertEqual((sent_email, sent_code), ("person@example.com", "000042"))
        self.assertIn("email=person%40example.com", sent_link)
        self.assertIn("code=000042", sent_link)
        stored = verifications.update_one.call_args.args[1]["$set"]
        self.assertEqual(stored["code"], "000042")
        self.assertEqual(stored["failedAttempts"], 0)
        self.assertAlmostEqual(
            (stored["expiresAt"] - datetime.now(timezone.utc)).total_seconds(),
            600,
            delta=1,
        )
        self.assertEqual(response["expiresInSeconds"], 600)
        self.assertTrue(response["emailSent"])
        self.assertNotIn("email", response)
        self.assertNotIn("code", response)
        self.assertNotIn("token", response)
        self.assertNotIn("verificationLink", response)
        self.assertNotIn("deliveryError", response)
        tokens.delete_many.assert_called_once_with({"email": "person@example.com"})

    def test_failed_email_delivery_does_not_disclose_verification_secrets(self) -> None:
        verifications = Mock()
        tokens = Mock()

        with (
            patch("main.send_email_verification_message", side_effect=RuntimeError("SMTP unavailable")),
            patch("main.email_verifications_collection", return_value=verifications),
            patch("main.verified_email_tokens_collection", return_value=tokens),
        ):
            with self.assertRaises(HTTPException) as failed:
                main.send_email_code(main.SendEmailCodeRequest(email="Person@Example.com"))

        self.assertEqual(failed.exception.status_code, 503)
        self.assertNotIn("000042", str(failed.exception.detail))
        verifications.delete_one.assert_called_once_with({
            "email": "person@example.com",
            "token": verifications.update_one.call_args.args[1]["$set"]["token"],
        })

    def test_gmail_sender_uses_starttls_and_required_message(self) -> None:
        smtp = MagicMock()
        smtp_context = smtp.__enter__.return_value
        with (
            patch.dict("os.environ", {
                "SMTP_HOST": "smtp.gmail.com",
                "SMTP_PORT": "587",
                "SMTP_USER": "skyline@example.com",
                "SMTP_PASSWORD": "app-password",
            }),
            patch("main.smtplib.SMTP", return_value=smtp) as smtp_factory,
        ):
            main.send_email_verification_message("person@example.com", "012345")
            smtp_factory.assert_called_once_with("smtp.gmail.com", 587, timeout=15)

        smtp_context.starttls.assert_called_once()
        sent_message = smtp_context.send_message.call_args.args[0]
        self.assertEqual(sent_message["To"], "person@example.com")
        self.assertIn(
            "Ваш код подтверждения для Skyline: 012345. Код действителен 10 минут.",
            sent_message.get_content(),
        )

    def test_verification_rejects_missing_and_expired_codes(self) -> None:
        payload = main.VerifyEmailCodeRequest(email="person@example.com", code="123456")
        with patch("main.email_verifications_collection") as collection:
            collection.return_value.find_one.return_value = None
            with self.assertRaises(HTTPException) as missing:
                main.verify_email_code(payload)
            self.assertIn("Код не запрошен", missing.exception.detail)

            collection.return_value.find_one.return_value = {
                "_id": ObjectId(),
                "expiresAt": datetime.now(timezone.utc) - timedelta(seconds=1),
                "failedAttempts": 0,
                "code": "123456",
            }
            with self.assertRaises(HTTPException) as expired:
                main.verify_email_code(payload)
            self.assertIn("Код истёк", expired.exception.detail)
            collection.return_value.delete_one.assert_called_once()

    def test_wrong_code_counts_attempts_and_removes_verification_at_five(self) -> None:
        verification_id = ObjectId()
        verifications = Mock()
        verifications.find_one.return_value = {
            "_id": verification_id,
            "expiresAt": datetime.now(timezone.utc) + timedelta(minutes=10),
            "failedAttempts": 3,
            "code": "123456",
        }
        verifications.find_one_and_update.return_value = {"failedAttempts": 4}
        payload = main.VerifyEmailCodeRequest(email="person@example.com", code="000000")

        with patch("main.email_verifications_collection", return_value=verifications):
            with self.assertRaises(HTTPException) as fourth:
                main.verify_email_code(payload)
            self.assertIn("Осталось попыток: 1", fourth.exception.detail)
            verifications.find_one_and_update.assert_called_once_with(
                {"_id": verification_id},
                {"$inc": {"failedAttempts": 1}},
                return_document=main.ReturnDocument.AFTER,
            )

            verifications.reset_mock()
            verifications.find_one.return_value["failedAttempts"] = 4
            verifications.find_one_and_update.return_value = {"failedAttempts": 5}
            with self.assertRaises(HTTPException) as fifth:
                main.verify_email_code(payload)
            self.assertIn("Слишком много попыток", fifth.exception.detail)
            verifications.delete_one.assert_called_once_with({"_id": verification_id})
            verifications.update_one.assert_not_called()

    def test_correct_code_creates_one_time_registration_token(self) -> None:
        verification_id = ObjectId()
        verifications = Mock()
        verifications.find_one.return_value = {
            "_id": verification_id,
            "expiresAt": datetime.now(timezone.utc) + timedelta(minutes=10),
            "failedAttempts": 0,
            "code": "000042",
        }
        verifications.find_one_and_delete.return_value = {"_id": verification_id}
        tokens = Mock()
        users = Mock()
        payload = main.VerifyEmailCodeRequest(email="person@example.com", code="000042")

        with (
            patch("main.email_verifications_collection", return_value=verifications),
            patch("main.verified_email_tokens_collection", return_value=tokens),
            patch("main.users_collection", return_value=users),
            patch("main.secrets.token_urlsafe", return_value="one-time-registration-token"),
        ):
            response = main.verify_email_code(payload)

        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["registrationToken"], "one-time-registration-token")
        token_record = tokens.insert_one.call_args.args[0]
        self.assertEqual(token_record["email"], "person@example.com")
        self.assertEqual(
            token_record["tokenHash"],
            hashlib.sha256(b"one-time-registration-token").hexdigest(),
        )
        self.assertGreater(token_record["expiresAt"], datetime.now(timezone.utc))
        users.update_one.assert_called_once_with(
            {"email": "person@example.com"},
            {"$set": {"isEmailVerified": True}},
        )
        verifications.find_one_and_delete.assert_called_once_with({
            "_id": verification_id,
            "code": "000042",
        })

    def test_register_requires_and_consumes_a_verified_email_token(self) -> None:
        users = Mock()
        users.find_one.return_value = None
        users.insert_one.return_value.inserted_id = ObjectId(USER_ID)
        verified_tokens = Mock()
        verified_tokens.find_one_and_delete.return_value = {"email": "person@example.com"}
        payload = main.RegisterRequest(
            email="Person@Example.com",
            password="password123",
            username="person_one",
            verificationToken="one-time-registration-token-1234567890",
        )

        with (
            patch("main.users_collection", return_value=users),
            patch("main.verified_email_tokens_collection", return_value=verified_tokens),
            patch("main.hash_password", return_value="password-hash"),
            patch("main.create_token", return_value="auth-token"),
        ):
            response = main.register(payload)

        self.assertTrue(response["user"]["isEmailVerified"])
        self.assertEqual(response["user"]["email"], "person@example.com")
        self.assertTrue(users.insert_one.call_args.args[0]["isEmailVerified"])
        verified_tokens.find_one_and_delete.assert_called_once()

    def test_register_requires_a_verification_token(self) -> None:
        with self.assertRaises(ValidationError):
            main.RegisterRequest(
                email="person@example.com",
                password="password123",
                username="person_one",
            )


if __name__ == "__main__":
    unittest.main()
