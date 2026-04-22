"""ports — single source of truth for ecosystem port numbers.

Order of precedence at runtime (highest first):
  1. environ['PORT'] — the canonical "what port THIS process listens on" var.
  2. environ['PORT_<NAME>'] — service-specific override, e.g. PORT_KEY_SERVER=13040.
  3. ports.yaml — the file in the repo root, edited once to retune the whole palette.
  4. The fallback argument passed by the caller (last-ditch hardcode).

ports.yaml format is fixed and minimal::

    ports:
      consciousness-server: 3032
      semantic-search: 3037

We parse it with regex instead of pulling in PyYAML so every block stays
dep-free. Comments and other YAML structure are ignored — only
``<name>: <number>`` lines under a top-level ``ports:`` key matter.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

_CACHE: dict[str, int] | None = None


def _find_ports_file() -> str | None:
    env = os.environ.get("CS_PORTS_FILE")
    if env:
        return env
    here = Path(__file__).resolve().parent
    for _ in range(6):
        candidate = here / "ports.yaml"
        if candidate.is_file():
            return str(candidate)
        if here.parent == here:
            break
        here = here.parent
    return None


_LINE_RE = re.compile(r"^([A-Za-z][\w-]*)\s*:\s*(\d+)\b")
_TOPKEY_RE = re.compile(r"^([A-Za-z][\w-]*)\s*:\s*$")


def _load_ports() -> dict[str, int]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    path = _find_ports_file()
    if not path:
        _CACHE = {}
        return _CACHE
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        _CACHE = {}
        return _CACHE
    out: dict[str, int] = {}
    in_ports = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0]  # strip inline comments
        stripped = line.strip()
        if not stripped:
            continue
        m_top = _TOPKEY_RE.match(stripped)
        if m_top:
            in_ports = m_top.group(1) == "ports"
            continue
        if in_ports:
            m = _LINE_RE.match(stripped)
            if m:
                out[m.group(1)] = int(m.group(2))
    _CACHE = out
    return _CACHE


def get_port(service_name: str, fallback: int | None = None) -> int:
    """Resolve the port for ``service_name`` (see precedence in module docstring)."""
    env_specific = os.environ.get(
        "PORT_" + service_name.upper().replace("-", "_")
    )
    if env_specific:
        try:
            return int(env_specific)
        except ValueError:
            pass

    if (
        os.environ.get("PORT")
        and os.environ.get("_CS_PORT_OWNER") == service_name
    ):
        try:
            return int(os.environ["PORT"])
        except ValueError:
            pass

    cfg = _load_ports()
    if service_name in cfg:
        return cfg[service_name]

    if fallback is not None:
        return int(fallback)

    raise RuntimeError(
        f"ports: no entry for {service_name!r} "
        f"(no PORT_{service_name.upper()} env, no ports.yaml entry, no fallback)"
    )


def own_port(service_name: str, fallback: int | None = None) -> int:
    """Convenience for a block's server.py when it owns the generic PORT var.

    Picks up ``PORT=<n>`` if set, else falls through to ports.yaml, else the
    hardcoded fallback. The fallback exists only so a developer who deletes
    ports.yaml still gets a working default.
    """
    p = os.environ.get("PORT")
    if p:
        try:
            return int(p)
        except ValueError:
            pass
    return get_port(service_name, fallback)
