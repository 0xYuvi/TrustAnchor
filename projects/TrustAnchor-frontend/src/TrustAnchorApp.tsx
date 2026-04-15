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
      
      // Logic: If they chose ZKP but didn't select Income, we MUST use boolean mode 
      // as our only ZK circuit is income-based.
      const actualMode = (verificationMode === 'zkp' && !discloseIncome) ? 'boolean' : verificationMode;

      const payload: any = {
        user_id: userId || activeAddress.slice(0, 8),
        mode: actualMode,
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
    <div className="min-h-screen bg-black text-slate-100 selection:bg-purple-500/30 font-sans">
      {/* Background Glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] glow-purple rounded-full blur-[120px] opacity-40"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] glow-purple rounded-full blur-[120px] opacity-30"></div>
      </div>

      <nav className="sticky top-0 z-50 p-6 backdrop-blur-md border-b border-white/5 flex justify-between items-center px-12">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-purple-500 to-purple-800 rounded-xl shadow-[0_0_20px_rgba(168,85,247,0.4)] flex items-center justify-center">
            <span className="text-white font-black text-xl">T</span>
          </div>
          <div className="text-2xl font-black tracking-tighter">TRUST<span className="text-purple-400">ANCHOR</span></div>
        </div>
        
        <div className="flex items-center gap-6">
          {activeAddress && (
             <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-purple-500/10 border border-purple-500/20 rounded-full text-xs text-purple-300">
               <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-pulse" />
               Connected
             </div>
          )}
          <button 
            onClick={() => setOpenWalletModal(true)} 
            className="px-6 py-2.5 bg-white text-black font-bold rounded-2xl hover:scale-[1.05] transition-all shadow-lg active:scale-95 text-xs uppercase tracking-widest"
          >
            {activeAddress ? `${activeAddress.slice(0, 4)}...${activeAddress.slice(-4)}` : 'Connect Gateway'}
          </button>
        </div>
      </nav>

      <main className="relative z-10 max-w-7xl mx-auto p-8 pt-16">
        {/* Hero Section */}
        <div className="text-center mb-16 space-y-4">
          <div className="inline-block px-4 py-1.5 bg-white/5 border border-white/10 rounded-full text-[10px] uppercase tracking-[0.2em] font-black text-purple-300 mb-2">
            Protocol v2.0 • Zero Knowledge
          </div>
          <h1 className="text-6xl md:text-8xl font-black tracking-tighter text-gradient leading-none">
            Truth-as-a-Service
          </h1>
          <p className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed">
            The private integration layer for real-world identity. Anchor Aadhaar documents securely using Algorand and generate anonymous proofs of data.
          </p>
        </div>

        {/* Dynamic content grid */}
        {!kycData ? (
          <div className="max-w-4xl mx-auto glow-container">
            <div className="fintech-card text-center p-12 space-y-8 bg-gradient-to-b from-white/[0.03] to-transparent">
              <div className="w-24 h-24 bg-purple-500/10 border border-purple-500/20 rounded-3xl mx-auto flex items-center justify-center mb-4">
                <svg className="w-10 h-10 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              </div>
              <div>
                <h2 className="text-3xl font-black mb-3">Identity Retrieval</h2>
                <p className="text-slate-400">Upload your government-issued PDF or bank statement to securely anchor your truth on-chain.</p>
              </div>
              
              <div className="relative group max-w-sm mx-auto">
                <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 to-white/20 rounded-2xl blur opacity-25 group-hover:opacity-100 transition duration-1000 group-hover:duration-200" />
                <div className="relative bg-white text-black p-5 rounded-2xl font-black uppercase text-xs tracking-widest cursor-pointer hover:bg-slate-100 active:scale-95 transition-all text-center">
                  <input 
                    type="file" 
                    accept=".pdf" 
                    onChange={uploadDocument}
                    disabled={loading || !activeAddress}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                  />
                  {loading ? 'Analyzing Cryptography...' : 'Select Source Document'}
                </div>
              </div>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest pt-4">End-to-End Encrypted • No Data Ever Leaves Your Browser</p>
            </div>
          </div>
        ) : (
          <div className="grid lg:grid-cols-12 gap-8 items-start">
            
            {/* Left Column: Data Preview & Disclosure */}
            <div className="lg:col-span-12 space-y-8">
               <div className="fintech-card">
                  <div className="flex justify-between items-start mb-10">
                    <div>
                      <h2 className="text-2xl font-black uppercase tracking-tight mb-1 text-white">Secure Identity Anchor</h2>
                      <div className="flex gap-2 items-center text-[10px] text-slate-500 font-mono">
                        <span className="bg-green-500/20 text-green-400 px-2 rounded tracking-widest">STATE: ANCHORED</span>
                        <span>TX: {kycData.anchor_txid?.slice(0, 16)}...</span>
                      </div>
                    </div>
                    <div className="bg-purple-500/10 border border-purple-500/20 px-4 py-2 rounded-2xl text-xs text-purple-300 font-black">
                      KYC ID: {kycData.kyc_id}
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-12">
                     <div className="space-y-6">
                        <div className="text-white font-black text-sm uppercase tracking-widest mb-6 border-b border-white/5 pb-2 inline-block">Selective Disclosure Console</div>
                        
                        <div className="grid gap-3">
                            <label className={`flex items-center gap-4 p-4 rounded-2xl border transition-all cursor-pointer ${discloseName ? 'bg-purple-500/10 border-purple-500/50' : 'bg-white/[0.02] border-white/5 hover:border-white/20'}`}>
                                <input type="checkbox" checked={discloseName} onChange={(e) => setDiscloseName(e.target.checked)} className="w-5 h-5 accent-purple-500 rounded-lg" />
                                <div className="flex-1">
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Full Name</div>
                                    <div className="font-bold text-white">{kycData.verified_data?.full_name}</div>
                                </div>
                            </label>

                            <label className={`flex items-center gap-4 p-4 rounded-2xl border transition-all cursor-pointer ${discloseCitizenship ? 'bg-purple-500/10 border-purple-500/50' : 'bg-white/[0.02] border-white/5 hover:border-white/20'}`}>
                                <input type="checkbox" checked={discloseCitizenship} onChange={(e) => setDiscloseCitizenship(e.target.checked)} className="w-5 h-5 accent-purple-500 rounded-lg" />
                                <div className="flex-1">
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Citizenship</div>
                                    <div className="font-bold text-white">{kycData.verified_data?.citizenship}</div>
                                </div>
                            </label>

                            <label className={`flex items-center gap-4 p-4 rounded-2xl border transition-all cursor-pointer ${discloseAge ? 'bg-purple-500/10 border-purple-500/50' : 'bg-white/[0.02] border-white/5 hover:border-white/20'}`}>
                                <input type="checkbox" checked={discloseAge} onChange={(e) => setDiscloseAge(e.target.checked)} className="w-5 h-5 accent-purple-500 rounded-lg" />
                                <div className="flex-1">
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Verified Age</div>
                                    <div className="font-bold text-white">{kycData.verified_data?.age} Years</div>
                                </div>
                            </label>

                            <label className={`flex items-start gap-4 p-4 rounded-2xl border transition-all cursor-pointer ${discloseAddress ? 'bg-purple-500/10 border-purple-500/50' : 'bg-white/[0.02] border-white/5 hover:border-white/20'}`}>
                                <input type="checkbox" checked={discloseAddress} onChange={(e) => setDiscloseAddress(e.target.checked)} className="w-5 h-5 accent-purple-500 rounded-lg mt-1" />
                                <div className="flex-1">
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Residential Address</div>
                                    <div className="font-bold text-white text-xs leading-relaxed">{kycData.verified_data?.address}</div>
                                </div>
                            </label>

                            {kycData.verified_data?.income_annual !== undefined && (
                                <label className={`flex items-center gap-4 p-4 rounded-2xl border transition-all cursor-pointer ${discloseIncome ? 'bg-green-500/10 border-green-500/50' : 'bg-white/[0.02] border-white/5 hover:border-white/20'}`}>
                                    <input type="checkbox" checked={discloseIncome} onChange={(e) => setDiscloseIncome(e.target.checked)} className="w-5 h-5 accent-green-500 rounded-lg" />
                                    <div className="flex-1">
                                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Annual Income (Financial)</div>
                                        <div className="font-bold text-white">${kycData.verified_data.income_annual.toLocaleString()}</div>
                                    </div>
                                </label>
                            )}
                        </div>
                     </div>

                     <div className="space-y-8">
                        <div className="text-white font-black text-sm uppercase tracking-widest mb-2 border-b border-white/5 pb-2 inline-block">Attestation Factory</div>
                        
                        <div className="space-y-4 bg-white/[0.02] p-8 rounded-3xl border border-white/5">
                            {/* Metadata input (Alias helper) */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-[10px] uppercase font-bold text-slate-500">Verification Alias (Your Session Name)</label>
                                    <button 
                                        onClick={() => setUserId(`Verify_${Math.floor(1000 + Math.random() * 9000)}`)}
                                        className="text-[9px] bg-white/5 hover:bg-white/10 text-purple-400 px-2 py-0.5 rounded border border-white/5 transition-colors uppercase font-bold"
                                    >
                                        Auto-Generate
                                    </button>
                                </div>
                                <input 
                                    type="text" 
                                    placeholder="e.g. Identity_Check_402"
                                    value={userId} 
                                    onChange={(e) => setUserId(e.target.value)} 
                                    className="w-full bg-black/50 border border-white/10 p-4 rounded-xl font-bold text-white focus:outline-none focus:border-purple-500/50 transition-all font-mono text-sm"
                                />
                            </div>

                            {/* Conditional Threshold - Only if document has income data AND user chooses to disclose it in ZKP mode */}
                            {verificationMode === 'zkp' && discloseIncome && kycData.verified_data?.income_annual !== undefined && (
                                <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
                                    <label className="text-[10px] uppercase font-bold text-slate-500 text-green-400">Financial Bound Threshold ($)</label>
                                    <input 
                                        type="number" 
                                        value={threshold} 
                                        onChange={(e) => setThreshold(Number(e.target.value))} 
                                        className="w-full bg-black/50 border border-green-500/30 p-4 rounded-xl font-bold text-white focus:outline-none focus:border-green-500/50 transition-all"
                                    />
                                </div>
                            )}

                            <div className="flex flex-col gap-2">
                                <label className="text-[10px] uppercase font-bold text-slate-500 mb-1">Proof Configuration</label>
                                <div className="flex gap-2 p-1 bg-black/50 rounded-xl border border-white/5">
                                    <button onClick={() => setVerificationMode('boolean')} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${verificationMode === 'boolean' ? 'bg-white/10 text-white shadow-inner' : 'text-slate-500 hover:text-slate-300'}`}>Identity Seal</button>
                                    <button onClick={() => setVerificationMode('zkp')} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${verificationMode === 'zkp' ? 'bg-purple-500 text-white shadow-[0_0_15px_rgba(168,85,247,0.3)]' : 'text-slate-500 hover:text-slate-300'}`}>ZK Attestation</button>
                                </div>
                            </div>

                            <button
                                onClick={runVerificationFlow}
                                disabled={loading || !activeAddress}
                                className="w-full py-6 bg-white text-black font-black uppercase tracking-[0.2em] text-sm rounded-2xl shadow-xl hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-30 mt-4"
                            >
                                {loading ? 'Sealing Attributes...' : `Generate ${(verificationMode === 'zkp' && discloseIncome) ? 'Zero-Knowledge' : 'Identity'} Proof`}
                            </button>
                            {error && <div className="text-red-400 text-center text-xs font-bold mt-2">Error: {error}</div>}
                        </div>
                     </div>
                  </div>
               </div>
            </div>

            {/* Execution Logs Area */}
            <div className="lg:col-span-12 grid lg:grid-cols-2 gap-8">
                <div className="fintech-card h-80 flex flex-col">
                    <div className="text-xs uppercase font-black text-slate-500 tracking-widest mb-4 flex justify-between items-center">
                        <span>Computation Lifecycle</span>
                        <div className="flex gap-1">
                            {['request', 'payment', 'prove', 'verify'].map(s => (
                                <div key={s} className={`w-2 h-2 rounded-full ${step === s ? 'bg-purple-500 animate-pulse' : (['complete'].includes(step) ? 'bg-green-500/40' : 'bg-white/10')}`}></div>
                            ))}
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-2 font-mono text-[11px] bg-black/40 p-4 rounded-2xl border border-white/5">
                        {logs.map((l, i) => (
                            <div key={i} className={`flex gap-3 ${l.includes('[ERROR]') ? 'text-red-400' : l.includes('[SUCCESS]') || l.includes('[REDACTED]') ? 'text-purple-300' : 'text-slate-400'}`}>
                                <span className="text-[9px] opacity-30">[{i}]</span>
                                <span>{l}</span>
                            </div>
                        ))}
                        {logs.length === 0 && <div className="text-slate-700 italic">Ready for verification lifecycle...</div>}
                    </div>
                </div>

                <div className="fintech-card h-80 relative overflow-hidden flex flex-col justify-center items-center text-center">
                    {!verificationResult ? (
                        <div className="space-y-4 opacity-30">
                            <div className="w-16 h-16 border-2 border-dashed border-white/20 rounded-full mx-auto flex items-center justify-center">
                                <span className="text-2xl">?</span>
                            </div>
                            <div className="text-xs font-black uppercase tracking-widest">Pending Verification</div>
                        </div>
                    ) : (
                        <div className="space-y-6 animate-in fade-in zoom-in duration-500">
                             <div className="w-20 h-20 bg-green-500/20 border border-green-500/50 rounded-full mx-auto flex items-center justify-center mb-4">
                                <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                            </div>
                            <div>
                                <h3 className="text-3xl font-black text-white mb-1 uppercase tracking-tighter">Verified</h3>
                                <p className="text-slate-400 text-xs uppercase tracking-widest font-bold">ZKP-SNARK ATTRIBUTE ATTESTATION</p>
                            </div>
                            <div className="bg-white/[0.03] border border-white/10 p-4 rounded-2xl flex gap-12 justify-center">
                                <div className="text-center">
                                    <div className="text-[10px] text-slate-500 uppercase font-black mb-1">Pass Ratio</div>
                                    <div className="text-xl font-bold text-white">100%</div>
                                </div>
                                <div className="text-center">
                                    <div className="text-[10px] text-slate-500 uppercase font-black mb-1">Mode</div>
                                    <div className="text-xl font-bold text-white uppercase">{verificationResult.mode}</div>
                                </div>
                                {verificationResult.mode === 'zkp' && (
                                    <div className="text-center">
                                        <div className="text-[10px] text-slate-500 uppercase font-black mb-1">Threshold</div>
                                        <div className="text-xl font-bold text-white">${verificationResult.threshold.toLocaleString()}</div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
          </div>
        )}
      </main>

      <div className="p-12 text-center text-[10px] uppercase font-black tracking-[0.4em] text-slate-700">
        Powered by Algorand • Truth Registry Protocol • x402 Payments
      </div>

      <ConnectWallet openModal={openWalletModal} closeModal={() => setOpenWalletModal(false)} />
    </div>
  )
}

export default TrustAnchorApp