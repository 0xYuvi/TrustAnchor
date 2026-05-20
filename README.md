# TrustAnchor — Truth-as-a-Service on Algorand

**Institutions pay USDC. Users prove with ZKPs. Privacy preserved.**

TrustAnchor is a privacy-preserving identity verification protocol on Algorand. Institutions (employers, DeFi protocols, lenders) pay USDC to verify user attributes via zero-knowledge proofs — without ever seeing raw PII.

---

## Business Model

| Tier | Product | USDC | Who Pays |
|------|---------|------|----------|
| Boolean | "Is income > $50k?" yes/no | $0.01 | Institution |
| ZKP | Full zero-knowledge proof | $0.10 | Institution |
| Subscription | 1,000 verifications/month | $10/mo | Enterprise |
| Onboarding | Register on platform | $2 one-time | Institution |

### Why only USDC?
Enterprise buyers need stable, predictable pricing. ALGO is volatile. USDC (ASA `31566704` mainnet / `10419441` testnet) gives institutions fixed costs they can budget.

---

## Flow

```
1. Institution registers → pays $2 USDC onboarding → gets API key + 1,000 quota
2. User anchors identity on-chain → PII never stored, only cryptographic commitment
3. Institution requests verification of user → pays $0.01/$0.10 USDC
4. User sees pending request → approves → ZKP generated from anchored data
5. Institution reads verification result on TruthRegistry
```

---

## Key Features

- **Institution Pays**: Verifiers bear the cost, not consumers. Matches real-world KYC (Onfido, Jumio, Persona).
- **Zero-Knowledge Proofs**: Groth16 proofs via gnark. Prove attributes without revealing values.
- **x402 + USDC**: HTTP 402 payment flow with USDC asset transfers, not ALGO.
- **Identity Anchoring**: KYC data committed to Algorand ledger. Raw data never stored.
- **Verification Requests**: On-chain tracking via BoxMap — institutions request, users approve.

---

## Technical Stack

- **Smart Contracts**: Algorand Python (PuyaPy)
- **Cryptography**: gnark (Go-based ZKP engine, Groth16)
- **Backend**: FastAPI (Python), algosdk, x402
- **Frontend**: React (TypeScript), Tailwind CSS, @txnlab/use-wallet
- **Payments**: USDC ASA transfers (not ALGO)

---

## Quick Start

```bash
# 1. Install dependencies
algokit project bootstrap all

# 2. Compile ZKP prover
cd circuits && go build -o prover ./cmd/prover && ./prover setup --dir ./keys && cd ..

# 3. Start backend
cd projects/TrustAnchor-backend
cp .env.example .env  # configure USDC_ASSET_ID, network, etc.
python -m uvicorn main:app --reload --port 8000

# 4. Launch frontend
cd projects/TrustAnchor-frontend
npm run dev
```

---

## Docs

- [PROJECT.md](PROJECT.md) — Full technical documentation, API reference, architecture
- [USAGE.md](USAGE.md) — Quick-start guide and commands
- [SETUP.md](SETUP.md) — Teammate onboarding guide
- [TASKS.md](TASKS.md) — Task breakdown for 3-member team
