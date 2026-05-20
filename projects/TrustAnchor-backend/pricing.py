"""
Dynamic pricing logic for TrustAnchor Issuer Agent.

All pricing in USDC only.
1 USDC = 1,000,000 microUSDC

Pricing tiers:
- boolean: $0.01 USDC (simple verification)
- zkp: $0.10 USDC (zero-knowledge proof verification)
- subscription_monthly: $10 USDC (1,000 verifications/month)
- onboarding_fee: $2 USDC (register institution on IdentityRegistry)
"""

from enum import Enum
from typing import Literal, Optional

USDC_DECIMALS = 1_000_000


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

SUBSCRIPTION_MONTHLY_COST = PricingTier.SUBSCRIPTION_MONTHLY
SUBSCRIPTION_MONTHLY_QUOTA = 1_000  # 1,000 verifications/month

ONBOARDING_FEE = PricingTier.ONBOARDING_FEE

USDC_MAINNET_ASSET_ID = 31566704
USDC_TESTNET_ASSET_ID = 10458941


def get_price(mode: Literal["boolean", "zkp"]) -> int:
    """Get price in microUSDC for a given verification mode."""
    return PRICE_MAP[VerificationMode(mode)]


def get_price_usdc(mode: Literal["boolean", "zkp"]) -> float:
    """Get price in USDC for a given verification mode."""
    return get_price(mode) / USDC_DECIMALS


def format_price(mode: Literal["boolean", "zkp"]) -> str:
    """Format price as human-readable string."""
    return f"${get_price_usdc(mode):.2f} USDC"


def format_subscription_price() -> str:
    """Format subscription price."""
    return f"${SUBSCRIPTION_MONTHLY_COST / USDC_DECIMALS:.2f} USDC/month"


def format_onboarding_fee() -> str:
    """Format onboarding fee."""
    return f"${ONBOARDING_FEE / USDC_DECIMALS:.2f} USDC"


class SubscriptionTracker:
    """Tracks monthly verification quotas for institutions."""

    def __init__(self):
        self._quotas: dict[str, int] = {}

    def set_quota(self, institution_id: str, quota: int = SUBSCRIPTION_MONTHLY_QUOTA):
        self._quotas[institution_id] = quota

    def consume(self, institution_id: str) -> bool:
        if institution_id not in self._quotas:
            return False
        if self._quotas[institution_id] <= 0:
            return False
        self._quotas[institution_id] -= 1
        return True

    def remaining(self, institution_id: str) -> int:
        return self._quotas.get(institution_id, 0)

    def reset_all(self, quota: int = SUBSCRIPTION_MONTHLY_QUOTA):
        for k in self._quotas:
            self._quotas[k] = quota
