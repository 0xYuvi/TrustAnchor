# TrustAnchor - Usage Guide

Privacy-preserving identity verification marketplace on Algorand using zero-knowledge proofs.

## Quick Start

### Prerequisites

- Node.js 18+
- Go 1.22+
- Python 3.12+
- Docker (for localnet)
- Algorand Node (for smart contracts)

### Environment Setup

```bash
# 1. Clone the repository
cd TrustAnchor

# 2. Setup ZKP circuit (Go)
cd circuits
go build -o prover ./cmd/prover
./prover setup --dir ./keys

# 3. Setup smart contracts (Python)
cd ../projects/TrustAnchor-contracts
poetry install
algokit localnet start

# 4. Setup frontend
cd ../TrustAnchor-frontend
npm install
```

## Running the Application

### Option 1: Full Stack

```bash
# Terminal 1: Start backend
cd projects/TrustAnchor-backend
poetry run uvicorn main:app --reload

# Terminal 2: Start frontend
cd projects/TrustAnchor-frontend
npm run dev
```

### Option 2: Frontend Only

```bash
cd projects/TrustAnchor-frontend
npm run dev
# Open http://localhost:5173
```

## ZKP Circuit Commands

### Generate Keys

```bash
cd circuits
./prover setup --dir ./keys
```

Output:
```
Keys generated successfully!
Proving Key: ./keys/pk.groth16.key
Verifying Key: ./keys/vk.groth16.key
```

### Generate Proof

```bash
./prover prove \
  --secret 75000 \
  --threshold 50000 \
  --pk ./keys/pk.groth16.key
```

Output:
```json
{
  "proof": "{\"a\":\"g1_00000000000124f8\",...}",
  "public_inputs": {"threshold": 50000}
}
```

### Verify Proof

```bash
./prover verify \
  --proof "<base64_encoded_proof>" \
  --public '{"threshold": 50000}' \
  --vk ./keys/vk.groth16.key
```

## Smart Contract Commands

### Build Contracts

```bash
cd projects/TrustAnchor-contracts
algokit project run build
```

### Deploy to LocalNet

```bash
algokit project deploy localnet
```

### Run Tests

```bash
algokit project run test
```

## Frontend Commands

### Development

```bash
cd projects/TrustAnchor-frontend
npm run dev      # Start dev server
npm run test    # Run tests
npm run lint   # Lint code
```

### Production

```bash
npm run build    # Build for production
npm run preview  # Preview production build
```

## Smart Contract

### Deployed to Testnet
- **App ID**: 758807528
- **App Address**: CNQVFP2AP6R67SI4IKDRGFRJUW2P3JIBQD5QER4U27Q4DEH7OAJ4KE3KNE
- **Issuer**: COBW4B43ZK4EJBWTFY6ZQIMBYMKMLBITGEMWMVHJ2UMWBGAKQBRTL223WI
- **Network**: Algorand testnet

### Redeploy Contract

```bash
cd projects/TrustAnchor-contracts
algokit project run build
# Deploy via algokit or:
algokit project deploy testnet
```

## Verification Modes

### Boolean Mode (0.1 ALGO)
- Simple yes/no verification
- Less private
- Lower cost

### ZKP Mode (0.5 ALGO)
- Zero-knowledge proof
- Complete privacy
- Proves secret > threshold without revealing secret

## Demo Flow

1. **Connect Wallet** - Use Pera, Defly, or Exodus
2. **Enter Parameters** - User ID, threshold, secret value
3. **Select Mode** - Boolean or ZKP
4. **Run Verification** - Complete the flow
5. **View Result** - Check verification status and proof

## Project Structure

```
TrustAnchor/
├── circuits/               # ZKP circuit (Go/gnark)
│   ├── prove.go           # Circuit + proving logic
│   ├── cmd/prover/       # CLI entry point
│   ├── keys/            # Generated proving/verifying keys
│   └── prover          # Compiled binary
├── projects/
│   ├── TrustAnchor-contracts/  # Smart contracts (algopy)
│   │   └── smart_contracts/
│   │       └── trust_anchor/
│   ├── TrustAnchor-backend/       # Backend API (FastAPI)
│   │   └── zkp_service.py
│   └── TrustAnchor-frontend/      # Frontend (React + TS)
│       └── src/
│           └── TrustAnchorApp.tsx
└── PROJECT.md             # Full project documentation
```

## Troubleshooting

### LocalNet Issues

```bash
algokit localnet reset
algokit localnet start
```

### Key Generation Errors

Make sure Go is installed and in PATH:
```bash
go version
go build -o prover ./cmd/prover
```

### Frontend Build Errors

Check Node version:
```bash
node --version  # Should be 18+
```

### Smart Contract Errors

Ensure localnet is running:
```bash
algokit localnet status
```

## API Endpoints

### Backend (FastAPI)

- `POST /verify` - Submit verification request
- `GET /status/{proof_id}` - Check verification status
- `GET /proof/{proof_id}` - Get proof data

### Payments (X402)

- Automatic payment handling via HTTP 402
- 0.1 ALGO for boolean verification
- 0.5 ALGO for ZKP verification

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Run tests
5. Submit PR

## License

MIT