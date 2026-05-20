# TrustAnchor — Technical Documentation

## Overview

TrustAnchor is a privacy-preserving identity verification marketplace on Algorand where **institutions pay USDC** to verify user attributes via zero-knowledge proofs.

### Key Changes (v2.0)
- **Institution pays** — not the consumer. All pricing in USDC only.
- **Verification requests** — institutions initiate, users approve.
- **On-chain tracking** — VerificationRequest stored in BoxMap.
- **API key auth** — institutions get API keys on registration.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    TrustAnchor v2 — Institution Pays                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐    1. Register ($2 USDC)   ┌──────────────────┐   │
│  │  Institution     │ ─────────────────────────► │  Backend API     │   │
│  │  (Verifier)      │ ◄───────────────────────── │  (FastAPI)       │   │
│  │                  │    6. Read result           │                  │   │
│  └──────────────────┘                            └──────────────────┘   │
│         │ 2. Request verify ($0.10)                      │              │
│         ▼                                                 ▼             │
│  ┌──────────────────┐    3. Pending    ┌────────────────────────────┐   │
│  │  User (Prover)   │ ◄────────────── │  Identity Anchor (KYC)     │   │
│  │                  │ ───────────────► │  + TruthRegistry (on-chain)│   │
│  │                  │    4. Approve     │                            │   │
│  └──────────────────┘                  └────────────────────────────┘   │
│         │ 5. ZKP generated (off-chain)                                  │
│         ▼                                                               │
│  ┌──────────────────┐     Result stored    ┌──────────────────┐        │
│  │  gnark Prover    │ ──────────────────►  │  TruthRegistry   │        │
│  │  (Go binary)     │                      │  (Algorand)      │        │
│  └──────────────────┘                      └──────────────────┘        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
TrustAnchor/
├── circuits/                      # ZKP circuit (Go + gnark)
│   ├── prove.go                   # GreaterThan circuit
│   ├── cmd/prover/main.go         # CLI
│   ├── keys/                      # groth16 proving/verifying keys
│   └── prover                     # Compiled binary
├── projects/
│   ├── TrustAnchor-backend/       # FastAPI (Python)
│   │   ├── main.py                # API server — institution endpoints
│   │   ├── pricing.py             # USDC pricing + SubscriptionTracker
│   │   ├── payment_verifier.py    # USDC ASA transfer verification
│   │   ├── kyc_agent.py           # Identity anchoring
│   │   ├── recruiter_agent.py     # USDC asset transfer signing
│   │   └── zkp_service.py         # ZKP generation
│   ├── TrustAnchor-contracts/     # Algorand smart contracts
│   │   └── smart_contracts/
│   │       ├── truth_registry/    # Proof storage + verification
│   │       ├── identity_registry/ # Institution registry
│   │       └── trust_anchor/      # Verification request tracking
│   └── TrustAnchor-frontend/      # React + TypeScript
│       ├── src/
│       │   ├── TrustAnchorApp.tsx  # Main app (institution + citizen)
│       │   ├── components/        # Wallet, transact, calls
│       │   └── utils/             # Network configs, USDC asset ID
│       └── package.json
├── demo.py                         # Full flow demo
├── README.md                       # This file
├── PROJECT.md                      # Technical docs
├── USAGE.md                        # Quick-start
├── SETUP.md                        # Teammate onboarding
└── TASKS.md                        # Task breakdown
```

---

## API Reference

### Institution Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/institutions/register` | None | Register institution, pay $2 USDC onboarding |
| POST | `/verify/request` | API key | Institution requests user verification |
| GET | `/verify/requests` | API key | List institution's verification requests |
| GET | `/verify/result/{request_id}` | API key | Get verification result |
| GET | `/verify/requests/pending/{user_address}` | None | User sees pending requests |
| POST | `/verify/approve/{request_id}` | None | User approves request, generates ZKP |

### Legacy Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/verify/income` | Verification (requires prepaid request_id) |
| POST | `/kyc/upload` | Upload KYC document for anchoring |
| GET | `/pricing` | Current USDC pricing |
| GET | `/health` | Health check |

### Pricing

| Mode | Price (USDC) | Asset |
|------|-------------|-------|
| Onboarding | $2.00 | USDC (ASA 31566704) |
| Boolean | $0.01 | USDC (ASA 31566704) |
| ZKP | $0.10 | USDC (ASA 31566704) |
| Monthly subscription | $10.00 | USDC (ASA 31566704) |

---

## Verification Flow (Detailed)

```
1. INSTITUTION REGISTERS
   POST /institutions/register
   { name: "Acme Corp", address: "0x...", onboarding_txid: "USDC_TX_ID" }
   → { institution_id, api_key, quota: 1000 }

2. INSTITUTION REQUESTS VERIFICATION
   POST /verify/request
   Authorization: Bearer <api_key>
   { user_address: "0x...", mode: "zkp", threshold: 50000 }
   → { request_id, status: "pending" }

3. USER CHECKS PENDING REQUESTS
   GET /verify/requests/pending/{user_address}
   → { requests: [{ request_id, mode, threshold, status }] }

4. USER APPROVES
   POST /verify/approve/{request_id}
   { secret_value: 75000 }
   → { status: "fulfilled", result: true }

5. INSTITUTION READS RESULT
   GET /verify/result/{request_id}
   Authorization: Bearer <api_key>
   → { request_id, result: true, status: "fulfilled" }
```

---

## Smart Contracts

### IdentityRegistry
- Methods: `register_institution`, `is_registered`
- Tracks registered institutions on-chain

### TruthRegistry
- Methods: `verify_zk_claim`, `get_proof_status`, `is_proof_verified`
- Stores ZKP verification results in BoxMap keyed by proof_id

### TrustAnchor
- Methods: `request_verification`, `fulfill_request`, `get_request`
- VerificationRequest struct stored in BoxMap (`req_` prefix)
- Tracks institution_id, user_address, mode, threshold, status, round

---

## Payment Integration (x402 + USDC)

```
Request:
  POST /verify/request
  Body: { user_address, mode, threshold }

Response (402 Payment Required):
  {
    "detail": {
      "error": "Payment required",
      "paymentRequirements": [{
        "scheme": "exact",
        "network": "algorand:testnet",
        "assetId": 10419441,
        "payTo": "TRUST_ANCHOR_ADDRESS",
        "maximumAmountRequired": 100000,
        "description": "zkp verification"
      }]
    }
  }

Payment:
  AssetTransferTxn(assetId=10419441, amount=100000, receiver=ISSUER)

Retry:
  POST /verify/request
  Headers: { "x402-payment-proof": "<txid>" }
  Authorization: Bearer <api_key>
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| USDC_ASSET_ID | 10419441 | USDC ASA (mainnet: 31566704) |
| DEFAULT_USDC_DECIMALS | 6 | USDC decimal places |
| TRUST_ANCHOR_ADDRESS | — | Issuer payment address |
| ALGORAND_NETWORK | testnet | Network selection |
| KYC_ORACLE_MNEMONIC | — | Wallet mnemonic for real anchors |

---

## Key Components

### ZKP Circuits (`circuits/`)
Proves `secret > threshold` without revealing secret. Uses Groth16 proving system via gnark v0.14.0.

### Backend (`projects/TrustAnchor-backend/`)
FastAPI server with x402 integration. Institution registration and auth. KYC anchoring. USDC payment verification.

### Frontend (`projects/TrustAnchor-frontend/`)
React + TypeScript with @txnlab/use-wallet. Institution portal (register, request, check) and citizen portal (anchor, approve). USDC asset display.

---

## Security

1. **PII never stored** — only cryptographic commitments on-chain
2. **Secret never revealed** — ZKP proves threshold without exposing value
3. **Institution API keys** — bearer auth for all institution endpoints
4. **USDC only** — stable asset, no volatility risk for enterprise pricing
