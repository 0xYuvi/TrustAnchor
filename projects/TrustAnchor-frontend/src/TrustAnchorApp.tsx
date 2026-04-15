import { useWallet } from '@txnlab/use-wallet-react'
import React, { useState, useCallback } from 'react'
import algosdk from 'algosdk'
import ConnectWallet from './components/ConnectWallet'

const BACKEND_URL = 'http://localhost:8000'

interface ZKProofData {
  a: string
  b: string
  c?: string
  public_hash: string
}

interface VerificationResult {
  result: boolean
  user_id: string
  mode: string
  threshold: number
  proof?: ZKProofData | null
  txid?: string
}

interface KYCData {
  kyc_id: string
  commitment: string
  anchor_txid?: string
  full_name?: string
  income_annual?: number
  citizenship?: string
}

const APP_ID = 758839639
const ISSUER_ADDR = 'COBW4B43ZK4EJBWTFY6ZQIMBYMKMLBITGEMWMVHJ2UMWBGAKQBRTL223WI'
const PAYMENT_FEE = 50000

const TrustAnchorApp: React.FC = () => {
  const { activeAddress, transactionSigner, signTransactions } = useWallet()

  const [openWalletModal, setOpenWalletModal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState('idle')
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null)
  const [zkProof, setZkProof] = useState<ZKProofData | null>(null)
  const [kycData, setKycData] = useState<KYCData | null>(null)
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<string[]>([])

  const [userId, setUserId] = useState('')
  const [threshold, setThreshold] = useState(50000)
  const [secretValue, setSecretValue] = useState(75000)
  const [verificationMode, setVerificationMode] = useState<'boolean' | 'zkp'>('zkp')
  
  // Selective Disclosure State
  const [discloseName, setDiscloseName] = useState(false)
  const [discloseIncome, setDiscloseIncome] = useState(true)
  const [discloseCitizenship, setDiscloseCitizenship] = useState(false)
  const [discloseAge, setDiscloseAge] = useState(false)
  const [discloseAddress, setDiscloseAddress] = useState(false)

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg])
  }, [])

  const uploadDocument = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !activeAddress) return

    setLoading(true)
    setError('')
    setLogs([])

    try {
      setStep('kyc')
      addLog(`[KYC] Scanning document: ${file.name}...`)
      addLog(`[USER] ${activeAddress.slice(0, 8)}...`)
      
      const formData = new FormData()
      formData.append('file', file)
      formData.append('user_address', activeAddress)

      const response = await fetch(`${BACKEND_URL}/kyc/upload`, {
        method: 'POST',
        body: formData
      })
      
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.detail || 'KYC anchor failed')
      }
      
      const data = await response.json()
      setKycData(data)
      
      setStep('anchored')
      addLog('[KYC] Identity anchored successfully!')
      addLog(`[KYC_ID] ${data.kyc_id}`)
      addLog(`[COMMITMENT] ${data.commitment.slice(0, 16)}...`)
      if (data.verified_data) {
        addLog(`[DATA] Income: $${data.verified_data.income_annual?.toLocaleString()}`)
        addLog(`[DATA] Citizenship: ${data.verified_data.citizenship}`)
      }
      
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'KYC anchoring failed'
      setError(msg)
      addLog(`[ERROR] ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  const checkKYCStatus = async () => {
    if (!activeAddress) return
    
    try {
      const response = await fetch(`${BACKEND_URL}/kyc/status/${activeAddress}`)
      if (response.ok) {
        const data = await response.json()
        if (data.anchored) {
          setKycData(data)
          setStep('anchored')
        }
      }
    } catch {
      // Ignore - user hasn't anchored yet
    }
  }

  const runVerificationFlow = async () => {
    if (!activeAddress || !transactionSigner) {
      setError('Please connect wallet first')
      return
    }

    setLoading(true)
    setError('')
setStep('init')
      setVerificationResult(null)
      setZkProof(null)
      setLogs([])

      // Check if KYC anchor exists
      if (!kycData) {
        setError('Please complete KYC anchoring first')
        addLog('[ERROR] No KYC anchor found')
        setLoading(false)
        return
      }

      // Verify that secret value matches anchored income (for demo)
      if (verificationMode === 'zkp' && kycData.income_annual) {
        if (secretValue !== kycData.income_annual) {
          addLog(`[WARN] Using anchored income: $${kycData.income_annual}`)
          setSecretValue(kycData.income_annual)
        }
      }

      try {
      setStep('request')
      addLog(`[REQUEST] POST /verify/income (${verificationMode})`)
      
      const payload: any = {
        user_id: userId || activeAddress.slice(0, 8),
        mode: verificationMode,
        threshold: threshold,
      }
      
      const traits = [discloseName, discloseCitizenship, discloseAge, discloseAddress].filter(x => x).length
      addLog(`[REDACTED] Selected ${traits} out of 4 total anchored traits.`)
      if (!discloseName && kycData.verified_data?.full_name) {
          addLog(`[REDACTED] Stripping Full Name from payload...`)
      }
      if (!discloseCitizenship && kycData.verified_data?.citizenship) {
          addLog(`[REDACTED] Stripping Citizenship from payload...`)
      }
      if (!discloseAge && kycData.verified_data?.age) {
          addLog(`[REDACTED] Stripping Age from payload...`)
      }
      if (!discloseAddress && kycData.verified_data?.address) {
          addLog(`[REDACTED] Stripping Address from payload...`)
      }
      
      if (verificationMode === 'zkp') {
        payload.secret_value = secretValue
      }

      let response = await fetch('http://localhost:8000/verify/income', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      // Handle 402 Payment Required
      if (response.status === 402) {
        setStep('payment')
        const data = await response.json()
        const reqs = data.detail?.paymentRequirements?.[0] || data.detail?.[0]
        
        if (!reqs) throw new Error('Invalid 402 response: Missing payment requirements')
        const amountRequired = reqs.maximumAmountRequired || PAYMENT_FEE
        const payTo = reqs.payTo || ISSUER_ADDR

        addLog(`[PAYMENT] Payment Required: ${amountRequired / 1_000_000} ALGO`)
        
        addLog(`[TX] Fetching network params...`)
        // Initialize Algod client natively to avoid v3 .bc fetch bugs
        const algodClient = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud', '')
        const suggestedParams = await algodClient.getTransactionParams().do()
        
        addLog(`[TX] Building payment txn...`)
        // Use makePaymentTxn with BigInt cast to bypass v3 bugs while keeping correct suggestedParams mapping
        const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: activeAddress,
          receiver: payTo,
          amount: BigInt(amountRequired),
          suggestedParams: suggestedParams,
          note: new TextEncoder().encode('TrustAnchor x402 payment')
        })
        
        setStep('submit')
        addLog(`[TX] Signing with wallet...`)
        
        const encodedTxn = paymentTxn.toByte()
        const signedTxns = await signTransactions([encodedTxn])
        
        addLog(`[TX] Sending via node...`)
        const txId = paymentTxn.txID().toString()
        // @ts-ignore - wallet signing return type varies
        await algodClient.sendRawTransaction(signedTxns[0]).do()
        addLog(`[TX] Pending: ${txId}`)
        
        addLog(`[TX] Waiting for confirmation...`)
        await algosdk.waitForConfirmation(algodClient, txId, 4)
        addLog(`[TX] Confirmed!`)
        
        setStep('prove')
        addLog(`[REQUEST] Resubmitting with payment proof...`)
        response = await fetch('http://localhost:8000/verify/income', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X402-Payment-Proof': txId
          },
          body: JSON.stringify(payload)
        })
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.detail?.message || errData.detail || errData.error || `Server returned ${response.status}`)
      }

      const finalData = await response.json()
      addLog(`[SERVER] Verified: ${finalData.result}`)
      
      setStep('complete')
      addLog('[SUCCESS] Verification complete!')

      setVerificationResult(finalData)
      setZkProof(finalData.proof?.proof || null)
      
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed'
      setError(msg)
      addLog(`[ERROR] ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <nav className="p-4 border-b border-slate-700 flex justify-between items-center">
        <div className="text-xl font-bold">Trust<span className="text-purple-400">Anchor</span></div>
        <button onClick={() => setOpenWalletModal(true)} className="px-4 py-2 bg-purple-600 rounded-lg">
          {activeAddress ? `${activeAddress.slice(0, 8)}...` : 'Connect Wallet'}
        </button>
      </nav>

      <main className="p-8">
        <h1 className="text-4xl font-bold mb-8 text-center">Truth-as-a-Service</h1>

        {/* KYC Anchor Section */}
        {!kycData && (
          <div className="mb-8 p-6 bg-gradient-to-r from-blue-900/50 to-purple-900/50 rounded-xl border border-blue-500/30">
            <h2 className="text-2xl font-bold mb-4 text-center">Trusted Identity Portal</h2>
            <p className="text-slate-300 mb-4 text-center">
              Anchor your verified identity before requesting verification
            </p>
            <div className="relative group w-full p-4 bg-gradient-to-r from-blue-600 to-cyan-600 rounded-lg font-bold text-center cursor-pointer overflow-hidden border border-blue-400/50 hover:brightness-110 transition-all">
              <input 
                type="file" 
                accept=".pdf" 
                onChange={uploadDocument}
                disabled={loading || !activeAddress}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
              />
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Scanning Document...</span>
                </div>
              ) : 'Upload Aadhaar / Bank PDF'}
            </div>
          </div>
        )}

        {/* KYC Status & Selective Disclosure */}
        {kycData && (
          <div className="mb-8 p-6 bg-slate-800/80 rounded-lg border border-slate-600">
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700">
              <span className="text-green-400 text-xl">✓</span>
              <span className="font-bold text-green-400 text-xl">Identity Anchored Successfully</span>
            </div>
            
            <div className="grid md:grid-cols-2 gap-6">
              <div className="text-sm text-slate-300 space-y-2 font-mono bg-black/30 p-4 rounded-lg">
                <div className="text-purple-400 mb-2 font-bold font-sans">On-Chain Commitment</div>
                <div>ID: {kycData.kyc_id}</div>
                <div>Hash: {kycData.commitment?.slice(0, 32)}...</div>
              </div>
              
              <div className="space-y-3">
                <div className="text-white mb-2 font-bold flex items-center justify-between">
                  <span>Selective Disclosure</span>
                  <span className="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full border border-purple-500/30 uppercase tracking-widest">Privacy Guard</span>
                </div>
                <div className="text-xs text-slate-400 mb-4 bg-slate-900/30 p-2 rounded border border-slate-800">
                  Select which verified attributes to include in your Zero-Knowledge Proof. Attributes not selected will be physically redacted.
                </div>
                
                <div className="grid gap-2">
                  {kycData.verified_data?.full_name && (
                    <label className={`flex items-center gap-3 p-3 rounded border transition-all cursor-pointer ${discloseName ? 'bg-purple-900/20 border-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.1)]' : 'bg-slate-900/50 border-slate-700 hover:border-slate-500'}`}>
                      <input type="checkbox" checked={discloseName} onChange={(e) => setDiscloseName(e.target.checked)} className="w-5 h-5 accent-purple-500 rounded" />
                      <div className="flex flex-col">
                        <span className="text-[10px] text-slate-400 uppercase font-bold">Full Name</span>
                        <span className="font-bold text-white text-sm">{kycData.verified_data.full_name}</span>
                      </div>
                    </label>
                  )}
                  
                  {kycData.verified_data?.citizenship && (
                    <label className={`flex items-center gap-3 p-3 rounded border transition-all cursor-pointer ${discloseCitizenship ? 'bg-purple-900/20 border-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.1)]' : 'bg-slate-900/50 border-slate-700 hover:border-slate-500'}`}>
                      <input type="checkbox" checked={discloseCitizenship} onChange={(e) => setDiscloseCitizenship(e.target.checked)} className="w-5 h-5 accent-purple-500 rounded" />
                      <div className="flex flex-col">
                        <span className="text-[10px] text-slate-400 uppercase font-bold">Citizenship</span>
                        <span className="font-bold text-white text-sm">{kycData.verified_data.citizenship}</span>
                      </div>
                    </label>
                  )}

                  {kycData.verified_data?.age !== undefined && kycData.verified_data.age > 0 && (
                    <label className={`flex items-center gap-3 p-3 rounded border transition-all cursor-pointer ${discloseAge ? 'bg-purple-900/20 border-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.1)]' : 'bg-slate-900/50 border-slate-700 hover:border-slate-500'}`}>
                      <input type="checkbox" checked={discloseAge} onChange={(e) => setDiscloseAge(e.target.checked)} className="w-5 h-5 accent-purple-500 rounded" />
                      <div className="flex flex-col">
                        <span className="text-[10px] text-slate-400 uppercase font-bold">Calculated Age</span>
                        <span className="font-bold text-white text-sm">{kycData.verified_data.age} Years</span>
                      </div>
                    </label>
                  )}

                  {kycData.verified_data?.address && (
                    <label className={`flex items-start gap-3 p-3 rounded border transition-all cursor-pointer ${discloseAddress ? 'bg-purple-900/20 border-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.1)]' : 'bg-slate-900/50 border-slate-700 hover:border-slate-500'}`}>
                      <input type="checkbox" checked={discloseAddress} onChange={(e) => setDiscloseAddress(e.target.checked)} className="w-5 h-5 accent-purple-500 rounded mt-0.5" />
                      <div className="flex flex-col">
                        <span className="text-[10px] text-slate-400 uppercase font-bold">Residential Address</span>
                        <span className={`font-bold text-white text-[11px] leading-tight ${kycData.verified_data.address === "Address not found" ? 'text-red-400 italic' : ''}`}>
                          {kycData.verified_data.address}
                        </span>
                      </div>
                    </label>
                  )}

                  {kycData.verified_data?.income_annual !== undefined && (
                    <div className="flex items-center gap-3 p-3 bg-green-900/10 rounded border border-green-500/30">
                      <div className="w-5 h-5 flex items-center justify-center bg-green-500/20 rounded text-green-400 text-[10px]">🔒</div>
                      <div className="flex flex-col">
                        <span className="text-[10px] text-green-400 uppercase font-bold">Anchored Income</span>
                        <span className="font-bold text-white text-sm">${kycData.verified_data.income_annual.toLocaleString()}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-8">
          <div className="space-y-4">
            <input
              type="text"
              placeholder="User ID"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-full p-3 bg-slate-800 rounded border border-slate-700"
            />
            <input
              type="number"
              placeholder="Threshold"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-full p-3 bg-slate-800 rounded border border-slate-700"
            />
            {verificationMode === 'zkp' && (
              <input
                type="number"
                placeholder="Your Income"
                value={secretValue}
                onChange={(e) => setSecretValue(Number(e.target.value))}
                className="w-full p-3 bg-green-900/30 rounded border border-green-700"
              />
            )}
            <div className="flex gap-2">
              <button onClick={() => setVerificationMode('boolean')} className={`flex-1 p-3 rounded ${verificationMode === 'boolean' ? 'bg-slate-600' : 'bg-slate-800'}`}>Boolean</button>
              <button onClick={() => setVerificationMode('zkp')} className={`flex-1 p-3 rounded ${verificationMode === 'zkp' ? 'bg-purple-600' : 'bg-slate-800'}`}>ZK Proof</button>
            </div>
            <button
              onClick={runVerificationFlow}
              disabled={loading || !activeAddress}
              className="w-full p-4 bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg font-bold disabled:opacity-50"
            >
              {loading ? 'Processing...' : 'Run Verification'}
            </button>
            {error && <div className="text-red-400 p-2">{error}</div>}
          </div>

          <div className="space-y-4">
            <div className="bg-slate-800 p-4 rounded">
              <div className="text-sm text-slate-400 mb-2">Verification Flow</div>
              <div className="flex flex-wrap gap-2">
                {['init', 'request', 'payment', 'prove', 'submit', 'verify', 'complete'].map((s) => (
                  <div key={s} className={`px-3 py-1 rounded ${step === s ? 'bg-purple-500' : ['init', 'complete'].includes(step) && ['init', 'request', 'payment', 'prove', 'submit', 'verify', 'complete'].indexOf(step) > ['init', 'request', 'payment', 'prove', 'submit', 'verify', 'complete'].indexOf(s) ? 'bg-green-500/30 text-green-400' : 'bg-slate-700'}`}>
                    {s}
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-black/50 p-4 rounded font-mono text-sm max-h-64 overflow-y-auto">
              {logs.map((log, i) => <div key={i} className="text-slate-300">{log}</div>)}
              {logs.length === 0 && <div className="text-slate-500">Press Run Verification</div>}
            </div>

            {verificationResult && (
              <div className="bg-green-900/30 p-4 rounded border border-green-500">
                <div className="text-green-400 font-bold">VERIFIED</div>
                <div className="text-sm mt-2">
                  Mode: {verificationResult.mode}<br/>
                  Threshold: ${verificationResult.threshold}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <ConnectWallet openModal={openWalletModal} closeModal={() => setOpenWalletModal(false)} />
    </div>
  )
}

export default TrustAnchorApp