# TrustAnchor — Usage Guide

Privacy-preserving identity verification on Algorand. **Institutions pay USDC. Users prove with ZKPs.**

## Quick Start

### Prerequisites

- Node.js 18+
- Go 1.22+
- Python 3.12+
- Docker (for localnet)
- Algorand Node (for smart contracts)
- AlgoKit CLI

### Setup

```bash
# 1. Clone
cd TrustAnchor

# 2. Setup ZKP circuit
cd circuits
go build -o prover ./cmd/prover
./prover setup --dir ./keys
cd ..

# 3. Install backend deps
pip install -r projects/TrustAnchor-backend/requirements.txt

# 4. Setup frontend
cd projects/TrustAnchor-frontend
npm install
```

## Running

### Backend

```bash
cd projects/TrustAnchor-backend
cp .env.example .env
# Edit .env — set USDC_ASSET_ID, ALGORAND_NETWORK, etc.
python -m uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd projects/TrustAnchor-frontend
npm run dev
# Open http://localhost:5173
```

### Demo (simulated)

```bash
cd TrustAnchor
python demo.py --dry-run
```

## Verification Modes

### Boolean Mode ($0.01 USDC)
- Simple yes/no threshold check
- "Is income > $50k?" → true/false

### ZKP Mode ($0.10 USDC)
- Zero-knowledge proof
- Proves secret > threshold without revealing secret
- Complete privacy

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/institutions/register` | Register institution ($2 USDC) |
| POST | `/verify/request` | Request verification (API key auth) |
| GET | `/verify/requests` | List institution requests |
| GET | `/verify/requests/pending/{addr}` | User pending requests |
| POST | `/verify/approve/{id}` | User approves request |
| POST | `/verify/income` | Legacy verification |
| GET | `/pricing` | USDC pricing |
| GET | `/health` | Health check |

## Smart Contracts

### Deployed (Testnet)
- **TrustAnchor**: App ID 758839639
- **TruthRegistry**: deployed via algokit
- **IdentityRegistry**: deployed via algokit

### Build & Deploy

```bash
cd projects/TrustAnchor-contracts
algokit project run build
algokit project deploy localnet
```

## Troubleshooting

### LocalNet
```bash
algokit localnet reset
algokit localnet start
```

### ZKP
```bash
cd circuits && ./prover --help
```

### Frontend
```bash
node --version  # Need 18+
npm run lint
npm test
```
