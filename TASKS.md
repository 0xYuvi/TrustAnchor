# TrustAnchor — Task Breakdown (3 Members)

## Business Model Context

**Core change**: Institutions (employers, DeFi protocols, exchanges, lenders) pay for verification — NOT end users.

**Currency**: All pricing in **USDC only** — no ALGO pricing. Reason: stable pricing for enterprise buyers, predictable accounting.

**Pricing**:

| Tier | Product | USDC | Who Pays |
|------|---------|------|----------|
| Boolean | "Is income > $50k?" yes/no | $0.01 | Institution |
| ZKP | Full zero-knowledge proof | $0.10 | Institution |
| Subscription | 1,000 verifications/month | $10/mo | Enterprise |
| Onboarding | Register on IdentityRegistry | $2 one-time | Institution |

**Flow**:

```
1. Institution registers (pays $2 USDC)
2. User connects bank → identity anchored on-chain (institution covers tx fee)
3. Institution requests verification of user X → pays $0.01/$0.10 USDC
4. User approves → ZKP generated using anchored data
5. Result stored on TruthRegistry
6. Institution reads: is_proof_verified(proof_id) = true
```

**USDC Asset**: Mainnet ASA ID `31566704`. On testnet: `10458941`.

---

## Member 1 — Backend Payment Rewrite

**Focus**: Replace all ALGO payment logic with USDC asset transfers. Rewrite payment verification to check ASA transfers instead of ALGO pay transactions.

### Files to Modify

| File | Changes |
|------|---------|
| `projects/TrustAnchor-backend/pricing.py` | Remove ALGO pricing. Add `PricingTier` with USDC amounts in base units (1 USDC = 1,000,000 microUSDC). `BOOLEAN_COST = 10000` ($0.01), `ZKP_COST = 100000` ($0.10), `SUBSCRIPTION_MONTHLY = 10000000` ($10), `ONBOARDING_FEE = 2000000` ($2). |
| `projects/TrustAnchor-backend/payment_verifier.py` | Rewrite `verify_payment()`. Instead of checking ALGO payment via Indexer, check for a USDC ASA transfer: validate `assetId == USDC_ASSET_ID`, `amount >= required_amount`, correct `receiver` (institution's TrustAnchor address), and correct `note` (request binding hash). Use `algod.asset_transfer()` or Indexer asset lookup. |
| `projects/TrustAnchor-backend/recruiter_agent.py` | Rename `AlgorandSigner` to handle asset transfers. Add `send_usdc_payment()` method that constructs `AssetTransferTxn` instead of `PaymentTxn`. Keep existing signing logic. |
| `projects/TrustAnchor-backend/main.py` | Update x402 payment requirement: `"network": "algorand:mainnet"`, add `"assetId": 31566704` to payment requirements JSON. Remove ALGO-specific logic. Add `USDC_ASSET_ID` as env config. |
| `projects/TrustAnchor-backend/scratch/get_addr.py` | Verify / update address derivation if needed. |

### Acceptance Criteria
- [ ] Pricing module returns USDC amounts only
- [ ] `verify_payment()` correctly validates USDC ASA transfers (asset ID, amount, receiver, note)
- [ ] x402 flow works with USDC payments
- [ ] Recruiter agent sends USDC asset transfers correctly

---

## Member 2 — Flow Redesign + Smart Contracts

**Focus**: Redesign the verification flow so institutions initiate and pay. Update API endpoints. Optional smart contract changes for on-chain payment tracking.

### Files to Modify

| File | Changes |
|------|---------|
| `projects/TrustAnchor-backend/main.py` | **Major rewrite.** New endpoints: `POST /institutions/register` (register, pay $2 USDC), `POST /verify/request` (institution initiates: `{user_id, threshold, mode}` — returns `request_id`), `GET /verify/requests` (list pending), `POST /verify/approve/{request_id}` (user approves). Add institution API key auth middleware. Change `/verify/income` to require `request_id` prepaid by institution. |
| `projects/TrustAnchor-backend/pricing.py` | Coordinate with Member 1 on the pricing module interface. Add subscription quota tracking. |
| `projects/TrustAnchor-backend/kyc_agent.py` | Update `anchor_kyc()` docstring and flow to reflect institution-initiated anchoring. No major logic change — KYC agent still simulates bank/government. |
| `projects/TrustAnchor-contracts/smart_contracts/trust_anchor/contract.py` | **Optional**: Add `request_verification(sender, user, fee)` method that tracks prepaid verification requests on-chain. Add `USDC_ASSET_ID` constant. (Keep simple if out of scope.) |
| `demo.py` | Rewrite demo to match new flow: institution registers → institution requests → user approves → ZKP generated → result on-chain. Replace ALGO pay with USDC asset transfer in demo output. |

### Acceptance Criteria
- [ ] Institution can register → pays $2 USDC
- [ ] Institution can request verification of a user → pays $0.01/$0.10 USDC
- [ ] User can see and approve pending requests
- [ ] Demo script shows new institution-pays flow with USDC
- [ ] API key auth works for institutions

---

## Member 3 — Frontend + DevOps + Docs

**Focus**: Redesign the UI for dual-role (institution vs user). USDC payment UI. Setup docs for teammates.

### Files to Modify

| File | Changes |
|------|---------|
| `projects/TrustAnchor-frontend/src/TrustAnchorApp.tsx` | **Major rewrite.** Split into institution dashboard (register, API keys, request verification, usage stats) and user dashboard (anchor identity, approve requests, view verifications). Remove ALGO price display, show USDC ($). |
| `projects/TrustAnchor-frontend/src/components/AppCalls.tsx` | Update to construct USDC `AssetTransferTxn` instead of ALGO `PaymentTxn`. Use `algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject()`. |
| `projects/TrustAnchor-frontend/src/components/Transact.tsx` | Show "Pay $0.10 USDC" instead of "Pay 0.5 ALGO". |
| `projects/TrustAnchor-frontend/src/components/ConnectWallet.tsx` | Add network switch hint (testnet USDC pool vs mainnet). |
| `projects/TrustAnchor-frontend/src/utils/network/getAlgoClientConfigs.ts` | Add `USDC_ASSET_ID` to network configs (mainnet: 31566704, testnet: 10458941). |
| `projects/TrustAnchor-frontend/public/index.html` | Update tagline / meta to reflect institution-pays model. |
| `projects/TrustAnchor-backend/.env.example` | Add `USDC_ASSET_ID=31566704`, `DEFAULT_USDC_DECIMALS=6`, placeholder for `INSTITUTION_API_KEYS`. |
| `TrustAnchor/README.md` | Rewrite business model: USDC-only, institution pays. Update pricing table. Update architecture diagram. |
| `TrustAnchor/PROJECT.md` | Update technical docs to reflect new flow. Update API reference with new endpoints. |
| `TrustAnchor/USAGE.md` | Quick-start guide updated for teammate onboarding. |
| **New: `TrustAnchor/SETUP.md`** | Full teammate onboarding guide (see below). |
| **New: `TrustAnchor/opencode.example.json`** | Reference MCP config for vibekit + kappa. |

### Acceptance Criteria
- [ ] Institution dashboard renders (register, request verification, API keys)
- [ ] User dashboard renders (approve requests, view history)
- [ ] USDC asset transfer works from browser wallet
- [ ] Prices shown in $USD, not ALGO
- [ ] All docs updated — README, PROJECT, USAGE, SETUP
- [ ] `opencode.example.json` committed to git

---

## Timeline (Suggested)

| Phase | Duration | Deliverables |
|-------|----------|-------------|
| Phase 1 | Day 1-2 | Member 1: payment rewrite. Member 2: new API endpoints. Member 3: UI rewrite + setup docs. |
| Phase 2 | Day 3 | Integration testing — all 3 members test end-to-end flow |
| Phase 3 | Day 4 | Polish, docs, demo prep, submission |
