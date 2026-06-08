// ── EchoVault — app.js ─────────────────────────────────────
// Stack: ethers.js v6, Firebase, Groq AI, vanilla JS
// Contract: EchoVault.sol deployed on Sepolia
// Pitched as "Powered by Rialo native timers + web calls"
// ──────────────────────────────────────────────────────────

import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.1/dist/ethers.esm.min.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, getDocs, collection, query, where, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ══ CONFIG — fill in before deploying ══════════════════════
const CONFIG = {
  CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000000", // ← paste after deploy
  SEPOLIA_RPC: "https://rpc.sepolia.org",
  SEPOLIA_CHAIN_ID: "0xaa36a7",
  SEPOLIA_EXPLORER: "https://sepolia.etherscan.io",
  GROQ_API_KEY: "", // ← paste Groq free API key
  FIREBASE: {
    apiKey: "", authDomain: "", projectId: "",
    storageBucket: "", messagingSenderId: "", appId: "",
  },
};

// ══ CONTRACT ABI (minimal) ═════════════════════════════════
const ABI = [
  "function createVault(string title,string encryptedMessage,uint8 triggerType,uint256 unlockAt,uint256 deadManDays,address tokenAddress,uint256 tokenAmount,address[] benefWallets,uint16[] benefShares,string[] benefLabels,string conditionApiUrl,string conditionKeyword) payable returns (uint256)",
  "function ping(uint256 vaultId)",
  "function execute(uint256 vaultId)",
  "function cancel(uint256 vaultId)",
  "function topUp(uint256 vaultId) payable",
  "function isExecutable(uint256 vaultId) view returns (bool ok, string reason)",
  "function getVault(uint256 vaultId) view returns (uint256 id,address owner,string title,uint8 triggerType,uint256 unlockAt,uint256 deadManDays,uint256 lastOwnerPing,uint256 ethAmount,address tokenAddress,uint256 tokenAmount,uint8 status,uint256 createdAt,string conditionApiUrl,string conditionKeyword)",
  "function getBeneficiaries(uint256 vaultId) view returns (tuple(address wallet,uint16 basisPoints,string label)[])",
  "function getEncryptedMessage(uint256 vaultId) view returns (string)",
  "function getOwnerVaults(address owner) view returns (uint256[])",
  "function vaultCount() view returns (uint256)",
  "event VaultCreated(uint256 indexed vaultId,address indexed owner,string title,uint8 trigger)",
  "event VaultExecuted(uint256 indexed vaultId,address indexed executor,uint256 ts)",
  "event OwnerPinged(uint256 indexed vaultId,address owner,uint256 ts)",
];

// ══ STATE ══════════════════════════════════════════════════
let state = {
  address: null, provider: null, signer: null,
  ethBal: "0.000",
  vaults: [],         // local cache
  benefCount: 1,      // create form
  groqLoading: false,
};

// ══ FIREBASE ═══════════════════════════════════════════════
let db = null;
try {
  const fbApp = initializeApp(CONFIG.FIREBASE);
  db = getFirestore(fbApp, "echovault");
} catch(e) { console.warn("Firebase not configured — local mode only"); }

async function fbSave(col, id, data) {
  if (!db || !state.address) return;
  try {
    await setDoc(doc(db, col, id), { ...data, ownerAddress: state.address.toLowerCase(), updatedAt: Date.now() }, { merge: true });
  } catch(e) { console.warn("fbSave error", e); }
}
async function fbGet(col, id) {
  if (!db) return null;
  try { const s = await getDoc(doc(db, col, id)); return s.exists() ? s.data() : null; }
  catch { return null; }
}
async function fbList(col) {
  if (!db || !state.address) return [];
  try {
    const snap = await getDocs(query(collection(db, col), where("ownerAddress","==",state.address.toLowerCase())));
    return snap.docs.map(d => ({ fbId: d.id, ...d.data() }));
  } catch { return []; }
}

// ══ HELPERS ════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
function san(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function shortAddr(a) { return a ? a.slice(0,6)+"…"+a.slice(-4) : "—"; }
function shortHash(h) { return h ? h.slice(0,8)+"…"+h.slice(-6) : "—"; }
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-GB", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
}
function fmtCountdown(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return "NOW";
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function triggerLabel(t) {
  return ["⏰ Time Lock","💀 Dead-man Switch","🔗 Combined"][t] ?? "Unknown";
}
function statusLabel(s) { return ["Active","Executed","Cancelled"][s] ?? "—"; }
function statusClass(s) { return ["active","executed","cancelled"][s] ?? ""; }
function triggerClass(t) { return ["time","dead","combo"][t] ?? "time"; }

// ══ TOAST ══════════════════════════════════════════════════
function toast(type, msg) {
  let c = $("toast-container");
  if (!c) { c = document.createElement("div"); c.id="toast-container"; c.className="toast-container"; document.body.appendChild(c); }
  const t = document.createElement("div");
  const icons = { success:"✅", error:"❌", info:"ℹ️", warning:"⚠️" };
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type]||"•"}</span><span>${san(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ══ MODAL ══════════════════════════════════════════════════
function showModal(title, body) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = body;
  $("modal").classList.add("open");
}
function closeModal(e) {
  if (!e || e.target === $("modal")) $("modal").classList.remove("open");
}
window.closeModal = closeModal;

function showSuccessModal(title, body) { showModal(title, body); }

// ══ LOADING ════════════════════════════════════════════════
function setLoading(btn, on, label) {
  if (!btn) return;
  btn.disabled = on;
  if (label) btn.textContent = on ? "⏳ " + label : label.replace("⏳ ","");
}

// ══ NAVIGATION ═════════════════════════════════════════════
const PAGE_TITLES = {
  home:"Dashboard", vaults:"My Vaults", create:"Create Vault",
  monitor:"Condition Monitor", agent:"AI Rule Agent", about:"About EchoVault",
};
function nav(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.querySelectorAll(".mobile-nav-item").forEach(n =>
    n.classList.toggle("active", n.getAttribute("onclick")?.includes(`'${id}'`) ?? false)
  );
  const page = $("page-" + id);
  if (!page) return;
  page.classList.add("active");
  document.querySelectorAll(".nav-item").forEach(n => {
    if (n.getAttribute("onclick")?.includes(`'${id}'`)) n.classList.add("active");
  });
  setText("page-title", PAGE_TITLES[id] || id);
  onPageLoad(id);
}
window.nav = nav;

function navDrawer(id) { closeDrawer(); nav(id); }
window.navDrawer = navDrawer;

function toggleDrawer() {
  $("mobile-drawer")?.classList.toggle("open");
  $("drawer-overlay")?.classList.toggle("open");
}
function closeDrawer() {
  $("mobile-drawer")?.classList.remove("open");
  $("drawer-overlay")?.classList.remove("open");
}
window.toggleDrawer = toggleDrawer;
window.closeDrawer  = closeDrawer;

function onPageLoad(id) {
  if (id === "home")    renderHome();
  if (id === "vaults")  renderVaults();
  if (id === "monitor") renderMonitor();
  if (id === "create")  initCreateForm();
  if (id === "agent")   initAgentPage();
}

// ══ WALLET ═════════════════════════════════════════════════
async function handleWalletClick() {
  if (state.address) { disconnectWallet(); return; }
  await connectWallet();
}
window.handleWalletClick = handleWalletClick;

async function connectWallet() {
  if (!window.ethereum) { toast("error","Install MetaMask"); return; }
  try {
    const accounts = await window.ethereum.request({ method:"eth_requestAccounts" });
    if (!accounts.length) return;
    state.address  = accounts[0];
    state.provider = new ethers.BrowserProvider(window.ethereum);
    state.signer   = await state.provider.getSigner();
    await ensureSepoliaNetwork();
    state.provider = new ethers.BrowserProvider(window.ethereum);
    state.signer   = await state.provider.getSigner();
    await refreshBalance();
    await loadVaults();
    updateWalletUI();
    renderHome();
    toast("success", `Connected: ${shortAddr(state.address)}`);
  } catch(e) {
    if (e.code === 4001) return;
    toast("error", e.message ?? "Connection failed");
  }
}
window.connectWallet = connectWallet;

function disconnectWallet() {
  state = { ...state, address:null, provider:null, signer:null, ethBal:"0.000", vaults:[] };
  updateWalletUI();
  renderHome();
  toast("info","Wallet disconnected");
}

async function ensureSepoliaNetwork() {
  if (!window.ethereum) return;
  const chainId = await window.ethereum.request({ method:"eth_chainId" });
  if (chainId.toLowerCase() === CONFIG.SEPOLIA_CHAIN_ID.toLowerCase()) return;
  try {
    await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{ chainId: CONFIG.SEPOLIA_CHAIN_ID }] });
  } catch(e) {
    if (e.code === 4902) {
      await window.ethereum.request({ method:"wallet_addEthereumChain", params:[{
        chainId: CONFIG.SEPOLIA_CHAIN_ID, chainName:"Sepolia Testnet",
        rpcUrls:["https://rpc.sepolia.org"], blockExplorerUrls:["https://sepolia.etherscan.io"],
        nativeCurrency:{ name:"SepoliaETH", symbol:"ETH", decimals:18 },
      }] });
    } else throw e;
  }
}

async function refreshBalance() {
  if (!state.address) return;
  try {
    const rpc = new ethers.JsonRpcProvider(CONFIG.SEPOLIA_RPC);
    const bal = await rpc.getBalance(state.address);
    state.ethBal = parseFloat(ethers.formatEther(bal)).toFixed(4);
    updateWalletUI();
  } catch { state.ethBal = "—"; }
}

function updateWalletUI() {
  const dot  = $("wallet-dot"), lbl = $("wallet-label"), disp = $("balance-display");
  if (!dot) return;
  if (state.address) {
    dot.className = "dot connected";
    lbl.textContent = shortAddr(state.address);
    disp.style.display = "block";
    disp.textContent = state.ethBal + " ETH";
    setText("home-eth", state.ethBal + " ETH");
    setText("home-vaults", state.vaults.length);
    const active = state.vaults.filter(v => v.status === 0).length;
    setText("home-active", active);
  } else {
    dot.className = "dot disconnected";
    lbl.textContent = "Connect Wallet";
    disp.style.display = "none";
    ["home-eth","home-vaults","home-active","home-executed"].forEach(id => setText(id,"—"));
  }
}

// Auto-reconnect
window.addEventListener("load", async () => {
  if (!window.ethereum) return;
  const saved = localStorage.getItem("echovault_session");
  if (!saved) return;
  const accounts = await window.ethereum.request({ method:"eth_accounts" }).catch(() => []);
  if (!accounts.length) return;
  state.address  = accounts[0];
  state.provider = new ethers.BrowserProvider(window.ethereum);
  state.signer   = null;
  await refreshBalance();
  await loadVaults();
  updateWalletUI();
  renderHome();

  window.ethereum.on?.("accountsChanged", async accounts => {
    if (!accounts.length) { disconnectWallet(); return; }
    state.address = accounts[0];
    state.provider = new ethers.BrowserProvider(window.ethereum);
    state.signer   = await state.provider.getSigner();
    await refreshBalance();
    await loadVaults();
    updateWalletUI();
    renderHome();
  });
});

// ══ CONTRACT ════════════════════════════════════════════════
function getContract(write = false) {
  if (CONFIG.CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
    toast("warning", "Contract not deployed yet — using demo mode");
    return null;
  }
  const runner = write ? state.signer : new ethers.JsonRpcProvider(CONFIG.SEPOLIA_RPC);
  return new ethers.Contract(CONFIG.CONTRACT_ADDRESS, ABI, runner);
}

// ══ LOAD VAULTS ════════════════════════════════════════════
async function loadVaults() {
  if (!state.address) return;
  state.vaults = [];

  // Try on-chain
  const c = getContract();
  if (c) {
    try {
      const ids = await c.getOwnerVaults(state.address);
      const loaded = await Promise.all(ids.map(id => loadVaultById(Number(id))));
      state.vaults = loaded.filter(Boolean);
      // Cache to localStorage
      localStorage.setItem("echovault_vaults_" + state.address.toLowerCase(), JSON.stringify(state.vaults));
      return;
    } catch(e) { console.warn("On-chain load failed, using cache", e); }
  }

  // Fallback: localStorage demo data
  const cached = localStorage.getItem("echovault_vaults_" + state.address?.toLowerCase());
  if (cached) {
    try { state.vaults = JSON.parse(cached); } catch {}
  }

  // If totally empty, seed demo vault
  if (!state.vaults.length) seedDemoVaults();
}

async function loadVaultById(id) {
  const c = getContract();
  if (!c) return null;
  try {
    const raw = await c.getVault(id);
    const benefs = await c.getBeneficiaries(id);
    return {
      id: Number(raw[0]), owner: raw[1], title: raw[2],
      triggerType: Number(raw[3]), unlockAt: Number(raw[4]) * 1000,
      deadManDays: Number(raw[5]), lastOwnerPing: Number(raw[6]) * 1000,
      ethAmount: ethers.formatEther(raw[7]),
      tokenAddress: raw[8], tokenAmount: raw[9].toString(),
      status: Number(raw[10]), createdAt: Number(raw[11]) * 1000,
      conditionApiUrl: raw[12], conditionKeyword: raw[13],
      beneficiaries: benefs.map(b => ({
        wallet: b.wallet, basisPoints: Number(b.basisPoints), label: b.label,
      })),
    };
  } catch { return null; }
}

function seedDemoVaults() {
  state.vaults = [
    {
      id: 1, owner: state.address, title: "Family Inheritance Fund",
      triggerType: 2, unlockAt: Date.now() + 86400000 * 365 * 5,
      deadManDays: 60, lastOwnerPing: Date.now(),
      ethAmount: "2.5", tokenAddress: null, tokenAmount: "10000",
      status: 0, createdAt: Date.now() - 86400000 * 30,
      conditionApiUrl: "", conditionKeyword: "",
      beneficiaries: [
        { wallet: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12", basisPoints: 6000, label: "Wife" },
        { wallet: "0x1234567890ABCDEF1234567890ABCDEF12345678", basisPoints: 4000, label: "Son" },
      ],
      _demo: true,
    },
    {
      id: 2, owner: state.address, title: "Time Capsule 2030",
      triggerType: 0, unlockAt: new Date("2030-01-01").getTime(),
      deadManDays: 0, lastOwnerPing: Date.now(),
      ethAmount: "0.5", tokenAddress: null, tokenAmount: "1000",
      status: 0, createdAt: Date.now() - 86400000 * 10,
      conditionApiUrl: "https://newsapi.org/v2/everything?q=", conditionKeyword: "Mars landing",
      beneficiaries: [
        { wallet: state.address, basisPoints: 10000, label: "Future Me" },
      ],
      _demo: true,
    },
  ];
}

// ══ HOME PAGE ══════════════════════════════════════════════
function renderHome() {
  if (!state.address) {
    $("home-connect-msg").style.display = "block";
    $("home-dashboard").style.display   = "none";
    return;
  }
  $("home-connect-msg").style.display = "none";
  $("home-dashboard").style.display   = "block";

  const active   = state.vaults.filter(v => v.status === 0);
  const executed = state.vaults.filter(v => v.status === 1);
  const totalEth = state.vaults.reduce((s,v) => s + parseFloat(v.ethAmount || 0), 0);

  setText("home-eth",      state.ethBal + " ETH");
  setText("home-vaults",   state.vaults.length);
  setText("home-active",   active.length);
  setText("home-executed", executed.length);
  setText("home-total-locked", totalEth.toFixed(4) + " ETH");

  // Recent vaults
  const el = $("home-vault-list");
  if (!el) return;
  if (!state.vaults.length) {
    el.innerHTML = '<div class="empty-state text-xs">No vaults yet — <a href="#" onclick="nav(\'create\');return false" style="color:var(--p2)">create one</a></div>';
    return;
  }
  el.innerHTML = state.vaults.slice(0,3).map(v => vaultMiniCard(v)).join("");
}

function vaultMiniCard(v) {
  const pct  = triggerProgress(v);
  const tc   = triggerClass(v.triggerType);
  const sc   = statusClass(v.status);
  return `
  <div class="vault-card status-${sc} mb-8" onclick="openVaultDetail(${v.id})" style="padding:14px">
    <div class="flex items-center gap-12 mb-8">
      <div class="vault-icon" style="background:rgba(124,92,252,.12)">${vaultEmoji(v)}</div>
      <div style="flex:1;min-width:0">
        <div class="fw600 text-sm truncate">${san(v.title)}</div>
        <div class="text-xs text-muted mt-4">${triggerLabel(v.triggerType)} · ${san(v.ethAmount)} ETH</div>
      </div>
      <span class="tag tag-${sc === 'active' ? 'green' : sc === 'executed' ? 'teal' : 'gray'}">${statusLabel(v.status)}</span>
    </div>
    <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
    <div class="flex justify-between mt-4">
      <span class="text-xs text-dim">${san(v.beneficiaries.length)} beneficiar${v.beneficiaries.length===1?'y':'ies'}</span>
      <span class="countdown text-xs">${getCountdownLabel(v)}</span>
    </div>
  </div>`;
}

function vaultEmoji(v) {
  if (v.status === 1) return "✅";
  if (v.status === 2) return "❌";
  if (v.triggerType === 0) return "⏰";
  if (v.triggerType === 1) return "💀";
  return "🔗";
}

function triggerProgress(v) {
  if (v.status !== 0) return 100;
  if (v.triggerType === 0) {
    const total = v.unlockAt - v.createdAt;
    const done  = Date.now() - v.createdAt;
    return Math.min(99, Math.max(2, (done/total)*100));
  }
  if (v.triggerType === 1) {
    const silenceSec = v.deadManDays * 86400000;
    const elapsed    = Date.now() - v.lastOwnerPing;
    return Math.min(99, Math.max(2, (elapsed/silenceSec)*100));
  }
  return 50;
}

function getCountdownLabel(v) {
  if (v.status !== 0) return statusLabel(v.status);
  if (v.triggerType === 0) return v.unlockAt > Date.now() ? "Unlocks in " + fmtCountdown(v.unlockAt) : "Ready";
  if (v.triggerType === 1) {
    const deadline = v.lastOwnerPing + v.deadManDays * 86400000;
    return deadline > Date.now() ? "Pings OK · " + fmtCountdown(deadline) + " left" : "⚠️ Triggered!";
  }
  return "Active";
}

// ══ VAULT LIST PAGE ════════════════════════════════════════
function renderVaults() {
  const el = $("vaults-grid");
  if (!el) return;
  if (!state.address) { el.innerHTML = '<div class="empty-state text-xs">Connect wallet first</div>'; return; }
  if (!state.vaults.length) {
    el.innerHTML = `<div class="card text-center" style="padding:40px"><div style="font-size:48px;margin-bottom:16px">🏛️</div><div class="fw600 mb-8">No vaults yet</div><div class="text-muted text-sm mb-20">Create your first digital heritage vault</div><button class="btn btn-gold" onclick="nav('create')">✨ Create Vault</button></div>`;
    return;
  }
  el.innerHTML = state.vaults.map(v => fullVaultCard(v)).join("");
}

function fullVaultCard(v) {
  const pct = triggerProgress(v);
  const sc  = statusClass(v.status);
  const tc  = triggerClass(v.triggerType);
  const deadline = v.triggerType === 1 ? v.lastOwnerPing + v.deadManDays * 86400000 : v.unlockAt;
  const silenceElapsed = v.triggerType === 1 ? Math.min(100, ((Date.now() - v.lastOwnerPing) / (v.deadManDays * 86400000)) * 100) : 0;

  return `
  <div class="vault-card status-${sc} mb-12" onclick="openVaultDetail(${v.id})">
    <div class="flex items-center gap-12 mb-12">
      <div class="vault-icon" style="background:rgba(124,92,252,.15);font-size:24px">${vaultEmoji(v)}</div>
      <div style="flex:1;min-width:0">
        <div class="fw700" style="font-size:15px">${san(v.title)}</div>
        <div class="flex gap-8 mt-6 flex-wrap">
          <span class="rule-badge ${tc}">${triggerLabel(v.triggerType)}</span>
          ${v.conditionKeyword ? `<span class="rule-badge api">🌐 API: ${san(v.conditionKeyword)}</span>` : ""}
          <span class="tag tag-${sc === 'active' ? 'green' : sc === 'executed' ? 'teal' : 'gray'}">${statusLabel(v.status)}</span>
        </div>
      </div>
      <div style="text-align:right">
        <div class="fw700 mono" style="font-size:16px;color:var(--gold)">${san(v.ethAmount)} ETH</div>
        <div class="text-xs text-dim mt-4">${san(v.beneficiaries.length)} heir${v.beneficiaries.length===1?'':'s'}</div>
      </div>
    </div>

    <div class="flex justify-between text-xs text-dim mb-4">
      <span>Progress to trigger</span>
      <span class="countdown">${getCountdownLabel(v)}</span>
    </div>
    <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>

    ${v.triggerType === 1 ? `
    <div class="flex justify-between text-xs mt-6">
      <span style="color:var(--amber)">⏱ Silence: ${Math.round(silenceElapsed)}% of ${san(String(v.deadManDays))} days</span>
      <span style="color:var(--text3)">Last ping: ${fmtDate(v.lastOwnerPing)}</span>
    </div>` : ""}

    <div class="flex gap-8 mt-14" onclick="event.stopPropagation()">
      ${v.status === 0 ? `
        ${(v.triggerType === 1 || v.triggerType === 2) ? `<button class="btn btn-success btn-sm" onclick="doPing(${v.id})">💓 Ping</button>` : ""}
        <button class="btn btn-secondary btn-sm" onclick="openVaultDetail(${v.id})">View</button>
        <button class="btn btn-danger btn-sm" onclick="doCancel(${v.id})">Cancel</button>
      ` : `<button class="btn btn-secondary btn-sm" onclick="openVaultDetail(${v.id})">View Details</button>`}
    </div>
  </div>`;
}

// ══ VAULT DETAIL MODAL ═════════════════════════════════════
async function openVaultDetail(id) {
  const v = state.vaults.find(x => x.id === id);
  if (!v) return;

  const benefRows = v.beneficiaries.map(b => `
    <div class="flex justify-between items-center" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div class="fw600 text-sm">${san(b.label)}</div>
        <div class="mono text-xs text-dim">${san(shortAddr(b.wallet))}</div>
      </div>
      <span class="tag tag-purple">${(b.basisPoints/100).toFixed(0)}%</span>
    </div>`).join("");

  const [execOk, execReason] = await checkExecutable(id);

  showModal(`🏛️ ${san(v.title)}`, `
    <div class="flex gap-8 mb-16 flex-wrap">
      <span class="rule-badge ${triggerClass(v.triggerType)}">${triggerLabel(v.triggerType)}</span>
      <span class="tag tag-${statusClass(v.status) === 'active' ? 'green' : 'gray'}">${statusLabel(v.status)}</span>
      ${v._demo ? '<span class="tag tag-amber">Demo</span>' : ""}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
      <div class="card-inner"><div class="text-xs text-dim mb-4">ETH Locked</div><div class="fw700 mono" style="color:var(--gold)">${san(v.ethAmount)} ETH</div></div>
      <div class="card-inner"><div class="text-xs text-dim mb-4">Created</div><div class="text-sm">${fmtDate(v.createdAt)}</div></div>
      ${v.unlockAt ? `<div class="card-inner"><div class="text-xs text-dim mb-4">Unlocks</div><div class="text-sm">${fmtDate(v.unlockAt)}</div></div>` : ""}
      ${v.deadManDays ? `<div class="card-inner"><div class="text-xs text-dim mb-4">Dead-man</div><div class="text-sm">${san(String(v.deadManDays))} days silence</div></div>` : ""}
    </div>

    ${v.conditionApiUrl ? `
    <div class="card-inner mb-16" style="border-color:rgba(0,229,195,.2)">
      <div class="flex items-center gap-8 mb-4"><span>🌐</span><span class="text-xs fw600" style="color:var(--teal)">External Condition (Rialo Web Call)</span></div>
      <div class="text-xs text-dim mb-4">API: ${san(v.conditionApiUrl)}</div>
      <div class="text-xs">Keyword: <span class="tag tag-teal">${san(v.conditionKeyword)}</span></div>
    </div>` : ""}

    <div class="section-title">Beneficiaries</div>
    <div class="mb-16">${benefRows || "<div class='empty-state text-xs'>None</div>"}</div>

    <div class="card-inner mb-16" style="background:${execOk ? 'rgba(34,217,138,.06)' : 'rgba(255,181,71,.04)'};border-color:${execOk ? 'rgba(34,217,138,.3)' : 'rgba(255,181,71,.2)'}">
      <div class="text-xs fw600 mb-4">Execution Status</div>
      <div class="text-sm">${execOk ? '✅' : '⏳'} ${san(execReason)}</div>
    </div>

    ${v.status === 0 ? `
    <div class="flex gap-8 flex-wrap">
      ${(v.triggerType === 1 || v.triggerType === 2) ? `<button class="btn btn-success" onclick="doPing(${v.id});closeModal()">💓 Ping (I'm alive)</button>` : ""}
      ${execOk ? `<button class="btn btn-primary" onclick="doExecute(${v.id});closeModal()">⚡ Execute Vault</button>` : ""}
      <button class="btn btn-secondary" onclick="doTopUp(${v.id})">+ Top Up</button>
      <button class="btn btn-danger btn-sm" onclick="doCancel(${v.id});closeModal()">Cancel</button>
    </div>` : ""}
    <button class="btn btn-secondary btn-full mt-12" onclick="closeModal()">Close</button>
  `);
}
window.openVaultDetail = openVaultDetail;

async function checkExecutable(id) {
  const v = state.vaults.find(x => x.id === id);
  if (!v) return [false, "Not found"];
  if (v._demo) {
    // Simulate check
    if (v.triggerType === 0) {
      return v.unlockAt <= Date.now() ? [true,"Time lock reached"] : [false,`Unlocks in ${fmtCountdown(v.unlockAt)}`];
    }
    if (v.triggerType === 1) {
      const deadline = v.lastOwnerPing + v.deadManDays * 86400000;
      return deadline <= Date.now() ? [true,"Dead-man switch triggered"] : [false,`Owner active — ${fmtCountdown(deadline)} remaining`];
    }
    return [false,"Combined: check both conditions"];
  }
  const c = getContract();
  if (!c) return [false,"Contract not deployed"];
  try {
    const [ok, reason] = await c.isExecutable(id);
    return [ok, reason];
  } catch { return [false,"Check failed"]; }
}

// ══ VAULT ACTIONS ═══════════════════════════════════════════
async function doPing(id) {
  if (!state.address) { toast("error","Connect wallet"); return; }
  const v = state.vaults.find(x => x.id === id);
  if (!v) return;
  if (v._demo) {
    v.lastOwnerPing = Date.now();
    saveLocalVaults();
    renderVaults(); renderHome();
    toast("success","💓 Ping sent — you're alive!");
    return;
  }
  const c = getContract(true);
  if (!c) return;
  try {
    const tx = await c.ping(id);
    toast("info","Pinging…");
    await tx.wait();
    v.lastOwnerPing = Date.now();
    renderVaults(); renderHome();
    toast("success","💓 Ping confirmed on-chain!");
  } catch(e) { toast("error", e.reason ?? e.message ?? "Ping failed"); }
}
window.doPing = doPing;

async function doExecute(id) {
  if (!state.address) { toast("error","Connect wallet"); return; }
  const confirmed = await Swal.fire({
    title:"Execute Vault?", text:"This will release funds to all beneficiaries. This cannot be undone.",
    icon:"warning", showCancelButton:true, confirmButtonText:"Yes, execute",
    background:"#0d1120", color:"#eef0ff", confirmButtonColor:"#7c5cfc",
  });
  if (!confirmed.isConfirmed) return;
  const v = state.vaults.find(x => x.id === id);
  if (v?._demo) {
    v.status = 1;
    saveLocalVaults();
    renderVaults(); renderHome();
    showSuccessModal("✅ Vault Executed (Demo)", `
      <div class="card-inner mb-12"><div class="text-xs text-dim mb-4">Vault</div><div class="fw600">${san(v.title)}</div></div>
      <div class="card-inner mb-16"><div class="text-xs text-dim mb-4">Distributed</div><div class="fw700 mono" style="color:var(--gold)">${san(v.ethAmount)} ETH</div></div>
      <div class="text-xs text-muted mb-16">In production: Rialo native timers execute this automatically — no one needs to press a button.</div>
      <button class="btn btn-secondary btn-full" onclick="closeModal()">Done</button>`);
    return;
  }
  const c = getContract(true);
  if (!c) return;
  try {
    const tx = await c.execute(id);
    toast("info","Executing…");
    await tx.wait();
    await loadVaults();
    renderVaults(); renderHome();
    toast("success","✅ Vault executed!");
  } catch(e) { toast("error", e.reason ?? e.message ?? "Execution failed"); }
}
window.doExecute = doExecute;

async function doCancel(id) {
  const confirmed = await Swal.fire({
    title:"Cancel Vault?", text:"Funds will be returned to you.",
    icon:"question", showCancelButton:true, confirmButtonText:"Yes, cancel",
    background:"#0d1120", color:"#eef0ff", confirmButtonColor:"#7c5cfc",
  });
  if (!confirmed.isConfirmed) return;
  const v = state.vaults.find(x => x.id === id);
  if (v?._demo) {
    v.status = 2;
    saveLocalVaults();
    renderVaults(); renderHome();
    toast("info","Vault cancelled (demo)");
    return;
  }
  const c = getContract(true);
  if (!c) return;
  try {
    const tx = await c.cancel(id);
    toast("info","Cancelling…");
    await tx.wait();
    await loadVaults();
    renderVaults(); renderHome();
    toast("success","Vault cancelled — funds returned");
  } catch(e) { toast("error", e.reason ?? e.message ?? "Cancel failed"); }
}
window.doCancel = doCancel;

async function doTopUp(id) {
  const v = state.vaults.find(x => x.id === id);
  if (!v) return;
  const { value: amt } = await Swal.fire({
    title:"Top Up Vault", input:"number",
    inputLabel:"ETH to add", inputPlaceholder:"0.01",
    showCancelButton:true, background:"#0d1120", color:"#eef0ff", confirmButtonColor:"#7c5cfc",
  });
  if (!amt || parseFloat(amt) <= 0) return;
  if (v._demo) {
    v.ethAmount = (parseFloat(v.ethAmount) + parseFloat(amt)).toFixed(4);
    saveLocalVaults();
    renderVaults(); renderHome();
    toast("success",`Topped up ${amt} ETH (demo)`);
    return;
  }
  const c = getContract(true);
  if (!c) return;
  try {
    const tx = await c.topUp(id, { value: ethers.parseEther(amt) });
    await tx.wait();
    await loadVaults();
    renderVaults(); renderHome();
    toast("success",`Topped up ${amt} ETH`);
  } catch(e) { toast("error", e.reason ?? e.message ?? "Top-up failed"); }
}
window.doTopUp = doTopUp;

function saveLocalVaults() {
  if (!state.address) return;
  localStorage.setItem("echovault_vaults_" + state.address.toLowerCase(), JSON.stringify(state.vaults));
}

// ══ CREATE VAULT ════════════════════════════════════════════
function initCreateForm() {
  updateTriggerFields();
  const tomorrow = new Date(Date.now() + 86400000);
  const iso = tomorrow.toISOString().slice(0,16);
  const dateEl = $("cv-unlock-date");
  if (dateEl) { dateEl.min = iso; dateEl.value = iso; }
  renderBeneficiaryRows();
}
window.initCreateForm = initCreateForm;

function updateTriggerFields() {
  const type = parseInt($("cv-trigger")?.value ?? "0");
  const timeGroup = $("cv-time-group");
  const deadGroup = $("cv-dead-group");
  if (timeGroup) timeGroup.style.display = (type === 0 || type === 2) ? "block" : "none";
  if (deadGroup) deadGroup.style.display = (type === 1 || type === 2) ? "block" : "none";
}
window.updateTriggerFields = updateTriggerFields;

function addBeneficiary() {
  state.benefCount++;
  renderBeneficiaryRows();
}
function removeBeneficiary() {
  if (state.benefCount > 1) { state.benefCount--; renderBeneficiaryRows(); }
}
window.addBeneficiary    = addBeneficiary;
window.removeBeneficiary = removeBeneficiary;

function renderBeneficiaryRows() {
  const el = $("benef-rows");
  if (!el) return;
  el.innerHTML = Array.from({length: state.benefCount}, (_,i) => `
    <div class="benef-row">
      <input type="text" id="benef-addr-${i}" placeholder="0x… wallet" />
      <input type="number" class="share-field" id="benef-share-${i}" placeholder="%" min="1" max="100" step="1" value="${Math.floor(100/state.benefCount)}" />
      <input type="text" id="benef-label-${i}" placeholder="Wife / Son…" />
      ${i > 0 ? `<button class="btn btn-danger btn-sm" onclick="removeBeneficiary()" style="padding:8px">✕</button>` : `<div></div>`}
    </div>`).join("");
}

async function doCreateVault() {
  if (!state.address) { toast("error","Connect wallet first"); return; }

  const title      = $("cv-title")?.value.trim();
  const message    = $("cv-message")?.value.trim() ?? "";
  const ethAmt     = $("cv-eth")?.value.trim() ?? "0";
  const triggerType = parseInt($("cv-trigger")?.value ?? "0");
  const unlockDate  = $("cv-unlock-date")?.value;
  const deadDays    = parseInt($("cv-dead-days")?.value ?? "30");
  const apiUrl      = $("cv-api-url")?.value.trim() ?? "";
  const apiKeyword  = $("cv-api-keyword")?.value.trim() ?? "";

  if (!title) { toast("error","Enter a vault title"); return; }

  // Collect beneficiaries
  const wallets = [], shares = [], labels = [];
  let totalShare = 0;
  for (let i = 0; i < state.benefCount; i++) {
    const w = $(`benef-addr-${i}`)?.value.trim();
    const s = parseInt($(`benef-share-${i}`)?.value ?? "0");
    const l = $(`benef-label-${i}`)?.value.trim() || `Heir ${i+1}`;
    if (!w || !ethers.isAddress(w)) { toast("error",`Beneficiary ${i+1}: invalid address`); return; }
    if (!s || s < 1)                { toast("error",`Beneficiary ${i+1}: invalid share`); return; }
    wallets.push(w); shares.push(s * 100); labels.push(l);
    totalShare += s;
  }
  if (totalShare !== 100) { toast("error",`Shares must total 100% (currently ${totalShare}%)`); return; }

  const unlockAt   = unlockDate ? Math.floor(new Date(unlockDate).getTime()/1000) : 0;
  const ethValue   = parseFloat(ethAmt) || 0;

  // Encrypt message (XOR with address as demo key — use proper encryption in prod)
  const encMsg = message ? simpleEncrypt(message, state.address) : "";

  const btn = $("cv-submit-btn");
  setLoading(btn, true, "Creating…");

  const c = getContract(true);
  if (!c) {
    // Demo mode
    const newVault = {
      id: state.vaults.length + 100 + Math.floor(Math.random()*1000),
      owner: state.address, title,
      triggerType, unlockAt: unlockAt * 1000,
      deadManDays: deadDays, lastOwnerPing: Date.now(),
      ethAmount: ethAmt || "0",
      tokenAddress: null, tokenAmount: "0",
      status: 0, createdAt: Date.now(),
      conditionApiUrl: apiUrl, conditionKeyword: apiKeyword,
      beneficiaries: wallets.map((w,i) => ({ wallet:w, basisPoints:shares[i], label:labels[i] })),
      encryptedMessage: encMsg, _demo: true,
    };
    state.vaults.unshift(newVault);
    saveLocalVaults();
    setLoading(btn, false, "✨ Create Vault");
    showSuccessModal("🏛️ Vault Created!", `
      <div class="card-inner mb-12"><div class="text-xs text-dim mb-4">Title</div><div class="fw600">${san(title)}</div></div>
      <div class="card-inner mb-12"><div class="text-xs text-dim mb-4">Trigger</div><div class="fw600">${triggerLabel(triggerType)}</div></div>
      <div class="card-inner mb-16"><div class="text-xs text-dim mb-4">Beneficiaries</div><div class="fw600">${wallets.length} heirs configured</div></div>
      <div style="background:rgba(0,229,195,.06);border:1px solid rgba(0,229,195,.2);border-radius:10px;padding:12px;font-size:12px;color:var(--teal);margin-bottom:16px">
        ⚡ <strong>On Rialo:</strong> This vault would self-execute via native on-chain timers. No relayer. No server. No one needs to press a button.
      </div>
      <button class="btn btn-gold btn-full" onclick="nav('vaults');closeModal()">View My Vaults</button>`);
    nav("vaults");
    return;
  }

  try {
    const tx = await c.createVault(
      title, encMsg, triggerType,
      unlockAt, deadDays,
      ethers.ZeroAddress, 0n,
      wallets, shares, labels,
      apiUrl, apiKeyword,
      { value: ethers.parseEther(ethAmt || "0") }
    );
    toast("info","Creating vault on Sepolia…");
    const receipt = await tx.wait();
    await loadVaults();
    localStorage.setItem("echovault_session","1");
    setLoading(btn, false, "✨ Create Vault");
    showSuccessModal("🏛️ Vault Created On-Chain!", `
      <div class="card-inner mb-12"><div class="text-xs text-dim mb-4">TX Hash</div><a href="${CONFIG.SEPOLIA_EXPLORER}/tx/${receipt.hash}" target="_blank" class="mono text-xs" style="color:var(--p2)">${shortHash(receipt.hash)}</a></div>
      <button class="btn btn-gold btn-full" onclick="nav('vaults');closeModal()">View My Vaults</button>`);
    nav("vaults");
  } catch(e) {
    setLoading(btn, false, "✨ Create Vault");
    toast("error", e.reason ?? e.message ?? "Create failed");
  }
}
window.doCreateVault = doCreateVault;

// ══ MONITOR PAGE ════════════════════════════════════════════
async function renderMonitor() {
  const el = $("monitor-list");
  if (!el) return;
  if (!state.vaults.length) {
    el.innerHTML = '<div class="empty-state text-xs">No vaults to monitor</div>'; return;
  }

  el.innerHTML = '<div class="text-xs text-dim mb-12">Checking conditions…</div>';

  const rows = await Promise.all(state.vaults.filter(v => v.status === 0).map(async v => {
    const [execOk, reason] = await checkExecutable(v.id);
    const apiStatus = v.conditionApiUrl ? await checkApiCondition(v) : null;

    return `
    <div class="card-inner mb-8">
      <div class="flex items-center gap-12 mb-10">
        <div class="vault-icon" style="background:rgba(124,92,252,.1);font-size:18px">${vaultEmoji(v)}</div>
        <div style="flex:1">
          <div class="fw600 text-sm">${san(v.title)}</div>
          <div class="text-xs text-dim mt-4">${triggerLabel(v.triggerType)}</div>
        </div>
        <span class="tag tag-${execOk ? 'green' : 'amber'}">${execOk ? 'Ready' : 'Waiting'}</span>
      </div>

      <div class="condition-row">
        <div class="flex items-center gap-8">
          <div class="condition-icon" style="background:rgba(124,92,252,.1)">⏰</div>
          <div>
            <div class="text-sm fw600">Time Condition</div>
            <div class="text-xs text-dim">${getCountdownLabel(v)}</div>
          </div>
        </div>
        <span class="tag tag-${v.triggerType === 0 && v.unlockAt <= Date.now() ? 'green' : v.triggerType !== 0 ? 'teal' : 'amber'}">${v.triggerType === 0 ? (v.unlockAt <= Date.now() ? "✅ Met" : "Pending") : "N/A"}</span>
      </div>

      ${v.triggerType === 1 || v.triggerType === 2 ? `
      <div class="condition-row">
        <div class="flex items-center gap-8">
          <div class="condition-icon" style="background:rgba(255,181,71,.1)">💀</div>
          <div>
            <div class="text-sm fw600">Dead-man Switch</div>
            <div class="text-xs text-dim">Last ping: ${fmtDate(v.lastOwnerPing)}</div>
          </div>
        </div>
        <span class="tag tag-${Date.now() >= v.lastOwnerPing + v.deadManDays * 86400000 ? 'red' : 'green'}">${Date.now() >= v.lastOwnerPing + v.deadManDays * 86400000 ? "⚠️ Triggered" : "✅ Active"}</span>
      </div>` : ""}

      ${v.conditionApiUrl ? `
      <div class="condition-row">
        <div class="flex items-center gap-8">
          <div class="condition-icon" style="background:rgba(0,229,195,.1)">🌐</div>
          <div>
            <div class="text-sm fw600">API Condition</div>
            <div class="text-xs text-dim mono truncate" style="max-width:200px">${san(v.conditionKeyword)}</div>
          </div>
        </div>
        <span class="tag tag-${apiStatus === true ? 'green' : apiStatus === false ? 'amber' : 'gray'}">${apiStatus === true ? "✅ Found" : apiStatus === false ? "Not found" : "—"}</span>
      </div>` : ""}

      ${execOk ? `
      <button class="btn btn-primary btn-sm mt-10 w-full" onclick="doExecute(${v.id})">⚡ Execute Now</button>` : ""}
    </div>`;
  }));

  el.innerHTML = rows.join("");
}

async function checkApiCondition(v) {
  if (!v.conditionApiUrl || !v.conditionKeyword) return null;
  try {
    const res = await fetch(v.conditionApiUrl, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    return text.toLowerCase().includes(v.conditionKeyword.toLowerCase());
  } catch { return null; }
}

// ══ AI AGENT (Groq) ═════════════════════════════════════════
function initAgentPage() {
  renderAgentHistory();
}

let agentHistory = [];

async function askAgent() {
  if (state.groqLoading) return;
  const input = $("agent-input");
  const msg = input?.value.trim();
  if (!msg) return;
  input.value = "";

  agentHistory.push({ role:"user", content: msg });
  renderAgentHistory();

  state.groqLoading = true;
  const btn = $("agent-send-btn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳"; }

  try {
    const systemPrompt = `You are EchoVault AI — an expert in digital heritage planning, smart contract vaults, and blockchain inheritance.

Context: EchoVault is a "Living Will on Blockchain" dApp. Users can:
- Create vaults with ETH + encrypted messages
- Set triggers: Time Lock, Dead-man Switch (inactive for N days), or Combined
- Add beneficiaries with % shares
- Add external API conditions (e.g. news keywords, price checks)
- Built on Rialo blockchain: contracts can make native HTTP calls, run on-chain timers without servers

Help users:
1. Design smart vault rules for their situation
2. Choose trigger types (time vs dead-man vs combined)
3. Suggest beneficiary splits
4. Recommend what assets to put in vaults
5. Explain privacy features

Be concise, practical, warm. Suggest specific rule configurations when relevant.
Format suggestions as: **Rule:** [description] — **Why:** [reason]`;

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONFIG.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [{ role:"system", content:systemPrompt }, ...agentHistory],
        max_tokens: 512,
        temperature: 0.7,
      }),
    });
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content ?? "Sorry, I couldn't get a response right now.";
    agentHistory.push({ role:"assistant", content: reply });
  } catch(e) {
    agentHistory.push({ role:"assistant", content: "⚠️ Groq API error — make sure your API key is set in CONFIG.GROQ_API_KEY. Get a free key at console.groq.com" });
  }

  state.groqLoading = false;
  if (btn) { btn.disabled = false; btn.textContent = "Send"; }
  renderAgentHistory();
}
window.askAgent = askAgent;

function agentKeydown(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askAgent(); } }
window.agentKeydown = agentKeydown;

function renderAgentHistory() {
  const el = $("agent-messages");
  if (!el) return;
  if (!agentHistory.length) {
    el.innerHTML = `
      <div style="text-align:center;padding:30px 0">
        <div style="font-size:40px;margin-bottom:12px">🤖</div>
        <div class="fw600 mb-8">EchoVault AI Agent</div>
        <div class="text-muted text-sm mb-20">Ask me to help design your vault rules</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${["I want to leave money for my kids if I pass away","Help me set up a time capsule for 2030","What's the best trigger for emergency funds?","How should I split assets between family members?"].map(q =>
            `<div class="ai-suggestion" onclick="setAgentPrompt('${q.replace(/'/g,"\\'")}')">
              <div class="ai-suggestion-title">💡 ${san(q)}</div>
            </div>`).join("")}
        </div>
      </div>`;
    return;
  }

  el.innerHTML = agentHistory.map(m => `
    <div style="margin-bottom:14px;display:flex;${m.role==='user'?'justify-content:flex-end':''} ">
      <div style="max-width:85%;padding:12px 16px;border-radius:${m.role==='user'?'16px 4px 16px 16px':'4px 16px 16px 16px'};
        background:${m.role==='user'?'rgba(124,92,252,.2)':'var(--bg3)'};
        border:1px solid ${m.role==='user'?'rgba(124,92,252,.3)':'var(--border)'};
        font-size:13px;line-height:1.6;white-space:pre-wrap">
        ${m.role==='assistant'?'🤖 ':''}${san(m.content)}
      </div>
    </div>`).join("");

  el.scrollTop = el.scrollHeight;
}

function setAgentPrompt(q) { const el = $("agent-input"); if (el) { el.value = q; el.focus(); } }
window.setAgentPrompt = setAgentPrompt;

function clearAgentChat() { agentHistory = []; renderAgentHistory(); }
window.clearAgentChat = clearAgentChat;

// ══ SIMPLE ENCRYPT (demo only — use proper encryption in prod) ══
function simpleEncrypt(text, key) {
  const k = key.slice(2, 10);
  return btoa(text.split("").map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ k.charCodeAt(i % k.length))).join(""));
}
function simpleDecrypt(cipher, key) {
  const k = key.slice(2, 10);
  const text = atob(cipher);
  return text.split("").map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ k.charCodeAt(i % k.length))).join("");
}

// ══ LIVE COUNTDOWNS ═════════════════════════════════════════
setInterval(() => {
  document.querySelectorAll(".countdown").forEach(el => {
    const vaultId = parseInt(el.dataset.vaultId);
    if (!vaultId) return;
    const v = state.vaults.find(x => x.id === vaultId);
    if (v) el.textContent = getCountdownLabel(v);
  });
}, 30000);

// ══ INIT ════════════════════════════════════════════════════
nav("home");