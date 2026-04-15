"""
TrustAnchor Issuer Agent - FastAPI Service with x402 Payment Integration.

Endpoints:
- POST /verify/income - Verify income with boolean or ZKP mode
- GET /health - Health check

Dynamic Pricing:
- boolean: 0.1 ALGO
- zkp: 0.5 ALGO
"""

import logging
import os
from contextlib import asynccontextmanager
from typing import Annotated, Literal, Optional

from algosdk import encoding
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from payment_verifier import PaymentVerifier, create_payment_verifier
from pricing import VerificationMode, get_price, get_price_algo
from zkp_service import ZKPService, create_zkp_service

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


TRUST_ANCHOR_ADDRESS = os.getenv("TRUST_ANCHOR_ADDRESS")
if not TRUST_ANCHOR_ADDRESS:
    raise ValueError("TRUST_ANCHOR_ADDRESS environment variable is required")

ALGORAND_NETWORK = os.getenv("ALGORAND_NETWORK", "testnet")
ALGORAND_INDEXER_URL = os.getenv(
    "ALGORAND_INDEXER_URL",
    "https://testnet-idx.algonode.cloud"
    if ALGORAND_NETWORK == "testnet"
    else "https://mainnet-idx.algonode.cloud",
)

FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")


class IncomeVerificationRequest(BaseModel):
    """Request body for income verification."""

    user_id: str = Field(..., description="User identifier")
    mode: Literal["boolean", "zkp"] = Field(
        default="boolean",
        description="Verification mode: 'boolean' for simple check, 'zkp' for ZKP",
    )
    threshold: float = Field(..., description="Income threshold to verify against")
    secret_value: Optional[int] = Field(
        None,
        description="Secret income value (required for ZKP mode)",
    )


class IncomeVerificationResponse(BaseModel):
    """Response for income verification."""

    result: bool
    user_id: str
    mode: str
    threshold: float
    proof: Optional[dict] = None
    txid: Optional[str] = None
    payment_amount: float


class BooleanResult(BaseModel):
    """Result for boolean mode verification."""

    result: bool


class ZKPResult(BaseModel):
    """Result for ZKP mode verification."""

    result: bool
    proof: dict
    public_inputs: dict


payment_verifier: Optional[PaymentVerifier] = None
zkp_service: Optional[ZKPService] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle."""
    global payment_verifier, zkp_service

    payment_verifier = create_payment_verifier()
    zkp_service = create_zkp_service()

    logger.info("TrustAnchor Issuer Agent started")
    logger.info(f"Receiver address: {TRUST_ANCHOR_ADDRESS}")
    logger.info(f"Indexer URL: {ALGORAND_INDEXER_URL}")
    logger.info(f"Facilitator URL: {FACILITATOR_URL}")

    yield

    if payment_verifier:
        await payment_verifier.close()
    if zkp_service:
        await zkp_service.close()

    logger.info("TrustAnchor Issuer Agent stopped")


app = FastAPI(
    title="TrustAnchor Issuer Agent",
    description="Income verification service with x402 payment integration",
    version="1.0.0",
    lifespan=lifespan,
)

from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X402-Payment-Required"],
)

# Note: x402 middleware simplified for demo - no payment middleware added


@app.get("/")
async def root():
    """Root endpoint with API info."""
    return {
        "service": "TrustAnchor Issuer Agent",
        "version": "1.0.0",
        "endpoints": ["/", "/health", "/pricing", "/verify/income", "/docs"],
    }


@app.get("/health")
async def health_check():
    """Health check endpoint (no payment required)."""
    return {
        "status": "ok",
        "service": "TrustAnchor Issuer Agent",
        "version": "1.0.0",
    }


@app.get("/pricing")
async def get_pricing():
    """Get current pricing for verification modes."""
    return {
        "boolean": {
            "price_microalgo": get_price("boolean"),
            "price_algo": get_price_algo("boolean"),
            "description": "Simple boolean verification",
        },
        "zkp": {
            "price_microalgo": get_price("zkp"),
            "price_algo": get_price_algo("zkp"),
            "description": "Zero-knowledge proof verification",
        },
    }


@app.post("/verify/income")
async def verify_income(
    request: IncomeVerificationRequest,
    http_request: Request,
):
    """
    Verify income threshold using boolean or ZKP mode.

    Requires x402 payment. The payment amount depends on the verification mode:
    For ZKP mode, provide secret_value which will be proven to be greater than threshold.
    """
    txid = http_request.headers.get("x402-payment-proof") or http_request.headers.get("X402-Payment-Proof")
    expected_amount = get_price(request.mode)

    if not txid:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "Payment required",
                "paymentRequirements": [
                    {
                        "maximumAmountRequired": expected_amount,
                        "payTo": TRUST_ANCHOR_ADDRESS,
                        "network": f"algorand:{ALGORAND_NETWORK}",
                    }
                ]
            },
        )

    payer_address = "wallet_user"

    logger.info(
        f"Income verification request: user={request.user_id}, "
        f"mode={request.mode}, threshold={request.threshold}, "
        f"payer={payer_address}, txid={txid}"
    )

    if request.mode == VerificationMode.BOOLEAN:
        return await _verify_boolean(
            request.user_id,
            request.threshold,
            payer_address,
            txid,
            expected_amount,
        )

    elif request.mode == VerificationMode.ZKP:
        if not request.secret_value:
            raise HTTPException(
                status_code=400,
                detail="secret_value required for ZKP mode",
            )
        return await _verify_zkp(
            request.user_id,
            request.secret_value,
            request.threshold,
            payer_address,
            txid,
            expected_amount,
        )

    raise HTTPException(
        status_code=400,
        detail=f"Invalid mode: {request.mode}",
    )


async def _verify_boolean(
    user_id: str,
    threshold: float,
    payer: str,
    txid: str,
    expected_amount: int,
) -> JSONResponse:
    """Handle boolean mode verification."""

    if not payment_verifier:
        raise HTTPException(status_code=500, detail="Payment verifier not initialized")

    verification = await payment_verifier.verify_payment(
        txid=txid,
        expected_amount=expected_amount,
    )

    if not verification.valid:
        raise HTTPException(
            status_code=400,
            detail=verification.error,
        )

    secret_value = 100000

    result = secret_value > threshold

    logger.info(
        f"Boolean verification complete: user={user_id}, "
        f"threshold={threshold}, result={result}"
    )

    return JSONResponse(
        status_code=200,
        content={
            "result": result,
            "user_id": user_id,
            "mode": "boolean",
            "threshold": threshold,
            "txid": txid,
            "payment_amount": expected_amount / 1_000_000,
        },
    )


async def _verify_zkp(
    user_id: str,
    secret_value: int,
    threshold: float,
    payer: str,
    txid: str,
    expected_amount: int,
) -> JSONResponse:
    """Handle ZKP mode verification."""

    if not payment_verifier or not zkp_service:
        raise HTTPException(status_code=500, detail="Services not initialized")

    verification = await payment_verifier.verify_payment(
        txid=txid,
        expected_amount=expected_amount,
    )

    if not verification.valid:
        raise HTTPException(
            status_code=400,
            detail=verification.error,
        )

    proof_result = await zkp_service.generate_proof(
        secret_value=secret_value,
        threshold=int(threshold),
        user_id=user_id,
    )

    if not proof_result.valid or not proof_result.proof:
        raise HTTPException(
            status_code=500,
            detail=f"ZKP generation failed: {proof_result.error}",
        )

    zkp_result = await zkp_service.verify_proof(
        proof=proof_result.proof.proof,
        public_inputs=proof_result.proof.public_inputs,
        threshold=int(threshold),
    )

    logger.info(
        f"ZKP verification complete: user={user_id}, "
        f"threshold={threshold}, result={zkp_result.valid}"
    )

    return JSONResponse(
        status_code=200,
        content={
            "result": zkp_result.valid,
            "user_id": user_id,
            "mode": "zkp",
            "threshold": threshold,
            "proof": {
                "proof": proof_result.proof.proof,
                "public_inputs": proof_result.proof.public_inputs,
            },
            "txid": txid,
            "payment_amount": expected_amount / 1_000_000,
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
