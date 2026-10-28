
"""
Модуль для управления аутентификацией и безопасностью.

Предоставляет утилиты для хеширования паролей, проверки их валидности,
а также для генерации, декодирования и верификации JWT-токенов в контексте
веб-приложений на базе FastAPI.

Functions
---------
hash_password(password)
    Хеширует текстовый пароль с использованием соли.
verify_password(password, password_hash)
    Проверяет соответствие открытого пароля его хешу.
create_token(user_id, email, username)
    Создает JWT токен для аутентификации пользователя.
decode_token(token)
    Декодирует JWT токен и проверяет его валидность.
get_current_user(authorization)
    Извлекает и валидирует данные пользователя из HTTP-заголовка Authorization.

Attributes
----------
JWT_SECRET : str
    Секретный ключ для подписи JWT-токенов. По умолчанию используется "change_me".
JWT_ALGO : str
    Алгоритм шифрования JWT. По умолчанию "HS256".
JWT_EXPIRES_MINUTES : int
    Время жизни токена в минутах. По умолчанию 10080 (7 дней).
"""


from datetime import datetime, timedelta, timezone
from os import getenv

from bson import ObjectId
from bcrypt import checkpw, gensalt, hashpw
from fastapi import HTTPException, Header
from jwt import ExpiredSignatureError, InvalidTokenError, decode as jwt_decode, encode as jwt_encode

from db import users_collection


JWT_SECRET: str = getenv("JWT_SECRET", "")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET must be configured")
JWT_ALGO: str = "HS256"
JWT_EXPIRES_MINUTES: int = int(getenv("JWT_EXPIRES_MINUTES", "10080"))


def hash_password(password: str) -> str:

    """
    Хеширует текстовый пароль с использованием соли.

    Parameters
    ----------
    password : str
        Исходный пароль в виде строки для хеширования.

    Returns
    -------
    str
        Декодированная строка хеша пароля, готовая для сохранения в базу данных.
    """

    salt = gensalt()
    return hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:

    """
    Проверяет соответствие открытого пароля его хешу.

    Parameters
    ----------
    password : str
        Открытый пароль, предоставленный пользователем для проверки.
    password_hash : str
        Строка сохраненного хеша, с которым сравнивается пароль.

    Returns
    -------
    bool
        True, если пароль совпадает с хешем, иначе False. При возникновении 
        любых исключений в процессе проверки также возвращается False.
    """

    try:
        return checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except Exception:
        return False


def create_token(user_id: str, email: str, username: str) -> str:

    """
    Создает JWT токен для аутентификации пользователя.

    Включает в полезную нагрузку (payload) идентификатор пользователя, email,
    имя пользователя, а также время выпуска (iat) и время окончания 
    действия токена (exp).

    Parameters
    ----------
    user_id : str
        Уникальный идентификатор пользователя.
    email : str
        Адрес электронной почты пользователя.
    username : str
        Имя пользователя в системе.

    Returns
    -------
    str
        Закодированный JWT токен в виде строки.
    """

    payload = {
        "userId": user_id,
        "email": email,
        "username": username,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRES_MINUTES),
        "iat": datetime.now(timezone.utc),
    }
    return jwt_encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def decode_token(token: str) -> dict:

    """
    Декодирует JWT токен и проверяет его валидность.

    Parameters
    ----------
    token : str
        Строка JWT токена, переданная для декодирования.

    Returns
    -------
    dict
        Словарь с полезной нагрузкой (payload) декодированного токена, 
        содержащий утверждения (claims) о пользователе и времени жизни токена.

    Raises
    ------
    HTTPException
        С кодом 401, если срок действия токена истек (Token expired) 
        или токен является некорректным (Invalid token).
    """

    try:
        return jwt_decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def get_current_user(authorization: str = Header(default=None)) -> dict:

    """
    Извлекает и валидирует данные пользователя из HTTP-заголовка Authorization.

    Используется в качестве зависимости (dependency) в FastAPI для защиты эндпоинтов.

    Parameters
    ----------
    authorization : str, optional
        Значение HTTP-заголовка 'Authorization', передаваемое клиентом. 
        По умолчанию принимает значение None, если заголовок отсутствует.

    Returns
    -------
    dict
        Декодированная полезная нагрузка (payload) валидного токена, 
        представляющая данные текущего авторизованного пользователя.

    Raises
    ------
    HTTPException
        С кодом 401, если заголовок отсутствует, не начинается со строки 'Bearer ',
        а также если токен просрочен или невалиден.
    """

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="No token provided")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid token")
    payload = decode_token(token)
    user_id = payload.get("userId") if isinstance(payload, dict) else None
    if not isinstance(user_id, str) or not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=401, detail="Invalid token")
    user = users_collection().find_one({"_id": ObjectId(user_id)}, {"_id": 1})
    if not user:
        raise HTTPException(status_code=401, detail="User account no longer exists")
    return payload


__all__ = ['hash_password', 'verify_password', 'create_token', 'decode_token', 'get_current_user']
