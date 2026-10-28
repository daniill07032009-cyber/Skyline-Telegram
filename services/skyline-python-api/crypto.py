"""Validate and store public JWKs; message encryption stays in clients."""

from datetime import datetime, timezone
import base64
import json


def validate_public_key(public_key: str) -> bool:
    """Support current P-256 ECDH JWKs and legacy RSA-OAEP public keys."""
    if not public_key or not isinstance(public_key, str):
        return False
    if len(public_key) < 32 or len(public_key) > 8192:
        return False

    try:
        data = json.loads(public_key)
    except (json.JSONDecodeError, TypeError):
        try:
            base64.b64decode(public_key, validate=True)
            return True
        except (ValueError, TypeError):
            return False

    if data.get("kty") == "EC":
        return (
            data.get("crv") == "P-256"
            and isinstance(data.get("x"), str)
            and isinstance(data.get("y"), str)
            and "d" not in data
        )
    if data.get("kty") == "RSA":
        return (
            isinstance(data.get("n"), str)
            and isinstance(data.get("e"), str)
            and "d" not in data
        )
    return False


def make_key_document(user_id: str, public_key: str) -> dict:
    """Create the public-key document stored for a user."""
    now = datetime.now(timezone.utc)
    return {
        "userId": user_id,
        "publicKey": public_key,
        "createdAt": now,
        "updatedAt": now,
    }
