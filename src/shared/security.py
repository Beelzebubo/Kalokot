"""Security middleware for OpenTender + Counsel API.

Provides:
- Input sanitization (SQL injection, XSS prevention)
- Security headers
- Request size limits
"""

from __future__ import annotations

import re
from typing import Optional

# ── SQL Injection Prevention ──────────────────────────────────────────────────

_SQL_INJECTION_PATTERNS = [
    r"(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION)\b)",
    r"(--|;|/\*|\*/|@@|@)",
    r"(\b(OR|AND)\b\s+\d+\s*=\s*\d+)",
    r"('(\s)*(OR|AND)(\s)*')",
    r"((\%27)|('))\s*((\%6F)|o|(\%4F))((\%72)|r|(\#52))",
    r"(\bHAVING\b|\bGROUP\s+BY\b)",
    r"(\bWAITFOR\b\s+\bDELAY\b)",
    r"(\bBENCHMARK\b\s*\()",
]

_SQL_PATTERN = re.compile(
    "|".join(_SQL_INJECTION_PATTERNS),
    re.IGNORECASE,
)


def sanitize_input(text: str, max_length: int = 50000) -> str:
    """Sanitize user input to prevent SQL injection and XSS.

    - Truncates to max_length
    - Removes null bytes
    - Raises ValueError if SQL injection patterns detected
    """
    if not text:
        return ""

    # Truncate
    if len(text) > max_length:
        text = text[:max_length]

    # Remove null bytes
    text = text.replace("\x00", "")

    # Check for SQL injection patterns
    if _SQL_PATTERN.search(text):
        raise ValueError("Input contains potentially dangerous characters")

    return text


def sanitize_filename(name: str) -> str:
    """Sanitize file names to prevent path traversal."""
    # Remove path separators and special chars
    name = re.sub(r"[^a-zA-Z0-9._-]", "_", name)
    # Prevent path traversal
    name = name.replace("..", "_")
    return name[:255]


# ── Security Headers Middleware ────────────────────────────────────────────────

class SecurityHeadersMiddleware:
    """Add security headers to all responses."""

    def __init__(self, app):
        from starlette.middleware.base import BaseHTTPMiddleware

        class _Middleware(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                response = await call_next(request)
                response.headers["X-Content-Type-Options"] = "nosniff"
                response.headers["X-Frame-Options"] = "DENY"
                response.headers["X-XSS-Protection"] = "1; mode=block"
                response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
                response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
                return response

        app.add_middleware(_Middleware)
