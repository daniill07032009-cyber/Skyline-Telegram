import json
import unittest

from crypto import validate_public_key


class PublicKeyValidationTests(unittest.TestCase):
    def test_accepts_p256_ecdh_public_key(self) -> None:
        key = json.dumps({
            "kty": "EC",
            "crv": "P-256",
            "x": "encoded-x-coordinate",
            "y": "encoded-y-coordinate",
        })

        self.assertTrue(validate_public_key(key))

    def test_rejects_private_ecdh_key_material(self) -> None:
        key = json.dumps({
            "kty": "EC",
            "crv": "P-256",
            "x": "encoded-x-coordinate",
            "y": "encoded-y-coordinate",
            "d": "private-key-material",
        })

        self.assertFalse(validate_public_key(key))

    def test_rejects_other_ec_curves(self) -> None:
        key = json.dumps({
            "kty": "EC",
            "crv": "P-384",
            "x": "encoded-x-coordinate",
            "y": "encoded-y-coordinate",
        })

        self.assertFalse(validate_public_key(key))

    def test_keeps_accepting_legacy_rsa_public_keys(self) -> None:
        key = json.dumps({
            "kty": "RSA",
            "n": "encoded-modulus",
            "e": "AQAB",
        })

        self.assertTrue(validate_public_key(key))


if __name__ == "__main__":
    unittest.main()
