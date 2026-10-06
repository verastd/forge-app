"""Who is calling /api/upland/*: verify the web tier's short-lived API assertion.

The browser never calls these routes directly. The Next BFF checks the session
cookie, mints an HS256 JWS with the shared FORGE_API_ASSERTION_SECRET, and
forwards the request; `require_identity` verifies it on every call. The contract
(the web side is `mintApiAssertion` in packages/auth):

    header  alg=HS256, typ=JWT (typ may be omitted)
    claims  iss="forge-web", aud="forge-api", sub=<GitHub numeric id>,
            login=<GitHub login>, iat, exp  (integer seconds, 0 < exp - iat <= 120)

Every failure is the same 401 {"error": "unauthenticated"}, including an unset or
short secret and the `github_signin` flag being off, so a caller learns nothing
about why. Operator-only routes add `require_admin`: 403 {"error": "admin_only"}
unless the caller's GitHub user id is on FORGE_ADMIN_IDS.
"""

import functools
import logging
import os
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Any, TypeGuard

import jwt
from fastapi import Depends, Header

from forge_api.services import flags as flags_service
from forge_api.services.errors import ApiError

SIGNIN_FLAG = "github_signin"
SECRET_ENV = "FORGE_API_ASSERTION_SECRET"
ADMIN_IDS_ENV = "FORGE_ADMIN_IDS"

ALGORITHM = "HS256"
ISSUER = "forge-web"
AUDIENCE = "forge-api"
MIN_SECRET_LENGTH = 32
MAX_TTL_SECONDS = 120
CLOCK_SKEW_SECONDS = 30

# fullmatch, never `$`: `$` also matches just before a trailing newline.
_SUB = re.compile(r"[1-9][0-9]{0,19}")
_LOGIN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")
# Case-insensitive scheme, exactly one space, then the token (RFC 6750 §2.1).
_BEARER = re.compile(r"bearer (\S+)", re.IGNORECASE | re.ASCII)

logger = logging.getLogger(__name__)


class InvalidAssertion(Exception):
    """The assertion, or the secret it must be checked against, is unusable."""


@dataclass(frozen=True)
class Identity:
    sub: str
    login: str


def verify_assertion(token: str, *, secret: str, now: int | None = None) -> Identity:
    """The identity an assertion vouches for. Raises InvalidAssertion on any defect."""
    if len(secret) < MIN_SECRET_LENGTH:
        # pyjwt only warns about a short HMAC key, and an unset one would accept
        # anything signed with "".
        raise InvalidAssertion("assertion secret is unset or too short")
    try:
        header = jwt.get_unverified_header(token)
        claims = jwt.decode(
            token,
            secret.encode(),
            algorithms=[ALGORITHM],
            audience=AUDIENCE,
            issuer=ISSUER,
            options={
                "require": ["iss", "aud", "sub", "iat", "exp"],
                # The contract's aud is one string; a list merely containing it is not that.
                "strict_aud": True,
                # pyjwt reads the wall clock; the checks below use the injectable `now`.
                "verify_exp": False,
                "verify_iat": False,
                "verify_nbf": False,
            },
        )
    except jwt.PyJWTError as exc:
        raise InvalidAssertion(str(exc)) from exc
    if header.get("typ", "JWT") != "JWT":
        raise InvalidAssertion("typ header is not JWT")
    _check_lifetime(claims, int(time.time()) if now is None else now)
    sub, login = claims["sub"], claims.get("login")
    if not _fullmatch(sub, _SUB):
        raise InvalidAssertion("sub is not a GitHub numeric id")
    if not _fullmatch(login, _LOGIN):
        raise InvalidAssertion("login is not a GitHub login")
    return Identity(sub=sub, login=login)


def mint_assertion(
    sub: str, login: str, *, secret: str, ttl: int = 60, now: int | None = None
) -> str:
    """Sign an assertion the way the web tier does. Tests and fixtures only: the API
    never mints. Refuses anything `verify_assertion` would reject."""
    issued = int(time.time()) if now is None else now
    if len(secret) < MIN_SECRET_LENGTH:
        raise ValueError(f"secret must be at least {MIN_SECRET_LENGTH} characters")
    if not _fullmatch(sub, _SUB):
        raise ValueError("sub must be a GitHub numeric id")
    if not _fullmatch(login, _LOGIN):
        raise ValueError("login must be a GitHub login")
    if not (_is_int(ttl) and 1 <= ttl <= MAX_TTL_SECONDS):
        raise ValueError(f"ttl must be 1-{MAX_TTL_SECONDS} seconds")
    if not _is_int(issued):
        raise ValueError("now must be an integer")
    claims = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": sub,
        "login": login,
        "iat": issued,
        "exp": issued + ttl,
    }
    return jwt.encode(claims, secret.encode(), algorithm=ALGORITHM, headers={"typ": "JWT"})


def require_identity(authorization: Annotated[str | None, Header()] = None) -> Identity:
    """Router dependency: the verified caller, or 401 for any defect whatsoever."""
    if not flags_service.is_enabled(SIGNIN_FLAG):
        raise _unauthenticated()
    match = _BEARER.fullmatch(authorization or "")
    if match is None:
        raise _unauthenticated()
    try:
        return verify_assertion(match.group(1), secret=os.environ.get(SECRET_ENV, ""))
    except InvalidAssertion as exc:
        logger.debug("API assertion rejected: %s", exc)  # the reason, never the token
        raise _unauthenticated() from None


def is_admin(identity: Identity) -> bool:
    """Whether `identity` is an admin: its GitHub user id is on FORGE_ADMIN_IDS. The id,
    never the login: a login can be renamed, and then registered by someone else."""
    return identity.sub in admin_ids()


def require_admin(identity: Annotated[Identity, Depends(require_identity)]) -> Identity:
    """Router dependency for operator-only routes: the caller must be an admin (`is_admin`)."""
    if not is_admin(identity):
        raise ApiError(403, {"error": "admin_only"})
    return identity


def admin_ids(env: Mapping[str, str] | None = None) -> frozenset[str]:
    """FORGE_ADMIN_IDS: comma-separated numeric GitHub user ids (what
    https://api.github.com/users/<login> returns as `id`). Entries are trimmed and blank
    ones dropped; unset or empty means nobody. One invalid entry means nobody at all."""
    return _parse_admin_ids((env if env is not None else os.environ).get(ADMIN_IDS_ENV, ""))


@functools.lru_cache(maxsize=8)
def _parse_admin_ids(raw: str) -> frozenset[str]:
    # Cached per value, so a bad setting logs its warning once, not on every admin request.
    entries = [entry.strip() for entry in raw.split(",") if entry.strip()]
    if not all(_fullmatch(entry, _SUB) for entry in entries):
        # Fail closed: a login or a typo in the list must not leave the rest of it in force.
        logger.warning(
            "%s has an entry that is not a numeric GitHub user id; nobody is admin", ADMIN_IDS_ENV
        )
        return frozenset()
    return frozenset(entries)


def _check_lifetime(claims: dict[str, Any], now: int) -> None:
    iat, exp = claims["iat"], claims["exp"]
    if not (_is_int(iat) and _is_int(exp)):
        raise InvalidAssertion("iat and exp must be integers")
    if exp <= now:
        raise InvalidAssertion("expired")
    if iat > now + CLOCK_SKEW_SECONDS:
        raise InvalidAssertion("issued in the future")
    if not 0 < exp - iat <= MAX_TTL_SECONDS:
        raise InvalidAssertion(f"lifetime is not 1-{MAX_TTL_SECONDS} seconds")
    # pyjwt's nbf check is off with the others; keep its meaning against `now`.
    if "nbf" in claims:
        nbf = claims["nbf"]
        if not (_is_int(nbf) and nbf <= now + CLOCK_SKEW_SECONDS):
            raise InvalidAssertion("not yet valid")


def _is_int(value: object) -> TypeGuard[int]:
    # bool is an int subclass, and a JSON float such as 1.7e9 is not an integer claim.
    return isinstance(value, int) and not isinstance(value, bool)


def _fullmatch(value: object, pattern: re.Pattern[str]) -> TypeGuard[str]:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _unauthenticated() -> ApiError:
    # RFC 6750: a 401 names the scheme it wants. No error detail in the challenge, on purpose.
    return ApiError(401, {"error": "unauthenticated"}, headers={"WWW-Authenticate": "Bearer"})
