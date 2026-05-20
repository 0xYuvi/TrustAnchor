"""
TrustAnchor Issuer Agent - FastAPI Service with x402 Payment Integration.

All pricing in USDC only.
Institutions pay for verification — end users verify for free.

Flow:
1. Institution registers → receives API key, pays $2 USDC onboarding
2. Institution requests verification of user X → pays $0.01/$0.10 USDC
3. User approves request → ZKP generated from anchored data
4. Result stored on TruthRegistry
5. Institution reads: is_proof_verified(proof_id)
"""

import hashlib
import logging
import os
import re
import secrets
import string
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated, Literal, Optional

import pdfplumber
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from payment_verifier import PaymentVerifier, create_payment_verifier
from pricing import (
    VerificationMode,
    get_price,
    get_price_usdc,
    format_price,
    format_onboarding_fee,
    format_subscription_price,
    ONBOARDING_FEE,
    SUBSCRIPTION_MONTHLY_COST,
    USDC_MAINNET_ASSET_ID,
    USDC_TESTNET_ASSET_ID,
    SubscriptionTracker,
)
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

USDC_ASSET_ID = int(os.getenv("USDC_ASSET_ID", str(
    USDC_TESTNET_ASSET_ID if ALGORAND_NETWORK == "testnet" else USDC_MAINNET_ASSET_ID
)))

FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")


# =============================================================================
# Institution Auth
# =============================================================================

security = HTTPBearer(auto_error=False)

institution_store: dict[str, dict] = {}
subscription_tracker = SubscriptionTracker()


def _generate_api_key() -> str:
    return f"ta_{secrets.token_hex(32)}"


async def get_current_institution(
    credentials: Annotated[Optional[HTTPAuthorizationCredentials], Depends(security)],
) -> Optional[str]:
    if credentials is None:
        return None
    for inst_id, data in institution_store.items():
        if data["api_key"] == credentials.credentials:
            return inst_id
    return None


async def require_institution(
    credentials: Annotated[Optional[HTTPAuthorizationCredentials], Depends(security)],
) -> str:
    inst_id = await get_current_institution(credentials)
    if not inst_id:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return inst_id


# =============================================================================
# Models
# =============================================================================


class InstitutionRegisterRequest(BaseModel):
    name: str = Field(..., description="Institution name")
    institution_type: str = Field(..., description="Type: bank, employer, defi_protocol, exchange, lender, government, kyc_provider, other")
    required_traits: list[str] = Field(..., description="What the institution needs from the prover. Options: full_name, income_annual, citizenship, date_of_birth, address, employment_status, credit_score, phone_number")
    address: str = Field(..., description="Algorand address for USDC payments")
    email: Optional[str] = None
    onboarding_txid: Optional[str] = Field(None, description="USDC transfer txid for onboarding fee ($2)")


class InstitutionRegisterResponse(BaseModel):
    institution_id: str
    api_key: str
    name: str
    institution_type: str
    required_traits: list[str]
    address: str
    quota: int
    message: str


class IncomeVerificationRequest(BaseModel):
    request_id: Optional[str] = Field(None, description="Prepaid request ID from institution")
    user_id: str = Field(..., description="User identifier")
    mode: Literal["boolean", "zkp"] = Field(default="boolean")
    threshold: Optional[float] = Field(0, description="Income threshold")
    secret_value: Optional[float] = Field(None, description="Secret income value (ZKP mode)")


class VerifyRequestCreate(BaseModel):
    user_id: str = Field(..., description="Target user to verify")
    mode: Literal["boolean", "zkp"] = Field(default="boolean")
    threshold: float = Field(..., description="Income threshold to check")
    required_traits: Optional[list[str]] = Field(None, description="Traits requested from the prover. Defaults to institution's registered required_traits.")


class VerifyRequestResponse(BaseModel):
    request_id: str
    user_id: str
    institution_name: str
    institution_type: str
    required_traits: list[str]
    mode: str
    threshold: float
    status: str
    payment_required: dict


class VerifyApproveRequest(BaseModel):
    secret_value: Optional[float] = Field(None, description="Required for ZKP mode")


class AttestationBundle(BaseModel):
    proof: str
    public_inputs: dict
    user_id: str
    threshold: float
    mode: str


class BooleanResult(BaseModel):
    result: bool


class ZKPResult(BaseModel):
    result: bool
    proof: str
    public_inputs: dict


class KYCAnchorRequest(BaseModel):
    user_address: str
    full_name: Optional[str] = None
    income_annual: Optional[int] = None
    citizenship: Optional[str] = None
    date_of_birth: Optional[str] = None


class KYCAnchorResponse(BaseModel):
    success: bool
    user_address: str
    kyc_id: str
    commitment: str
    anchor_txid: Optional[str]
    block: Optional[int]
    verified_data: dict


# =============================================================================
# In-Memory Stores
# =============================================================================

verification_requests: dict[str, dict] = {}
inquiry_registry: dict[str, dict] = {}

payment_verifier: Optional[PaymentVerifier] = None
zkp_service: Optional[ZKPService] = None


# =============================================================================
# Lifespan
# =============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    global payment_verifier, zkp_service
    payment_verifier = create_payment_verifier()
    zkp_service = create_zkp_service()
    logger.info("TrustAnchor Issuer Agent started")
    logger.info(f"Receiver address: {TRUST_ANCHOR_ADDRESS}")
    logger.info(f"USDC Asset ID: {USDC_ASSET_ID}")
    yield
    if payment_verifier:
        await payment_verifier.close()
    if zkp_service:
        await zkp_service.close()


app = FastAPI(
    title="TrustAnchor Issuer Agent",
    description="Privacy-preserving identity verification — institutions pay, users verify for free",
    version="2.0.0",
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


# =============================================================================
# Root & Health
# =============================================================================


@app.get("/")
async def root():
    return {
        "service": "TrustAnchor Issuer Agent",
        "version": "2.0.0",
        "description": "Privacy-preserving identity verification with ZKPs",
        "pricing": {
            "boolean": format_price("boolean"),
            "zkp": format_price("zkp"),
            "subscription_monthly": format_subscription_price(),
            "onboarding_fee": format_onboarding_fee(),
        },
        "endpoints": [
            "/",
            "/health",
            "/pricing",
            "/institutions/register",
            "/kyc/anchor",
            "/kyc/status/{address}",
            "/verify/request",
            "/verify/requests",
            "/verify/approve/{request_id}",
            "/verify/income",
            "/docs",
        ],
    }


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "TrustAnchor Issuer Agent",
        "version": "2.0.0",
    }


@app.get("/pricing")
async def get_pricing():
    return {
        "boolean": {
            "price_usdc": get_price_usdc("boolean"),
            "price_microusdc": get_price("boolean"),
            "description": "Simple boolean threshold check",
        },
        "zkp": {
            "price_usdc": get_price_usdc("zkp"),
            "price_microusdc": get_price("zkp"),
            "description": "Zero-knowledge proof verification",
        },
        "subscription_monthly": {
            "price_usdc": SUBSCRIPTION_MONTHLY_COST / 1_000_000,
            "price_microusdc": SUBSCRIPTION_MONTHLY_COST,
            "quota": 1000,
            "description": "1,000 verifications per month",
        },
        "onboarding": {
            "price_usdc": ONBOARDING_FEE / 1_000_000,
            "price_microusdc": ONBOARDING_FEE,
            "description": "One-time institution registration fee",
        },
        "currency": "USDC",
        "asset_id": USDC_ASSET_ID,
        "network": ALGORAND_NETWORK,
    }


# =============================================================================
# Institution Endpoints
# =============================================================================


@app.post("/institutions/register", response_model=InstitutionRegisterResponse)
async def register_institution(request: InstitutionRegisterRequest):
    """
    Register a new institution.

    Institution pays $2 USDC onboarding fee (one-time).
    Receives API key for subsequent requests.
    """
    if not request.onboarding_txid:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "Onboarding fee required",
                "paymentRequirements": [
                    {
                        "scheme": "exact",
                        "assetId": USDC_ASSET_ID,
                        "amount": ONBOARDING_FEE,
                        "payTo": TRUST_ANCHOR_ADDRESS,
                        "network": f"algorand:{ALGORAND_NETWORK}",
                        "description": "TrustAnchor institution onboarding fee ($2 USDC)",
                    }
                ],
            },
        )

    if not payment_verifier:
        raise HTTPException(status_code=500, detail="Payment verifier not initialized")

    verification = await payment_verifier.verify_payment(
        txid=request.onboarding_txid,
        expected_amount=ONBOARDING_FEE,
        expected_asset_id=USDC_ASSET_ID,
    )
    if not verification.valid:
        raise HTTPException(status_code=400, detail=verification.error)

    institution_id = f"inst_{uuid.uuid4().hex[:12]}"
    api_key = _generate_api_key()

    institution_store[institution_id] = {
        "name": request.name,
        "institution_type": request.institution_type,
        "required_traits": request.required_traits,
        "address": request.address,
        "email": request.email,
        "api_key": api_key,
        "onboarding_txid": request.onboarding_txid,
        "registered_at": datetime.now().isoformat(),
        "tier": "free",
    }

    subscription_tracker.set_quota(institution_id)

    logger.info(f"[INST] Registered institution {institution_id}: {request.name}")

    return InstitutionRegisterResponse(
        institution_id=institution_id,
        api_key=api_key,
        name=request.name,
        institution_type=request.institution_type,
        required_traits=request.required_traits,
        address=request.address,
        quota=subscription_tracker.remaining(institution_id),
        message="Keep your API key secure. It will not be shown again.",
    )


@app.get("/institutions/me")
async def get_institution_info(
    institution_id: str = Depends(require_institution),
):
    data = institution_store.get(institution_id, {})
    return {
        "institution_id": institution_id,
        "name": data.get("name"),
        "institution_type": data.get("institution_type"),
        "required_traits": data.get("required_traits", []),
        "address": data.get("address"),
        "tier": data.get("tier"),
        "remaining_quota": subscription_tracker.remaining(institution_id),
        "registered_at": data.get("registered_at"),
    }


@app.post("/institutions/subscribe")
async def subscribe_monthly(
    payment_txid: str,
    institution_id: str = Depends(require_institution),
):
    """Upgrade to monthly subscription ($10 USDC, 1,000 verifications)."""
    if not payment_verifier:
        raise HTTPException(status_code=500, detail="Payment verifier not initialized")

    verification = await payment_verifier.verify_payment(
        txid=payment_txid,
        expected_amount=SUBSCRIPTION_MONTHLY_COST,
        expected_asset_id=USDC_ASSET_ID,
    )
    if not verification.valid:
        raise HTTPException(status_code=400, detail=verification.error)

    subscription_tracker.set_quota(institution_id)
    institution_store[institution_id]["tier"] = "subscription"

    return {
        "status": "active",
        "tier": "subscription",
        "quota": subscription_tracker.remaining(institution_id),
        "valid_until": "end of billing period",
    }


# =============================================================================
# Verification Request Flow — Institution initiates, User approves
# =============================================================================


@app.post("/verify/request", response_model=VerifyRequestResponse)
async def create_verification_request(
    request: VerifyRequestCreate,
    institution_id: str = Depends(require_institution),
):
    """
    Institution requests verification of a user.

    Institution must have quota remaining (pre-paid via onboarding or subscription).
    Returns request_id for the user to approve.
    """
    if not subscription_tracker.consume(institution_id):
        raise HTTPException(
            status_code=402,
            detail={
                "error": "No verification quota remaining",
                "paymentRequirements": [
                    {
                        "scheme": "exact",
                        "assetId": USDC_ASSET_ID,
                        "amount": get_price(request.mode),
                        "payTo": TRUST_ANCHOR_ADDRESS,
                        "network": f"algorand:{ALGORAND_NETWORK}",
                        "description": f"{request.mode} verification (${get_price_usdc(request.mode):.2f} USDC)",
                    }
                ],
            },
        )

    inst_data = institution_store.get(institution_id, {})
    inst_name = inst_data.get("name", "Unknown")
    inst_type = inst_data.get("institution_type", "other")
    inst_traits = inst_data.get("required_traits", [])
    traits = request.required_traits if request.required_traits is not None else inst_traits

    request_id = f"vr_{uuid.uuid4().hex[:16]}"

    verification_requests[request_id] = {
        "request_id": request_id,
        "institution_id": institution_id,
        "institution_name": inst_name,
        "institution_type": inst_type,
        "required_traits": traits,
        "user_id": request.user_id,
        "mode": request.mode,
        "threshold": request.threshold,
        "status": "pending",
        "created_at": datetime.now().isoformat(),
        "result": None,
        "proof": None,
    }

    logger.info(f"[VR] Created verification request {request_id}: "
                f"institution={institution_id[:12]}... user={request.user_id[:8]}...")

    return VerifyRequestResponse(
        request_id=request_id,
        user_id=request.user_id,
        institution_name=inst_name,
        institution_type=inst_type,
        required_traits=traits,
        mode=request.mode,
        threshold=request.threshold,
        status="pending",
        payment_required={
            "assetId": USDC_ASSET_ID,
            "amount": get_price(request.mode),
            "payTo": TRUST_ANCHOR_ADDRESS,
        },
    )


@app.get("/verify/requests")
async def list_verification_requests(
    user_address: Optional[str] = None,
    institution_id: str = Depends(require_institution),
):
    """List verification requests for this institution."""
    results = []
    for req in verification_requests.values():
        if req["institution_id"] == institution_id:
            if user_address and req["user_id"] != user_address:
                continue
            results.append({
                "request_id": req["request_id"],
                "user_id": req["user_id"],
                "institution_name": req.get("institution_name", "Unknown"),
                "institution_type": req.get("institution_type", "other"),
                "required_traits": req.get("required_traits", []),
                "mode": req["mode"],
                "threshold": req["threshold"],
                "status": req["status"],
                "created_at": req["created_at"],
                "result": req["result"],
            })
    return {"requests": results, "count": len(results)}


@app.get("/verify/requests/pending/{user_address}")
async def get_pending_requests_for_user(user_address: str):
    """Get all pending verification requests for a user (no auth needed)."""
    results = []
    for req in verification_requests.values():
        if req["user_id"] == user_address and req["status"] == "pending":
            results.append({
                "request_id": req["request_id"],
                "institution_name": req.get("institution_name", "Unknown"),
                "institution_type": req.get("institution_type", "other"),
                "required_traits": req.get("required_traits", []),
                "mode": req["mode"],
                "threshold": req["threshold"],
                "created_at": req["created_at"],
            })
    return {"requests": results, "count": len(results)}


@app.post("/verify/approve/{request_id}")
async def approve_verification(
    request_id: str,
    body: VerifyApproveRequest,
):
    """
    User approves a verification request.

    Once approved, the ZKP is generated (or boolean check run)
    and the result is stored on TruthRegistry.
    """
    if request_id not in verification_requests:
        raise HTTPException(status_code=404, detail="Verification request not found")

    req = verification_requests[request_id]
    if req["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Request already {req['status']}")

    if not kyc_issuer_agent.has_valid_anchor(req["user_id"]):
        raise HTTPException(
            status_code=400,
            detail="User has no KYC anchor. Run POST /kyc/anchor first.",
        )

    if req["mode"] == "zkp":
        if not body.secret_value:
            raise HTTPException(status_code=400, detail="secret_value required for ZKP mode")
        secret_value = int(body.secret_value)
    else:
        record = kyc_issuer_agent.get_record(req["user_id"])
        secret_value = record.income_annual if record else 100000

    threshold = int(req["threshold"])
    result_bool = secret_value > threshold

    if req["mode"] == "zkp" and zkp_service:
        proof_result = await zkp_service.generate_proof(
            secret_value=secret_value,
            threshold=threshold,
            user_id=req["user_id"],
        )
        req["proof"] = {
            "proof": proof_result.proof.proof if proof_result.proof else None,
            "public_inputs": proof_result.proof.public_inputs if proof_result.proof else None,
        }
        req["result"] = result_bool and proof_result.valid
    else:
        req["result"] = result_bool

    req["status"] = "fulfilled"

    logger.info(f"[VR] Fulfilled request {request_id}: result={req['result']}")

    return {
        "status": "fulfilled",
        "request_id": request_id,
        "result": req["result"],
        "proof": req.get("proof"),
    }


# =============================================================================
# KYC Agent Endpoints
# =============================================================================


@app.post("/kyc/anchor")
async def anchor_identity(request: KYCAnchorRequest):
    """
    Anchor user's identity to Algorand.

    Called by the institution (or user with institution covering tx fee).
    Institution registers the commitment on-chain after KYC verification.
    """
    logger.info(f"[API] KYC anchor request for {request.user_address[:8]}...")

    try:
        kwargs = request.model_dump(exclude_none=True)
        user_addr = kwargs.pop("user_address")

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
    file: UploadFile = File(...),
):
    """Parse an Aadhaar/Bank PDF and anchor extracted data (institution initiates)."""
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Must be a PDF document.")

    extracted_text = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        with pdfplumber.open(tmp_path) as pdf:
            for page in pdf.pages:
                extracted_text += page.extract_text() + "\n"

        os.unlink(tmp_path)
    except Exception as e:
        logger.error(f"[API] PDF Extraction failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to parse PDF document.")

    is_aadhaar = False
    extracted_name = "Auth Verified"
    citizenship = "US"
    income_val = 0

    aadhaar_match = re.search(r'\b\d{4}\s?\d{4}\s?\d{4}\b', extracted_text)
    if aadhaar_match or "aadhaar" in extracted_text.lower() or "dob" in extracted_text.lower():
        is_aadhaar = True
        citizenship = "IN"
        extracted_name = "Verified Aadhaar Citizen"

        lines = [line.strip() for line in extracted_text.split('\n') if line.strip()]
        for idx, line in enumerate(lines):
            if "DOB" in line.upper() or "YEAR OF BIRTH" in line.upper():
                if idx > 0 and len(lines[idx-1]) > 2:
                    potential_name = lines[idx-1].title()
                    if "GOVERNMENT" not in potential_name.upper():
                        extracted_name = potential_name
                    break

        if extracted_name == "Verified Aadhaar Citizen" and file.filename:
            base = file.filename.lower().replace(".pdf", "").replace("aadhar", "").replace("unlocked", "").replace("_", " ").strip()
            if base:
                extracted_name = base.title()

        dirty_name = extracted_name
        clean_words = []
        for word in extracted_name.split():
            if re.match(r'^[A-Za-z]+$', word):
                clean_words.append(word)
        if clean_words:
            extracted_name = " ".join(clean_words[:3])

        extracted_address = "Address not found"
        addr_match = re.search(r'(?i)(?:address|add|addr|पता|कव|c/o|s/o|d/o|w/o|care\s+of)[\s:]*(.*)', extracted_text.replace('\n', ' '))
        if addr_match:
            extracted_address = addr_match.group(1).split("Pin")[0].strip()[:150]

        if (extracted_address == "Address not found" or len(extracted_address) < 10) and len(dirty_name) > len(extracted_name):
            possible_addr = dirty_name.replace(extracted_name, "").strip()
            possible_addr = re.sub(r'^[\s,:\-बेकरी]+', '', possible_addr)
            if len(possible_addr) > 5:
                extracted_address = possible_addr

        if extracted_address == "Address not found":
            pin_search = re.search(r'([A-Za-z0-9\s,]{20,}\b\d{6}\b)', extracted_text.replace('\n', ' '))
            if pin_search:
                extracted_address = pin_search.group(1).strip()[:150]

        extracted_age = 25
        dob_match = re.search(r'(?i)(?:dob|year of birth|birth|जन्म).*?(\d{4})', extracted_text)
        if dob_match:
            try:
                yob = int(dob_match.group(1))
                extracted_age = 2026 - yob
            except Exception:
                pass

        income_val = 1000000
    else:
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
        kyc_record, anchor = await kyc_issuer_agent.extract_and_anchor(
            user_address=user_address,
            create_onchain=True,
            income_annual=income_val,
            full_name=extracted_name,
            citizenship=citizenship,
            age=extracted_age,
            address=extracted_address,
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
    """Check if user has a valid KYC anchor."""
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
# Verification Endpoint (backward compatible — requires prepaid request_id)
# =============================================================================


@app.post("/verify/income")
async def verify_income(request: IncomeVerificationRequest):
    """
    Verify income using a prepaid request_id.

    The request_id must have been created by an institution via POST /verify/request
    and approved by the user via POST /verify/approve/{request_id}.
    """
    if not request.request_id:
        raise HTTPException(status_code=400, detail="request_id is required. Institution must create a request first.")

    if request.request_id not in verification_requests:
        raise HTTPException(status_code=404, detail="Verification request not found")

    req = verification_requests[request.request_id]
    if req["status"] != "fulfilled":
        raise HTTPException(status_code=400, detail=f"Request not yet fulfilled. Status: {req['status']}")

    return JSONResponse(
        status_code=200,
        content={
            "result": req["result"],
            "user_id": req["user_id"],
            "mode": req["mode"],
            "threshold": req["threshold"],
            "request_id": request.request_id,
            "proof": req.get("proof"),
        },
    )


# =============================================================================
# Backward Compatible Endpoints
# =============================================================================


@app.post("/attestation/generate", response_model=ZKPResult)
async def generate_attestation(request: IncomeVerificationRequest):
    """Generate a ZK attestation for a user claim (no payment needed — institution already paid)."""
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
            raise HTTPException(status_code=500, detail=f"Proof generation failed: {proof_result.error}")

        return ZKPResult(
            result=True,
            proof=proof_result.proof.proof,
            public_inputs=proof_result.proof.public_inputs,
        )
    else:
        return ZKPResult(
            result=True,
            proof="SIGNED_IDENTITY_SEAL_V1",
            public_inputs={"threshold": request.threshold, "user_id": request.user_id},
        )


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
