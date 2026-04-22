"""verify_signed — shared middleware for signed-request enforcement.

Single source of truth for Python blocks in the CS ecosystem.
`bin/sync-middleware` copies this file into each block's
`middleware/` directory; CI drift check refuses to merge if any
copy diverges from this master.

Protocol: docs/SIGNING-PROTOCOL.md. Mode semantics: docs/AUTH-MODE.md.

Env:
  AUTH_MODE        off | observe | enforce  (default: off)
  KEY_SERVER_URL   http://key-server:3040    (default shown; ignored if off)
  AUTH_OBSERVE_LOG path to observe-mode log  (default: logs/auth-observe.log)

Exports:
  verify_signed_request(headers, method, path, body_bytes) → dict
  flask_middleware(app)              — Flask before_request hook
  stdlib_gate(handler_class)         — BaseHTTPRequestHandler decorator
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib import error as _urlerror
from urllib import request as _urlrequest

_LOG = logging.getLogger("verify_signed")

AUTH_MODE = (os.environ.get("AUTH_MODE") or "off").strip().lower()
KEY_SERVER_URL = (os.environ.get("KEY_SERVER_URL") or "http://key-server:3040").rstrip("/")
AUTH_OBSERVE_LOG = os.environ.get("AUTH_OBSERVE_LOG") or "logs/auth-observe.log"
VERIFY_TIMEOUT_S = float(os.environ.get("AUTH_VERIFY_TIMEOUT", "2.0"))

_VALID_MODES = ("off", "observe", "enforce")
if AUTH_MODE not in _VALID_MODES:
    _LOG.warning("AUTH_MODE=%r not recognised, falling back to 'off'", AUTH_MODE)
    AUTH_MODE = "off"

# Endpoints that skip the gate in every mode (see docs/AUTH-MODE.md "Always-open endpoints").
_ALWAYS_OPEN_PATHS = frozenset({"/health", "/metrics"})


def _body_sha256(body_bytes: bytes | None) -> str:
    return hashlib.sha256(body_bytes or b"").hexdigest()


def _header(headers: Mapping[str, str], name: str) -> str | None:
    # Flask/WSGI are case-insensitive; plain dicts need help.
    if hasattr(headers, "get"):
        v = headers.get(name)
        if v is not None:
            return v
    lname = name.lower()
    for k, v in headers.items():
        if k.lower() == lname:
            return v
    return None


def verify_signed_request(
    headers: Mapping[str, str],
    method: str,
    path: str,
    body_bytes: bytes | None,
) -> dict:
    """Ask key-server whether this request is authentic.

    Returns {'valid': True} on success, or
            {'valid': False, 'reason': <str>}.

    Reasons: missing_headers, key_server_unreachable, plus the ones
    key-server itself returns (bad_signature, unknown_agent,
    nonce_replayed, timestamp_out_of_window).
    """
    agent_id = _header(headers, "X-Agent-Id")
    timestamp = _header(headers, "X-Timestamp")
    nonce = _header(headers, "X-Nonce")
    signature = _header(headers, "X-Signature")

    if not (agent_id and timestamp and nonce and signature):
        return {"valid": False, "reason": "missing_headers"}

    payload = {
        "agent_id": agent_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "method": method.upper(),
        "path": path,
        "body_sha256": _body_sha256(body_bytes),
        "signature": signature,
    }
    data = json.dumps(payload).encode("utf-8")
    req = _urlrequest.Request(
        f"{KEY_SERVER_URL}/api/verify",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with _urlrequest.urlopen(req, timeout=VERIFY_TIMEOUT_S) as resp:
            body = resp.read()
            parsed = json.loads(body.decode("utf-8"))
    except _urlerror.HTTPError as http_err:
        # 401 from key-server is the expected "invalid" verdict.
        try:
            parsed = json.loads(http_err.read().decode("utf-8"))
        except Exception:
            return {"valid": False, "reason": f"key_server_http_{http_err.code}"}
        return {
            "valid": bool(parsed.get("valid")),
            "reason": parsed.get("reason") or f"key_server_http_{http_err.code}",
        }
    except (_urlerror.URLError, TimeoutError, OSError):
        return {"valid": False, "reason": "key_server_unreachable"}
    except Exception as err:  # defensive: malformed response, etc.
        return {"valid": False, "reason": f"key_server_error: {err.__class__.__name__}"}

    if parsed.get("valid") is True:
        return {"valid": True, "agent_id": parsed.get("agent_id") or agent_id}
    return {"valid": False, "reason": parsed.get("reason") or "invalid"}


def _observe_log_line(entry: dict) -> None:
    """Best-effort write to AUTH_OBSERVE_LOG. Never raises."""
    try:
        Path(AUTH_OBSERVE_LOG).parent.mkdir(parents=True, exist_ok=True)
        entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **entry}
        with open(AUTH_OBSERVE_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except Exception:
        # Logging must never break a request.
        pass


def _should_skip(method: str, path: str) -> bool:
    if method.upper() == "OPTIONS":
        return True
    if path in _ALWAYS_OPEN_PATHS:
        return True
    return False


def flask_middleware(app: Any) -> None:
    """Attach before_request hook to a Flask app.

    Leaves ``app`` otherwise untouched. Idempotent only if called
    once — call site is the block's top-level, not inside a factory.
    """
    # Local imports so the module loads fine in non-Flask contexts
    # (e.g. stdlib blocks that import verify_signed_request directly).
    from flask import jsonify, request

    @app.before_request
    def _verify_signed_gate():  # noqa: ANN001  (Flask signature)
        if _should_skip(request.method, request.path):
            return None
        if AUTH_MODE == "off":
            return None

        verdict = verify_signed_request(
            request.headers,
            request.method,
            request.path,
            request.get_data(cache=True),
        )

        if verdict.get("valid"):
            return None

        reason = verdict.get("reason") or "invalid"

        if AUTH_MODE == "observe":
            _observe_log_line(
                {
                    "event": "would_reject",
                    "method": request.method,
                    "path": request.path,
                    "reason": reason,
                    "agent_id": _header(request.headers, "X-Agent-Id") or None,
                }
            )
            return None

        # enforce
        status = 503 if reason == "key_server_unreachable" else 401
        return jsonify({"error": "unauthorized", "reason": reason}), status


def stdlib_gate(handler_method: Callable) -> Callable:
    """Decorator for ``http.server.BaseHTTPRequestHandler`` method handlers.

    Usage::

        class MyHandler(BaseHTTPRequestHandler):
            @stdlib_gate
            def do_POST(self):
                ...

    Wraps the handler so the gate runs before the real method. On
    reject writes 401/503 and returns; on pass delegates to the
    original method.
    """
    def _wrapped(self, *args, **kwargs):
        method = self.command or "GET"
        path = (self.path or "/").split("?", 1)[0]

        if _should_skip(method, path):
            return handler_method(self, *args, **kwargs)
        if AUTH_MODE == "off":
            return handler_method(self, *args, **kwargs)

        # Read body (once). POST/PUT/PATCH typically; GET usually empty.
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        body_bytes = self.rfile.read(length) if length > 0 else b""
        # Reinject the buffered body so the real handler sees a normal
        # rfile: any `self.rfile.read(length)` downstream replays the
        # same bytes. Also stash on the instance for callers that
        # prefer direct access.
        self.rfile = io.BytesIO(body_bytes)
        self._verify_signed_body = body_bytes  # type: ignore[attr-defined]

        verdict = verify_signed_request(self.headers, method, path, body_bytes)

        if verdict.get("valid"):
            return handler_method(self, *args, **kwargs)

        reason = verdict.get("reason") or "invalid"

        if AUTH_MODE == "observe":
            _observe_log_line(
                {
                    "event": "would_reject",
                    "method": method,
                    "path": path,
                    "reason": reason,
                    "agent_id": _header(self.headers, "X-Agent-Id"),
                }
            )
            return handler_method(self, *args, **kwargs)

        status = 503 if reason == "key_server_unreachable" else 401
        payload = json.dumps({"error": "unauthorized", "reason": reason}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        return None

    _wrapped.__name__ = getattr(handler_method, "__name__", "wrapped")
    _wrapped.__doc__ = handler_method.__doc__
    return _wrapped


__all__ = [
    "AUTH_MODE",
    "KEY_SERVER_URL",
    "verify_signed_request",
    "flask_middleware",
    "stdlib_gate",
]
