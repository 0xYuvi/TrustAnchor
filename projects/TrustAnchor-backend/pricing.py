"""
Dynamic pricing logic for TrustAnchor Issuer Agent.

Pricing tiers:
- boolean: 0.1 ALGO (simple verification)
- zkp: 0.5 ALGO (zero-knowledge proof verification)
"""

from enum import Enum
from typing import Literal

MICROALGO = 1_000_000


class VerificationMode(str, Enum):
    BOOLEAN = "boolean"
    ZKP = "zkp"


PRICE_MAP: dict[VerificationMode, int] = {
    VerificationMode.BOOLEAN: int(0.1 * MICROALGO),  # 0.1 ALGO in microAlgos
    VerificationMode.ZKP: int(0.05 * MICROALGO),  # 0.05 ALGO in microAlgos
}


def get_price(mode: Literal["boolean", "zkp"]) -> int:
    """Get price in microAlgos for a given verification mode."""
    return PRICE_MAP[VerificationMode(mode)]


def get_price_algo(mode: Literal["boolean", "zkp"]) -> float:
    """Get price in ALGO for a given verification mode."""
    return get_price(mode) / MICROALGO


def format_price(mode: Literal["boolean", "zkp"]) -> str:
    """Format price as human-readable string."""
    return f"{get_price_algo(mode)} ALGO"
