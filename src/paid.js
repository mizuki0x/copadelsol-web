import { createAppKit } from '@reown/appkit'
import { EthersAdapter } from '@reown/appkit-adapter-ethers'
import { base } from '@reown/appkit/networks'
import { BrowserProvider, Contract } from 'ethers'

const API = window.BLUE_LINE_PAID_API || 'https://blue-line-paid.onrender.com'
const PROJECT_ID = '05127cba9dfa263ef6c85ff020515276'
const SESSION_KEY = 'blue-line-paid-session'
const MATCH_KEY = 'blue-line-paid-match'
const SEARCH_KEY = 'blue-line-paid-search'

const erc20Abi = [
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]
const settlementAbi = [
  'function openMatch(uint64 replayMatchId,address opponent,uint256 stake) returns (bytes32)',
  'function fundMatch(bytes32 matchId)',
  'function reclaim(bytes32 matchId)',
  'function refundExpired(bytes32 matchId)',
]

const modal = createAppKit({
  adapters: [new EthersAdapter()],
  networks: [base],
  metadata: {
    name: 'The Blue Line',
    description: 'Identity-bound USDC arcade hockey matches on Base',
    url: 'https://bluelinegame.com',
    icons: ['https://bluelinegame.com/icon-192.png'],
  },
  projectId: PROJECT_ID,
  features: {
    analytics: false,
    email: false,
    socials: [],
    swaps: false,
    onramp: false,
  },
  themeMode: 'dark',
})

const ui = {
  wallet: document.querySelector('#wallet'),
  action: document.querySelector('#action'),
  leave: document.querySelector('#leave'),
  stake: document.querySelector('#stake'),
  terms: document.querySelector('#terms'),
  status: document.querySelector('#status'),
  detail: document.querySelector('#detail'),
  receipt: document.querySelector('#receipt'),
}

let session = readJson(SESSION_KEY)
let wallet = {}
let network = {}
let config
let match
let searching = sessionStorage.getItem(SEARCH_KEY) === '1'
let pollTimer
let busy = false

modal.subscribeAccount(state => {
  wallet = state || {}
  render()
})
modal.subscribeNetwork(state => {
  network = state || {}
  render()
})

ui.wallet.addEventListener('click', connect)
ui.action.addEventListener('click', act)
ui.leave.addEventListener('click', leave)
addEventListener('pageshow', boot)

async function boot() {
  try {
    config = await request('/v1/config')
    if (session?.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
      clearSession()
    }
    if (session) {
      match = await request('/v1/matches/current', { auth: true })
      if (match) startPolling()
    }
  } catch (error) {
    showError(error)
  }
  render()
}

async function connect() {
  if (wallet.isConnected) {
    await modal.open({ view: 'Account' })
    return
  }
  await modal.open()
}

async function act() {
  if (busy) return
  busy = true
  render()
  try {
    if (!wallet.isConnected) {
      await connect()
      return
    }
    await ensureBase()
    await ensureSession()
    if (!match) {
      if (!ui.terms.checked) throw new Error('Confirm the match terms before joining.')
      const result = await request('/v1/queue', {
        method: 'POST',
        auth: true,
        body: { stake: Number(ui.stake.value) },
      })
      match = result.match || null
      searching = !match
      sessionStorage.setItem(SEARCH_KEY, searching ? '1' : '0')
      startPolling()
      setStatus(match ? 'Opponent found.' : 'Searching for an opponent…')
      return
    }
    if (match.state === 'paired' && match.seat === 0) {
      await openEscrow()
      return
    }
    if (match.state === 'open' && match.seat === 1) {
      await fundEscrow()
      return
    }
    if (match.state === 'open' && match.seat === 0) {
      await reclaim()
      return
    }
    if (match.state === 'funded' && refundAvailable(match)) {
      await refundExpired()
      return
    }
    if (match.socketPath && ['funded', 'playing', 'settling'].includes(match.state)) {
      launchGame()
    }
  } catch (error) {
    showError(error)
  } finally {
    busy = false
    render()
  }
}

async function ensureBase() {
  if (Number(network.chainId || modal.getChainId()) === 8453) return
  await modal.switchNetwork(base)
  const provider = modal.getWalletProvider()
  if (!provider) throw new Error('Reconnect your wallet on Base.')
}

async function ensureSession() {
  const address = (wallet.address || modal.getAddress() || '').toLowerCase()
  if (!address) throw new Error('Connect a wallet first.')
  if (session?.address === address && Date.parse(session.expiresAt) > Date.now()) return

  const signer = await getSigner()
  const challenge = await request('/v1/auth/challenge', {
    method: 'POST',
    body: { address },
  })
  const signature = await signer.signMessage(challenge.message)
  session = await request('/v1/auth/verify', {
    method: 'POST',
    body: { challengeId: challenge.challengeId, signature },
  })
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

async function openEscrow() {
  const { signer, address } = await signerAndAddress()
  const token = new Contract(config.usdcAddress, erc20Abi, signer)
  await requireBalance(token, address)
  await approveIfNeeded(token, address)
  setStatus('Confirm the match escrow in your wallet.')
  const escrow = new Contract(config.settlementAddress, settlementAbi, signer)
  const tx = await escrow.openMatch(
    BigInt(match.replayMatchId),
    match.seatB,
    BigInt(match.stake),
  )
  setStatus('Opening escrow on Base…')
  await tx.wait()
  match = await request(`/v1/matches/${match.id}/opened`, {
    method: 'POST',
    auth: true,
    body: { txHash: tx.hash },
  })
  setStatus('Your stake is locked. Waiting for your opponent.')
}

async function fundEscrow() {
  const { signer, address } = await signerAndAddress()
  const token = new Contract(config.usdcAddress, erc20Abi, signer)
  await requireBalance(token, address)
  await approveIfNeeded(token, address)
  setStatus('Confirm the match escrow in your wallet.')
  const escrow = new Contract(config.settlementAddress, settlementAbi, signer)
  const tx = await escrow.fundMatch(match.onchainMatchId)
  setStatus('Funding escrow on Base…')
  await tx.wait()
  match = await request(`/v1/matches/${match.id}/funded`, {
    method: 'POST',
    auth: true,
    body: { txHash: tx.hash },
  })
  setStatus('Both stakes are locked. Preparing the rink…')
}

async function approveIfNeeded(token, address) {
  const stake = BigInt(match.stake)
  if (await token.allowance(address, config.settlementAddress) >= stake) return
  setStatus('Approve this match stake in USDC.')
  const tx = await token.approve(config.settlementAddress, stake)
  setStatus('Confirming USDC approval…')
  await tx.wait()
}

async function requireBalance(token, address) {
  if (await token.balanceOf(address) < BigInt(match.stake)) {
    throw new Error(`You need ${formatUsdc(match.stake)} USDC on Base for this match.`)
  }
}

async function reclaim() {
  const signer = await getSigner()
  const escrow = new Contract(config.settlementAddress, settlementAbi, signer)
  setStatus('Confirm reclaim in your wallet.')
  const tx = await escrow.reclaim(match.onchainMatchId)
  await tx.wait()
  await refreshMatch()
}

async function refundExpired() {
  const signer = await getSigner()
  const escrow = new Contract(config.settlementAddress, settlementAbi, signer)
  setStatus('Confirm the expired-match refund in your wallet.')
  const tx = await escrow.refundExpired(match.onchainMatchId)
  await tx.wait()
  await refreshMatch()
}

async function leave() {
  try {
    if (session && !match) await request('/v1/queue', { method: 'DELETE', auth: true })
    clearInterval(pollTimer)
    pollTimer = null
    match = null
    searching = false
    sessionStorage.removeItem(SEARCH_KEY)
    setStatus('Matchmaking cancelled.')
  } catch (error) {
    showError(error)
  }
  render()
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(refreshMatch, 2000)
}

async function refreshMatch() {
  try {
    const path = match?.id ? `/v1/matches/${match.id}` : '/v1/matches/current'
    const next = await request(path, { auth: true })
    if (next) {
      match = next
      searching = false
      sessionStorage.removeItem(SEARCH_KEY)
    }
    if (match?.state === 'settled' || match?.state === 'refunded') {
      clearInterval(pollTimer)
      pollTimer = null
    }
    render()
  } catch (error) {
    showError(error)
  }
}

function launchGame() {
  sessionStorage.setItem(MATCH_KEY, JSON.stringify({
    api: API,
    token: session.token,
    match,
  }))
  location.assign('/game/?paid=1')
}

async function signerAndAddress() {
  const signer = await getSigner()
  const address = (await signer.getAddress()).toLowerCase()
  if (address !== session.address) {
    clearSession()
    throw new Error('Wallet account changed. Sign in again.')
  }
  return { signer, address }
}

async function getSigner() {
  const provider = modal.getWalletProvider()
  if (!provider) throw new Error('Wallet provider is unavailable. Reconnect your wallet.')
  return new BrowserProvider(provider).getSigner()
}

function render() {
  const address = wallet.address || modal.getAddress()
  ui.wallet.textContent = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connect wallet'
  ui.leave.hidden = !searching
  ui.stake.disabled = Boolean(match) || busy
  ui.terms.disabled = Boolean(match) || busy
  ui.action.disabled = busy

  if (!wallet.isConnected) {
    ui.action.textContent = 'Connect wallet'
    setDetail('Connect an EVM wallet. You sign in without moving funds.')
    return
  }
  if (!session) {
    ui.action.textContent = 'Sign in to play'
    setDetail('A one-time signature binds this browser session to your wallet.')
    return
  }
  if (!match) {
    ui.action.textContent = searching ? 'Searching…' : (busy ? 'Joining…' : 'Find paid match')
    ui.action.disabled = busy || searching
    setDetail(`Stake per player: ${formatUsdc(ui.stake.value)} USDC on Base.`)
    return
  }

  const opponent = `${match.opponent.slice(0, 6)}…${match.opponent.slice(-4)}`
  setDetail(`Seat ${match.seat === 0 ? 'A' : 'B'} · opponent ${opponent} · ${formatUsdc(match.stake)} USDC each`)
  if (match.state === 'paired') {
    ui.action.textContent = match.seat === 0 ? 'Approve & open escrow' : 'Waiting for seat A…'
    ui.action.disabled = busy || match.seat !== 0
  } else if (match.state === 'open') {
    ui.action.textContent = match.seat === 1 ? 'Approve & fund escrow' : 'Reclaim stake'
    ui.action.disabled = busy
  } else if (match.state === 'funded' && refundAvailable(match)) {
    ui.action.textContent = 'Refund expired match'
  } else if (match.socketPath && ['funded', 'playing', 'settling'].includes(match.state)) {
    ui.action.textContent = 'Enter the rink'
  } else if (['funded', 'playing', 'settling'].includes(match.state)) {
    ui.action.textContent = 'Preparing witness…'
    ui.action.disabled = true
  } else if (match.state === 'settled') {
    ui.action.textContent = 'Match settled'
    ui.action.disabled = true
    renderReceipt()
  } else if (match.state === 'refunded') {
    ui.action.textContent = 'Match refunded'
    ui.action.disabled = true
    renderReceipt()
  }
  if (match.error) setStatus(match.error, true)
}

function renderReceipt() {
  const tx = match.settlementTx || match.fundedTx || match.openedTx
  ui.receipt.hidden = false
  ui.receipt.innerHTML = tx
    ? `<strong>${match.state}</strong><a href="https://basescan.org/tx/${tx}" target="_blank" rel="noopener">View transaction ↗</a>`
    : `<strong>${match.state}</strong>`
}

function refundAvailable(value) {
  if (!value.fundedAt || !config) return false
  return Date.parse(value.fundedAt) + Number(config.settleWindowSeconds) * 1000 <= Date.now()
}

async function request(path, options = {}) {
  const headers = {}
  if (options.body) headers['content-type'] = 'application/json'
  if (options.auth) {
    if (!session?.token) throw new Error('Your paid-match session expired.')
    headers.authorization = `Bearer ${session.token}`
  }
  const response = await fetch(`${API}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error?.message || `Paid match service returned ${response.status}.`)
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return null
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

function formatUsdc(value) {
  return (Number(value) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function readJson(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key))
  } catch {
    return null
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY)
  sessionStorage.removeItem(MATCH_KEY)
  sessionStorage.removeItem(SEARCH_KEY)
  session = null
  searching = false
}

function setStatus(message, error = false) {
  ui.status.textContent = message
  ui.status.dataset.error = error ? 'true' : 'false'
}

function setDetail(message) {
  ui.detail.textContent = message
}

function showError(error) {
  setStatus(error?.shortMessage || error?.reason || error?.message || 'Something went wrong.', true)
}
