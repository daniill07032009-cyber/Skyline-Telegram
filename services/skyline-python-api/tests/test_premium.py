import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from bson import ObjectId
from pydantic import ValidationError

import premium


USER_ID = "507f1f77bcf86cd799439011"
USER_OBJECT_ID = ObjectId(USER_ID)


class PremiumTests(unittest.TestCase):
    def test_premium_expires_when_expiry_is_in_the_past(self) -> None:
        user = {
            "isPremium": True,
            "premiumUntil": datetime.now(timezone.utc) - timedelta(seconds=1),
            "coinsBalance": 42,
        }

        self.assertEqual(
            premium.serialize_premium(user),
            {"isPremium": False, "premiumUntil": None, "coinsBalance": 42},
        )

    def test_premium_purchase_grants_thirty_days(self) -> None:
        users = Mock()
        users.find_one.return_value = {
            "_id": USER_OBJECT_ID,
            "isPremium": False,
            "premiumUntil": None,
        }
        users.update_one.return_value.matched_count = 1

        with patch("premium.users_collection", return_value=users):
            response = premium.buy_premium({"userId": USER_ID})

        expiry = datetime.fromisoformat(response["premiumUntil"])
        self.assertTrue(response["isPremium"])
        self.assertTrue(response["simulated"])
        self.assertEqual(response["durationDays"], 30)
        self.assertAlmostEqual((expiry - datetime.now(timezone.utc)).total_seconds(), 30 * 86400, delta=5)
        self.assertTrue(users.update_one.called)
        update = users.update_one.call_args.args[1]["$set"]
        self.assertTrue(update["isPremium"])
        self.assertEqual(update["premiumUntil"], expiry)

    def test_renewal_extends_an_active_premium_period(self) -> None:
        existing_expiry = datetime.now(timezone.utc) + timedelta(days=12)
        users = Mock()
        users.find_one.return_value = {
            "_id": USER_OBJECT_ID,
            "isPremium": True,
            "premiumUntil": existing_expiry,
        }
        users.update_one.return_value.matched_count = 1

        with patch("premium.users_collection", return_value=users):
            response = premium.buy_premium({"userId": USER_ID})

        expiry = datetime.fromisoformat(response["premiumUntil"])
        self.assertAlmostEqual(
            (expiry - existing_expiry).total_seconds(),
            30 * 86400,
            delta=2,
        )

    def test_coin_purchase_credits_only_a_supported_package(self) -> None:
        users = Mock()
        users.find_one.return_value = {"_id": USER_OBJECT_ID, "coinsBalance": 25}
        users.update_one.return_value.matched_count = 1

        with patch("premium.users_collection", return_value=users):
            response = premium.buy_coins(
                premium.BuyCoinsRequest(coins=500),
                {"userId": USER_ID},
            )

        self.assertEqual(response["coinsAdded"], 500)
        self.assertEqual(response["priceRub"], 449)
        self.assertEqual(response["coinsBalance"], 525)
        self.assertTrue(response["simulated"])
        self.assertEqual(
            users.update_one.call_args.args[1],
            {"$inc": {"coinsBalance": 500}},
        )

    def test_coin_purchase_rejects_custom_amounts(self) -> None:
        with self.assertRaises(ValidationError):
            premium.BuyCoinsRequest(coins=200)

    def test_coin_balance_never_reports_a_negative_value(self) -> None:
        users = Mock()
        users.find_one.return_value = {"_id": USER_OBJECT_ID, "coinsBalance": -30}

        with patch("premium.users_collection", return_value=users):
            balance = premium.get_coins_balance({"userId": USER_ID})

        self.assertEqual(balance, {"coinsBalance": 0})


if __name__ == "__main__":
    unittest.main()
