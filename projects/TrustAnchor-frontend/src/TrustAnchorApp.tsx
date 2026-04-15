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
  verified_data?: any
}

const APP_ID = 758839639
const ISSUER_ADDR = 'COBW4B43ZK4EJBWTFY6ZQIMBYMKMLBITGEMWMVHJ2UMWBGAKQBRTL223WI'
const PAYMENT_FEE = 50000

const TrustAnchorApp: React.FC = () => {
  const { activeAddress, transactionSigner, signTransactions } = useWallet()

  const [openWalletModal, setOpenWalletModal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState('idle')
  const [verificationResult, setVerificationResult] = useState<any>(null)
  const [kycData, setKycData] = useState<KYCData | null>(null)
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<string[]>([])

  const [userId, setUserId] = useState('')
  const [threshold, setThreshold] = useState(50000)
  const [verificationMode, setVerificationMode] = useState<'boolean' | 'zkp'>('zkp')
  
  const [portalMode, setPortalMode] = useState<'citizen' | 'verifier'>('citizen')
  const [attestationCode, setAttestationCode] = useState<string | null>(null)
  
  // Inquiry Flow State
  const [inquiryCode, setInquiryCode] = useState('')
  const [activeInquiry, setActiveInquiry] = useState<any>(null)
  
  // Verifier Request State
  const [reqTraits, setReqTraits] = useState<string[]>(['income_annual'])

  // Selective Disclosure State (Citizen View)
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
    } catch (err: any) {
      setError(err.message)
      addLog(`[ERROR] ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // --- ENTERPRISE LOGIC ---

  const runCreateInquiryFlow = async () => {
    if (!activeAddress || !transactionSigner) {
      setError('Verifier: Connect wallet')
      return
    }

    setLoading(true)
    setError('')
    setLogs([])
    addLog('[VERIFIER] Initiating Identity Inquiry...')

    const payload = {
      user_id: "ANONYMOUS_PROVER",
      mode: verificationMode,
      threshold: threshold,
      requested_traits: reqTraits
    }

    try {
      setStep('request')
      let response = await fetch(`${BACKEND_URL}/inquiry/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (response.status === 402) {
        setStep('payment')
        const data = await response.json()
        const reqs = data.detail?.paymentRequirements?.[0] || data.detail?.[0]
        
        const amountRequired = reqs.maximumAmountRequired || PAYMENT_FEE
        const payTo = reqs.payTo || ISSUER_ADDR

        addLog(`[PAYMENT] Inquiry Fee Required: ${amountRequired / 1_000_000} ALGO`)
        
        const algodClient = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud', '')
        const suggestedParams = await algodClient.getTransactionParams().do()
        
        const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: activeAddress,
          receiver: payTo,
          amount: BigInt(amountRequired),
          suggestedParams: suggestedParams,
          note: new TextEncoder().encode(`TrustAnchor Inquiry: ${verificationMode}`)
        })
        
        setStep('submit')
        const encodedTxn = paymentTxn.toByte()
        const signedTxns = await signTransactions([encodedTxn])
        const txId = paymentTxn.txID().toString()
        await algodClient.sendRawTransaction(signedTxns[0]).do()
        
        addLog(`[TX] Confirmed: ${txId}`)
        await algosdk.waitForConfirmation(algodClient, txId, 4)
        
        setStep('verify')
        response = await fetch(`${BACKEND_URL}/inquiry/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X402-Payment-Proof': txId
          },
          body: JSON.stringify(payload)
        })
      }

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.detail || 'Inquiry creation failed')
      }

      const inquiryData = await response.json()
      setAttestationCode(inquiryData.inquiry_id)
      setStep('complete')
      addLog(`[SUCCESS] Inquiry Issued: ${inquiryData.inquiry_id}`)
    } catch (err: any) {
      setError(err.message)
      addLog(`[ERROR] ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const checkInquiryStatus = async (id: string) => {
    try {
      const resp = await fetch(`${BACKEND_URL}/inquiry/status/${id}`)
      const data = await resp.json()
      if (data.status === 'fulfilled') {
         setVerificationResult(data)
         addLog(`[VERIFIER] Request fulfilled! Result: ${data.result}`)
      }
    } catch (e) {}
  }

  // --- CITIZEN LOGIC ---

  const runFetchInquiry = async (code: string) => {
    setLoading(true)
    setError('')
    try {
      const resp = await fetch(`${BACKEND_URL}/inquiry/status/${code}`)
      if (!resp.ok) throw new Error('Invalid inquiry code')
      const data = await resp.json()
      setActiveInquiry(data)
      setThreshold(data.threshold)
      setVerificationMode(data.mode)
      addLog(`[SUCCESS] Inquiry Loaded: ${data.mode} check for $${data.threshold}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const runFulfillInquiry = async () => {
    if (!activeAddress || !kycData || !activeInquiry) return

    setLoading(true)
    setError('')
    try {
      setStep('request')
      addLog('[CITIZEN] Generating ZK-Proof for inquiry...')
      
      const genResp = await fetch(`${BACKEND_URL}/attestation/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: activeAddress.slice(0, 8),
          mode: activeInquiry.mode,
          threshold: activeInquiry.threshold,
          secret_value: kycData.verified_data?.income_annual || 0
        })
      })

      if (!genResp.ok) throw new Error('Proof generation failed')
      const proofData = await genResp.json()

      const fulfillResp = await fetch(`${BACKEND_URL}/inquiry/fulfill/${activeInquiry.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proof: proofData.proof,
          public_inputs: proofData.public_inputs,
          user_id: activeAddress.slice(0, 8),
          threshold: activeInquiry.threshold,
          mode: activeInquiry.mode
        })
      })

      if (!fulfillResp.ok) throw new Error('Fulfillment failed')
      
      setStep('complete')
      addLog('[SUCCESS] Inquiry fulfilled!')
      setActiveInquiry((prev: any) => ({ ...prev, status: 'fulfilled', result: true }))
    } catch (err: any) {
      setError(err.message)
      addLog(`[ERROR] ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-black text-slate-100 font-sans selection:bg-purple-500/30">
      {/* Background Decor */}
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
            Citizen Mode
          </button>
          <button 
            onClick={() => setPortalMode('verifier')}
            className={`px-8 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${portalMode === 'verifier' ? 'bg-purple-500 text-white shadow-[0_0_20px_rgba(168,85,247,0.4)]' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Enterprise Gate
          </button>
        </div>

        <button 
          onClick={() => setOpenWalletModal(true)} 
          className="px-6 py-2.5 bg-white text-black font-black rounded-2xl hover:scale-105 transition-all shadow-lg text-[10px] uppercase tracking-widest"
        >
          {activeAddress ? `${activeAddress.slice(0, 4)}...${activeAddress.slice(-4)}` : 'Connect Wallet'}
        </button>
      </nav>

      <main className="relative z-10 max-w-7xl mx-auto p-8 pt-16">
        {/* Hero Section */}
        <div className="text-center mb-16 space-y-4">
          <div className="inline-block px-4 py-1.5 bg-white/5 border border-white/10 rounded-full text-[10px] uppercase tracking-[0.2em] font-black text-purple-300 mb-2">
            Protocol v2.5 • Zero Knowledge 
          </div>
          <h1 className="text-6xl md:text-8xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-b from-white to-white/40 leading-none">
            Truth-as-a-Service
          </h1>
          <p className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed italic">
            Private identity verification where verifiers take the lead. Secure, anonymous, and on-chain.
          </p>
        </div>

        {portalMode === 'verifier' ? (
          /* ENTERPRISE/VERIFIER VIEW */
          <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in zoom-in duration-500">
             <div className="fintech-card p-12 text-center space-y-8 bg-gradient-to-tr from-purple-900/10 to-transparent">
                <div className="w-20 h-20 bg-purple-500/20 border border-purple-500/40 rounded-full mx-auto flex items-center justify-center">
                  <svg className="w-10 h-10 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                </div>
                <div>
                  <h2 className="text-4xl font-black mb-4 uppercase tracking-tighter">Inquiry Generator</h2>
                  <p className="text-slate-400 max-w-xl mx-auto">Set verification requirements and issue a secure inquiry code. The fee is paid up-front by you.</p>
                </div>
                
                <div className="grid md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                    <div className="space-y-2 text-left">
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest">Income Bound ($)</label>
                        <input 
                            type="number" 
                            value={threshold} 
                            onChange={(e) => setThreshold(Number(e.target.value))} 
                            className="w-full bg-black/50 border border-white/10 p-4 rounded-xl font-black text-white focus:outline-none focus:border-purple-500 font-mono"
                        />
                    </div>
                    <div className="space-y-2 text-left">
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest">Proof Protocol</label>
                        <select 
                            value={verificationMode}
                            onChange={(e: any) => setVerificationMode(e.target.value)}
                            className="w-full bg-black/50 border border-white/10 p-4 rounded-xl font-black text-white focus:outline-none uppercase text-xs"
                        >
                            <option value="boolean">Identity Seal (Boolean)</option>
                            <option value="zkp">ZK Attestation (ZKP)</option>
                        </select>
                    </div>
                </div>

                <div className="max-w-2xl mx-auto space-y-4">
                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block text-left">Requested Attributes</label>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {[
                          { id: 'full_name', label: 'Full Name' },
                          { id: 'age', label: 'Verified Age' },
                          { id: 'income_annual', label: 'Annual Income' },
                          { id: 'citizenship', label: 'Citizenship' },
                          { id: 'address', label: 'Residency' }
                        ].map(trait => (
                          <button 
                            key={trait.id}
                            onClick={() => {
                              setReqTraits(prev => 
                                prev.includes(trait.id) ? prev.filter(t => t !== trait.id) : [...prev, trait.id]
                              )
                            }}
                            className={`px-4 py-3 rounded-xl border text-[10px] font-black uppercase tracking-tighter transition-all ${reqTraits.includes(trait.id) ? 'bg-purple-500/20 border-purple-500 text-white' : 'bg-white/5 border-white/5 text-slate-500 hover:border-white/20'}`}
                          >
                            {trait.label}
                          </button>
                        ))}
                    </div>
                </div>

                <div className="max-w-2xl mx-auto pt-4">
                  <button 
                    onClick={runCreateInquiryFlow}
                    disabled={loading || !activeAddress}
                    className="w-full py-6 rounded-2xl bg-purple-600 hover:bg-purple-500 text-white font-black uppercase tracking-[0.3em] shadow-[0_0_30px_rgba(147,51,234,0.3)] transition-all active:scale-95 disabled:opacity-30"
                  >
                    {loading ? 'Issuing Protocol Inquiry...' : 'Issue Paid Inquiry Request'}
                  </button>
                </div>

                {attestationCode && (
                   <div className="mt-8 p-8 bg-green-500/10 border border-green-500/30 rounded-3xl animate-in zoom-in duration-500 max-w-2xl mx-auto border-dashed">
                      <div className="text-[10px] font-black text-green-400 uppercase tracking-[0.4em] mb-4">Request Issued Successfully</div>
                      <div className="text-6xl font-black text-white tracking-widest mb-6 font-mono select-all">
                        {attestationCode}
                      </div>
                      <div className="flex gap-4 justify-center">
                        <button 
                          onClick={() => {
                            navigator.clipboard.writeText(attestationCode);
                            addLog('[UI] Code copied!');
                          }}
                          className="px-8 py-3 bg-green-500 text-black font-black uppercase tracking-widest text-[10px] rounded-xl hover:scale-105 active:scale-95 transition-all"
                        >
                          Copy Code
                        </button>
                        <button 
                          onClick={() => attestationCode && checkInquiryStatus(attestationCode)}
                          className="px-8 py-3 bg-white text-black font-black uppercase tracking-widest text-[10px] rounded-xl hover:scale-105 active:scale-95 transition-all"
                        >
                          Check Status
                        </button>
                      </div>
                   </div>
                )}

                {verificationResult && (
                    <div className="mt-8 p-12 fintech-card border-green-500 bg-green-500/5 animate-pulse max-w-2xl mx-auto flex items-center justify-center gap-6">
                        <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center border border-green-500/40">
                            <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                        </div>
                        <div className="text-left">
                            <h3 className="text-4xl font-black text-white uppercase italic tracking-tighter leading-none">Verified</h3>
                            <p className="text-green-400 font-bold uppercase tracking-widest text-[10px]">Proof satisfies all protocol constraints</p>
                        </div>
                    </div>
                )}
             </div>
          </div>
        ) : (
          /* CITIZEN/PROVER VIEW */
          <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in zoom-in duration-500">
            {!kycData ? (
                 <div className="fintech-card text-center p-12 space-y-8 bg-gradient-to-b from-white/[0.03] to-transparent">
                     <div className="w-24 h-24 bg-purple-500/10 border border-purple-500/20 rounded-3xl mx-auto flex items-center justify-center mb-4">
                        <svg className="w-10 h-10 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                      </div>
                      <div>
                        <h2 className="text-3xl font-black mb-3">Identity Anchor</h2>
                        <p className="text-slate-400">Upload your government-issued document to securely participate.</p>
                      </div>
                      <div className="relative group max-w-sm mx-auto">
                        <div className="relative bg-white text-black p-5 rounded-2xl font-black uppercase text-xs tracking-widest cursor-pointer hover:bg-slate-100 active:scale-95 transition-all text-center">
                            <input 
                                type="file" 
                                accept=".pdf" 
                                onChange={uploadDocument}
                                disabled={loading || !activeAddress}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                            />
                            {loading ? 'Analyzing...' : 'Select Document'}
                        </div>
                      </div>
                 </div>
            ) : (
              <div className="space-y-8">
                 <div className="fintech-card p-12 text-center bg-gradient-to-b from-purple-500/5 to-transparent border-purple-500/20">
                    <h2 className="text-3xl font-black mb-4 uppercase tracking-tighter">Inquiry Fulfillment</h2>
                    <p className="text-slate-400 mb-8 max-w-md mx-auto">Enter the secure inquiry code provided by an enterprise to unlock their request.</p>
                    
                    <div className="max-w-md mx-auto space-y-4">
                        <input 
                            type="text" 
                            placeholder="TRU-XXXXXX"
                            value={inquiryCode}
                            onChange={(e) => setInquiryCode(e.target.value.toUpperCase())}
                            className="w-full bg-black/50 border border-white/10 p-6 rounded-2xl text-center text-5xl font-black text-purple-300 tracking-[0.2em] focus:outline-none focus:border-purple-500 transition-all font-mono"
                        />
                        <button 
                            onClick={() => runFetchInquiry(inquiryCode)}
                            disabled={loading || !inquiryCode}
                            className="w-full py-5 bg-white text-black font-black uppercase tracking-widest rounded-2xl shadow-xl hover:bg-slate-100 transition-all active:scale-95 disabled:opacity-30"
                        >
                            {loading ? 'Searching Ledger...' : 'Unlock Request'}
                        </button>
                    </div>

                    {activeInquiry && (
                        <div className="mt-12 p-8 border border-purple-500/30 rounded-3xl bg-purple-500/5 text-left animate-in slide-in-from-top-4 duration-500 max-w-2xl mx-auto">
                            <div className="flex justify-between items-start mb-8">
                                <div>
                                    <h3 className="text-xl font-black uppercase text-white tracking-tight">Enterprise Request</h3>
                                    <p className="text-[10px] text-slate-500 font-mono tracking-widest">{activeInquiry.id}</p>
                                </div>
                                <div className="px-3 py-1 bg-green-500/20 text-green-400 text-[10px] font-black rounded-full border border-green-500/30 uppercase tracking-tighter">Active Inquiry</div>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4 mb-4">
                                <div className="p-4 bg-black/40 rounded-2xl border border-white/5 col-span-2">
                                    <span className="text-[9px] text-slate-500 uppercase font-black tracking-widest block mb-1">Requested Data Points</span>
                                    <div className="flex flex-wrap gap-2">
                                        {activeInquiry.requested_traits?.map((t: string) => (
                                            <span key={t} className="px-2 py-1 bg-white/5 rounded text-[9px] font-bold text-purple-300 uppercase">{t.replace('_', ' ')}</span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4 mb-8">
                                <div className="p-4 bg-black/40 rounded-2xl border border-white/5">
                                    <span className="text-[9px] text-slate-500 uppercase font-black tracking-widest block mb-1">Verification Mode</span>
                                    <span className="text-xs font-bold text-white uppercase italic">{activeInquiry.mode === 'zkp' ? 'ZK Income Proof' : 'Identity Seal'}</span>
                                </div>
                                <div className="p-4 bg-black/40 rounded-2xl border border-white/5">
                                    <span className="text-[9px] text-slate-500 uppercase font-black tracking-widest block mb-1">Constraint</span>
                                    <span className="text-xs font-bold text-white">&gt; ${activeInquiry.threshold.toLocaleString()}</span>
                                </div>
                            </div>

                            <p className="text-[11px] text-slate-400 mb-8 leading-relaxed">
                                <strong className="text-purple-400">Privacy Assurance:</strong> No raw values will be shared. Only a cryptographic proof of fact will be transmitted.
                            </p>

                            {activeInquiry.status === 'pending' ? (
                                <button 
                                    onClick={runFulfillInquiry}
                                    disabled={loading}
                                    className="w-full py-6 bg-purple-600 hover:bg-purple-500 text-white font-black uppercase tracking-[0.3em] rounded-2xl shadow-[0_0_30px_rgba(147,51,234,0.3)] transition-all active:scale-95"
                                >
                                    {loading ? 'Computing Cryptographic Proof...' : 'Authorize & Fulfill Request'}
                                </button>
                            ) : (
                                <div className="py-6 bg-green-500/20 border border-green-500/40 text-green-400 font-black uppercase text-center rounded-2xl flex items-center justify-center gap-3">
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                    Request Fulfilled Successfully
                                </div>
                            )}
                        </div>
                    )}
                 </div>
              </div>
            )}
          </div>
        )}

        {/* Protocol Logs */}
        <div className="max-w-4xl mx-auto mt-16 pb-24">
            <div className="fintech-card h-80 flex flex-col bg-black/40 backdrop-blur-xl border-white/5">
                <div className="text-[10px] uppercase font-black text-slate-500 tracking-[0.3em] mb-4 flex justify-between items-center border-b border-white/5 pb-2">
                    <span>Truth Engine Runtime Logs</span>
                    <span className="text-purple-400/50">v2.5.0-beta</span>
                </div>
                <div className="flex-1 overflow-y-auto space-y-1 font-mono text-[9px] scrollbar-hide">
                    {logs.map((log, i) => (
                    <div key={i} className={`py-1 border-b border-white/5 last:border-0 ${log.includes('[ERROR]') ? 'text-red-400' : log.includes('[SUCCESS]') ? 'text-green-400' : log.includes('[TX]') ? 'text-blue-400' : 'text-slate-500'}`}>
                        <span className="opacity-20 mr-2">[{new Date().toLocaleTimeString()}]</span> {log}
                    </div>
                    ))}
                    {logs.length === 0 && <div className="text-slate-800 italic uppercase font-black tracking-widest text-center mt-20 opacity-30 animate-pulse">Awaiting Payload...</div>}
                </div>
            </div>
        </div>
      </main>

      <ConnectWallet open={openWalletModal} setOpen={setOpenWalletModal} />
      
      {/* Floating Error Toast */}
      {error && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-red-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-2xl animate-in slide-in-from-bottom-4 duration-300 z-[100]">
            Error: {error}
            <button onClick={() => setError('')} className="ml-4 opacity-50 hover:opacity-100">×</button>
        </div>
      )}
    </div>
  )
}

export default TrustAnchorApp