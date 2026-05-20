import { useWallet } from '@txnlab/use-wallet-react'
import React, { useState, useCallback } from 'react'
import ConnectWallet from './components/ConnectWallet'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'
const USDC_MAINNET = 31566704
const USDC_TESTNET = 10458941
const USDC_ASSET_ID = import.meta.env.VITE_ALGOD_NETWORK === 'mainnet' ? USDC_MAINNET : USDC_TESTNET

const MICRO_USDC = 1_000_000

const formatUsdc = (microUsdc: number) => `$${(microUsdc / MICRO_USDC).toFixed(2)} USDC`

interface Institution {
  institution_id: string
  name: string
  institution_type: string
  required_traits: string[]
  api_key: string
  quota: number
}

interface VerificationRequest {
  request_id: string
  user_address: string
  institution_name: string
  institution_type: string
  required_traits: string[]
  mode: string
  threshold: number
  status: string
  result?: boolean
}

interface KYCData {
  kyc_id: string
  commitment: string
  anchor_txid?: string
  full_name?: string
  income_annual?: number
  citizenship?: string
  verified_data?: any
}

const TrustAnchorApp: React.FC = () => {
  const { activeAddress, wallets, signTransactions } = useWallet()

  const [openWalletModal, setOpenWalletModal] = useState(false)
  const [portalMode, setPortalMode] = useState<'citizen' | 'institution'>('citizen')
  const [showDisconnect, setShowDisconnect] = useState(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [successMsg, setSuccessMsg] = useState('')

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg])
  }, [])

  // --- Institution State ---
  const [institution, setInstitution] = useState<Institution | null>(null)
  const [instName, setInstName] = useState('')
  const [instType, setInstType] = useState('bank')
  const [instRequiredTraits, setInstRequiredTraits] = useState<string[]>(['full_name', 'income_annual'])
  const [instRequests, setInstRequests] = useState<VerificationRequest[]>([])
  const [instTargetUser, setInstTargetUser] = useState('')
  const [instThreshold, setInstThreshold] = useState(50000)
  const [instMode, setInstMode] = useState<'boolean' | 'zkp'>('zkp')

  // --- Citizen State ---
  const [kycData, setKycData] = useState<KYCData | null>(null)
  const [pendingRequests, setPendingRequests] = useState<VerificationRequest[]>([])
  const [inqCodeInput, setInqCodeInput] = useState('')

  // --- Institution Registration with x402 ---
  const handleRegisterInstitution = async () => {
    if (!instName || !activeAddress) return
    setLoading(true)
    setError('')
    setLogs([])
    addLog('[INST] Registering institution...')

    try {
      const tryRegister = async (txid?: string) => {
        return await fetch(`${BACKEND_URL}/institutions/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: instName, institution_type: instType, required_traits: instRequiredTraits, address: activeAddress, onboarding_txid: txid || '' }),
        })
      }

      let res = await tryRegister()
      if (res.status === 402) {
        const payReq = await res.json()
        const req = payReq?.detail?.paymentRequirements?.[0] || {}
        const payTo = req.payTo || ''
        const amount = req.amount || 2_000_000
        const assetId = req.assetId || 10458941
        addLog(`[INST] Pay $2.00 USDC to ${payTo.slice(0, 8)}...`)
        addLog('[INST] Wallet should prompt to sign...')
        try {
          const algosdk = await import('algosdk')
          const algodClient = new algosdk.Algodv2(
            '',
            import.meta.env.VITE_ALGOD_SERVER || 'https://testnet-api.algonode.cloud',
            import.meta.env.VITE_ALGOD_PORT || '',
          )
          const params = await algodClient.getTransactionParams().do()
          const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: activeAddress,
            receiver: payTo,
            amount: BigInt(amount),
            assetIndex: assetId,
            suggestedParams: params,
          })
          addLog('[INST] Waiting for wallet signature...')
          const signedTxsRaw = await signTransactions([txn.toByte()])
          const signedTxs = signedTxsRaw.filter((tx): tx is Uint8Array => tx !== null)
          const tx = signedTxs[0]
          if (!tx) throw new Error('Signing was cancelled or failed')
          const txResult = (await algodClient.sendRawTransaction([tx]).do()) as any
          const txId: string = txResult.txId || txResult.txID || txResult.txid
          addLog(`[TX] USDC sent: ${txId.slice(0, 16)}...`)
          await algosdk.waitForConfirmation(algodClient, txId, 10)
          addLog('[TX] Confirmed on-chain!')

          addLog('[INST] Retrying registration...')
          res = await tryRegister(txId)
          const responseData = await res.json()
          if (!res.ok) throw new Error(responseData.detail?.error || responseData.detail || 'Registration failed')
          setInstitution(responseData)
          addLog(`[INST] Registered! ID: ${responseData.institution_id}`)
          setSuccessMsg('Institution registered! Save your API key.')
        } catch (payErr: any) {
          const msg = payErr.message || String(payErr)
          console.error('[TRUSTANCHOR] Payment error:', payErr)
          addLog(`[ERROR] ${msg}`)
          if (msg.includes('cancelled') || msg.includes('Cancelled') || msg.includes('User denied')) {
            setError('Payment was cancelled')
          } else if (msg.includes('opted in') || msg.includes('not opted')) {
            setError('Opt into USDC first: ASA 10458941 on testnet')
          } else {
            setError(msg || 'USDC payment failed. Check browser console for details.')
          }
        }
        setLoading(false)
        return
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError(err.detail?.error || err.detail || 'Registration failed')
        addLog(`[ERROR] Registration failed: ${res.status}`)
        setLoading(false)
        return
      }
      const data = await res.json()
      setInstitution(data)
      addLog(`[INST] Registered! ID: ${data.institution_id}`)
      setSuccessMsg('Institution registered! Save your API key.')
    } catch (err: any) {
      setError(err.message || 'Network error')
      addLog(`[ERROR] ${err.message}`)
    }
    setLoading(false)
  }

  // --- Institution: Request Verification ---
  const handleRequestVerification = async () => {
    if (!institution || !instTargetUser) return
    setLoading(true)
    setError('')
    setLogs([])
    addLog(`[INST] Requesting ${instMode} verification of ${instTargetUser.slice(0, 8)}...`)
    try {
      const res = await fetch(`${BACKEND_URL}/verify/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${institution.api_key}`,
        },
        body: JSON.stringify({
          user_address: instTargetUser,
          mode: instMode,
          threshold: instThreshold,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Request failed')
      }
      const data = await res.json()
      addLog(`[INST] Request created: ${data.request_id}`)
      setSuccessMsg(`Verification request created: ${data.request_id.slice(0, 16)}...`)
      handleListRequests()
    } catch (err: any) {
      setError(err.message)
      addLog(`[ERROR] ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // --- Institution: List Requests ---
  const handleListRequests = async () => {
    if (!institution) return
    try {
      const res = await fetch(`${BACKEND_URL}/verify/requests`, {
        headers: { 'Authorization': `Bearer ${institution.api_key}` },
      })
      if (res.ok) {
        const data = await res.json()
        setInstRequests(data.requests || [])
      }
    } catch {}
  }

  // --- Institution: Check Result ---
  const handleCheckResult = async (requestId: string) => {
    if (!institution) return
    try {
      const res = await fetch(`${BACKEND_URL}/verify/result/${requestId}`, {
        headers: { 'Authorization': `Bearer ${institution.api_key}` },
      })
      if (res.ok) {
        const data = await res.json()
        addLog(`[RESULT] ${requestId.slice(0, 12)}... → ${data.result ? 'PASSED' : 'FAILED'}`)
        handleListRequests()
      }
    } catch {}
  }

  // --- Citizen: Upload KYC ---
  const uploadDocument = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !activeAddress) return
    setLoading(true)
    setError('')
    setLogs([])
    addLog(`[KYC] Scanning ${file.name}...`)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('user_address', activeAddress)
      const res = await fetch(`${BACKEND_URL}/kyc/upload`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) throw new Error('KYC anchor failed')
      const data = await res.json()
      setKycData(data)
      addLog('[KYC] Identity anchored successfully!')
    } catch (err: any) {
      setError(err.message)
      addLog(`[ERROR] ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // --- Citizen: Fetch Pending Requests ---
  const handleFetchPending = async () => {
    if (!activeAddress) return
    setLoading(true)
    setError('')
    try {
      const addr = inqCodeInput || activeAddress
      const res = await fetch(`${BACKEND_URL}/verify/requests/pending/${addr}`)
      if (!res.ok) throw new Error('Failed to fetch pending requests')
      const data = await res.json()
      setPendingRequests(data.requests || [])
      addLog(`[CITIZEN] ${data.requests?.length || 0} pending requests found`)
    } catch (err: any) {
      setError(err.message)
      addLog(`[ERROR] ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // --- Citizen: Approve Request ---
  const handleApproveRequest = async (reqId: string) => {
    setLoading(true)
    setError('')
    addLog(`[CITIZEN] Approving ${reqId.slice(0, 12)}...`)
    try {
      const secretVal = 75000
      const res = await fetch(`${BACKEND_URL}/verify/approve/${reqId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret_value: secretVal }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Approval failed')
      }
      const data = await res.json()
      addLog(`[CITIZEN] Result: ${data.result ? 'PASSED ✓' : 'FAILED ✗'}`)
      setSuccessMsg(data.result ? 'Verification passed!' : 'Verification failed')
      handleFetchPending()
    } catch (err: any) {
      setError(err.message)
      addLog(`[ERROR] ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-black text-slate-100 font-sans selection:bg-purple-500/30">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-purple-900/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-purple-900/10 rounded-full blur-[120px]" />
      </div>

      <nav className="sticky top-0 z-50 p-6 backdrop-blur-md border-b border-white/5 flex justify-between items-center px-12 bg-black/50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-purple-500 to-purple-800 rounded-xl shadow-[0_0_20px_rgba(168,85,247,0.4)] flex items-center justify-center">
            <span className="text-white font-black text-xl">T</span>
          </div>
          <div className="text-2xl font-black tracking-tighter uppercase italic">Trust<span className="text-purple-400">Anchor</span></div>
        </div>

        <div className="flex bg-white/5 border border-white/10 p-1 rounded-2xl">
          <button
            onClick={() => setPortalMode('citizen')}
            className={`px-8 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${portalMode === 'citizen' ? 'bg-white text-black shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Citizen
          </button>
          <button
            onClick={() => setPortalMode('institution')}
            className={`px-8 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${portalMode === 'institution' ? 'bg-purple-500 text-white shadow-[0_0_20px_rgba(168,85,247,0.4)]' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Institution
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-[10px] text-slate-600 font-mono">
            USDC: ASA {USDC_ASSET_ID}
          </div>
          <button
            onClick={() => {
              if (!activeAddress) setOpenWalletModal(true)
              else if (showDisconnect) {
                const activeWallet = wallets?.find((w) => w.isActive)
                if (activeWallet) activeWallet.disconnect().then(() => setShowDisconnect(false))
                else {
                  localStorage.removeItem('@txnlab/use-wallet:v3')
                  window.location.reload()
                }
              } else setShowDisconnect(true)
            }}
            className={`px-6 py-2.5 font-bold rounded-2xl transition-all shadow-lg text-[10px] uppercase tracking-widest flex items-center gap-2 ${activeAddress ? (showDisconnect ? 'bg-red-500 text-white' : 'bg-white/5 border border-white/10 text-slate-300 hover:border-purple-500/50') : 'bg-white text-black hover:scale-105'}`}
          >
            {activeAddress ? (
              showDisconnect ? (
                <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>Confirm</>
              ) : (
                <><div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />{`${activeAddress.slice(0, 4)}...${activeAddress.slice(-4)}`}</>
              )
            ) : 'Connect Wallet'}
          </button>
        </div>
      </nav>

      <main className="pt-32 px-6">
        <section className="max-w-7xl mx-auto text-center space-y-12 mb-40">
          <div className="space-y-4">
            <h1 className="text-7xl md:text-9xl font-black tracking-tighter text-gradient leading-none py-2">
              Truth-as-a-Service
            </h1>
            <p className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed font-medium">
              Institutions pay <span className="text-purple-400 font-bold">USDC</span> to verify users privately. Zero-knowledge proofs, no data leaks.
            </p>
          </div>
        </section>

        <section className="max-w-7xl mx-auto mb-48 scroll-mt-32">
          {!activeAddress ? (
            <div className="fintech-card py-32 text-center space-y-10 bg-gradient-to-b from-purple-500/5 to-transparent border-dashed">
              <div className="space-y-4">
                <h2 className="text-6xl font-black uppercase tracking-tighter">Connect Wallet</h2>
                <p className="text-slate-500 max-w-sm mx-auto">Connect your Algorand wallet to access TrustAnchor.</p>
              </div>
              <button onClick={() => setOpenWalletModal(true)} className="btn-premium transform scale-125">
                Connect Wallet
              </button>
            </div>
          ) : (
            <div className="space-y-12">
              {portalMode === 'institution' ? (
                <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in zoom-in duration-700">
                  <div className="fintech-card p-12 text-center space-y-12 bg-gradient-to-tr from-purple-900/10 to-transparent">
                    <div className="flex flex-col items-center space-y-6">
                      <div className="w-20 h-20 bg-purple-500/20 border border-purple-500/40 rounded-full flex items-center justify-center">
                        <svg className="w-10 h-10 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                      </div>
                      <div className="space-y-2">
                        <h2 className="text-5xl font-black uppercase tracking-tighter">Institution Portal</h2>
                        <p className="text-slate-400 max-w-md mx-auto text-xs uppercase tracking-widest font-bold opacity-60">
                          Pay {formatUsdc(2000000)} onboarding. Verify users for {formatUsdc(10000)} each.
                        </p>
                      </div>
                    </div>

                    {!institution ? (
                      <div className="max-w-xl mx-auto space-y-6">
                        <input
                          type="text"
                          placeholder="Institution Name"
                          value={instName}
                          onChange={(e) => setInstName(e.target.value)}
                          className="w-full bg-black border border-[#2a2a2a] p-6 rounded-3xl font-black text-white focus:outline-none focus:border-purple-500 text-center text-xl"
                        />

                        <select
                          value={instType}
                          onChange={(e) => setInstType(e.target.value)}
                          className="w-full bg-black border border-[#2a2a2a] p-6 rounded-3xl font-black text-white focus:outline-none focus:border-purple-500 text-center text-xl appearance-none cursor-pointer"
                        >
                          <option value="bank">Bank / Financial Institution</option>
                          <option value="employer">Employer / HR</option>
                          <option value="defi_protocol">DeFi Protocol</option>
                          <option value="exchange">Exchange</option>
                          <option value="lender">Lender / Credit</option>
                          <option value="government">Government / KYC</option>
                          <option value="kyc_provider">KYC Provider</option>
                          <option value="other">Other</option>
                        </select>

                        <div className="bg-[#0A0A0A] border border-[#2a2a2a] p-6 rounded-3xl text-left space-y-3">
                          <div className="text-[10px] font-black uppercase text-purple-400 tracking-widest mb-3">Required from Prover</div>
                          {['full_name', 'income_annual', 'citizenship', 'date_of_birth', 'address', 'employment_status', 'credit_score', 'phone_number'].map((trait) => (
                            <label key={trait} className="flex items-center gap-3 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={instRequiredTraits.includes(trait)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setInstRequiredTraits([...instRequiredTraits, trait])
                                  } else {
                                    setInstRequiredTraits(instRequiredTraits.filter((t) => t !== trait))
                                  }
                                }}
                                className="w-5 h-5 accent-purple-500 rounded"
                              />
                              <span className="text-sm font-black uppercase tracking-widest text-slate-300 group-hover:text-white transition-colors">
                                {trait.replace(/_/g, ' ')}
                              </span>
                            </label>
                          ))}
                        </div>

                        <div className="bg-purple-500/5 p-6 rounded-2xl border border-purple-500/10 space-y-2 text-left">
                          <div className="text-[10px] font-black uppercase text-purple-400 tracking-widest">Onboarding Fee</div>
                          <div className="text-2xl font-black text-white">{formatUsdc(2000000)}</div>
                          <div className="text-[10px] text-slate-500">Pay $2 USDC to register. You get 1,000 free verifications.</div>
                        </div>
                        <button
                          onClick={handleRegisterInstitution}
                          disabled={loading || !instName || instRequiredTraits.length === 0}
                          className="btn-premium w-full py-8 text-base"
                        >
                          {loading ? 'Registering...' : `Register — ${formatUsdc(2000000)}`}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-8">
                        <div className="bg-green-500/5 border border-green-500/20 p-6 rounded-2xl">
                          <div className="flex items-center justify-between mb-3">
                            <div className="text-left">
                              <div className="text-[10px] font-black uppercase text-green-400 tracking-widest">Registered</div>
                              <div className="text-lg font-black text-white">{institution.name}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Quota</div>
                              <div className="text-2xl font-black text-purple-400">{institution.quota}</div>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-4 text-[11px]">
                            <div className="px-3 py-1.5 bg-purple-500/10 rounded-xl border border-purple-500/20 text-purple-300 font-bold uppercase tracking-widest">
                              {institution.institution_type.replace(/_/g, ' ')}
                            </div>
                            {institution.required_traits?.map((t: string) => (
                              <span key={t} className="px-3 py-1.5 bg-black rounded-xl border border-[#2a2a2a] text-slate-400 uppercase tracking-wider text-[10px] font-bold">
                                {t.replace(/_/g, ' ')}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="bg-black/40 border border-[#2a2a2a] p-4 rounded-2xl">
                          <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-2">API Key</div>
                          <div className="text-sm font-mono text-purple-300 truncate">{institution.api_key}</div>
                        </div>

                        <div className="grid md:grid-cols-3 gap-4">
                          <input
                            type="text"
                            placeholder="User wallet address"
                            value={instTargetUser}
                            onChange={(e) => setInstTargetUser(e.target.value)}
                            className="bg-black border border-[#2a2a2a] p-4 rounded-2xl text-white focus:outline-none focus:border-purple-500 text-sm font-mono"
                          />
                          <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-purple-400 font-bold text-sm">$</span>
                            <input
                              type="number"
                              value={instThreshold}
                              onChange={(e) => setInstThreshold(Number(e.target.value))}
                              className="w-full bg-black border border-[#2a2a2a] p-4 pl-8 rounded-2xl text-white focus:outline-none focus:border-purple-500 font-mono"
                            />
                          </div>
                          <select
                            value={instMode}
                            onChange={(e: any) => setInstMode(e.target.value)}
                            className="bg-black border border-[#2a2a2a] p-4 rounded-2xl text-white focus:outline-none appearance-none cursor-pointer text-xs uppercase tracking-widest"
                          >
                            <option value="zkp">ZKP — {formatUsdc(100000)}</option>
                            <option value="boolean">Boolean — {formatUsdc(10000)}</option>
                          </select>
                        </div>

                        <button
                          onClick={handleRequestVerification}
                          disabled={loading || !instTargetUser}
                          className="btn-premium w-full py-6"
                        >
                          {loading ? 'Requesting...' : `Request ${instMode === 'zkp' ? 'ZKP' : 'Boolean'} Verification — ${instMode === 'zkp' ? formatUsdc(100000) : formatUsdc(10000)}`}
                        </button>

                        {instRequests.length > 0 && (
                          <div className="space-y-4">
                            <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest text-left">Verification Requests</div>
                            {instRequests.map((req) => (
                              <div key={req.request_id} className="bg-black/40 border border-[#2a2a2a] p-4 rounded-2xl flex items-center justify-between">
                                <div className="text-left">
                                  <div className="text-xs font-mono text-slate-500">{req.request_id.slice(0, 20)}...</div>
                                  <div className="text-sm text-white">{req.mode} | ${req.threshold.toLocaleString()}</div>
                                </div>
                                <div className="flex items-center gap-4">
                                  <span className={`text-[10px] font-black uppercase ${req.status === 'fulfilled' ? 'text-green-400' : req.status === 'pending' ? 'text-yellow-400' : 'text-slate-500'}`}>
                                    {req.status}
                                  </span>
                                  {req.status === 'pending' && (
                                    <button onClick={() => handleCheckResult(req.request_id)} className="px-4 py-2 bg-purple-500 text-white text-[10px] font-black rounded-xl uppercase tracking-widest">
                                      Check
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        <button onClick={handleListRequests} className="w-full py-4 bg-white/5 border border-white/10 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-400 hover:border-purple-500/50 transition-all">
                          Refresh Requests
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="max-w-6xl mx-auto animate-in fade-in zoom-in duration-700">
                  {!kycData ? (
                    <div className="fintech-card text-center p-24 space-y-12 bg-gradient-to-b from-purple-500/5 to-transparent border-dashed">
                      <div className="w-24 h-24 bg-purple-500/10 border border-purple-500/20 rounded-3xl mx-auto flex items-center justify-center">
                        <svg className="w-10 h-10 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                      </div>
                      <div className="space-y-4">
                        <h2 className="text-6xl font-black uppercase tracking-tighter">Identity Anchor</h2>
                        <p className="text-slate-400 max-w-md mx-auto">Commit your identity document. Your PII is never stored — only a cryptographic anchor.</p>
                      </div>
                      <div className="relative group max-w-sm mx-auto pt-6">
                        <div className="btn-premium w-full flex items-center justify-center h-24">
                          <input
                            type="file"
                            accept=".pdf"
                            onChange={uploadDocument}
                            disabled={loading}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                          />
                          {loading ? 'Anchoring...' : 'Anchor Identity'}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-12 animate-in slide-in-from-bottom-10 duration-1000">
                      <div className="fintech-card bg-gradient-to-br from-purple-500/10 to-transparent border-purple-500/20 p-12">
                        <div className="flex justify-between items-start mb-8">
                          <div>
                            <h3 className="text-3xl font-black uppercase tracking-tight text-white mb-2 leading-none">Identity Vault</h3>
                            <p className="text-[10px] text-slate-600 font-mono tracking-[0.5em] uppercase">Commitment Active</p>
                          </div>
                          <div className="px-6 py-3 bg-green-500/10 text-green-400 text-[10px] font-black rounded-2xl border border-green-500/20 flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            SECURE SESSION
                          </div>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div className="p-6 bg-black/60 rounded-2xl border border-[#2a2a2a]">
                            <div className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">Name</div>
                            <div className="text-lg font-bold text-white">{kycData.verified_data?.full_name || 'Anchored'}</div>
                          </div>
                          <div className="p-6 bg-black/60 rounded-2xl border border-[#2a2a2a]">
                            <div className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">Income</div>
                            <div className="text-lg font-bold text-white">{kycData.verified_data?.income_annual ? `$${kycData.verified_data.income_annual.toLocaleString()}` : 'Anchored'}</div>
                          </div>
                          <div className="p-6 bg-black/60 rounded-2xl border border-[#2a2a2a]">
                            <div className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">Citizenship</div>
                            <div className="text-lg font-bold text-white">{kycData.verified_data?.citizenship || 'Anchored'}</div>
                          </div>
                          <div className="p-6 bg-black/60 rounded-2xl border border-[#2a2a2a]">
                            <div className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">Age</div>
                            <div className="text-lg font-bold text-white">{kycData.verified_data?.age ? `${kycData.verified_data.age}y` : 'Anchored'}</div>
                          </div>
                        </div>
                      </div>

                      <div className="fintech-card p-16 text-center bg-gradient-to-b from-purple-500/5 to-transparent">
                        <h2 className="text-4xl font-black mb-4 uppercase tracking-tighter">Pending Verification Requests</h2>
                        <p className="text-slate-500 mb-10 max-w-md mx-auto text-sm">
                          Institutions request verification of your data. You approve — ZKP proves eligibility without revealing your info.
                        </p>

                        <div className="max-w-md mx-auto flex gap-4 mb-12">
                          <input
                            type="text"
                            placeholder="Your wallet address"
                            value={inqCodeInput}
                            onChange={(e) => setInqCodeInput(e.target.value)}
                            className="flex-1 bg-black border border-[#2a2a2a] p-4 rounded-2xl text-center text-white font-mono focus:outline-none focus:border-purple-500"
                          />
                          <button
                            onClick={handleFetchPending}
                            disabled={loading}
                            className="px-8 py-4 bg-purple-500 text-white text-[10px] font-black rounded-2xl uppercase tracking-widest hover:bg-purple-600 transition-all"
                          >
                            {loading ? 'Loading...' : 'Check'}
                          </button>
                        </div>

                        {pendingRequests.length === 0 && (
                          <div className="text-slate-700 italic uppercase text-xs tracking-widest">No pending verification requests</div>
                        )}

                        {pendingRequests.map((req) => (
                          <div key={req.request_id} className="max-w-2xl mx-auto p-8 border border-purple-500/20 rounded-[2.5rem] bg-[#0A0A0A] text-left mb-6 animate-in slide-in-from-top-10 duration-1000 shadow-2xl relative overflow-hidden">
                              <div className="flex justify-between items-start mb-6">
                                <div className="space-y-2">
                                  <h3 className="text-2xl font-black uppercase text-white tracking-tight leading-none">Verification Request</h3>
                                  <p className="text-[11px] text-slate-600 font-mono tracking-widest uppercase">{req.request_id.slice(0, 24)}...</p>
                                </div>
                                <div className="px-4 py-2 bg-purple-500/10 text-purple-400 text-[10px] font-black rounded-2xl border border-purple-500/20 uppercase tracking-widest">
                                  {req.mode}
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-2 mb-6">
                                <span className="px-3 py-1.5 bg-purple-500/10 rounded-xl border border-purple-500/20 text-purple-300 text-[10px] font-bold uppercase tracking-widest">
                                  {req.institution_name || 'Unknown'}
                                </span>
                                <span className="px-3 py-1.5 bg-black rounded-xl border border-[#2a2a2a] text-slate-400 text-[10px] font-bold uppercase tracking-widest">
                                  {req.institution_type?.replace(/_/g, ' ') || 'Institution'}
                                </span>
                              </div>

                              <div className="grid md:grid-cols-2 gap-6 mb-6">
                                <div className="space-y-2">
                                  <span className="text-[11px] text-slate-600 uppercase font-black tracking-[0.2em] block">Traits Requested</span>
                                  <div className="flex flex-wrap gap-1.5">
                                    {(req.required_traits || []).map((t: string) => (
                                      <span key={t} className="px-2 py-1 bg-black rounded-lg border border-[#2a2a2a] text-slate-400 text-[9px] font-bold uppercase tracking-wider">
                                        {t.replace(/_/g, ' ')}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                                <div className="p-4 bg-black rounded-[1.5rem] border border-[#2a2a2a]">
                                  <span className="text-[11px] text-slate-600 uppercase font-black tracking-[0.2em] block mb-1">Threshold</span>
                                  <span className="text-2xl font-black text-white">${req.threshold.toLocaleString()}</span>
                                </div>
                              </div>

                              <div className="bg-purple-500/5 p-6 rounded-[1.5rem] border border-purple-500/10 mb-6 flex items-center gap-6">
                                <div className="w-10 h-10 rounded-2xl bg-purple-500/10 flex items-center justify-center text-purple-400 shrink-0">
                                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                                </div>
                                <p className="text-sm text-slate-500 font-medium">
                                  The institution will receive a <span className="text-purple-400 font-bold">mathematical proof</span> — no raw data revealed.
                                </p>
                              </div>

                            {req.status === 'fulfilled' ? (
                              <div className={`py-6 rounded-[2rem] text-center font-black uppercase flex items-center justify-center gap-4 ${req.result ? 'bg-green-500/5 border border-green-500/40 text-green-400' : 'bg-red-500/5 border border-red-500/40 text-red-500'}`}>
                                {req.result ? (
                                  <><svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg> Verified ✓</>
                                ) : (
                                  <><svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg> Rejected ✗</>
                                )}
                              </div>
                            ) : (
                              <button
                                onClick={() => handleApproveRequest(req.request_id)}
                                disabled={loading}
                                className="btn-premium w-full py-6 text-sm tracking-[0.3em]"
                              >
                                {loading ? 'Generating ZKP...' : 'Approve & Generate Proof'}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="max-w-5xl mx-auto pb-48">
          <div className="fintech-card h-[30rem] flex flex-col bg-black border-[#2a2a2a] p-10 shadow-2xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-20 transition-opacity">
              <svg className="w-48 h-48 text-purple-500" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
            </div>
            <div className="text-[10px] uppercase font-black text-slate-600 tracking-[0.6em] mb-8 flex justify-between items-center border-b border-[#2a2a2a] pb-6 relative z-10">
              <span className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                Protocol Terminal
              </span>
              <span className="text-purple-400/50">Institution Pays — USDC Only</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3 font-mono text-[10px] scrollbar-hide relative z-10">
              {logs.map((log, i) => (
                <div key={i} className={`py-2 border-b border-white/5 last:border-0 ${log.includes('[ERROR]') ? 'text-red-400' : log.includes('[SUCCESS]') ? 'text-green-400 font-bold' : log.includes('[RESULT]') ? 'text-blue-400' : log.includes('[TX]') ? 'text-blue-400' : 'text-slate-600'}`}>
                  <span className="opacity-30 mr-3">[{new Date().toLocaleTimeString()}]</span> {log}
                </div>
              ))}
              {logs.length === 0 && <div className="text-slate-800 italic uppercase font-black tracking-[1em] text-center mt-32 opacity-10 animate-pulse">Awaiting Payload...</div>}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#1a1a1a] bg-[#050505] py-32 px-6 text-center">
        <div className="max-w-7xl mx-auto space-y-12">
          <div className="flex flex-col items-center gap-4">
            <div className="text-3xl font-black tracking-tighter text-white">Trust<span className="text-purple-400">Anchor</span></div>
            <div className="h-px w-20 bg-gradient-to-r from-transparent via-purple-500/50 to-transparent" />
          </div>
          <div className="flex flex-wrap justify-center gap-12 text-[10px] font-black uppercase tracking-[0.3em] text-slate-600">
            <div className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-purple-500/40" /> Algorand</div>
            <div className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-purple-500/40" /> gnark ZKP</div>
            <div className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-purple-500/40" /> x402 USDC</div>
          </div>
          <p className="text-slate-700 text-[10px] font-medium tracking-widest leading-relaxed">
            Institutions pay. Users prove. Privacy preserved.
          </p>
        </div>
      </footer>

      <ConnectWallet openModal={openWalletModal} closeModal={() => setOpenWalletModal(false)} />

      {error && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-red-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-2xl animate-in slide-in-from-bottom-4 duration-300 z-[100]">
          {error}
          <button onClick={() => setError('')} className="ml-4 opacity-50 hover:opacity-100">×</button>
        </div>
      )}

      {successMsg && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-green-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-2xl animate-in slide-in-from-bottom-4 duration-300 z-[100]">
          {successMsg}
          <button onClick={() => setSuccessMsg('')} className="ml-4 opacity-50 hover:opacity-100">×</button>
        </div>
      )}
    </div>
  )
}

export default TrustAnchorApp
