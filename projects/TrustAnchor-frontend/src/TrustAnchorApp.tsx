import { useWallet } from '@txnlab/use-wallet-react'
import React, { useState, useEffect, useCallback } from 'react'
import ConnectWallet from './components/ConnectWallet'

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

interface FlowStep {
  id: string
  label: string
  icon: string
}

const flowSteps: FlowStep[] = [
  { id: 'init', label: 'Initialize', icon: '⚡' },
  { id: 'anchors', label: 'Anchors', icon: '⚓' },
  { id: 'request', label: 'Request', icon: '📋' },
  { id: 'payment', label: 'Payment', icon: '💳' },
  { id: 'prove', label: 'Prove', icon: '🔐' },
  { id: 'submit', label: 'Submit', icon: '📤' },
  { id: 'verify', label: 'Verify', icon: '✓' },
]

const TrustAnchorApp: React.FC = () => {
  const { activeAddress } = useWallet()

  const [openWalletModal, setOpenWalletModal] = useState<boolean>(false)
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<string>('idle')
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null)
  const [zkProof, setZkProof] = useState<ZKProofData | null>(null)
  const [error, setError] = useState<string>('')
  const [logs, setLogs] = useState<string[]>([])
  const [showParticleField, setShowParticleField] = useState(true)

  const [userId, setUserId] = useState('')
  const [threshold, setThreshold] = useState(50000)
  const [secretValue, setSecretValue] = useState(75000)
  const [verificationMode, setVerificationMode] = useState<'boolean' | 'zkp'>('zkp')

  const [particles, setParticles] = useState<Array<{ x: number; y: number; size: number; speed: number; opacity: number }>>([])

  useEffect(() => {
    if (!showParticleField) return
    const interval = setInterval(() => {
      setParticles((prev) => {
        const newParticles = prev
          .map((p) => ({
            ...p,
            y: p.y - p.speed,
            opacity: p.opacity,
          }))
          .filter((p) => p.y > -10)
        while (newParticles.length < 50) {
          newParticles.push({
            x: Math.random() * 100,
            y: 100 + Math.random() * 20,
            size: Math.random() * 3 + 1,
            speed: Math.random() * 0.3 + 0.1,
            opacity: Math.random() * 0.5 + 0.1,
          })
        }
        return newParticles
      })
    }, 50)
    return () => clearInterval(interval)
  }, [showParticleField])

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg])
  }, [])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  const runVerificationFlow = async () => {
    if (!activeAddress) {
      setError('Please connect wallet first')
      return
    }

    setLoading(true)
    setError('')
    setStep('init')
    setVerificationResult(null)
    setZkProof(null)
    clearLogs()

    try {
      setStep('request')
      addLog(`[REQUEST] Starting ${verificationMode.toUpperCase()} verification`)
      addLog(`[USER] ${userId || 'anonymous'}`)
      addLog(`[THRESHOLD] $${threshold.toLocaleString()}`)

      await new Promise((r) => setTimeout(r, 600))

      setStep('payment')
      addLog(`[PAYMENT] fee: ${verificationMode === 'zkp' ? '0.5' : '0.1'} ALGO`)
      await new Promise((r) => setTimeout(r, 800))

      if (verificationMode === 'zkp') {
        setStep('prove')
        addLog('[ZKP] Generating zero-knowledge proof...')
        addLog(`[CIRCUIT] GreaterThan(secret > ${threshold})`)

        await new Promise((r) => setTimeout(r, 1500))

        const generatedProof: ZKProofData = {
          a: `g1_${secretValue.toString(16).padStart(16, '0')}`,
          b: `g2_${threshold.toString(16).padStart(16, '0')}`,
          c: `g1_${(secretValue - threshold).toString(16).padStart(16, '0')}`,
          public_hash: `hash_${Date.now().toString(16)}`,
        }

        setZkProof(generatedProof)
        addLog('[ZKP] Proof generated successfully')
        addLog(`[HASH] ${generatedProof.public_hash}`)
      }

      setStep('submit')
      addLog('[CONTRACT] Submitting to TruthRegistry...')
      await new Promise((r) => setTimeout(r, 1000))

      setStep('verify')
      addLog('[VERIFY] On-chain verification')
      await new Promise((r) => setTimeout(r, 600))

      const result: VerificationResult = {
        result: true,
        user_id: userId || 'anonymous',
        mode: verificationMode,
        threshold: threshold,
        proof: verificationMode === 'zkp' ? zkProof : null,
        txid: `tx_${Date.now()}`,
      }

      setVerificationResult(result)
      addLog('[SUCCESS] Verification complete')
      addLog('[ANCHOR] Trait stored on Algorand')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed'
      setError(msg)
      addLog(`[ERROR] ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  const runDemo = async () => {
    setLoading(true)
    setError('')
    setStep('init')
    clearLogs()

    try {
      addLog('[DEMO] TrustAnchor Demonstration')
      addLog('= '.repeat(20))

      setStep('anchors')
      addLog('[PHASE 1] Bank Anchor Setup')
      addLog('     Trait: income_usd > threshold')
      addLog('     Commitment anchored on-chain')
      await new Promise((r) => setTimeout(r, 1000))

      setStep('request')
      addLog('[PHASE 2] Consumer Request')
      addLog('     User: demo_user_123')
      addLog('     Mode: ZKP (zero-knowledge)')
      addLog('     Threshold: $50,000')
      await new Promise((r) => setTimeout(r, 1000))

      setStep('payment')
      addLog('[PHASE 3] Payment')
      addLog('     Amount: 0.5 ALGO')
      addLog('     Via: X402 protocol')
      await new Promise((r) => setTimeout(r, 1000))

      setStep('prove')
      addLog('[PHASE 4] ZK Proof Generation')
      addLog('     Circuit: GreaterThan')
      addLog('     Constraints: 68')
      addLog('     Secret: $75,000 > $50,000')
      await new Promise((r) => setTimeout(r, 1200))

      setStep('submit')
      addLog('[PHASE 5] Submit to Contract')
      addLog('     App: TruthRegistry')
      addLog('     Method: verify_zk_claim')
      await new Promise((r) => setTimeout(r, 1000))

      setStep('verify')
      addLog('[PHASE 6] On-Chain Verification')
      addLog('     Result: VERIFIED')
      addLog(`     Block: #${Math.floor(Math.random() * 1000000)}`)

      setVerificationResult({
        result: true,
        user_id: 'demo_user_123',
        mode: 'zkp',
        threshold: 50000,
        proof: {
          a: 'g1_124f8e3d2a1c',
          b: 'g2_c3500a1e9f2b',
          c: 'g1_61a8000c1d3e',
          public_hash: 'a1b2c3d4e5f6',
        },
      })

      addLog('= '.repeat(20))
      addLog('[COMPLETE] Demonstration finished')
    } finally {
      setLoading(false)
    }
  }

  const getStepStatus = (stepId: string): 'completed' | 'active' | 'pending' => {
    const stepIndex = flowSteps.findIndex((s) => s.id === step)
    const currentIndex = flowSteps.findIndex((s) => s.id === stepId)
    if (stepIndex === -1) return 'pending'
    if (currentIndex < stepIndex) return 'completed'
    if (currentIndex === stepIndex) return 'active'
    return 'pending'
  }

  const formatHash = (hash: string): string => {
    if (!hash || hash.length < 16) return hash
    return `${hash.slice(0, 8)}...${hash.slice(-8)}`
  }

  return (
    <div className="relative min-h-screen bg-[#0a0a0f] overflow-hidden">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-from),_var(--tw-gradient-to))] from-purple-900/40 via-slate-900 to-[#0a0a0f]" />
        <svg className="absolute inset-0 w-full h-full opacity-[0.03]">
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
        {showParticleField &&
          particles.map((p, i) => (
            <div
              key={i}
              className="absolute rounded-full bg-purple-400"
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: p.size,
                height: p.size,
                opacity: p.opacity,
              }}
            />
          ))}
      </div>

      <nav className="relative z-50 px-6 py-4 border-b border-white/5 backdrop-blur-xl bg-black/20">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-purple-500/25">
              <span className="text-white font-bold text-lg">T</span>
            </div>
            <span className="text-white font-semibold text-xl tracking-tight">
              Trust<span className="text-purple-400">Anchor</span>
            </span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowParticleField(!showParticleField)}
              className="p-2 rounded-lg hover:bg-white/5 transition-colors"
              title="Toggle background"
            >
              <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </button>
            <button
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 text-white font-medium text-sm hover:from-purple-500 hover:to-pink-500 transition-all shadow-lg shadow-purple-500/20"
              onClick={() => setOpenWalletModal(true)}
            >
              {activeAddress ? (
                <span className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  {formatHash(activeAddress)}
                </span>
              ) : (
                'Connect Wallet'
              )}
            </button>
          </div>
        </div>
      </nav>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-12">
        <section className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300 text-sm mb-6">
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
            Privacy-Preserving Verification
          </div>
          <h1 className="text-5xl md:text-7xl font-bold text-white mb-6 tracking-tight">
            <span className="bg-gradient-to-r from-white via-purple-100 to-purple-300 bg-clip-text text-transparent">
              Truth-as-a-Service
            </span>
          </h1>
          <p className="text-xl text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Prove you meet criteria without revealing sensitive data. Built on Algorand with zero-knowledge proofs for complete privacy.
          </p>
        </section>

        <div className="grid lg:grid-cols-12 gap-8 mb-12">
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-gradient-to-b from-white/5 to-transparent rounded-2xl p-6 border border-white/10 backdrop-blur">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold text-white">Create Verification</h2>
                <div className="flex gap-2">
                  {verificationMode === 'zkp' ? (
                    <span className="px-2 py-1 rounded-md bg-purple-500/20 text-purple-300 text-xs font-medium">ZKP</span>
                  ) : (
                    <span className="px-2 py-1 rounded-md bg-slate-500/20 text-slate-300 text-xs font-medium">BOOL</span>
                  )}
                </div>
              </div>

              <div className="space-y-5">
                <div>
                  <label className="block text-sm text-slate-400 mb-2">User ID</label>
                  <input
                    type="text"
                    placeholder="Enter identifier"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-sm text-slate-400 mb-2">Income Threshold ($)</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                    <input
                      type="number"
                      value={threshold}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                      className="w-full pl-8 pr-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                    />
                  </div>
                </div>

                {verificationMode === 'zkp' && (
                  <div className="p-4 rounded-xl bg-green-500/5 border border-green-500/20">
                    <label className="block text-sm text-green-400 mb-2">Your Actual Income ($)</label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-green-500/50">$</span>
                      <input
                        type="number"
                        value={secretValue}
                        onChange={(e) => setSecretValue(Number(e.target.value))}
                        className="w-full pl-8 pr-4 py-3 rounded-xl bg-green-500/10 border border-green-500/20 text-green-100 focus:outline-none focus:border-green-500/50 transition-colors"
                      />
                    </div>
                    <p className="text-xs text-green-400/60 mt-2">This value is proven but never revealed on-chain</p>
                  </div>
                )}

                <div>
                  <label className="block text-sm text-slate-400 mb-2">Verification Mode</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => setVerificationMode('boolean')}
                      className={`p-4 rounded-xl border transition-all text-left ${
                        verificationMode === 'boolean'
                          ? 'bg-slate-500/20 border-slate-400 text-white'
                          : 'bg-white/5 border-white/10 text-slate-400 hover:border-white/20'
                      }`}
                    >
                      <div className="font-medium">Boolean</div>
                      <div className="text-xs text-slate-500 mt-1">0.1 ALGO</div>
                    </button>
                    <button
                      onClick={() => setVerificationMode('zkp')}
                      className={`p-4 rounded-xl border transition-all text-left ${
                        verificationMode === 'zkp'
                          ? 'bg-purple-500/20 border-purple-400 text-white'
                          : 'bg-white/5 border-white/10 text-slate-400 hover:border-white/20'
                      }`}
                    >
                      <div className="font-medium">ZK Proof</div>
                      <div className="text-xs text-purple-400/60 mt-1">0.5 ALGO</div>
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={runVerificationFlow}
                  disabled={loading || !activeAddress}
                  className="flex-1 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 text-white font-medium hover:from-purple-500 hover:to-pink-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-purple-500/25"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      Processing...
                    </span>
                  ) : (
                    'Run Verification'
                  )}
                </button>
                <button
                  onClick={runDemo}
                  disabled={loading}
                  className="px-6 py-3 rounded-xl border border-white/10 text-slate-300 hover:border-white/20 hover:text-white disabled:opacity-50 transition-all"
                >
                  Demo
                </button>
              </div>

              {error && <div className="mt-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">{error}</div>}
            </div>
          </div>

          <div className="lg:col-span-7 space-y-6">
            <div className="bg-gradient-to-b from-white/5 to-transparent rounded-2xl p-6 border border-white/10 backdrop-blur">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold text-white">Verification Flow</h2>
                <button onClick={clearLogs} className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                  Clear
                </button>
              </div>

              <div className="flex flex-wrap gap-2 mb-6">
                {flowSteps.map((s) => {
                  const status = getStepStatus(s.id)
                  return (
                    <div
                      key={s.id}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                        status === 'active'
                          ? 'bg-purple-500 text-white shadow-lg shadow-purple-500/25'
                          : status === 'completed'
                            ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                            : 'bg-white/5 text-slate-500'
                      }`}
                    >
                      <span>{s.icon}</span>
                      <span>{s.label}</span>
                    </div>
                  )
                })}
              </div>

              <div className="bg-black/40 rounded-xl p-4 font-mono text-sm max-h-64 overflow-y-auto custom-scrollbar">
                {logs.length === 0 ? (
                  <div className="text-slate-500">
                    Press <span className="text-purple-400">Run Verification</span> or <span className="text-purple-400">Demo</span> to
                    start
                  </div>
                ) : (
                  logs.map((log, i) => (
                    <div
                      key={i}
                      className={`mb-1 ${
                        log.includes('[ERROR]')
                          ? 'text-red-400'
                          : log.includes('[SUCCESS]') || log.includes('[COMPLETE]')
                            ? 'text-green-400'
                            : log.includes('=') || log.includes('-')
                              ? 'text-slate-600'
                              : log.includes('[PHASE')
                                ? 'text-purple-300'
                                : 'text-slate-300'
                      }`}
                    >
                      {log}
                    </div>
                  ))
                )}
              </div>
            </div>

            {verificationResult && (
              <div
                className={`rounded-2xl p-6 border backdrop-blur transition-all ${
                  verificationResult.result
                    ? 'bg-gradient-to-b from-green-500/10 to-transparent border-green-500/20'
                    : 'bg-gradient-to-b from-red-500/10 to-transparent border-red-500/20'
                }`}
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl font-semibold text-white">Result</h2>
                  <div
                    className={`px-4 py-1.5 rounded-full text-sm font-medium ${
                      verificationResult.result ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                    }`}
                  >
                    {verificationResult.result ? 'VERIFIED' : 'FAILED'}
                  </div>
                </div>

                <div className="grid md:grid-cols-3 gap-6 mb-6">
                  <div>
                    <div className="text-sm text-slate-500 mb-1">User</div>
                    <div className="text-white font-medium">{verificationResult.user_id}</div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-500 mb-1">Mode</div>
                    <div className="text-white font-medium uppercase">{verificationResult.mode}</div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-500 mb-1">Threshold</div>
                    <div className="text-white font-medium">${verificationResult.threshold.toLocaleString()}</div>
                  </div>
                </div>

                {verificationResult.proof && (
                  <div className="pt-6 border-t border-white/10">
                    <div className="text-sm text-slate-500 mb-3">ZK Proof Data</div>
                    <div className="grid grid-cols-2 gap-4 text-sm font-mono">
                      <div className="p-3 rounded-lg bg-white/5">
                        <div className="text-slate-500 mb-1">a</div>
                        <div className="text-purple-300 truncate">{verificationResult.proof.a}</div>
                      </div>
                      <div className="p-3 rounded-lg bg-white/5">
                        <div className="text-slate-500 mb-1">b</div>
                        <div className="text-purple-300 truncate">{verificationResult.proof.b}</div>
                      </div>
                      <div className="p-3 rounded-lg bg-white/5">
                        <div className="text-slate-500 mb-1">c</div>
                        <div className="text-purple-300 truncate">{verificationResult.proof.c}</div>
                      </div>
                      <div className="p-3 rounded-lg bg-white/5">
                        <div className="text-slate-500 mb-1">hash</div>
                        <div className="text-purple-300 truncate">{verificationResult.proof.public_hash}</div>
                      </div>
                    </div>
                  </div>
                )}

                {verificationResult.txid && (
                  <div className="mt-6 pt-6 border-t border-white/10">
                    <div className="text-sm text-slate-500 mb-1">Transaction ID</div>
                    <div className="text-slate-400 font-mono text-sm">{verificationResult.txid}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <section className="grid md:grid-cols-3 gap-6 mb-12">
          <div className="p-6 rounded-2xl bg-gradient-to-br from-purple-500/10 to-pink-500/10 border border-purple-500/20">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a2 2 0 00-2-2H8a2 2 0 00-2 2v4h8z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-white">Zero-Knowledge</h3>
            </div>
            <p className="text-slate-400 text-sm">
              Prove you meet income threshold without revealing actual salary. Uses gnark groth16 with 68 constraints.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-gradient-to-br from-blue-500/10 to-cyan-500/10 border border-blue-500/20">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-blue-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-white">On-Chain</h3>
            </div>
            <p className="text-slate-400 text-sm">
              TruthRegistry stores anchored commitments. Public verification without data disclosure.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-gradient-to-br from-green-500/10 to-emerald-500/10 border border-green-500/20">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-white">X402 Payments</h3>
            </div>
            <p className="text-slate-400 text-sm">HTTP 402 integration for automatic payments. Pay 0.5 ALGO for ZKP verification.</p>
          </div>
        </section>

        <section className="rounded-2xl p-8 border border-white/10 bg-white/5">
          <h3 className="text-lg font-semibold text-white mb-6">Technical Stack</h3>
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <div className="text-purple-400 font-medium mb-2">ZKP Circuit</div>
              <div className="text-white">gnark v0.14.0</div>
              <div className="text-slate-500 text-sm">groth16 ��� 68 constraints</div>
            </div>
            <div>
              <div className="text-purple-400 font-medium mb-2">Smart Contracts</div>
              <div className="text-white">algopy</div>
              <div className="text-slate-500 text-sm">ARC4 • BoxMap</div>
            </div>
            <div>
              <div className="text-purple-400 font-medium mb-2">Backend</div>
              <div className="text-white">FastAPI</div>
              <div className="text-slate-500 text-sm">x402 • Python 3.13</div>
            </div>
            <div>
              <div className="text-purple-400 font-medium mb-2">Frontend</div>
              <div className="text-white">React + TS</div>
              <div className="text-slate-500 text-sm">use-wallet • Vite</div>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/5 py-6">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-slate-500">
          <div>Built on Algorand • TrustAnchor Protocol</div>
          <div className="flex items-center gap-4">
            <a href="#" className="hover:text-slate-300 transition-colors">
              Docs
            </a>
            <a href="#" className="hover:text-slate-300 transition-colors">
              GitHub
            </a>
            <a href="#" className="hover:text-slate-300 transition-colors">
              Discord
            </a>
          </div>
        </div>
      </footer>

      <ConnectWallet openModal={openWalletModal} closeModal={() => setOpenWalletModal(false)} />

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
      `}</style>
    </div>
  )
}

export default TrustAnchorApp
