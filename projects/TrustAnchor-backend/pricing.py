"""
USDC pricing logic for TrustAnchor Issuer Agent.

Pricing tiers in microUSDC (1 USDC = 1,000,000 microUSDC):
- boolean: $0.01 (10,000 microUSDC)
- zkp: $0.10 (100,000 microUSDC)
- subscription: $10.00 (10,000,000 microUSDC)
- onboarding: $2.00 (2,000,000 microUSDC)
"""

from enum import Enum
from typing import Literal

MICROUSDC = 1_000_000


class VerificationMode(str, Enum):
    BOOLEAN = "boolean"
    ZKP = "zkp"


class PricingTier(int, Enum):
    BOOLEAN_COST = 10_000          # $0.01
    ZKP_COST = 100_000            # $0.10
    SUBSCRIPTION_MONTHLY = 10_000_000  # $10.00
    ONBOARDING_FEE = 2_000_000    # $2.00


PRICE_MAP: dict[VerificationMode, int] = {
    VerificationMode.BOOLEAN: PricingTier.BOOLEAN_COST,
    VerificationMode.ZKP: PricingTier.ZKP_COST,
}


def get_price(mode: Literal["boolean", "zkp"]) -> int:
    """Get price in microUSDC for a given verification mode."""
    return PRICE_MAP[VerificationMode(mode)]


def get_price_usdc(mode: Literal["boolean", "zkp"]) -> float:
    """Get price in USDC for a given verification mode."""
    return get_price(mode) / MICROUSDC


def format_price(mode: Literal["boolean", "zkp"]) -> str:
    """Format price as human-readable string."""
    return f"${get_price_usdc(mode):.2f} USDC"

