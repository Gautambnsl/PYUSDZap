import { useEffect, useMemo, useState } from 'react'
import './App.css'

// Network targets (Arbitrum One)
const TARGET_CHAIN_ID = 42161
const TARGET_CHAIN_HEX = '0xa4b1'
const TARGET_CHAIN_NAME = 'Arbitrum One'
const TARGET_RPC_URL = 'https://arb1.arbitrum.io/rpc'
const TARGET_BLOCK_EXPLORER = 'https://arbiscan.io'

// PYUSD token address on Arbitrum One (provided)
const PYUSD_ADDRESS = '0x46850aD61C2B7d64d08c9C754F45254596696984'
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
]

type Strategy = {
  name: string
  apy: string
  desc: string
  risk: 'Low' | 'Medium' | 'High'
  tvl: string
}

type Position = {
  id: string
  strategyName: string
  apy: string
  risk: 'Low' | 'Medium' | 'High'
  tvl: string
  amountPYUSD: number
  openedAt: number
}

function App() {
  const [account, setAccount] = useState<string | null>(null)
  const [balance, setBalance] = useState<string>('0')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [walletDetected, setWalletDetected] = useState<boolean>(false)
  const [showDeposit, setShowDeposit] = useState(false)
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null)
  const [depositAmount, setDepositAmount] = useState<string>('')
  const amountNum = Number(depositAmount || '0')
  const [positions, setPositions] = useState<Position[]>([])

  // Simple mock estimates for review preview
  const review = useMemo(() => {
    const amt = isFinite(amountNum) ? Math.max(0, amountNum) : 0
    const routingFeePct = 0.001 // 0.10%
    const slippagePct = 0.003 // 0.30%
    const fee = amt * routingFeePct
    const minAfterSlippage = Math.max(0, (amt - fee) * (1 - slippagePct))
    return {
      routingFeePct: (routingFeePct * 100).toFixed(2) + '%',
      slippagePct: (slippagePct * 100).toFixed(2) + '%',
      fee: fee.toFixed(2),
      minAfterSlippage: minAfterSlippage.toFixed(2),
    }
  }, [amountNum])

  const strategies: Strategy[] = useMemo(
    () => [
      {
        name: 'ETH/PYUSD Liquidity Pool',
        apy: '8.2%',
        desc: 'Earn fees by providing liquidity to the ETH/PYUSD trading pair with optimized rebalancing.',
        risk: 'Medium',
        tvl: '$2.4M'
      },
      {
        name: 'USDC/PYUSD Stable Strategy',
        apy: '5.1%',
        desc: 'Conservative stable-to-stable strategy with minimal impermanent loss risk.',
        risk: 'Low',
        tvl: '$8.7M'
      },
      {
        name: 'Multi-Asset Yield Farm',
        apy: '12.5%',
        desc: 'Advanced multi-token strategy leveraging yield farming across multiple protocols.',
        risk: 'High',
        tvl: '$1.2M'
      }
    ],
    []
  )

  useEffect(() => {
    if (account) {
      fetchBalance()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account])

  // On mount, detect provider and prefetch existing accounts
  useEffect(() => {
    const eth = (window as any).ethereum
    if (!eth) {
      setWalletDetected(false)
      return
    }
    setWalletDetected(true)
    // Try to read already connected accounts
    if (typeof eth.request === 'function') {
      eth
        .request({ method: 'eth_accounts' })
        .then((accs: string[]) => {
          if (accs && accs[0]) setAccount(accs[0])
        })
        .catch(() => {})
    }

    // Listen to wallet events
    const handleAccountsChanged = (accs: string[]) => {
      setAccount(accs && accs[0] ? accs[0] : null)
    }
    const handleChainChanged = () => {
      // Refresh balance on chain changes
      if (account) fetchBalance()
    }
    eth.on?.('accountsChanged', handleAccountsChanged)
    eth.on?.('chainChanged', handleChainChanged)

    return () => {
      eth.removeListener?.('accountsChanged', handleAccountsChanged)
      eth.removeListener?.('chainChanged', handleChainChanged)
    }
  }, [])

  async function connectWallet() {
    setError(null)
    try {
      const eth = getEthProvider()
      if (!eth) {
        alert('Please install MetaMask')
        return
      }
      // Prefer direct request to wallet to avoid provider quirks
      let accounts: string[] | undefined
      if (typeof eth.request === 'function') {
        accounts = await eth.request({ method: 'eth_requestAccounts' })
      } else {
        const { ethers } = await import('ethers')
        const provider = new ethers.providers.Web3Provider(eth)
        accounts = await provider.send('eth_requestAccounts', [])
      }
      if (!accounts || accounts.length === 0) {
        setError('No accounts returned from wallet')
        return
      }
      setAccount(accounts[0])

      // Try switching to Arbitrum One after connect for a consistent UX
      await ensureTargetNetwork(eth)
    } catch (e: any) {
      // Handle common user rejection code
      if (e?.code === 4001) {
        setError('Connection request was rejected in the wallet')
      } else {
        setError(e?.message ?? 'Failed to connect wallet')
      }
    }
  }

  // Prefer MetaMask provider if multiple are present
  function getEthProvider(): any {
    const eth = (window as any).ethereum
    if (eth && Array.isArray(eth.providers)) {
      const metamask = eth.providers.find((p: any) => p.isMetaMask)
      return metamask || eth.providers[0]
    }
    return eth
  }

  async function fetchBalance() {
    if (!account) return
    setLoading(true)
    setError(null)
    try {
      const eth = getEthProvider()
      if (!eth) {
        setError('No wallet provider detected')
        return
      }
      const { ethers } = await import('ethers')
      // Ensure wallet is on Arbitrum, but read via RPC even if not switched
      await ensureTargetNetwork(eth)

      // Use RPC provider to guarantee reads from Arbitrum One
      const readProvider = new ethers.providers.JsonRpcProvider(TARGET_RPC_URL)
      const contract = new ethers.Contract(PYUSD_ADDRESS, ERC20_ABI, readProvider)
      const bal = await contract.balanceOf(account)
      const dec = await contract.decimals()
      setBalance(ethers.utils.formatUnits(bal, dec))
    } catch (e: any) {
      console.error(e)
      setError(
        e?.code === 'MODULE_NOT_FOUND'
          ? 'Dependency missing: please install "ethers"'
          : e?.reason || e?.message || `Failed to fetch PYUSD balance on ${TARGET_CHAIN_NAME}`
      )
    } finally {
      setLoading(false)
    }
  }

  // Ensure wallet is on target chain, try switch and add if needed
  async function ensureTargetNetwork(eth: any) {
    try {
      const { ethers } = await import('ethers')
      const provider = new ethers.providers.Web3Provider(eth)
      const network = await provider.getNetwork()
      if (network.chainId === TARGET_CHAIN_ID) return true
      // Try switch
      if (typeof eth.request === 'function') {
        try {
          await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_CHAIN_HEX }] })
          return true
        } catch (switchErr: any) {
          // Unrecognized chain -> try to add
          if (switchErr?.code === 4902) {
            try {
              await eth.request({
                method: 'wallet_addEthereumChain',
                params: [{
                  chainId: TARGET_CHAIN_HEX,
                  chainName: TARGET_CHAIN_NAME,
                  rpcUrls: [TARGET_RPC_URL],
                  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                  blockExplorerUrls: [TARGET_BLOCK_EXPLORER]
                }]
              })
              return true
            } catch (addErr) {
              // fall through
            }
          }
        }
      }
    } catch (_) {
      // ignore
    }
    return false
  }

  return (
    <div className="page">
      {/* Header */}
      <header className="header">
        <div className="brand">
          <div className="brand-mark" aria-hidden>Ƥ</div>
          <div className="brand-text">
            <span className="brand-name">PYUSD</span>
            <span className="brand-sub">Strategy Dashboard</span>
          </div>
        </div>

        {!account ? (
          walletDetected ? (
            <button className="btn btn-primary" onClick={connectWallet}>
              Connect Wallet
            </button>
          ) : (
            <a className="btn btn-primary" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
              Install MetaMask
            </a>
          )
        ) : (
          <div className="account">
            <div className="account-dot" />
            <span className="account-text">
              {account.slice(0, 6)}...{account.slice(-4)}
            </span>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="content">
        {/* Hero */}
        <section className="hero">
          <div className="hero-kicker">P • PYUSD Strategies • Powered by PayPal USD</div>
          <h1 className="hero-title">Maximize Your <span className="grad">PYUSD</span> Returns</h1>
          <p className="hero-sub">
            Discover institutional-grade DeFi strategies designed to optimize your PayPal USD holdings with
            transparent, secure, and automated yield generation.
          </p>
          {!account && (
            <div className="hero-actions">
              <button className="btn btn-primary" onClick={connectWallet}>Connect Wallet to Get Started</button>
            </div>
          )}
        </section>

        {/* Stats */}
        <section className="stats">
          <div className="stat"><div className="stat-value">$12.3M</div><div className="stat-label">Total Value Locked</div></div>
          <div className="stat"><div className="stat-value">2,847</div><div className="stat-label">Active Users</div></div>
          <div className="stat"><div className="stat-value">8.6%</div><div className="stat-label">Avg APY</div></div>
          <div className="stat"><div className="stat-value">3</div><div className="stat-label">Strategies Available</div></div>
        </section>

        {/* Wallet summary card */}
        {account && (
          <section className="card wallet">
            <div className="wallet-top">
              <h2 className="card-title">PYUSD Balance</h2>
              {loading ? (
                <div className="spinner" aria-label="Loading" />
              ) : null}
            </div>
            {error ? (
              <div className="alert alert-error">{error}</div>
            ) : (
              <p className="wallet-balance">
                <span className="balance-number">{balance}</span>
                <span className="balance-unit">PYUSD</span>
              </p>
            )}
            <div className="wallet-actions">
              <button className="btn btn-secondary" onClick={fetchBalance} disabled={loading}>
                Refresh Balance
              </button>
            </div>
          </section>
        )}

        {/* Single-Token Zaps (Deposit/Withdraw) */}
        <section>
          <div className="section-head">
            <h3 className="section-title">Single‑Token Zaps for PYUSD</h3>
            <p className="section-sub">Deposit and withdraw using only PYUSD. We handle the routing into and out of LP positions under the hood.</p>
          </div>
          <div className="zap-grid">
            <div className="card zap-card">
              <h4 className="zap-title">Deposit Zap (PYUSD ➜ LP)</h4>
              <p className="zap-desc">
                Supply only PYUSD. We automatically route through trusted DEXes on <strong>{TARGET_CHAIN_NAME}</strong> to create the balanced LP position for the selected strategy.
              </p>
              <ul className="zap-list">
                <li><span className="dot" /> Single‑asset input: PYUSD only</li>
                <li><span className="dot" /> Auto‑split, swap, and add liquidity</li>
                <li><span className="dot" /> Transparent routing and estimated slippage</li>
              </ul>
              <div className="zap-cta">
                <button className="btn btn-primary btn-block">Deposit PYUSD via Zap</button>
              </div>
              <p className="zap-note">Note: You’ll review route, fees, and min‑received before confirming in your wallet.</p>
            </div>

            <div className="card zap-card">
              <h4 className="zap-title">Withdraw Zap (LP ➜ PYUSD)</h4>
              <p className="zap-desc">
                Exit back to only PYUSD. We remove liquidity and swap residual tokens to PYUSD to keep your balances simple.
              </p>
              <ul className="zap-list">
                <li><span className="dot" /> Single‑asset output: PYUSD only</li>
                <li><span className="dot" /> Auto‑remove liquidity and swap to PYUSD</li>
                <li><span className="dot" /> Clear preview of output and fees</li>
              </ul>
              <div className="zap-cta">
                <button className="btn btn-secondary btn-block">Withdraw to PYUSD via Zap</button>
              </div>
              <p className="zap-note">Tip: Ideal for simplifying portfolio accounting and PYUSD‑only treasuries.</p>
            </div>
          </div>
        </section>

        {/* Featured Strategies */}
        <section>
          <div className="section-head">
            <h3 className="section-title">Featured Strategies</h3>
            <p className="section-sub">Choose from our carefully curated strategies, each designed for different risk profiles and yield objectives.</p>
          </div>
          <div className="grid">
            {strategies.map((s, i) => (
              <div className="card strategy" key={i}>
                <div className="strategy-top">
                  <span className="badge">{s.apy} APY</span>
                </div>
                <h4 className="strategy-title">{s.name}</h4>
                <p className="strategy-desc">{s.desc}</p>
                <div className="kv">
                  <div className="kv-row"><span className="kv-key">Risk Level</span><span className={`kv-val risk-${s.risk.toLowerCase()}`}>{s.risk}</span></div>
                  <div className="kv-row"><span className="kv-key">TVL</span><span className="kv-val">{s.tvl}</span></div>
                </div>
                <button className="btn btn-primary btn-block" onClick={() => { setSelectedStrategy(s); setShowDeposit(true); }}>Deposit PYUSD</button>
              </div>
            ))}
          </div>
        </section>

        {/* Your Positions */}
        <section>
          <div className="section-head">
            <h3 className="section-title">Your Positions</h3>
            <p className="section-sub">Track your active deposits and manage exits back to PYUSD.</p>
          </div>
          {positions.length === 0 ? (
            <div className="card">
              <p className="feature-desc">No active positions yet. Start by choosing a strategy above and depositing PYUSD via the Zap.</p>
            </div>
          ) : (
            <div className="grid">
              {positions.map((p) => (
                <div className="card" key={p.id}>
                  <h4 className="strategy-title">{p.strategyName}</h4>
                  <div className="kv">
                    <div className="kv-row"><span className="kv-key">Deposited</span><span className="kv-val">{p.amountPYUSD.toFixed(2)} PYUSD</span></div>
                    <div className="kv-row"><span className="kv-key">APY</span><span className="kv-val">{p.apy}</span></div>
                    <div className="kv-row"><span className="kv-key">Risk</span><span className={`kv-val risk-${p.risk.toLowerCase()}`}>{p.risk}</span></div>
                    <div className="kv-row"><span className="kv-key">Opened</span><span className="kv-val">{new Date(p.openedAt).toLocaleDateString()}</span></div>
                  </div>
                  <div className="wallet-actions">
                    <button className="btn btn-secondary">Withdraw to PYUSD</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Why Choose */}
        <section>
          <div className="section-head">
            <h3 className="section-title">Why Choose PYUSD Strategies?</h3>
          </div>
          <div className="grid why">
            <div className="card feature">
              <h4 className="feature-title">Bank-Grade Security</h4>
              <p className="feature-desc">Multi-signature wallets and audited smart contracts protect your funds with institutional-level security.</p>
            </div>
            <div className="card feature">
              <h4 className="feature-title">Automated Optimization</h4>
              <p className="feature-desc">Our algorithms continuously rebalance your positions to maximize yields while minimizing risks.</p>
            </div>
            <div className="card feature">
              <h4 className="feature-title">Transparent Returns</h4>
              <p className="feature-desc">Real-time tracking of your investments with detailed analytics and performance reporting.</p>
            </div>
          </div>
          <div className="tagline">Powered by PayPal USD • Secured by Smart Contracts</div>
          <p className="disclaimer">Always DYOR. Past performance does not guarantee future results.</p>
        </section>
      </main>

      {/* Deposit Modal */}
      {showDeposit && selectedStrategy && (
        <div className="modal-overlay" onClick={() => setShowDeposit(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3 className="modal-title">Deposit PYUSD</h3>
              <button className="modal-close" onClick={() => setShowDeposit(false)} aria-label="Close">×</button>
            </div>
            <div className="modal-body">
              <div className="modal-summary">
                <div className="modal-row"><span className="k">Strategy</span><span className="v">{selectedStrategy.name}</span></div>
                <div className="modal-row"><span className="k">Network</span><span className="v">{TARGET_CHAIN_NAME}</span></div>
                <div className="modal-row"><span className="k">Your PYUSD</span><span className="v">{balance}</span></div>
              </div>
              <label className="field">
                <span className="field-label">Amount (PYUSD)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  className="input"
                />
                <div className="field-hint">Single‑token zap. We’ll route and add liquidity behind the scenes.</div>
              </label>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowDeposit(false)}>Cancel</button>
              {!account ? (
                <button className="btn btn-primary" onClick={connectWallet}>Connect Wallet</button>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={!depositAmount || Number(depositAmount) <= 0}
                  onClick={() => {
                    // Create a mock position entry after confirming
                    if (selectedStrategy) {
                      const amt = Number(depositAmount)
                      if (!isNaN(amt) && amt > 0) {
                        setPositions(prev => [
                          {
                            id: Math.random().toString(36).slice(2),
                            strategyName: selectedStrategy.name,
                            apy: selectedStrategy.apy,
                            risk: selectedStrategy.risk,
                            tvl: selectedStrategy.tvl,
                            amountPYUSD: amt,
                            openedAt: Date.now(),
                          },
                          ...prev,
                        ])
                      }
                    }
                    setShowDeposit(false)
                    setDepositAmount('')
                  }}
                >
                  Confirm Deposit
                </button>
              )}
            </div>
            {depositAmount && Number(depositAmount) > 0 && (
              <div className="review card">
                <h4 className="review-title">Review Route</h4>
                <div className="review-grid">
                  <div className="review-row"><span className="k">Strategy APY</span><span className="v">{selectedStrategy.apy}</span></div>
                  <div className="review-row"><span className="k">Risk</span><span className={`v risk-${selectedStrategy.risk.toLowerCase()}`}>{selectedStrategy.risk}</span></div>
                  <div className="review-row"><span className="k">TVL</span><span className="v">{selectedStrategy.tvl}</span></div>
                  <div className="review-row"><span className="k">Input</span><span className="v">{Number(depositAmount).toFixed(2)} PYUSD</span></div>
                  <div className="review-row"><span className="k">Estimated Routing Fee</span><span className="v">{review.fee} PYUSD ({review.routingFeePct})</span></div>
                  <div className="review-row"><span className="k">Estimated Slippage</span><span className="v">{review.slippagePct}</span></div>
                  <div className="review-row"><span className="k">Min Received Into Position</span><span className="v">{review.minAfterSlippage} PYUSD-equivalent</span></div>
                  <div className="review-row"><span className="k">Route</span><span className="v">PYUSD → split/swap → add liquidity on {TARGET_CHAIN_NAME}</span></div>
                </div>
                <p className="review-note">This is a preview for readability. Final route, fees, and minimums will be shown in your wallet before confirmation.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="footer">
        <span>Built with ❤️ for the PYUSD ecosystem</span>
      </footer>
    </div>
  )
}

export default App
