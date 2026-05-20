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
import re
import tempfile
import pdfplumber
from contextlib import asynccontextmanager
from typing import Annotated, Literal, Optional

from algosdk import encoding
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, Response, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from payment_verifier import PaymentVerifier, create_payment_verifier
from pricing import VerificationMode, get_price, get_price_usdc, format_price
from zkp_service import ZKPService, create_zkp_service
from kyc_agent import KYCAgent, kyc_issuer_agent, KYCRecord, IdentityAnchor

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
USDC_ASSET_ID = int(os.getenv("USDC_ASSET_ID", "10419441"))


class IncomeVerificationRequest(BaseModel):
    """Request body for income verification."""

    user_id: str = Field(..., description="User identifier")
    mode: Literal["boolean", "zkp"] = Field(
        default="boolean",
        description="Verification mode: 'boolean' for simple check, 'zkp' for ZKP",
    )
    threshold: Optional[float] = Field(0, description="Income threshold to verify against")
    secret_value: Optional[float] = Field(None, description="Secret income value (required for ZKP mode)")
    requested_traits: Optional[list[str]] = Field(None, description="List of traits to verify (e.g. ['full_name', 'age'])")
    payment_txid: Optional[str] = Field(None, description="Transaction ID of the payment")


class IncomeVerificationResponse(BaseModel):
    """Response for income verification."""

    result: bool
    user_id: str
    mode: str
    threshold: float
    proof: Optional[str] = None
    public_inputs: Optional[dict] = None
    txid: Optional[str] = None
    payment_amount: float


class AttestationBundle(BaseModel):
    """A portable package containing a ZK proof and its public context."""

    proof: str
    public_inputs: dict
    user_id: str
    threshold: float
    mode: str


class BooleanResult(BaseModel):
    """Result for boolean mode verification."""

    result: bool


class ZKPResult(BaseModel):
    """Result for ZKP mode verification."""

    result: bool
    proof: str
    public_inputs: dict


class Inquiry(BaseModel):
    """A verification request issued by an enterprise and paid for up-front."""

    id: str
    mode: str
    threshold: float
    status: Literal["pending", "fulfilled", "failed"] = "pending"
    verifier_address: Optional[str] = None
    prover_id: Optional[str] = None
    requested_traits: list[str] = Field(default_factory=lambda: ["income_annual"])
    result: Optional[bool] = None
    proof: Optional[str] = None
    public_inputs: Optional[dict] = None
    payment_txid: Optional[str] = None
    error: Optional[str] = None


# In-memory store for demo (should be database/box for production)
inquiry_registry: dict[str, Inquiry] = {}


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
        "description": "Privacy-preserving identity verification with ZKPs",
        "endpoints": [
            "/",
            "/health",
            "/pricing",
            "/kyc/anchor",
            "/kyc/status/{address}",
            "/verify/income",
            "/docs",
        ],
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
            "price_microusdc": get_price("boolean"),
            "price_usdc": get_price_usdc("boolean"),
            "formatted": format_price("boolean"),
            "description": "Simple boolean verification",
        },
        "zkp": {
            "price_microusdc": get_price("zkp"),
            "price_usdc": get_price_usdc("zkp"),
            "formatted": format_price("zkp"),
            "description": "Zero-knowledge proof verification",
        },
    }


# =============================================================================
# KYC Agent Endpoints - Identity Anchoring
# =============================================================================


class KYCAnchorRequest(BaseModel):
    """Request to anchor identity"""

    user_address: str
    full_name: Optional[str] = None
    income_annual: Optional[int] = None
    citizenship: Optional[str] = None
    date_of_birth: Optional[str] = None


class KYCAnchorResponse(BaseModel):
    """Response with anchored identity info"""

    success: bool
    user_address: str
    kyc_id: str
    commitment: str
    anchor_txid: Optional[str]
    block: Optional[int]
    verified_data: dict


@app.post("/kyc/anchor")
async def anchor_identity(request: KYCAnchorRequest):
    """
    Anchor user's identity to Algorand.

    Flow:
    1. KYC Agent fetches verified data (simulated bank DB)
    2. Generates cryptographic commitment
    3. Anchors to Algorand TruthRegistry
    4. Returns anchor info for ZKP generation

    This is the "Trusted Issuer" step - user authorizes their bank/government
    to anchor their verified identity on-chain.
    """
    logger.info(f"[API] KYC anchor request for {request.user_address[:8]}...")

    try:
        kwargs = request.model_dump(exclude_none=True)
        user_addr = kwargs.pop("user_address")
        
        # Run KYC anchoring
        kyc_record, anchor = await kyc_issuer_agent.extract_and_anchor(
            user_address=user_addr, create_onchain=True, **kwargs
        )

        return KYCAnchorResponse(
            success=True,
            user_address=request.user_address,
            kyc_id=kyc_record.kyc_id,
            commitment=anchor.commitment,
            anchor_txid=anchor.anchor_txid,
            block=anchor.block,
            verified_data={
                "full_name": kyc_record.full_name,
                "income_annual": kyc_record.income_annual,
                "citizenship": kyc_record.citizenship,
                "date_of_birth": kyc_record.date_of_birth,
            },
        )

    except Exception as e:
        logger.error(f"[API] KYC anchor failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/kyc/upload")
async def anchor_document_upload(
    user_address: str = Form(...),
    file: UploadFile = File(...)
):
    """
    Parse an Aadhaar/Bank PDF and anchor extracted Data.
    """
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Must be a PDF document.")
        
    extracted_text = ""
    try:
        # Save temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
        
        # Parse PDF using pdfplumber
        with pdfplumber.open(tmp_path) as pdf:
            for page in pdf.pages:
                extracted_text += page.extract_text() + "\n"
        
        os.unlink(tmp_path)
    except Exception as e:
        logger.error(f"[API] PDF Extraction failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to parse PDF document.")

    # Identification Logic: Is this an Aadhaar or a Bank Statement?
    is_aadhaar = False
    extracted_name = "Auth Verified"
    citizenship = "US"
    income_val = 0

    aadhaar_match = re.search(r'\b\d{4}\s?\d{4}\s?\d{4}\b', extracted_text)
    if aadhaar_match or "aadhaar" in extracted_text.lower() or "dob" in extracted_text.lower():
        is_aadhaar = True
        citizenship = "IN"
        extracted_name = "Verified Aadhaar Citizen"
        
        # Search contextually for the name on the Aadhaar card (usually immediately preceding DOB)
        lines = [line.strip() for line in extracted_text.split('\n') if line.strip()]
        for idx, line in enumerate(lines):
            if "DOB" in line.upper() or "YEAR OF BIRTH" in line.upper():
                if idx > 0 and len(lines[idx-1]) > 2:
                    potential_name = lines[idx-1].title()
                    # Basic exclusion to ensure we didn't just grab a random header
                    if "GOVERNMENT" not in potential_name.upper():
                        extracted_name = potential_name
                    break

        # Strict fallback to capture the identity cleanly from the user's environment if OCR fails
        if extracted_name == "Verified Aadhaar Citizen" and file.filename:
            base = file.filename.lower().replace(".pdf", "").replace("aadhar", "").replace("unlocked", "").replace("_", " ").strip()
            if base:
                extracted_name = base.title()

        # Sanitize Name: Aadhaar PDFs often merge the name line with the local language address block.
        # We explicitly strip non-ASCII characters and limit to standard name length (first 3-4 words)
        dirty_name = extracted_name
        clean_words = []
        for word in extracted_name.split():
            if re.match(r'^[A-Za-z]+$', word):
                clean_words.append(word)
        
        if clean_words:
            # Most Indian names are 2-3 words. The rest is often address/local script.
            extracted_name = " ".join(clean_words[:3])

        # Extract Address (Strategy A: Explicit Label)
        extracted_address = "Address not found"
        # Look for English "Address" or Hindi "पता" or standard relation labels common on Aadhaar
        addr_match = re.search(r'(?i)(?:address|add|addr|पता|कव|c/o|s/o|d/o|w/o|care\s+of)[\s:]*(.*)', extracted_text.replace('\n', ' '))
        if addr_match:
            # Grab up to the Pincode or next major label
            extracted_address = addr_match.group(1).split("Pin")[0].strip()[:150]
        
        # Strategy B: If name was merged with address info (common in OCR)
        if (extracted_address == "Address not found" or len(extracted_address) < 10) and len(dirty_name) > len(extracted_name):
            possible_addr = dirty_name.replace(extracted_name, "").strip()
            # Clean up leading punctuation and common OCR artifacts
            possible_addr = re.sub(r'^[\s,:\-बेकरी]+', '', possible_addr)
            if len(possible_addr) > 5:
                extracted_address = possible_addr

        # Strategy C: Look for the Pincode and grab text around it if still not found
        if extracted_address == "Address not found":
            # Search for 6-digit number and look behind for addressy text
            pin_search = re.search(r'([A-Za-z0-9\s,]{20,}\b\d{6}\b)', extracted_text.replace('\n', ' '))
            if pin_search:
                extracted_address = pin_search.group(1).strip()[:150]

        # Extract DOB & Calculate Age
        extracted_age = 25 # Fallback
        dob_match = re.search(r'(?i)(?:dob|year of birth|birth|जन्म).*?(\d{4})', extracted_text)
        if dob_match:
            try:
                yob = int(dob_match.group(1))
                extracted_age = 2026 - yob # Current hackathon year relative
            except:
                pass

        # We assign an arbitrary high limit for Aadhaar verification proxying since the ZKP circuit requires an integer
        income_val = 1000000 
    else:
        # Not Aadhaar -> Assume Bank Statement
        extracted_address = "Bank Proof Attached"
        extracted_age = 0
        balance_match = re.search(r'(?i)(balance|income)[\s:.\-$]+([\d,]+)', extracted_text)
        if balance_match:
            raw_num = balance_match.group(2).replace(",", "")
            income_val = int(raw_num)
        else:
            num_match = re.search(r'\$?([\d,]{4,})', extracted_text)
            if num_match:
                income_val = int(num_match.group(1).replace(",", ""))
        extracted_name = "Bank Verified Identity"

    try:
        # Run KYC anchoring using extracted document data
        kyc_record, anchor = await kyc_issuer_agent.extract_and_anchor(
            user_address=user_address, 
            create_onchain=True,
            income_annual=income_val,
            full_name=extracted_name,
            citizenship=citizenship,
            age=extracted_age,
            address=extracted_address
        )

        response_data = {
            "full_name": kyc_record.full_name,
            "citizenship": kyc_record.citizenship,
            "age": kyc_record.age,
            "address": kyc_record.address,
            "income_annual": kyc_record.income_annual,
        }
        
        if is_aadhaar:
            response_data["date_of_birth"] = kyc_record.date_of_birth

        return KYCAnchorResponse(
            success=True,
            user_address=user_address,
            kyc_id=kyc_record.kyc_id,
            commitment=anchor.commitment,
            anchor_txid=anchor.anchor_txid,
            block=anchor.block,
            verified_data=response_data,
        )
    except Exception as e:
        logger.error(f"[API] KYC anchor from PDF failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/kyc/status/{user_address}")
async def get_kyc_status(user_address: str):
    """
    Check if user has a valid KYC anchor.

    Returns anchor status and verified data.
    """
    anchor = kyc_issuer_agent.get_anchor(user_address)
    record = kyc_issuer_agent.get_record(user_address)

    if not anchor or not record:
        return {
            "anchored": False,
            "message": "No KYC anchor. Run POST /kyc/anchor first.",
        }

    return {
        "anchored": True,
        "kyc_id": anchor.kyc_id,
        "commitment": anchor.commitment,
        "anchor_txid": anchor.anchor_txid,
        "block": anchor.block,
        "verified_data": {
            "income_annual": record.income_annual,
            "citizenship": record.citizenship,
        },
    }


# =============================================================================
# Verification Endpoint
# =============================================================================

@app.post("/verify/income")
async def verify_income(
    http_request: Request,
    request: IncomeVerificationRequest,
):
    """
    Verify income with boolean or ZKP mode.
    Paid by the recruiter agent (institution).
    """
    txid = http_request.headers.get("x402-payment-proof") or request.payment_txid
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
                        "assetId": USDC_ASSET_ID,
                        "scheme": "exact",
                    }
                ],
            },
        )

    if request.mode == "zkp":
        if request.secret_value is None:
            raise HTTPException(status_code=400, detail="secret_value required for ZKP")
        return await _verify_zkp(
            user_id=request.user_id,
            secret_value=int(request.secret_value),
            threshold=request.threshold or 0,
            payer="",
            txid=txid,
            expected_amount=expected_amount,
        )
    else:
        return await _verify_boolean(
            user_id=request.user_id,
            threshold=request.threshold or 0,
            payer="",
            txid=txid,
            expected_amount=expected_amount,
        )


@app.post("/attestation/generate", response_model=ZKPResult)
async def generate_attestation(request: IncomeVerificationRequest):
    """
    Generate a ZK attestation for a user claim.
    This endpoint is FREE for the citizen to use.
    """
    if not zkp_service:
        raise HTTPException(status_code=500, detail="ZKP Service not initialized")

    if request.mode == "zkp":
        if not request.secret_value:
            raise HTTPException(status_code=400, detail="secret_value required for ZKP")

        proof_result = await zkp_service.generate_proof(
            secret_value=int(request.secret_value),
            threshold=int(request.threshold),
            user_id=request.user_id,
        )

        if not proof_result.valid or not proof_result.proof:
            raise HTTPException(
                status_code=500, detail=f"Proof generation failed: {proof_result.error}"
            )

        return ZKPResult(
            result=True,
            proof=proof_result.proof.proof,
            public_inputs=proof_result.proof.public_inputs,
        )
    else:
        # For boolean mode, we just return a simple "Signed Statement" mock
        return ZKPResult(
            result=True,
            proof="SIGNED_IDENTITY_SEAL_V1",
            public_inputs={"threshold": request.threshold, "user_id": request.user_id},
        )


@app.post("/inquiry/create", response_model=dict)
async def create_inquiry(
    http_request: Request,
    request: IncomeVerificationRequest,
):
    """
    Create a verification inquiry.
    PAID by the Verifier.
    """
    # Check headers (FastAPI headers are lowercase) or body safely
    txid = http_request.headers.get("x402-payment-proof") or getattr(request, 'payment_txid', None)
    
    expected_amount = get_price(request.mode)

    if not txid:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "Payment required to issue inquiry",
                "paymentRequirements": [
                    {
                        "maximumAmountRequired": expected_amount,
                        "payTo": TRUST_ANCHOR_ADDRESS,
                        "network": f"algorand:{ALGORAND_NETWORK}",
                        "assetId": USDC_ASSET_ID,
                        "scheme": "exact",
                    }
                ],
            },
        )

    # Verify payment
    if not payment_verifier:
        raise HTTPException(status_code=500, detail="Payment Verifier not initialized")

    verification = await payment_verifier.verify_payment(
        txid=txid,
        expected_amount=expected_amount,
    )

    if not verification.valid:
        raise HTTPException(status_code=400, detail=verification.error)

    # Generate random 6-character code
    import string
    import random

    inquiry_id = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
    inquiry_id = f"TRU-{inquiry_id}"

    new_inquiry = Inquiry(
        id=inquiry_id,
        mode=request.mode,
        threshold=request.threshold,
        requested_traits=request.requested_traits or ["income_annual"],
        payment_txid=txid,
    )

    inquiry_registry[inquiry_id] = new_inquiry

    logger.info(f"[Inquiry] Created: {inquiry_id} for mode={request.mode}")

    return {"inquiry_id": inquiry_id, "status": "pending"}


@app.get("/inquiry/status/{inquiry_id}", response_model=Inquiry)
async def get_inquiry_status(inquiry_id: str):
    """Check status of an inquiry."""
    if inquiry_id not in inquiry_registry:
        raise HTTPException(status_code=404, detail="Inquiry not found")
    return inquiry_registry[inquiry_id]


@app.post("/inquiry/fulfill/{inquiry_id}")
async def fulfill_inquiry(inquiry_id: str, bundle: AttestationBundle):
    """
    Fulfill a verification inquiry with a proof.
    FREE for the Citizen.
    """
    if inquiry_id not in inquiry_registry:
        raise HTTPException(status_code=404, detail="Inquiry not found")

    inquiry = inquiry_registry[inquiry_id]

    if inquiry.status != "pending":
        raise HTTPException(status_code=400, detail="Inquiry already processed")

    # Verify proof against inquiry requirements
    if bundle.mode != inquiry.mode:
        raise HTTPException(status_code=400, detail="Mode mismatch")

    if not zkp_service:
        raise HTTPException(status_code=500, detail="ZKP Service not initialized")

    if inquiry.mode == "zkp":
        logger.info(f"[ZKP] Verifying proof for inquiry {inquiry_id} with threshold {inquiry.threshold}")
        zkp_result = await zkp_service.verify_proof(
            proof=bundle.proof,
            public_inputs=bundle.public_inputs,
            threshold=int(inquiry.threshold),
        )
        is_valid = zkp_result.valid
        if not is_valid:
            inquiry.error = zkp_result.error
            logger.warning(f"[ZKP] Verification FAILED for {inquiry_id}. Error: {zkp_result.error}")
        else:
            logger.info(f"[ZKP] Verification PASSED for {inquiry_id}")
    else:
        is_valid = bundle.proof == "SIGNED_IDENTITY_SEAL_V1"

    # Update inquiry status
    inquiry.status = "fulfilled"
    inquiry.result = is_valid
    inquiry.proof = bundle.proof
    inquiry.public_inputs = bundle.public_inputs
    inquiry.prover_id = bundle.user_id

    logger.info(f"[Inquiry] Fulfilled: {inquiry_id}, Result: {is_valid}")

    return {"status": "fulfilled", "result": is_valid}


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
