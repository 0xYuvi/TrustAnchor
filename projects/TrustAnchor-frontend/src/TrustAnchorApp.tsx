import { useWallet } from '@txnlab/use-wallet-react'
import React, { useState, useCallback } from 'react'
import algosdk from 'algosdk'
import ConnectWallet from './components/ConnectWallet'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'

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

const APP_ID = 758875733
const ISSUER_ADDR = '7726NOUPZSQEM3QHWMVNZPZMOZ3263GMTBT733QCZ5GQ2XIVUMKOJMDKZI'
const PAYMENT_FEE = 50000

const TrustAnchorApp: React.FC = () => {
  const { activeAddress, transactionSigner, signTransactions, wallets } = useWallet()

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
  const [showDisconnect, setShowDisconnect] = useState(false)
  
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
          receiver: ISSUER_ADDR,
          amount: BigInt(PAYMENT_FEE),
          suggestedParams: suggestedParams,
          note: new TextEncoder().encode(`TrustAnchor Inquiry: ${verificationMode}`)
        })
        
        setStep('submit')
        
        const signedTxsRaw = await signTransactions([paymentTxn.toByte()])
        const signedTxs = signedTxsRaw.filter((tx): tx is Uint8Array => tx !== null)
        const result = (await algodClient.sendRawTransaction(signedTxs).do()) as any
        const txId = result.txId || result.txID || result.txid
        
        if (!txId) {
          throw new Error('Transaction submission failed: No ID returned')
        }

        addLog(`[TX] Broadcast! View on Explorer: https://testnet.algoexplorer.io/tx/${txId}`)
        await algosdk.waitForConfirmation(algodClient, txId, 10)
        
        // Indexer Grace Period: Wait for the indexer to see the block
        addLog(`[SYNC] Waiting for Indexer synchronization (10s)...`)
        await new Promise(resolve => setTimeout(resolve, 10000))
        
        setStep('verify')
        response = await fetch(`${BACKEND_URL}/inquiry/create`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x402-payment-proof': txId 
          },
          body: JSON.stringify({
            ...payload,
            payment_txid: txId
          })
        })
      }

      if (!response.ok) {
        let errorMsg = 'Failed to process inquiry'
        try {
          const err = await response.json()
          errorMsg = typeof err.detail === 'string' ? err.detail : (err.detail?.error || JSON.stringify(err.detail))
        } catch (e) {
          errorMsg = response.statusText
        }
        throw new Error(errorMsg)
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
      const response = await fetch(`${BACKEND_URL}/inquiry/status/${code}`)
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail?.error || errData.detail || 'Inquiry issuance failed');
      }
      const data = await response.json()
      setActiveInquiry(data)
      setThreshold(data.threshold)
      setVerificationMode(data.mode)
      addLog(`[SUCCESS] Inquiry Loaded: ${data.mode} verification against ${data.requested_traits?.includes('income_annual') ? '$' : ''}${data.threshold}`)
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

      if (!genResp.ok) {
        const errData = await genResp.json();
        throw new Error(errData.detail || 'Proof generation failed');
      }
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
      const fulfillResult = await fulfillResp.json()
      
      setStep('complete')
      addLog(`[SYNC] Finalizing protocol state...`)
      // Refresh definitive state from backend
      await runFetchInquiry(activeInquiry.id)
      addLog(`[SUCCESS] Fulfillment Protocol Absolute.`)
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

        <div className="flex items-center gap-4">
          <button 
            onClick={() => {
              if (!activeAddress) {
                setOpenWalletModal(true)
              } else if (showDisconnect) {
                console.log('[Wallet] Triggering logout...')
                const activeWallet = wallets?.find((w) => w.isActive)
                if (activeWallet) {
                  activeWallet.disconnect().then(() => {
                    setShowDisconnect(false)
                  })
                } else {
                  // Fallback: Clear storage and reload
                  localStorage.removeItem('@txnlab/use-wallet:v3')
                  window.location.reload()
                }
              } else {
                setShowDisconnect(true)
              }
            }} 
            className={`px-6 py-2.5 font-bold rounded-2xl transition-all shadow-lg text-[10px] uppercase tracking-widest flex items-center gap-2 ${activeAddress ? (showDisconnect ? 'bg-red-500 text-white' : 'bg-white/5 border border-white/10 text-slate-300 hover:border-purple-500/50') : 'bg-white text-black hover:scale-105'}`}
          >
            {activeAddress ? (
              showDisconnect ? (
                <>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                  Confirm Disconnect
                </>
              ) : (
                <>
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                  {`${activeAddress.slice(0, 4)}...${activeAddress.slice(-4)}`}
                </>
              )
            ) : 'Connect Wallet'}
          </button>
          
          {showDisconnect && (
             <button 
              onClick={() => setShowDisconnect(false)}
              className="p-2.5 bg-white/5 border border-white/10 rounded-xl text-slate-500 hover:text-white transition-colors"
             >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
             </button>
          )}
        </div>
      </nav>

            <main className="pt-32 px-6">
        {/* Simple Brand Reveal */}
        <section id="about" className="max-w-7xl mx-auto text-center space-y-12 mb-40">
          <div className="space-y-4">
            <h1 className="text-7xl md:text-9xl font-black tracking-tighter text-gradient leading-none py-2">
              Truth-as-a-Service
            </h1>
            <p className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed font-medium">
              The next-generation <span className="text-purple-400 font-bold">ZK-Identity Protocol</span> on Algorand. Private verification where verifiers take the lead—secure, anonymous, and powered by x402 micropayments.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto text-left pt-12">
            {[
              { 
                title: 'Data Fortress', 
                desc: 'Raw PII never leaves your device. Prove eligibility (Age > 18, Income > $50k) using Zero-Knowledge cryptography without ever exposing your private values.',
                icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'
              },
              { 
                title: 'Algorand Proofs', 
                desc: 'Your identity is anchored as a cryptographic commitment to the Algorand ledger, ensuring global trust and mathematical integrity without a central database.',
                icon: 'M13 10V3L4 14h7v7l9-11h-7z'
              },
              { 
                title: 'x402 Economy', 
                desc: 'Automated micropayments align incentives between identity providers and verifiers. Build high-fidelity trust networks where verification is instant and paid.',
                icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
              }
            ].map((feature, i) => (
              <div key={i} className="fintech-card relative group hover:scale-[1.02]">
                <div className="w-12 h-12 bg-purple-500/10 border border-purple-500/20 rounded-2xl flex items-center justify-center mb-6 text-purple-400 group-hover:scale-110 group-hover:bg-purple-500 group-hover:text-white transition-all duration-500">
                   <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={feature.icon} /></svg>
                </div>
                <h3 className="text-xl font-black uppercase tracking-tight text-white mb-3">{feature.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Playground / Tooling Section */}
        <section id="playground" className="max-w-7xl mx-auto mb-48 scroll-mt-32">
          {!activeAddress ? (
            <div className="fintech-card py-32 text-center space-y-10 bg-gradient-to-b from-purple-500/5 to-transparent border-dashed">
                <div className="space-y-4">
                    <h2 className="text-6xl font-black uppercase tracking-tighter">Enter the Citadel</h2>
                    <p className="text-slate-500 max-w-sm mx-auto">Connect your Algorand wallet to access the TrustAnchor Protocol playground.</p>
                </div>
                <button 
                  onClick={() => setOpenWalletModal(true)}
                  className="btn-premium transform scale-125"
                >
                  Connect Wallet
                </button>
            </div>
          ) : (
             <div className="space-y-12">
                {/* Mode Selector */}
                <div className="flex justify-center">
                    <div className="bg-[#111111] p-2 rounded-[2rem] border border-[#2a2a2a] flex gap-2 shadow-2xl">
                        <button 
                            onClick={() => setPortalMode('citizen')}
                            className={`px-10 py-5 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] transition-all ${portalMode === 'citizen' ? 'bg-white text-black shadow-xl' : 'text-slate-500 hover:text-white'}`}
                        >
                            Identity Citizen
                        </button>
                        <button 
                            onClick={() => setPortalMode('verifier')}
                            className={`px-10 py-5 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] transition-all ${portalMode === 'verifier' ? 'bg-white text-black shadow-xl' : 'text-slate-500 hover:text-white'}`}
                        >
                            Enterprise Verifier
                        </button>
                    </div>
                </div>

                {portalMode === 'verifier' ? (
                  /* VERIFIER VIEW */
                  <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in zoom-in duration-700">
                     <div className="fintech-card p-12 text-center space-y-12 bg-gradient-to-tr from-purple-900/10 to-transparent">
                        <div className="flex flex-col items-center space-y-6">
                            <div className="w-20 h-20 bg-purple-500/20 border border-purple-500/40 rounded-full flex items-center justify-center">
                                <svg className="w-10 h-10 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                            </div>
                            <div className="space-y-2">
                                <h2 className="text-5xl font-black uppercase tracking-tighter">Inquiry Engine</h2>
                                <p className="text-slate-400 max-w-md mx-auto text-xs uppercase tracking-widest font-bold opacity-60">Issue a Paid Verification Challenge</p>
                            </div>
                        </div>
                        
                        <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
                            {(reqTraits.includes('income_annual') || reqTraits.includes('age')) ? (
                                <div className="space-y-4 text-left animate-in fade-in duration-500">
                                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest ml-2">
                                        {reqTraits.includes('income_annual') ? 'Minimum Income Yield ($)' : 'Minimum Age Requirement'}
                                    </label>
                                    <div className="relative">
                                        {reqTraits.includes('income_annual') && (
                                            <span className="absolute left-6 top-1/2 -translate-y-1/2 text-purple-400 font-bold">$</span>
                                        )}
                                        <input 
                                            type="number" 
                                            value={threshold} 
                                            onChange={(e) => setThreshold(Number(e.target.value))} 
                                            className={`w-full bg-black border border-[#2a2a2a] p-6 rounded-3xl font-black text-white focus:outline-none focus:border-purple-500 font-mono text-2xl ${reqTraits.includes('income_annual') ? 'pl-12' : 'pl-6'}`}
                                        />
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-4 text-left animate-in fade-in duration-500">
                                    <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest ml-2">Identity Verification</label>
                                    <div className="bg-black/40 border border-[#2a2a2a] p-6 rounded-3xl font-black text-slate-500 italic text-sm">
                                        Semantic Proof (No Numerical Bound Required)
                                    </div>
                                </div>
                            )}
                            <div className="space-y-4 text-left">
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest ml-2">Proof Complexity</label>
                                <select 
                                    value={verificationMode}
                                    onChange={(e: any) => setVerificationMode(e.target.value)}
                                    className="w-full bg-black border border-[#2a2a2a] p-6 rounded-3xl font-black text-white focus:outline-none appearance-none cursor-pointer hover:border-white/20 uppercase text-xs tracking-widest"
                                >
                                    <option value="zkp">ZK-Proof (Ultra Private)</option>
                                    <option value="boolean">Direct Seal (Standard)</option>
                                </select>
                            </div>
                        </div>

                        <div className="max-w-2xl mx-auto space-y-6">
                           <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest block text-left ml-2">Identity Slots Required</label>
                           <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                                {[
                                  { id: 'full_name', label: 'Identity Name' },
                                  { id: 'age', label: 'Citizen Age' },
                                  { id: 'income_annual', label: 'Gross Yield' },
                                  { id: 'citizenship', label: 'Nationality' },
                                  { id: 'address', label: 'Residency' }
                                ].map(trait => (
                                  <button 
                                    key={trait.id}
                                    onClick={() => {
                                      setReqTraits(prev => 
                                        prev.includes(trait.id) ? prev.filter(t => t !== trait.id) : [...prev, trait.id]
                                      )
                                    }}
                                    className={`px-4 py-5 rounded-2xl border text-[10px] font-black uppercase tracking-tight transition-all ${reqTraits.includes(trait.id) ? 'bg-purple-500/10 border-purple-500 text-white shadow-[0_0_40px_rgba(168,85,247,0.1)]' : 'bg-black border-[#2a2a2a] text-slate-500 hover:border-white/20'}`}
                                  >
                                    {trait.label}
                                  </button>
                                ))}
                           </div>
                        </div>

                        <div className="max-w-2xl mx-auto pt-8">
                           <button 
                             onClick={runCreateInquiryFlow}
                             disabled={loading}
                             className="btn-premium w-full py-8 text-base shadow-[0_0_40px_rgba(255,255,255,0.1)]"
                           >
                             {loading ? 'Confirming x402 Micropayment...' : 'Authorize Paid Inquiry'}
                           </button>
                        </div>

                        {attestationCode && (
                          <div className="max-w-xl mx-auto p-10 bg-green-500/5 border border-green-500/20 rounded-[2.5rem] animate-in slide-in-from-bottom-6">
                             <div className="text-[10px] font-black uppercase text-green-500 tracking-[0.4em] mb-6">Challenge Fragment Generated</div>
                             <div className="text-5xl font-black text-white font-mono tracking-tighter mb-8 bg-clip-text text-transparent bg-gradient-to-b from-white to-white/40">{attestationCode}</div>
                             
                             <div className="flex gap-4 justify-center">
                                <button 
                                    onClick={() => {
                                        navigator.clipboard.writeText(attestationCode);
                                        addLog('[UI] Code copied!');
                                    }}
                                    className="px-10 py-4 bg-white text-black text-[10px] font-black rounded-2xl hover:scale-105 transition-all uppercase tracking-widest"
                                >
                                    Copy ID
                                </button>
                                <button 
                                    onClick={() => checkInquiryStatus(attestationCode)}
                                    className="px-10 py-4 bg-purple-500 text-white text-[10px] font-black rounded-2xl hover:scale-105 transition-all uppercase tracking-widest shadow-[0_0_20px_rgba(168,85,247,0.4)]"
                                >
                                    Check Status
                                </button>
                             </div>
                          </div>
                        )}

                        {verificationResult !== null && (
                            <div className={`mt-12 p-12 fintech-card border-dashed max-w-2xl mx-auto flex items-center justify-center gap-8 animate-in zoom-in duration-500 ${verificationResult.result ? 'border-green-500 bg-green-500/5' : 'border-red-500 bg-red-500/5'}`}>
                                <div className={`w-20 h-20 rounded-full flex items-center justify-center border ${verificationResult.result ? 'bg-green-500/20 border-green-500/40 text-green-400' : 'bg-red-500/20 border-red-500/40 text-red-400'}`}>
                                    {verificationResult.result ? (
                                        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                    ) : (
                                        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                                    )}
                                </div>
                                <div className="text-left">
                                    <h3 className="text-5xl font-black text-white uppercase italic tracking-tighter leading-none mb-2">
                                        {verificationResult.result ? 'Verified' : 'Rejected'}
                                    </h3>
                                    <p className={`font-bold uppercase tracking-widest text-[10px] ${verificationResult.result ? 'text-green-400' : 'text-red-400'}`}>
                                        {verificationResult.result ? 'Proof satisfies all protocol constraints' : (verificationResult.error || 'Proof fails to meet required thresholds')}
                                    </p>
                                </div>
                            </div>
                        )}
                     </div>
                  </div>
                ) : (
                  /* CITIZEN VIEW */
                  <div className="max-w-6xl mx-auto animate-in fade-in zoom-in duration-700">
                    {!kycData ? (
                         <div className="fintech-card text-center p-24 space-y-12 bg-gradient-to-b from-purple-500/5 to-transparent border-dashed">
                             <div className="w-24 h-24 bg-purple-500/10 border border-purple-500/20 rounded-3xl mx-auto flex items-center justify-center">
                                <svg className="w-10 h-10 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                              </div>
                              <div className="space-y-4">
                                <h2 className="text-6xl font-black uppercase tracking-tighter">Identity Anchor</h2>
                                <p className="text-slate-400 max-w-md mx-auto">Commit your identity document to the decentralized ledger. Your PII is never stored; only a cryptographic anchor is generated.</p>
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
                                    {loading ? 'Anchoring to Algorand...' : 'Anchor Trusted Document'}
                                </div>
                              </div>
                         </div>
                    ) : (
                      <div className="space-y-12 animate-in slide-in-from-bottom-10 duration-1000">
                         {/* Vault Preview */}
                         <div className="fintech-card bg-gradient-to-br from-purple-500/10 to-transparent border-purple-500/20 p-12">
                            <div className="flex justify-between items-start mb-16">
                               <div>
                                  <h3 className="text-3xl font-black uppercase tracking-tight text-white mb-2 leading-none">Your Identity Vault</h3>
                                  <p className="text-[10px] text-slate-600 font-mono tracking-[0.5em] uppercase">Status: Ledger Commitment Active</p>
                               </div>
                               <div className="px-6 py-3 bg-green-500/10 text-green-400 text-[10px] font-black rounded-2xl border border-green-500/20 flex items-center gap-3">
                                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
                                  SECURE SESSION
                               </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
                               {[
                                  { label: 'Verified Full Name', value: kycData.verified_data?.full_name, icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
                                  { label: 'Citizen Age', value: kycData.verified_data?.age ? `${kycData.verified_data.age} Years` : 'Anchored', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
                                  { label: 'Annual Income Yield', value: kycData.verified_data?.income_annual ? `$${kycData.verified_data.income_annual.toLocaleString()}` : 'Analyzing...', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
                                  { label: 'Citizenship', value: kycData.verified_data?.citizenship, icon: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 002 2 2 2 0 012 2v.653M3 20h18M3 10a13.932 13.932 0 010 4M21 10a13.932 13.932 0 010 4' },
                                  { label: 'Anchored Residency', value: kycData.verified_data?.address?.slice(0, 30) + '...', icon: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z' },
                               ].map((item, idx) => (
                                  <div key={idx} className="p-8 bg-black/60 rounded-[2.5rem] border border-[#2a2a2a] space-y-6 group hover:border-purple-500/50 transition-all hover:scale-[1.02] shadow-2xl">
                                     <div className="w-12 h-12 bg-white/5 rounded-2xl flex items-center justify-center text-slate-500 group-hover:bg-purple-500 group-hover:text-white transition-all">
                                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} /></svg>
                                     </div>
                                     <div>
                                        <div className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em] mb-2">{item.label}</div>
                                        <div className="text-lg font-bold text-white truncate">{item.value || 'Data Shielded'}</div>
                                     </div>
                                  </div>
                               ))}
                            </div>
                         </div>

                         <div className="fintech-card p-20 text-center bg-gradient-to-b from-purple-500/5 to-transparent">
                            <h2 className="text-5xl font-black mb-6 uppercase tracking-tighter">Inquiry Fulfillment</h2>
                            <p className="text-slate-500 mb-12 max-w-sm mx-auto text-sm">Decode a secure challenge code to provide a Zero-Knowledge proof of fact.</p>
                            
                            <div className="max-w-md mx-auto space-y-6">
                                <input 
                                    type="text" 
                                    placeholder="TRU-XXXXXX"
                                    value={inquiryCode}
                                    onChange={(e) => setInquiryCode(e.target.value.toUpperCase())}
                                    className="w-full bg-black border border-[#2a2a2a] p-6 rounded-2xl text-center text-4xl font-black text-purple-300 tracking-[0.1em] focus:outline-none focus:border-purple-500 transition-all font-mono shadow-inner"
                                />
                                <button 
                                    onClick={() => runFetchInquiry(inquiryCode)}
                                    disabled={loading || !inquiryCode}
                                    className="btn-premium w-full h-20 text-sm tracking-[0.2em]"
                                >
                                    {loading ? 'Scanning Ledger...' : 'Access Request'}
                                </button>
                            </div>

                            {activeInquiry && (
                                <div className="mt-20 p-12 border border-purple-500/20 rounded-[3.5rem] bg-[#0A0A0A] text-left animate-in slide-in-from-top-10 duration-1000 max-w-4xl mx-auto shadow-2xl relative overflow-hidden">
                                    <div className="flex justify-between items-start mb-12">
                                        <div className="space-y-2">
                                            <h3 className="text-3xl font-black uppercase text-white tracking-tight leading-none">Challenge Payload</h3>
                                            <p className="text-[11px] text-slate-600 font-mono tracking-widest uppercase">{activeInquiry.id}</p>
                                        </div>
                                        <div className="px-6 py-2 bg-purple-500/10 text-purple-400 text-[10px] font-black rounded-2xl border border-purple-500/20 uppercase tracking-widest">Active Challenge</div>
                                    </div>
                                    
                                    <div className="grid md:grid-cols-2 gap-8 mb-12">
                                        <div className="p-8 bg-black rounded-[2rem] border border-[#2a2a2a] space-y-6">
                                            <span className="text-[11px] text-slate-600 uppercase font-black tracking-[0.2em] block">Data Disclosure Scope</span>
                                            <div className="flex flex-wrap gap-3">
                                                {activeInquiry.requested_traits?.map((t: string) => (
                                                    <span key={t} className="px-4 py-2 bg-purple-500/5 border border-purple-500/20 rounded-xl text-[10px] font-black text-purple-300 uppercase tracking-widest">{t.replace('_', ' ')}</span>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="p-8 bg-black rounded-[2rem] border border-[#2a2a2a] space-y-3 flex flex-col justify-center">
                                            <span className="text-[11px] text-slate-600 uppercase font-black tracking-[0.2em] block">Logic Constraint</span>
                                            <div className="text-3xl font-black text-white leading-none tracking-tight">
                                                {(activeInquiry.requested_traits?.includes('income_annual') || activeInquiry.requested_traits?.includes('age')) ? (
                                                    <>
                                                        {activeInquiry.requested_traits?.includes('income_annual') ? 'Income' : 'Age'} &gt; {activeInquiry.requested_traits?.includes('income_annual') ? '$' : ''}{activeInquiry.threshold.toLocaleString()}
                                                    </>
                                                ) : (
                                                    'Identity Attestation'
                                                )}
                                            </div>
                                            <div className="text-[10px] font-bold text-slate-700 uppercase tracking-widest">Method: {activeInquiry.mode === 'zkp' ? 'ZK-Proof (High Entropy)' : 'Boolean Seal'}</div>
                                        </div>
                                    </div>

                                    <div className="bg-purple-500/5 p-8 rounded-[2.5rem] border border-purple-500/10 mb-12 flex items-center gap-8">
                                        <div className="w-14 h-14 rounded-2xl bg-purple-500/10 flex items-center justify-center text-purple-400 shrink-0">
                                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                                        </div>
                                        <div className="space-y-1">
                                            <span className="text-xs font-black uppercase text-white tracking-widest block">Privacy Shield Active</span>
                                            <p className="text-sm text-slate-500 leading-relaxed font-medium">This verifier will receive a <span className="text-purple-400 font-bold uppercase">Mathematical Proof</span> of eligibility. No raw documents or values will be transmitted.</p>
                                        </div>
                                    </div>

                                    {activeInquiry.status === 'pending' ? (
                                        <button 
                                            onClick={runFulfillInquiry}
                                            disabled={loading}
                                            className="btn-premium w-full py-10 text-lg tracking-[0.5em]"
                                        >
                                            {loading ? 'Computing ZK Proof...' : 'Initiate Private Fulfillment'}
                                        </button>
                                    ) : activeInquiry.result ? (
                                        <div className="py-10 bg-green-500/5 border border-green-500/40 text-green-400 font-black uppercase text-center rounded-[3rem] flex items-center justify-center gap-6 animate-in fade-in zoom-in duration-1000 shadow-[0_0_50px_rgba(34,197,94,0.1)]">
                                            <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                            Verification Success: Fact Confirmed
                                        </div>
                                    ) : (
                                        <div className="py-10 bg-red-500/5 border border-red-500/40 text-red-500 font-black uppercase text-center rounded-[3rem] flex items-center justify-center flex-col gap-2 animate-in fade-in zoom-in duration-1000">
                                            <div className="flex items-center gap-6">
                                                <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                                                Verification Denied
                                            </div>
                                            {activeInquiry.error && <p className="text-[10px] opacity-60 normal-case font-mono mt-2 tracking-normal">{activeInquiry.error}</p>}
                                        </div>
                                    )}
                                </div>
                            )}
                         </div>
                      </div>
                    )}
                  </div>
                )}
             </div>
          )}
        </section>

        {/* Diagnostic Layer */}
        <section className="max-w-5xl mx-auto pb-48">
            <div className="fintech-card h-[30rem] flex flex-col bg-black border-[#2a2a2a] p-10 shadow-2xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-20 transition-opacity">
                    <svg className="w-48 h-48 text-purple-500" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
                </div>
                <div className="text-[10px] uppercase font-black text-slate-600 tracking-[0.6em] mb-8 flex justify-between items-center border-b border-[#2a2a2a] pb-6 relative z-10">
                    <span className="flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                        Protocol Runtime Terminal
                    </span>
                    <span className="text-purple-400/50">Production Node v2.5.1-Stable</span>
                </div>
                <div className="flex-1 overflow-y-auto space-y-3 font-mono text-[10px] scrollbar-hide relative z-10">
                    {logs.map((log, i) => (
                    <div key={i} className={`py-2 border-b border-white/5 last:border-0 ${log.includes('[ERROR]') ? 'text-red-400' : log.includes('[SUCCESS]') ? 'text-green-400 font-bold' : log.includes('[TX]') ? 'text-blue-400' : 'text-slate-600'}`}>
                        <span className="opacity-30 mr-3">[{new Date().toLocaleTimeString()}]</span> {log}
                    </div>
                    ))}
                    {logs.length === 0 && <div className="text-slate-800 italic uppercase font-black tracking-[1em] text-center mt-32 opacity-10 animate-pulse">Awaiting Payload Sequence...</div>}
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
                <div className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-purple-500/40" /> Algorand Core</div>
                <div className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-purple-500/40" /> gnark Cryptography</div>
                <div className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-purple-500/40" /> x402 Protocol</div>
            </div>
            <p className="text-slate-700 text-[10px] font-medium tracking-widest leading-relaxed">© 2026 TrustAnchor Private Limited. All Identity Proofs are mathematically sealed.</p>
         </div>
      </footer>

      <ConnectWallet 
        openModal={openWalletModal} 
        closeModal={() => setOpenWalletModal(false)} 
      />
      
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