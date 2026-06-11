
import {
  BrowserProvider,
  Contract,
  Interface,
  formatEther,
  parseEther,
} from "ethers";

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE SDK — Firestore
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp } from "firebase/app";
import {
  getStorage,
  ref as storageRef,
  uploadString,
  getDownloadURL,
} from "firebase/storage";
import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  getDoc,
  deleteDoc,
  doc,
  setDoc,
  onSnapshot,
  addDoc,
  updateDoc,
  serverTimestamp,
  orderBy,
  limit,
  type DocumentData,
  type QuerySnapshot,
  type Unsubscribe,
} from "firebase/firestore";

/* ──────────────────────────────────────────────────────────────
   🔥 FIREBASE CONFIG  —  read from .env (Vite)
   Create a .env file at project root:
     VITE_FB_API_KEY=...
     VITE_FB_AUTH_DOMAIN=...
     VITE_FB_PROJECT_ID=...
     VITE_FB_STORAGE_BUCKET=...
     VITE_FB_MESSAGING_SENDER_ID=...
     VITE_FB_APP_ID=...
   ──────────────────────────────────────────────────────────────── */
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FB_API_KEY,
  authDomain:        import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FB_APP_ID,
};

// Validate — all keys must have a value ───────────────────────────────────────
const FB_CONFIGURED = Object.values(firebaseConfig).every(v => !!v);

if (!FB_CONFIGURED) {
  console.warn(
    '%c[SecretBid] Firebase not configured — running in demo/offline mode.\n' +
    'Create a .env file with VITE_FB_* variables to enable realtime features.',
    'color:#f59e0b;font-weight:bold'
  );
}

const fbApp     = initializeApp(firebaseConfig);
const db        = getFirestore(fbApp);
const fbStorage = getStorage(fbApp);

// Expose db + Firestore helpers for ticker script (inline <script>, not a module)
(window as any).__fbDb           = db;
(window as any).__fbCollection   = collection;
(window as any).__fbQuery        = query;
(window as any).__fbOrderBy      = orderBy;
(window as any).__fbLimit        = limit;
(window as any).__fbOnSnapshot   = onSnapshot;
(window as any).__fbWhere        = where;

// ─────────────────────────────────────────────────────────────────────────────
//  WINDOW AUGMENTATION — fixes "Property does not exist on type 'Window'" errors
// ─────────────────────────────────────────────────────────────────────────────
declare global {
  interface Window {
    _pendingAddr: string;
  }
}

// Helper to safely access window.ethereum without TS errors
function getEthereum(): any | undefined {
  return (window as any).ethereum;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface Auction {
  id: number | string;
  _fbKey?: string;
  itemName: string;
  itemDescription: string;
  itemImageURI: string;
  startPrice: string;
  owner: string;           // seller address (mapped from asset.seller)
  biddingEnd: number;
  biddingStart?: number;    // optional — unix timestamp (s) when bidding starts; if absent = immediately
  // revealEnd removed — new contract has no reveal phase
  totalBidders: number;
  phase: 0 | 1 | 2;       // 0=BIDDING, 1=ENDED, 2=FINALIZED (maps to contract Phase enum)
  finalized: boolean;      // true khi phase === FINALIZED
  itemClaimed: boolean;    // maps to nftClaimed
  winner: string;
  winningBid: string;
  createdAt: number;
  watcherCount?: number;
  bidVelocity?: number;
  isPrivate?: boolean;
  auctionType?: 'public' | 'private';
  whitelist?: string[];
  // NFT asset on-chain
  nftContract?: string;
  tokenId?: string;
  nftAmount?: number;
  nftType?: 0 | 1;  // 0=ERC721, 1=ERC1155
  nftName?: string;
  nftSymbol?: string;
  nftMetadata?: string;
  finalizedAt?: number;      // timestamp (ms) when auction is finalized
  claimDeadline?: number;    // finalizedAt + 3 days (ms) — NFT claim deadline
}

// NFT token info
interface NftToken {
  contractAddress: string;
  tokenId: string;
  name: string;
  symbol: string;
  imageURI: string;
  tokenURI: string;
}

interface LocalSecret {
  amount: string;
  nonce: string;
  commitment: string;
  ts: number;
}

interface VaultEntry extends LocalSecret {
  auctionId: string | number;
  auctionName: string;
}

interface WalletState {
  address: string;
  provider: any;
  signer: any;
  contract: any | null;
}

interface AppState {
  wallet: WalletState | null;
  auctions: Auction[];
  filter: 'active' | 'upcoming' | 'completed' | 'cancelled';
  currentAuctionId: number | string | null;
  rexEnabled: boolean;
  localSecrets: Record<string | number, LocalSecret>;
  ethPrice: number;
  scannerInterval: ReturnType<typeof setInterval> | null;
  vaultUnlocked: boolean;
  vaultEntries: VaultEntry[];
  watcherCounts: Record<number | string, number>;
  bidVelocities: Record<number | string, number>;
  presencePath: string | null;
  // Recent Activity page state
  raAllItems: any[];
  raFiltered: any[];
  raPage: number;
  raPerPage: number;
  raFilter: string;
  raSearch: string;
  raUnsub: Unsubscribe | null;
  // Auctions pagination
  apPage: number;
  apPerPage: number;
  apList: Auction[];
  // MyBids pagination + filter
  mbPage: number;
  mbPerPage: number;
  mbFilter: 'all' | 'active' | 'ended' | 'won' | 'lost' | 'created';
  mbSearch: string;
  mbSort: 'newest' | 'oldest' | 'amount_high' | 'amount_low';
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const CONTRACT_ADDRESS = '0xc027F97BB0715A410A65Fe69EA0D552c2b351154';
const SEPOLIA_CHAIN_ID = 11155111;
// Phase enum from contract: 0=BIDDING, 1=ENDED, 2=FINALIZED
const PHASE_NAMES      = ['BIDDING', 'ENDED', 'FINALIZED'] as const;
const EMOJIS           = ['🎨','💎','🖼️','🎯','🏆','⚡','🌟','🔮'];

// ─── NFT (ERC-721) minimal ABI — used to load & approve seller NFT ────────
const ERC721_ABI = [
  'function balanceOf(address owner) external view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function approve(address to, uint256 tokenId) external',
  'function getApproved(uint256 tokenId) external view returns (address)',
  'function isApprovedForAll(address owner, address operator) external view returns (bool)',
  'function setApprovalForAll(address operator, bool approved) external',
  'function supportsInterface(bytes4 interfaceId) external view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
];

// ─── Auction contract ABI — matches NFTAuction.sol ────────────────────────
const CONTRACT_ABI = [
  // createAuction(nftContract, nftTokenId, nftAmount, nftType, itemName, itemDescription, itemImageURI, startPrice, biddingDuration)
  // nftType: 0 = ERC721, 1 = ERC1155
  'function createAuction(address,uint256,uint256,uint8,string,string,string,uint256,uint256) external returns (uint256)',
  'function placeBid(uint256) external payable',
  'function finalizeAuction(uint256) external',
  'function claimNFT(uint256) external',
  'function refund(uint256) external',
  'function auctionCount() external view returns (uint256)',
  // getAsset → AuctionAsset: (nftContract, nftTokenId, nftAmount, nftType, seller)
  'function getAsset(uint256) external view returns (tuple(address nftContract,uint256 nftTokenId,uint256 nftAmount,uint8 nftType,address seller))',
  // getInfo → AuctionInfo: (itemName, itemDescription, itemImageURI, startPrice, biddingEnd, phase, nftClaimed, winner, winningBid, totalBidders)
  'function getInfo(uint256) external view returns (tuple(string itemName,string itemDescription,string itemImageURI,uint256 startPrice,uint256 biddingEnd,uint8 phase,bool nftClaimed,address winner,uint256 winningBid,uint256 totalBidders))',
  // getBid → Bid: (amount, refunded)
  'function getBid(uint256,address) external view returns (tuple(uint256 amount,bool refunded))',
  'function getBidders(uint256) external view returns (address[])',
  'function getPhase(uint256) external view returns (uint8)',
  'function isNFTEscrowed(uint256) external view returns (bool)',
  'event AuctionCreated(uint256 indexed auctionId,address indexed seller,address nftContract,uint256 nftTokenId,uint8 nftType,string itemName,uint256 startPrice,uint256 biddingEnd)',
  'event BidPlaced(uint256 indexed auctionId,address indexed bidder,uint256 amount)',
  'event BidIncreased(uint256 indexed auctionId,address indexed bidder,uint256 newTotal)',
  'event AuctionFinalized(uint256 indexed auctionId,address indexed winner,uint256 winningBid,address indexed seller,uint256 sellerReceived)',
  'event AuctionNoWinner(uint256 indexed auctionId)',
  'event NFTClaimed(uint256 indexed auctionId,address indexed winner,address nftContract,uint256 nftTokenId)',
  'event Refunded(uint256 indexed auctionId,address indexed bidder,uint256 amount)',
  'event NFTReturnedToSeller(uint256 indexed auctionId,address indexed seller)',
];

const LS_WALLET  = 'sb:wallet';
const LS_SECRETS = 'sb:secrets';
const LS_VAULT   = 'sb:vault';

// ─────────────────────────────────────────────────────────────────────────────
//  APP STATE
// ─────────────────────────────────────────────────────────────────────────────
const S: AppState = {
  wallet:           null,
  auctions:         [],
  filter:           'active',
  currentAuctionId: null,
  rexEnabled:       true,
  localSecrets:     {},
  ethPrice:         2450,
  scannerInterval:  null,
  vaultUnlocked:    false,
  vaultEntries:     [],
  watcherCounts:    {},
  bidVelocities:    {},
  presencePath:     null,
  raAllItems:       [],
  raFiltered:       [],
  raPage:           1,
  raPerPage:        10,
  raFilter:         'all',
  raSearch:         '',
  raUnsub:          null,
  // Auctions pagination
  apPage:           1,
  apPerPage:        6,
  apList:           [],
  // MyBids pagination + filter
  mbPage:           1,
  mbPerPage:        6,
  mbFilter:         'all',
  mbSearch:         '',
  mbSort:           'newest',
};

// ─────────────────────────────────────────────────────────────────────────────
//  FIREBASE / FIRESTORE HELPERS
//
//  Path mapping from RTDB-style → Firestore collection/doc:
//    "auctions/{id}"          → collection("auctions").doc(id)
//    "users/{addr}"           → collection("users").doc(addr)
//    "bids/{auctionId}/{addr}"→ collection("bids").doc(`{auctionId}_{addr}`)
//    "activity/{id}"          → collection("activity").doc(id)
//    "pulses"                 → collection("pulses")  (addDoc)
//    "presence/{addr}"        → collection("presence").doc(addr)
//    "watchers/{aId}/{addr}"  → collection("watchers").doc(`{aId}_{addr}`)
// ─────────────────────────────────────────────────────────────────────────────

/** Read a single document by path of the form "collection/docId" */
async function fbRead(path: string): Promise<any> {
  if (!FB_CONFIGURED) return null;
  try {
    const slashIdx = path.indexOf('/');
    const col   = slashIdx >= 0 ? path.slice(0, slashIdx) : path;
    const docId = slashIdx >= 0 ? path.slice(slashIdx + 1).replace(/\//g, '_') : '';
    if (!docId) return null;
    const snap  = await getDoc(doc(db, col, docId));
    return snap.exists() ? snap.data() : null;
  } catch (e: any) { console.warn('[FB] read error:', path, e.message); return null; }
}

/** Write (overwrite) a document */
async function fbWrite(path: string, data: any): Promise<void> {
  if (!FB_CONFIGURED) return;
  try {
    const slashIdx = path.indexOf('/');
    const col   = slashIdx >= 0 ? path.slice(0, slashIdx) : path;
    const docId = slashIdx >= 0 ? path.slice(slashIdx + 1).replace(/\//g, '_') : String(Date.now());
    await setDoc(doc(db, col, docId), { ...data, updatedAt: serverTimestamp() }, { merge: false });
  } catch (e: any) { console.warn('[FB] write error:', path, e.message); }
}

/** Add a new document with auto-ID (equivalent to push) */
async function fbPush(col: string, data: any): Promise<string> {
  if (!FB_CONFIGURED) return 'offline-' + Date.now();
  try {
    const ref = await addDoc(collection(db, col), { ...data, createdAt: serverTimestamp() });
    return ref.id;
  } catch (e: any) { console.warn('[FB] push error:', col, e.message); return 'err'; }
}

/** Update (merge) fields into a document */
async function fbUpdate(path: string, data: any): Promise<void> {
  if (!FB_CONFIGURED) return;
  try {
    const slashIdx = path.indexOf('/');
    const col   = slashIdx >= 0 ? path.slice(0, slashIdx) : path;
    const docId = slashIdx >= 0 ? path.slice(slashIdx + 1).replace(/\//g, '_') : '';
    if (!docId) return;
    await updateDoc(doc(db, col, docId), data);
  } catch (e: any) { console.warn('[FB] update error:', path, e.message); }
}

/**
 * Listen for realtime changes on a collection.
 * Returns an unsubscribe function.
 * data is returned as Record<id, docData> for compatibility with Object.entries().
 */
function fbListen(col: string, cb: (data: any) => void): Unsubscribe {
  if (!FB_CONFIGURED) { cb(null); return () => {}; }
  try {
    return onSnapshot(collection(db, col), (snap: QuerySnapshot<DocumentData>) => {
      if (snap.empty) { cb(null); return; }
      const result: Record<string, any> = {};
      snap.forEach(d => { result[d.id] = { ...d.data(), _id: d.id }; });
      cb(result);
    }, (e: any) => { console.warn('[FB] listen error:', col, e.message); cb(null); });
  } catch (e: any) { console.warn('[FB] listen setup error:', col, e.message); cb(null); return () => {}; }
}

/** Delete a document */
async function fbRemove(path: string): Promise<void> {
  if (!FB_CONFIGURED) return;
  try {
    const slashIdx = path.indexOf('/');
    const col   = slashIdx >= 0 ? path.slice(0, slashIdx) : path;
    const docId = slashIdx >= 0 ? path.slice(slashIdx + 1).replace(/\//g, '_') : '';
    if (!docId) return;
    await deleteDoc(doc(db, col, docId));
  } catch (e: any) { console.warn('[FB] remove error:', path, e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOCAL STORAGE
// ─────────────────────────────────────────────────────────────────────────────
function lsLoadSecrets(): void {
  try { S.localSecrets = JSON.parse(localStorage.getItem(LS_SECRETS) || '{}'); } catch {}
}

function lsSaveSecret(id: string | number, data: LocalSecret): void {
  S.localSecrets[id] = data;
  localStorage.setItem(LS_SECRETS, JSON.stringify(S.localSecrets));
}

function lsLoadWallet(): string | null {
  try { return JSON.parse(localStorage.getItem(LS_WALLET) || 'null'); } catch { return null; }
}

function lsSaveWallet(addr: string): void  { localStorage.setItem(LS_WALLET, JSON.stringify(addr)); }
function lsClearWallet(): void             { localStorage.removeItem(LS_WALLET); }

// ─────────────────────────────────────────────────────────────────────────────
//  WALLET
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//  WALLET INFO MODAL — shown when clicking nav wallet btn while already connected
// ─────────────────────────────────────────────────────────────────────────────
// Original HTML of overlay-wallet modal-body — used to restore after closing wallet info
const WALLET_MODAL_ORIGINAL_TITLE = 'Connect Wallet';
const WALLET_MODAL_ORIGINAL_BODY  = `
  <div style="text-align:center">
    <div class="wc-logo">🔒</div>
    <div style="font-family:var(--font-head);font-size:1.1rem;font-weight:700;margin-bottom:0.4rem">SecretBid</div>
    <div style="font-size:13px;color:var(--text2);margin-bottom:1.2rem">Confirm connection to this dApp</div>
    <div class="wc-addr" id="wc-addr">—</div>
    <ul class="wc-list">
      <li><span class="wc-check">✓</span> View wallet balance and activity</li>
      <li><span class="wc-check">✓</span> Request transaction signatures</li>
      <li><span class="wc-check">✓</span> Address cached locally (never uploaded)</li>
      <li><span class="wc-check" style="color:var(--red)">✗</span> Cannot move funds without approval</li>
    </ul>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <button class="btn btn-ghost" id="btn-wallet-cancel">Cancel</button>
      <button class="btn btn-primary" id="btn-wallet-confirm">Connect &amp; Sign In</button>
    </div>
  </div>`;

function restoreWalletModal(): void {
  const modalTitle = document.querySelector('#overlay-wallet .modal-title') as HTMLElement;
  const modalBody  = document.querySelector('#overlay-wallet .modal-body')  as HTMLElement;
  if (modalTitle) modalTitle.textContent = WALLET_MODAL_ORIGINAL_TITLE;
  if (modalBody)  modalBody.innerHTML    = WALLET_MODAL_ORIGINAL_BODY;
  // Re-attach static listeners — clone nodes to remove any previously bound duplicates
  const cancelBtn = document.getElementById('btn-wallet-cancel');
  if (cancelBtn) {
    const fresh = cancelBtn.cloneNode(true) as HTMLElement;
    cancelBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      (window as any)._pendingCreate = false;
      closeOverlay('overlay-wallet');
    });
  }
  const confirmBtn = document.getElementById('btn-wallet-confirm');
  if (confirmBtn) {
    const fresh = confirmBtn.cloneNode(true) as HTMLElement;
    confirmBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      if (!S.wallet) confirmWalletConnect();
      else closeOverlay('overlay-wallet');
    });
  }
}

async function showWalletInfoModal(): Promise<void> {
  if (!S.wallet) return;

  const modalTitle = document.querySelector('#overlay-wallet .modal-title') as HTMLElement;
  const modalBody  = document.querySelector('#overlay-wallet .modal-body')  as HTMLElement;
  if (!modalTitle || !modalBody) return;

  let bal = '—', balUsd = '—';
  try {
    const b   = await S.wallet.provider.getBalance(S.wallet.address);
    const eth = parseFloat(formatEther(b));
    bal    = eth.toFixed(4) + ' ETH';
    balUsd = '≈ $' + (eth * S.ethPrice).toLocaleString('en', { maximumFractionDigits: 2 });
  } catch {}

  modalTitle.textContent = 'Wallet Connected';

  modalBody.innerHTML = `
    <div style="text-align:center;margin-bottom:1.2rem">
      <div class="wc-logo" style="background:linear-gradient(135deg,var(--glow2),var(--glow))">✅</div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text3);margin-bottom:0.5rem">Connected to Sepolia Testnet</div>
      <div class="wc-addr">${S.wallet.address}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border:1px solid var(--border);border-radius:var(--r2);overflow:hidden;margin-bottom:1.2rem">
      <div style="background:var(--bg2);padding:12px 16px">
        <div style="font-size:10px;color:var(--text3);font-family:var(--font-mono);margin-bottom:4px">BALANCE</div>
        <div style="font-family:var(--font-head);font-weight:700;color:var(--glow)">${bal}</div>
        <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono)">${balUsd}</div>
      </div>
      <div style="background:var(--bg2);padding:12px 16px">
        <div style="font-size:10px;color:var(--text3);font-family:var(--font-mono);margin-bottom:4px">NETWORK</div>
        <div style="font-family:var(--font-head);font-weight:700;color:var(--blue)">Sepolia</div>
        <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono)">Chain ID 11155111</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:1rem">
      <a class="btn btn-ghost btn-sm" href="https://sepoliafaucet.com" target="_blank" rel="noopener" style="justify-content:center">
        🚰 Sepolia Faucet
      </a>
      <a class="btn btn-ghost btn-sm" href="https://sepolia.etherscan.io/address/${S.wallet.address}" target="_blank" rel="noopener" style="justify-content:center">
        🔍 Etherscan
      </a>
    </div>
    <button class="btn btn-ghost btn-full" id="modal-disconnect-btn"
      style="color:var(--red);border-color:rgba(255,61,113,0.3)">
      🔌 Disconnect Wallet
    </button>
  `;

  // When closing wallet info modal — restore original body so connect flow works correctly
  const onClose = () => restoreWalletModal();
  document.getElementById('close-overlay-wallet')?.addEventListener('click', onClose, { once: true });

  document.getElementById('modal-disconnect-btn')?.addEventListener('click', async () => {
    document.getElementById('close-overlay-wallet')?.removeEventListener('click', onClose);
    closeOverlay('overlay-wallet');
    restoreWalletModal();
    await disconnectWallet();
  });

  openOverlay('overlay-wallet');
}

async function handleWalletClick(): Promise<void> {
  if (S.wallet) {
    showWalletInfoModal();
    return;
  }
  const eth = getEthereum();
  if (!eth) {
    toast('No Wallet', 'Install MetaMask or Rabby.', 'err');
    return;
  }
  try {
    const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
    if (!accounts.length) { toast('No Account', 'No accounts found.', 'err'); return; }
    window._pendingAddr = accounts[0];

    // If create is pending — skip the confirmation modal and connect directly
    if ((window as any)._pendingCreate) {
      await confirmWalletConnect();
      return;
    }

    // Normal case — open confirmation modal as usual
    const wcAddr = document.getElementById('wc-addr');
    if (wcAddr) wcAddr.textContent = accounts[0];
    openOverlay('overlay-wallet');
  } catch (e: any) {
    toast('Connection Failed', e.message, 'err');
  }
}

async function confirmWalletConnect(): Promise<void> {
  // Already connected — this overlay is info-only, no need to reconnect
  if (S.wallet) { closeOverlay('overlay-wallet'); return; }

  closeOverlay('overlay-wallet');
  const addr: string = window._pendingAddr;
  if (!addr) return;

  const eth = getEthereum();
  if (!eth) { toast('No Wallet', 'Install MetaMask or Rabby.', 'err'); return; }

  try {
    showTxOverlay('Checking Network', 'Verifying Sepolia…');

    // Use eth_chainId directly — fast, no need to create a provider first
    const chainIdHex: string = await eth.request({ method: 'eth_chainId' });
    if (parseInt(chainIdHex, 16) !== SEPOLIA_CHAIN_ID) {
      showTxOverlay('Switching Network', 'Switching to Sepolia Testnet…');
      try {
        await eth.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x' + SEPOLIA_CHAIN_ID.toString(16) }],
        });
      } catch (switchErr: any) {
        if (switchErr.code === 4902) {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0xaa36a7', chainName: 'Sepolia Testnet',
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://rpc.sepolia.org'],
              blockExplorerUrls: ['https://sepolia.etherscan.io'],
            }],
          });
        } else {
          throw new Error('Please switch to the Sepolia network in MetaMask.');
        }
      }
      // Wait for MetaMask to finish switching
      await new Promise(r => setTimeout(r, 500));
    }

    showTxOverlay('Authenticating', 'Sign message to verify wallet ownership…');

    // Create provider AFTER chain switch (old provider holds the old chain → stale)
    const provider = new BrowserProvider(eth);
    const signer = await provider.getSigner();
    const msg = `SecretBid Sign-In\nAddress: ${addr}\nDomain: secretbid.rialo.io\nTimestamp: ${Date.now()}`;
    await signer.signMessage(msg);

    const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

    S.wallet = { address: addr, provider, signer, contract };
    lsSaveWallet(addr);

    hideTxOverlay();
    await updateWalletUI();
    toast('Connected!', shortAddr(addr), 'ok');
    // Sync on-chain state after wallet connects
    void syncOnChainAuctions();

    // ── Auto-retry pending create auction ─────────────────────────────────────
    if ((window as any)._pendingCreate) {
      (window as any)._pendingCreate = false;
      // updateWalletUI already showed create-form, wait for DOM to settle then submit
      setTimeout(() => handleCreateAuction(), 400);
    }

    // ── Register MetaMask event listeners ───────────────────────────────────────
    eth.removeAllListeners?.('accountsChanged');
    eth.removeAllListeners?.('chainChanged');
    eth.on('accountsChanged', async (accs: string[]) => {
      if (!accs.length) {
        await disconnectWallet();
      } else if (accs[0].toLowerCase() !== S.wallet?.address.toLowerCase()) {
        toast('Account Changed', 'Reconnecting with new account…', 'info');
        await disconnectWallet();
        window._pendingAddr = accs[0];
        await confirmWalletConnect();
      }
    });
    eth.on('chainChanged', () => window.location.reload());

    // ── Firebase sync runs in background, does NOT block UI ─────────────────────
    void (async () => {
      try {
        const existing = await fbRead(`users/${addr.toLowerCase()}`);
        if (!existing) {
          // New user — write full profile
          await fbWrite(`users/${addr.toLowerCase()}`, {
            address: addr, joinedAt: Date.now(), lastSeen: Date.now(),
            totalBids: 0, auctionsWon: 0, totalSpent: '0', totalWon: '0', auctionsCreated: 0,
          });
          // Log wallet connect event to activity feed
          await fbPush('activity', {
            type: 'connect', text: 'New User', color: 'green', icon: '👛',
            detail: `${shortAddr(addr)} connected wallet for the first time`,
            ts: Date.now(),
            walletAddr: addr.toLowerCase(),
          });
        } else {
          // Returning user — update lastSeen
          await fbUpdate(`users/${addr.toLowerCase()}`, { lastSeen: Date.now() });
        }
      } catch (e: any) {
        console.warn('[FB] user sync (non-critical):', e.message);
      }
      try { await registerPresence(); } catch {}
      renderSidebarStats();
    })();

  } catch (e: any) {
    hideTxOverlay();
    toast('Sign Failed', e.message?.slice(0, 80) ?? 'Unknown error', 'err');
  }
}

async function disconnectWallet(): Promise<void> {
  // Remove ethereum event listeners before clearing state
  const eth = getEthereum();
  eth?.removeAllListeners?.('accountsChanged');
  eth?.removeAllListeners?.('chainChanged');

  if (S.presencePath && FB_CONFIGURED) {
    // presencePath is "presence/{addr}" — extract doc ID
    const presAddr = S.presencePath.replace('presence/', '');
    deleteDoc(doc(db, 'presence', presAddr)).catch(() => {});
  }
  S.wallet       = null;
  S.presencePath = null;
  lsClearWallet();
  // Clear activity if page is active
  if (S.raUnsub) { S.raUnsub(); S.raUnsub = null; }
  S.raAllItems = []; S.raFiltered = [];
  if (document.getElementById('page-vault')?.classList.contains('active')) renderRecentActivityPage();
  await updateWalletUI();
  toast('Disconnected', 'Wallet session ended.', 'info');
}

async function autoConnect(): Promise<void> {
  const saved = lsLoadWallet();
  const eth   = getEthereum();
  if (!saved || !eth) return;

  // Validate saved address format before using
  if (!/^0x[0-9a-fA-F]{40}$/.test(saved)) {
    lsClearWallet();
    return;
  }

  try {
    // eth_accounts does NOT prompt — returns already-authorised accounts only.
    // MetaMask may take a moment to initialise on page load, so retry once.
    let accounts: string[] = await eth.request({ method: 'eth_accounts' });
    if (!accounts.length) {
      await delay(800);
      accounts = await eth.request({ method: 'eth_accounts' });
    }

    if (!accounts.length || accounts[0].toLowerCase() !== saved.toLowerCase()) {
      console.info('[SecretBid] autoConnect: MetaMask account mismatch or locked — skipping silent reconnect.');
      return;
    }

    const provider = new BrowserProvider(eth);

    // Check chain ID ID — skip reconnect if on the wrong chain
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
      // Don't clear the saved address — user may just need to switch network
      toast('Wrong Network', 'Switch to Sepolia to reconnect automatically.', 'info');
      console.warn('[SecretBid] autoConnect: wrong chainId', Number(network.chainId));
      return;
    }

    const signer   = await provider.getSigner();
    const contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

    S.wallet = { address: accounts[0], provider, signer, contract };
    lsSaveWallet(accounts[0]);

    // Update UI immediately — before any async background work
    await updateWalletUI();

    // Background tasks fire-and-forget — never block or crash the connect flow
    registerPresence().catch(() => {});
    renderSidebarStats().catch(() => {});

    console.info('[SecretBid] autoConnect: session restored for', shortAddr(accounts[0]));

    // Register listeners after autoConnect to avoid losing them
    eth.removeAllListeners?.('accountsChanged');
    eth.removeAllListeners?.('chainChanged');
    eth.on('accountsChanged', async (accs: string[]) => {
      if (!accs.length) {
        await disconnectWallet();
      } else if (accs[0].toLowerCase() !== S.wallet?.address.toLowerCase()) {
        toast('Account Changed', 'Reconnecting with new account…', 'info');
        await disconnectWallet();
        window._pendingAddr = accs[0];
        await confirmWalletConnect();
      }
    });
    eth.on('chainChanged', () => window.location.reload());

  } catch (e: any) {
    // Log the real error instead of silently swallowing it
    console.error('[SecretBid] autoConnect failed:', e?.message ?? e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRESENCE  (Firestore has no native onDisconnect — use TTL + manual cleanup)
// ─────────────────────────────────────────────────────────────────────────────
async function registerPresence(): Promise<void> {
  if (!S.wallet || !FB_CONFIGURED) return;
  try {
    const addr = S.wallet.address.toLowerCase();
    await setDoc(doc(db, 'presence', addr), {
      address: S.wallet.address,
      ts: serverTimestamp(),
      ttl: Date.now() + 60_000, // client removes entry after 60s if not renewed
    });
    S.presencePath = `presence/${addr}`;
    // Renew every 30s while online
    const renewId = setInterval(async () => {
      if (!S.wallet) { clearInterval(renewId); return; }
      await setDoc(doc(db, 'presence', addr), {
        address: S.wallet.address, ts: serverTimestamp(), ttl: Date.now() + 60_000,
      }).catch(() => {});
    }, 30_000);
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      clearInterval(renewId);
      deleteDoc(doc(db, 'presence', addr)).catch(() => {});
    }, { once: true });
  } catch (e: any) { console.warn('[FB] presence error:', e.message); }
}

// Track registered watchers to avoid duplicate beforeunload handlers
const _registeredWatchers = new Set<string>();

async function registerAuctionWatcher(auctionId: number | string): Promise<void> {
  if (!S.wallet || !FB_CONFIGURED) return;
  try {
    const key = `${auctionId}_${S.wallet.address.toLowerCase()}`;
    // Skip if already registered for this session
    if (_registeredWatchers.has(key)) return;
    _registeredWatchers.add(key);

    await setDoc(doc(db, 'watchers', key), {
      auctionId: String(auctionId),
      address: S.wallet.address,
      ts: serverTimestamp(),
    });
    window.addEventListener('beforeunload', () => {
      // Delete flat doc directly — key is the Firestore doc ID
      deleteDoc(doc(db, 'watchers', key)).catch(() => {});
    }, { once: true });
  } catch (e: any) { console.warn('[FB] watcher error:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI UPDATE
// ─────────────────────────────────────────────────────────────────────────────
async function updateWalletUI(): Promise<void> {
  const dot        = document.getElementById('wallet-dot');
  const lbl        = document.getElementById('wallet-btn-label');
  const wBody      = document.getElementById('wallet-body');
  const myStatCard = document.getElementById('my-stats-card') as HTMLElement | null;
  const createWall = document.getElementById('create-wall') as HTMLElement | null;
  const createForm = document.getElementById('create-form') as HTMLElement | null;

  // DOM not ready yet — bail out silently
  if (!dot || !lbl || !wBody) {
    console.warn('[SecretBid] updateWalletUI: wallet DOM elements not found — DOM may not be ready');
    return;
  }

  if (S.wallet) {
    dot.className   = 'wallet-dot';          // green — connected
    lbl.textContent = shortAddr(S.wallet.address);
    console.log('[SecretBid] updateWalletUI: connected', S.wallet.address);

    let bal = '—', balUsd = '—';
    try {
      const b   = await S.wallet.provider.getBalance(S.wallet.address);
      const eth = parseFloat(formatEther(b));
      bal    = eth.toFixed(4) + ' ETH';
      balUsd = '≈ $' + (eth * S.ethPrice).toLocaleString('en', { maximumFractionDigits: 2 });
    } catch {}

    wBody.innerHTML = `
      <div class="wallet-balance">${bal}</div>
      <div class="wallet-usd">${balUsd}</div>
      <div style="margin-top:0.8rem;font-family:var(--font-mono);font-size:10px;color:var(--text3);word-break:break-all">${S.wallet.address}</div>
      <div class="wallet-actions" style="margin-top:1rem">
        <a class="btn btn-ghost btn-sm" href="https://sepoliafaucet.com" target="_blank" rel="noopener">
          🚰 Sepolia Faucet
        </a>
        <a class="btn btn-ghost btn-sm" href="https://sepolia.etherscan.io/address/${S.wallet.address}" target="_blank" rel="noopener">
          🔍 Etherscan
        </a>
      </div>
      <button class="btn btn-ghost btn-full" id="btn-disconnect-wallet"
        style="margin-top:0.8rem;color:var(--red);border-color:var(--red)">
        🔌 Disconnect Wallet
      </button>
    `;
    // Disconnect button inside the wallet overlay
    document.getElementById('btn-disconnect-wallet')?.addEventListener('click', async () => {
      closeOverlay('overlay-wallet');
      await disconnectWallet();
    });

    if (myStatCard) myStatCard.style.display = 'block';
    if (createWall) createWall.style.display = 'none';
    if (createForm) createForm.style.display = 'block';
    // Hide gate banner — wallet is connected
    const createBannerConnected = document.getElementById('create-wallet-banner') as HTMLElement | null;
    if (createBannerConnected) createBannerConnected.style.display = 'none';
    // Auto-scan wallet and populate NFT combobox
    void initNftCombobox(true);
  } else {
    dot.className   = 'wallet-dot red';      // red — disconnected
    lbl.textContent = 'Connect Wallet';
    console.log('[SecretBid] updateWalletUI: disconnected');
    wBody.innerHTML = `
      <div class="empty" style="padding:1rem 0">
        <div class="empty-ico">🔐</div>
        <div class="empty-title">Not connected</div>
        <button class="btn btn-primary btn-full" id="btn-connect-sidebar" style="margin-top:1rem">Connect Wallet</button>
      </div>`;
    document.getElementById('btn-connect-sidebar')?.addEventListener('click', handleWalletClick);
    if (myStatCard) myStatCard.style.display = 'none';
    if (createWall) createWall.style.display = 'block';
    if (createForm) createForm.style.display = 'none';
    // Hide wallet gate banner when completely disconnected (wall shown)
    const createBanner = document.getElementById('create-wallet-banner') as HTMLElement | null;
    if (createBanner) createBanner.style.display = 'none';
  }
}

async function renderSidebarStats(): Promise<void> {
  if (!S.wallet) return;
  try {
    const user    = await fbRead(`users/${S.wallet.address.toLowerCase()}`);
    const secrets = Object.keys(S.localSecrets).length;
    const won     = user?.auctionsWon ?? 0;
    const rate    = secrets > 0 ? Math.round((won / secrets) * 100) : 0;
    document.getElementById('ms-bids')!.textContent      = String(secrets);
    document.getElementById('ms-won')!.textContent       = String(won);
    document.getElementById('ms-spent')!.textContent     = (user?.totalSpent ?? '0') + ' ETH';
    document.getElementById('ms-total-won')!.textContent = (user?.totalWon ?? '0') + ' ETH';
    document.getElementById('ms-rate')!.textContent      = rate + '%';
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────
function navigate(page: string): void {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll<HTMLElement>('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.page === page)
  );
  document.querySelectorAll<HTMLElement>('.mob-nav-item').forEach(t =>
    t.classList.toggle('active', t.dataset.page === page)
  );
  const target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');

  if (page === 'mybids') {
    renderMyBids();
    void syncMyBidsFromFirebase().then(() => syncMyBidsOnChain());
  }
  if (page === 'analytics')   renderAnalytics();
  if (page === 'leaderboard') renderLeaderboard();
  if (page === 'scanner')     startScanner();
  if (page === 'vault')       renderRecentActivityPage();
  if (page === 'create' && S.wallet) void initNftCombobox();
  if (page === 'disputes')    void loadDisputesList();
}

// ─────────────────────────────────────────────────────────────────────────────
//  DATA — FIREBASE
// ─────────────────────────────────────────────────────────────────────────────
async function loadAuctions(): Promise<void> {
  document.getElementById('auction-grid')!.innerHTML =
    '<div class="loading-row"><div class="spin-icon"></div>Loading bids...</div>';

  // ── Auctions collection ──────────────────────────────────────────────────────
  fbListen('auctions', (data: any) => {
    S.auctions = [];
    if (data) {
      Object.entries(data).forEach(([key, val]: [string, any]) => {
        S.auctions.push({ ...val, _fbKey: key });
      });
      S.auctions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    renderAuctions(); updateStats();
    // Re-render My Bids if page is currently active (fixes race condition with Firebase load)
    if (document.getElementById('page-mybids')?.classList.contains('active')) {
      renderMyBids();
    }
    // Kick auto-finalize whenever auction list refreshes
    void autoFinalizeEndedAuctions();
  });

  // ── Activity feed ────────────────────────────────────────────────────────────
  fbListen('activity', (data: any) => renderActivityFeed(data));

  // ── Watchers — Firestore flat: collection("watchers") doc per watcher ───────
  if (FB_CONFIGURED) {
    onSnapshot(collection(db, 'watchers'), snap => {
      const counts: Record<string, number> = {};
      snap.forEach(d => {
        const aid = d.data().auctionId;
        if (aid) counts[String(aid)] = (counts[String(aid)] || 0) + 1;
      });
      S.watcherCounts = counts;
    });
  }

  // ── Sync on-chain auction states into Firebase (background) ──────────────────
  // Reads auctionCount from contract, then syncs any auction state that
  // may have changed on-chain (finalized, winner, winningBid, phase).
  void syncOnChainAuctions();
}

/**
 * Reads all on-chain auctions and updates Firebase with the latest state.
 * Runs in background — does NOT block UI.
 */
async function syncOnChainAuctions(): Promise<void> {
  if (!S.wallet?.contract) return;
  try {
    const count = Number(await S.wallet.contract.auctionCount());
    for (let i = 1; i <= count; i++) {
      try {
        // New contract splits into 2 structs: getAsset + getInfo
        const [asset, info] = await Promise.all([
          S.wallet.contract.getAsset(i),
          S.wallet.contract.getInfo(i),
        ]);
        const isFinalized = Number(info.phase) === 2; // Phase.FINALIZED = 2
        const existing = S.auctions.find(x => String(x.id) === String(i));
        const fbKey = existing?._fbKey || String(i);
        // Only update winner/winningBid if contract has real values (avoid overwriting 0x0/0)
        const onchainWinner    = info.winner as string;
        const onchainWinBid    = formatEther(info.winningBid);
        const hasRealWinner    = onchainWinner && onchainWinner !== '0x0000000000000000000000000000000000000000';
        const winnerFields     = hasRealWinner
          ? { winner: onchainWinner, winningBid: onchainWinBid }
          : {};

        // Patch S.auctions in-memory immediately so cards render correctly
        if (existing) {
          existing.startPrice = formatEther(info.startPrice);
          existing.totalBidders = Number(info.totalBidders);
          if (hasRealWinner && parseFloat(onchainWinBid) > 0) {
            existing.winner     = onchainWinner;
            existing.winningBid = onchainWinBid;
            (existing as any)._onchainWinningBid = onchainWinBid;
            (existing as any)._onchainWinner     = onchainWinner;
          }
        }

        await fbUpdate(`auctions/${fbKey}`, {
          id:              i,
          owner:           asset.seller,          // seller from AuctionAsset
          itemName:        info.itemName,
          itemDescription: info.itemDescription,
          itemImageURI:    info.itemImageURI,
          startPrice:      formatEther(info.startPrice),
          biddingEnd:      Number(info.biddingEnd),
          // revealEnd no longer exists
          ...winnerFields,
          // Only set finalized: true when on-chain phase = FINALIZED (2)
          // Avoid overwriting with false when auction is not yet finalized
          ...(isFinalized ? { finalized: true } : {}),
          itemClaimed:     info.nftClaimed,       // nftClaimed from AuctionInfo
          totalBidders:    Number(info.totalBidders),
          phase:           Number(info.phase),
          nftContract:     asset.nftContract ?? '',
          tokenId:         asset.nftTokenId ? asset.nftTokenId.toString() : '',
          nftAmount:       Number(asset.nftAmount),
          nftType:         Number(asset.nftType),
        });
      } catch { /* skip individual errors */ }
    }
    // Re-render immediately after patching in-memory — cards show correct price
    renderAuctions();
  } catch (e: any) {
    console.warn('[SecretBid] syncOnChainAuctions:', e.message);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
//  RENDER AUCTIONS
// ─────────────────────────────────────────────────────────────────────────────
function setFilter(f: AppState['filter']): void {
  S.filter = f;
  S.apPage = 1;
  document.querySelectorAll<HTMLElement>('.filter-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.filter === f)
  );
  renderAuctions();
}

function renderAuctions(): void {
  const grid = document.getElementById('auction-grid')!;
  const q    = ((document.getElementById('search-inp') as HTMLInputElement)?.value || '').toLowerCase();
  const now  = Math.floor(Date.now() / 1000);

  const now2   = Math.floor(Date.now() / 1000);
  const active    = S.auctions.filter(a => !a.finalized && calcPhase(a) === 0 && !isUpcoming(a));
  const upcoming  = S.auctions.filter(a => !a.finalized && isUpcoming(a));
  // completed = đã finalize có winner, HOẶC đã kết thúc (phase=1) chưa finalize nhưng có bidder
  const completed = S.auctions.filter(a =>
    (a.finalized && a.winner && a.winner !== '0x0000000000000000000000000000000000000000') ||
    (!a.finalized && calcPhase(a) === 1 && (a.totalBidders || 0) > 0)
  );
  const cancelled = S.auctions.filter(a =>
    (a.finalized && (!a.winner || a.winner === '0x0000000000000000000000000000000000000000')) ||
    (!a.finalized && calcPhase(a) === 1 && (a.totalBidders || 0) === 0)
  );

  (document.getElementById('f-active')   as HTMLElement).textContent = String(active.length);
  (document.getElementById('f-upcoming') as HTMLElement).textContent = String(upcoming.length);
  (document.getElementById('f-completed')as HTMLElement).textContent = String(completed.length);
  (document.getElementById('f-cancelled')as HTMLElement).textContent = String(cancelled.length);

  let list = S.filter === 'active'    ? active
           : S.filter === 'upcoming'  ? upcoming
           : S.filter === 'completed' ? completed
           : S.filter === 'cancelled' ? cancelled : [];

  if (q) list = list.filter(a =>
    a.itemName?.toLowerCase().includes(q) ||
    a.itemDescription?.toLowerCase().includes(q) ||
    String(a.id).includes(q) ||
    (a._fbKey && a._fbKey.toLowerCase().includes(q))
  );

  // Reset page when filter/search changes
  S.apList = list;
  S.apPage = Math.min(S.apPage, Math.max(1, Math.ceil(list.length / S.apPerPage)));

  if (!list.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-ico">🔒</div><div class="empty-title">No auctions found</div></div>`;
    apRenderPagination(0);
    return;
  }

  // Paginate
  const start   = (S.apPage - 1) * S.apPerPage;
  const pageItems = list.slice(start, start + S.apPerPage);

  grid.innerHTML = pageItems.map(a => auctionCardHTML(a)).join('');

  grid.querySelectorAll<HTMLElement>('.a-card[data-auction-id]').forEach(card => {
    card.addEventListener('click', () => openDetail(card.dataset.auctionId!));
  });

  // ── Seller settle/cancel buttons on cards ──────────────────────────────────
  grid.querySelectorAll<HTMLElement>('.btn-seller-settle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      handleFinalize(btn.dataset.id!);
    });
  });

  // Render pagination controls
  apRenderPagination(list.length);
}

function apRenderPagination(total: number): void {
  const pag     = document.getElementById('auctions-pagination')!;
  const infoEl  = document.getElementById('ap-info')!;
  const btnsEl  = document.getElementById('ap-btns')!;
  const totalPages = Math.max(1, Math.ceil(total / S.apPerPage));

  if (totalPages <= 1) {
    pag.style.display = 'none';
    btnsEl.innerHTML = '';
    return;
  }

  pag.style.display = 'flex';
  const startItem = (S.apPage - 1) * S.apPerPage + 1;
  const endItem   = Math.min(S.apPage * S.apPerPage, total);
  infoEl.textContent = `Showing ${startItem}–${endItem} of ${total}`;

  let html = `<button class="ra-pg-btn" id="ap-prev" ${S.apPage===1?'disabled':''}><i class="bi bi-chevron-left"></i></button>`;
  const pages: (number|string)[] = [];
  if (totalPages <= 7) { for (let i=1;i<=totalPages;i++) pages.push(i); }
  else {
    pages.push(1);
    if (S.apPage > 3) pages.push('…');
    for (let i=Math.max(2,S.apPage-1);i<=Math.min(totalPages-1,S.apPage+1);i++) pages.push(i);
    if (S.apPage < totalPages-2) pages.push('…');
    pages.push(totalPages);
  }
  pages.forEach(p => {
    if (p==='…') html+=`<span class="ap-ellipsis">…</span>`;
    else html+=`<button class="ra-pg-btn${p===S.apPage?' active':''}" data-p="${p}">${p}</button>`;
  });
  html += `<button class="ra-pg-btn" id="ap-next" ${S.apPage===totalPages?'disabled':''}><i class="bi bi-chevron-right"></i></button>`;
  btnsEl.innerHTML = html;
  btnsEl.querySelectorAll<HTMLElement>('[data-p]').forEach(btn =>
    btn.addEventListener('click', () => { S.apPage=+btn.dataset.p!; renderAuctions(); window.scrollTo(0,0); }));
  btnsEl.querySelector<HTMLElement>('#ap-prev')?.addEventListener('click', () => { if(S.apPage>1){S.apPage--;renderAuctions();window.scrollTo(0,0);} });
  btnsEl.querySelector<HTMLElement>('#ap-next')?.addEventListener('click', () => { if(S.apPage<totalPages){S.apPage++;renderAuctions();window.scrollTo(0,0);} });
}

function auctionCardHTML(a: Auction): string {
  const phase     = calcPhase(a);
  const upcoming  = isUpcoming(a);
  const emoji     = EMOJIS[(((parseInt(String(a.id)) || 1) - 1) % EMOJIS.length + EMOJIS.length) % EMOJIS.length];
  // For upcoming: show countdown to start; for active: countdown to end
  const timerTs   = upcoming ? (a.biddingStart ?? 0) : (phase === 0 ? a.biddingEnd : 0);
  const watchers  = S.watcherCounts[a.id] ?? 0;
  const mySecret  = S.localSecrets[a.id] ?? S.localSecrets[a._fbKey ?? ''];
  const hasSecret = !!mySecret;
  const idAttr    = a.id || a._fbKey;
  const phaseLbl  = upcoming ? 'UPCOMING' : ['BIDDING', 'ENDED', 'FINALIZED'][phase];
  const isPrivate = a.isPrivate || a.auctionType === 'private';
  const isOnChain = a.nftContract && a.nftContract !== '0x0000000000000000000000000000000000000000';
  const displayId = a.id ? `#${a.id}` : `#${a._fbKey?.slice(0, 8) ?? '??'}`;

  // Phase accent colors — upcoming uses purple
  const phaseColors = upcoming
    ? ['var(--purple,#7c3aed)', 'var(--gold)', 'var(--text3)']
    : ['var(--glow)', 'var(--gold)', 'var(--text3)'];
  const phaseBg = upcoming
    ? ['linear-gradient(135deg,rgba(91,63,191,0.12) 0%,rgba(124,58,237,0.06) 100%)', '', '']
    : [
      'linear-gradient(135deg,rgba(0,158,140,0.13) 0%,rgba(0,201,177,0.07) 100%)',
      'linear-gradient(135deg,rgba(200,150,10,0.14) 0%,rgba(212,97,10,0.09) 100%)',
      'linear-gradient(135deg,rgba(90,82,72,0.09)  0%,rgba(196,187,176,0.06) 100%)',
    ];

  // Winner / claim deadline info
  const hasWinner = a.finalized && a.winner && a.winner !== '0x0000000000000000000000000000000000000000';
  const isMyWin   = hasWinner && S.wallet?.address?.toLowerCase() === a.winner?.toLowerCase();
  const claimDl   = a.claimDeadline || (a.finalizedAt ? a.finalizedAt + 3*24*3600*1000 : 0);
  const claimExpired = claimDl > 0 && Date.now() > claimDl;

  // Winner banner (shown when finalized and has winner)
  // Prefer _onchainWinningBid if already patched from contract read
  const displayWinBid = (a as any)._onchainWinningBid || a.winningBid || '0';
  const winnerSection = hasWinner ? `
    <div style="margin:8px 0 4px;padding:9px 11px;
      background:linear-gradient(90deg,rgba(200,150,10,0.09),rgba(200,150,10,0.03));
      border:1px solid rgba(200,150,10,0.3);border-radius:var(--r2);
      display:flex;align-items:center;gap:8px">
      <span style="font-size:15px">🏆</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:9.5px;color:var(--text3);font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:1px">Winner</div>
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--gold);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${isMyWin ? '🎉 You Won!' : shortAddr(a.winner)}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--gold);font-weight:700">${parseFloat(displayWinBid||'0').toFixed(5).replace(/\.?0+$/, '')} ETH</div>
        ${a.itemClaimed
          ? `<div style="font-size:9px;color:var(--glow);font-family:var(--font-mono)">✅ Claimed</div>`
          : claimExpired
            ? `<div style="font-size:9px;color:var(--red);font-family:var(--font-mono)">⛔ Expired</div>`
            : claimDl > 0
              ? `<div style="font-size:9px;color:var(--gold);font-family:var(--font-mono)" data-claim-ts="${Math.floor(claimDl/1000)}">⏳ ${formatCountdown(Math.floor(claimDl/1000))}</div>`
              : ''}
      </div>
    </div>` : '';

  // Seller action banner — shown when auction has ended but not yet finalized
  const isSeller   = S.wallet?.address?.toLowerCase() === a.owner?.toLowerCase();
  const needsFinalize = !a.finalized && phase === 1; // phase 1 = ENDED, awaiting finalize
  const noBids     = (a.totalBidders || 0) === 0;
  const sellerActionBanner = isSeller && needsFinalize ? `
    <div onclick="event.stopPropagation()" style="margin:8px 0 4px;padding:9px 11px;
      background:linear-gradient(90deg,rgba(${noBids?'220,38,38':'200,150,10'},0.10),rgba(${noBids?'220,38,38':'200,150,10'},0.04));
      border:1px solid rgba(${noBids?'220,38,38':'200,150,10'},0.35);border-radius:var(--r2)">
      <div style="font-size:10px;color:var(--text3);font-family:var(--font-mono);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em">
        ${noBids ? '⚠️ No bids received — reclaim your NFT' : '⏰ Bidding ended — settle auction to receive ETH'}
      </div>
      <button class="btn btn-sm btn-seller-settle" data-id="${idAttr}"
        style="width:100%;justify-content:center;font-weight:700;border:none;
          background:linear-gradient(135deg,${noBids?'var(--red),#b91c1c':'var(--gold),var(--gold2)'});
          color:${noBids?'#fff':'#1a1000'}">
        ${noBids ? '🔙 Cancel & Reclaim NFT' : '✅ Finalize & Settle'}
      </button>
    </div>` : '';

  // Cancelled / no-winner banner for finalized auctions with no winner
  const noWinnerBanner = a.finalized && (!a.winner || a.winner === '0x0000000000000000000000000000000000000000') ? `
    <div style="margin:8px 0 4px;padding:9px 11px;
      background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.3);border-radius:var(--r2);
      display:flex;align-items:center;gap:8px">
      <span style="font-size:15px">❌</span>
      <div style="flex:1">
        <div style="font-size:11px;font-weight:600;color:var(--red)">No Winner</div>
        <div style="font-size:10px;color:var(--text3);margin-top:1px">NFT returned to seller</div>
      </div>
    </div>` : '';

  // My bid notification banner (only while bidding)
  const myBidBanner = hasSecret && phase === 0 ? `
    <div style="display:flex;align-items:center;gap:7px;margin:8px 0 2px;padding:7px 10px;
      background:linear-gradient(90deg,rgba(0,158,140,0.10),rgba(91,63,191,0.06));
      border:1px solid rgba(0,229,195,0.25);border-radius:var(--r2);font-size:11px">
      <span style="font-size:13px">✅</span>
      <span style="color:var(--text2)">Your bid:</span>
      <span style="font-family:var(--font-mono);color:var(--glow);font-weight:700;margin-left:auto">${parseFloat(mySecret.amount || '0').toFixed(4)} ETH</span>
    </div>` : '';

  return `<div class="a-card a-card-noimg phase-${phase}${upcoming?' upcoming':''}" data-auction-id="${idAttr}">

    <!-- ── Top accent bar ─────────────────────────── -->
    <div class="a-card-accent" style="background:${upcoming ? phaseBg[0] : phaseBg[phase]}">
      <div class="a-card-accent-emoji">${emoji}</div>

      <div class="a-card-top-badges">
        <div class="a-card-phase-badge" style="color:${upcoming ? phaseColors[0] : phaseColors[phase]};border-color:${upcoming ? phaseColors[0] : phaseColors[phase]}33;background:${upcoming ? phaseColors[0] : phaseColors[phase]}12">
          ${!upcoming && phase < 2 ? '<div class="pulse" style="width:5px;height:5px"></div>' : ''}
          ${phaseLbl}
        </div>
        <div class="a-access-badge ${isPrivate ? 'private' : 'public'}">
          ${isPrivate ? '🔒 Private' : '🌐 Public'}
        </div>
        ${isOnChain ? `<div class="onchain-badge" onclick="event.stopPropagation()">
          <i class="bi bi-link-45deg"></i>
          <a href="https://sepolia.etherscan.io/token/${esc(a.nftContract!)}?a=${esc(a.tokenId??'')}"
             target="_blank" rel="noopener" style="color:inherit;text-decoration:none">NFT</a>
        </div>` : ''}
      </div>

      ${(upcoming || phase === 0) ? `<div class="a-card-timer" data-ts="${timerTs}">
        <div class="pulse" style="width:5px;height:5px"></div>
        <span>${upcoming ? '⏳ Opens ' : ''}${timerTs ? formatCountdown(timerTs) : '—'}</span>
      </div>` : ''}


    </div>

    <!-- ── Body ────────────────────────────────────── -->
    <div class="a-card-body">
      <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:4px">
        <div class="a-card-title" style="flex:1">${esc(a.itemName)}</div>
        <div style="font-family:var(--font-mono);font-size:10px;color:var(--text4);background:var(--bg3);
          border:1px solid var(--border);border-radius:4px;padding:2px 6px;white-space:nowrap;margin-top:1px">${displayId}</div>
      </div>
      <div class="a-card-desc">${esc(a.itemDescription || 'No description provided.')}</div>

      ${winnerSection}
      ${noWinnerBanner}
      ${sellerActionBanner}
      ${myBidBanner}

      <div class="a-card-meta">
        <div>
          <div class="a-meta-lbl">Min Bid</div>
          <div class="a-meta-val green">${parseFloat(a.startPrice).toFixed(4)} ETH</div>
        </div>
        <div>
          <div class="a-meta-lbl">Bidders</div>
          <div class="a-meta-val">${a.totalBidders || 0}</div>
        </div>
        <div>
          <div class="a-meta-lbl">Status</div>
          <div class="a-meta-val" style="color:${phaseColors[phase]}">${phaseLbl}</div>
        </div>
        <div>
          <div class="a-meta-lbl">Seller</div>
          <div class="a-meta-val" style="font-size:10px">${a.owner ? a.owner.slice(0,6)+'…'+a.owner.slice(-4) : '—'}</div>
        </div>
      </div>

      <div class="a-card-footer">
        <div class="a-bidders">
          ${hasSecret && phase === 0 ? `<span style="color:var(--glow);font-weight:600">🏷 In the race</span>` : ''}
          ${isMyWin && !a.itemClaimed && !claimExpired ? `<span style="color:var(--gold);font-weight:600">⏳ Claim NFT</span>` : ''}
        </div>
        <div class="a-view-link">View →</div>
      </div>
    </div>
  </div>`;
}
function createCardHTML(): string {
  return `<div class="create-card">
    <div class="create-plus">＋</div>
    <div class="create-title">Create New Auction</div>
    <div class="create-sub">Start your sealed auction</div>
    <button class="btn btn-ghost btn-sm">Create Auction →</button>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUCTION DETAIL MODAL
// ─────────────────────────────────────────────────────────────────────────────
async function openDetail(id: number | string): Promise<void> {
  const a = S.auctions.find(x => String(x.id) === String(id) || x._fbKey === String(id));
  if (!a) return;
  S.currentAuctionId = id;

  const phase = calcPhase(a);
  const emoji = EMOJIS[(((parseInt(String(a.id)) || 1) - 1) % EMOJIS.length + EMOJIS.length) % EMOJIS.length];

  const badge = document.getElementById('md-phase-badge')!;
  badge.className = `md-phase-badge phase-${phase}`;
  (badge as HTMLElement).style.cssText = 'display:inline-flex;margin-bottom:6px;position:static;';
  document.getElementById('md-phase-txt')!.textContent = PHASE_NAMES[phase];
  document.getElementById('md-title')!.textContent     = a.itemName;
  document.getElementById('md-owner')!.textContent     = 'Owner: ' + shortAddr(a.owner);
  document.getElementById('md-desc')!.textContent      = a.itemDescription || '';

  const imgEl = document.getElementById('md-img')!;
  imgEl.innerHTML = a.itemImageURI
    ? `<img src="${esc(a.itemImageURI)}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='${emoji}'">`
    : emoji;

  document.getElementById('md-minbid')!.textContent  = a.startPrice + ' ETH';
  document.getElementById('md-bidders')!.textContent = String(a.totalBidders || 0);
  const bidEndEl   = document.getElementById('md-bidend');
  const bidStartEl = document.getElementById('md-bidstart');
  if (bidEndEl) {
    if (phase === 0) {
      bidEndEl.textContent = formatCountdown(a.biddingEnd);
      (bidEndEl as HTMLElement).dataset.ts = String(a.biddingEnd);
    } else {
      bidEndEl.textContent = phase === 1 ? 'Ended' : '—';
      (bidEndEl as HTMLElement).dataset.ts = ''; // clear so global timer doesn't override
    }
  }
  if (bidStartEl) {
    if (a.biddingStart && a.biddingStart > Math.floor(Date.now() / 1000)) {
      // Not yet started — show countdown
      bidStartEl.textContent  = formatCountdown(a.biddingStart);
      (bidStartEl as HTMLElement).dataset.ts = String(a.biddingStart);
    } else if (a.biddingStart) {
      // Start time has passed
      bidStartEl.textContent = new Date(a.biddingStart * 1000).toLocaleString('en-US', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      (bidStartEl as HTMLElement).dataset.ts = '';
    } else {
      bidStartEl.textContent = 'Immediately';
    }
  }
  document.getElementById('md-id')!.textContent = '#' + (a.id || a._fbKey);

  const wWrap = document.getElementById('md-winner-wrap')!;
  if (a.finalized && a.winner && a.winner !== '0x0000000000000000000000000000000000000000') {
    wWrap.style.display = 'block';
    const claimDl      = a.claimDeadline || (a.finalizedAt ? a.finalizedAt + 3*24*3600*1000 : 0);
    const claimDeadSec = Math.floor(claimDl / 1000);
    const claimExpired = claimDl > 0 && Date.now() > claimDl;
    const isMyWin      = S.wallet?.address?.toLowerCase() === a.winner.toLowerCase();
    document.getElementById('md-winner')!.innerHTML =
      (isMyWin ? '<span style="color:var(--gold);font-weight:700">🎉 You Won!</span>' : 'Winner: ' + shortAddr(a.winner));
    document.getElementById('md-winning-bid')!.textContent = parseFloat(a.winningBid||'0').toFixed(4) + ' ETH';
    // Claim deadline countdown
    const dlEl = document.getElementById('md-winner-wrap')!;
    const existingDl = dlEl.querySelector('.claim-countdown');
    if (existingDl) existingDl.remove();
    if (claimDl > 0 && !a.itemClaimed) {
      const cdDiv = document.createElement('div');
      cdDiv.className = 'claim-countdown';
      cdDiv.style.cssText = 'margin-top:8px;font-size:11px;font-family:var(--font-mono)';
      if (claimExpired) {
        cdDiv.innerHTML = `<span style="color:var(--red)">⛔ Claim period expired — NFT returned to seller</span>`;
      } else {
        cdDiv.innerHTML = `<span style="color:var(--text3)">Claim deadline: </span><span style="color:var(--red)" data-ts="${claimDeadSec}">${formatCountdown(claimDeadSec)}</span>`;
      }
      dlEl.appendChild(cdDiv);
    } else if (a.itemClaimed) {
      const cdDiv = document.createElement('div');
      cdDiv.className = 'claim-countdown';
      cdDiv.style.cssText = 'margin-top:6px;font-size:11px;color:var(--glow);font-family:var(--font-mono)';
      cdDiv.textContent = '✅ NFT claimed';
      dlEl.appendChild(cdDiv);
    }
  } else { wWrap.style.display = 'none'; }

  // Private / public badge in modal
  const isPrivate = a.isPrivate || a.auctionType === 'private';
  const mdAccessWrap = document.getElementById('md-access-wrap');
  if (mdAccessWrap) {
    mdAccessWrap.innerHTML = isPrivate
      ? `<span class="a-access-badge private" style="position:static;display:inline-flex;margin-right:6px">🔒 Private Auction</span>
         ${(a.whitelist && a.whitelist.length > 0)
           ? `<span style="font-size:11px;color:var(--text3);font-family:var(--font-mono)">${a.whitelist.length} allowed wallet${a.whitelist.length !== 1 ? 's' : ''}</span>`
           : ''}`
      : `<span class="a-access-badge public" style="position:static;display:inline-flex">🌐 Public Auction</span>`;
  }

  renderOracle(a, phase);

  // Phase 1: read winner directly from contract (independent of Firebase)
  // Contract knows winner as soon as biddingEnd passes, before finalize.
  if (phase === 1 && S.wallet?.contract && a.id) {
    const contractId = typeof a.id === 'string' && /^\d+$/.test(a.id) ? Number(a.id) : a.id;
    S.wallet.contract.getInfo(contractId).then((onchainInfo: any) => {
      const onchainWinner = onchainInfo.winner as string;
      const onchainBid    = formatEther(onchainInfo.winningBid);  // use ethers formatEther — avoids precision loss
      const hasOnchainWinner = onchainWinner && onchainWinner !== '0x0000000000000000000000000000000000000000';
      if (hasOnchainWinner) {
        // Patch so renderDetailActions can see the winner
        (a as any)._onchainWinner     = onchainWinner;
        (a as any)._onchainWinningBid = onchainBid;
        // Update Firebase in background
        const fbKey = a._fbKey || String(a.id);
        fbUpdate(`auctions/${fbKey}`, { winner: onchainWinner, winningBid: onchainBid }).catch(() => {});
        // Also update md-winner-wrap
        const wWrap = document.getElementById('md-winner-wrap');
        if (wWrap) {
          wWrap.style.display = 'block';
          const isMyWin = !!(S.wallet?.address?.toLowerCase() === onchainWinner.toLowerCase());
          const winnerEl = document.getElementById('md-winner');
          const bidEl    = document.getElementById('md-winning-bid');
          if (winnerEl) winnerEl.innerHTML = isMyWin
            ? '<span style="color:var(--gold);font-weight:700">🎉 You Won!</span>'
            : 'Winner: ' + shortAddr(onchainWinner);
          if (bidEl) bidEl.textContent = parseFloat(onchainBid).toFixed(4) + ' ETH';
        }
        // Re-render actions panel with winner info (only if modal is still open)
        if (document.getElementById('overlay-detail')?.classList.contains('open')) {
          renderDetailActions({ ...a, winner: onchainWinner, winningBid: onchainBid } as any, phase);
        }
      }
    }).catch((e: any) => console.warn('[openDetail] getInfo on-chain:', e?.message));
  }

  renderDetailActions(a, phase);
  openOverlay('overlay-detail');
  registerAuctionWatcher(a.id);
}
function getMySecret(a: Auction): LocalSecret | undefined {
  return S.localSecrets[a.id] ?? S.localSecrets[a._fbKey ?? ''];
}
function renderDetailActions(a: Auction, phase: 0|1|2): void {
  const el        = document.getElementById('md-actions')!;
  const mySecret  = getMySecret(a);
  const connected = !!S.wallet;
  const id        = a.id || a._fbKey;

  if (!connected) {
    el.innerHTML = `
      <div class="bid-panel" style="text-align:center;padding:1.5rem">
        <div style="font-size:2rem;margin-bottom:0.6rem">🔐</div>
        <div style="font-family:var(--font-head);font-weight:700;font-size:0.95rem;margin-bottom:0.4rem">Connect Wallet to Participate</div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:1rem">You need a Web3 wallet to place bids on this auction.</div>
        <button class="btn btn-primary btn-full" id="md-connect-btn">
          <i class="bi bi-wallet2"></i> Connect Wallet
        </button>
      </div>`;
    document.getElementById('md-connect-btn')?.addEventListener('click', handleWalletClick);
    return;
  }

  // Seller check — seller cannot bid on their own auction
  const isSeller = !!(a.owner && S.wallet && a.owner.toLowerCase() === S.wallet.address.toLowerCase());
  if (isSeller && phase === 0) {
    el.innerHTML = `
      <div class="bid-panel" style="text-align:center;padding:1.4rem;border:1.5px solid rgba(245,200,66,0.25);background:rgba(245,200,66,0.03)">
        <div style="font-size:2rem;margin-bottom:0.6rem">👑</div>
        <div style="font-family:var(--font-head);font-weight:700;color:var(--gold);margin-bottom:0.4rem">You created this auction</div>
        <div style="font-size:12px;color:var(--text3);line-height:1.6">
          As the seller, you cannot bid on your own auction.<br>
          Share the link so others can place bids.
        </div>
      </div>`;
    return;
  }

  // ── Whitelist check ───────────────────────────────────────────────────────
  const isPrivateAuction = a.isPrivate || a.auctionType === 'private';
  const whitelistArr = Array.isArray(a.whitelist) ? a.whitelist.map(w => w.toLowerCase()) : [];
  const blockedByWhitelist = isPrivateAuction && whitelistArr.length > 0
    && !whitelistArr.includes(S.wallet!.address.toLowerCase());

  if (blockedByWhitelist && phase === 0) {
    el.innerHTML = `
      <div class="bid-panel" style="text-align:center;padding:1.4rem">
        <div style="font-size:2rem;margin-bottom:0.6rem">🔒</div>
        <div style="font-family:var(--font-head);font-weight:700;color:var(--red);margin-bottom:0.4rem">Private Auction</div>
        <div style="font-size:12px;color:var(--text3)">Your wallet is not on the allowlist for this private auction.</div>
      </div>`;
    return;
  }

  // ── UPCOMING check — auction not yet started ────────────────────────────
  if (isUpcoming(a)) {
    const startStr = new Date(a.biddingStart! * 1000).toLocaleString('en-US', {
      dateStyle: 'medium', timeStyle: 'short',
    });
    const countdown = formatCountdown(a.biddingStart!);
    el.innerHTML = `
      <div class="bid-panel" style="text-align:center;padding:1.4rem;border:1.5px solid rgba(91,63,191,0.3);background:rgba(91,63,191,0.04)">
        <div style="font-size:2rem;margin-bottom:0.6rem">⏳</div>
        <div style="font-family:var(--font-head);font-weight:700;color:var(--text);margin-bottom:0.4rem">Auction Not Started Yet</div>
        <div style="font-family:var(--font-mono);font-size:18px;font-weight:700;color:var(--glow);margin-bottom:0.5rem" data-ts="${a.biddingStart}">${countdown}</div>
        <div style="font-size:12px;color:var(--text3)">Bidding opens on ${startStr}</div>
      </div>`;
    return;
  }

  // ── PHASE 0: BIDDING ──────────────────────────────────────────────────────
  if (phase === 0) {
    const existingBidAmt = mySecret ? parseFloat(mySecret.amount || '0') : 0;
    const timeLeft = a.biddingEnd - Math.floor(Date.now() / 1000);
    const urgencyColor = timeLeft < 3600 ? 'var(--red)' : timeLeft < 86400 ? 'var(--gold)' : 'var(--glow)';
    const urgencyTxt   = timeLeft < 3600 ? '⚡ Closing soon!' : timeLeft < 86400 ? '⏰ Less than 24h left' : '🕐 Plenty of time';

    el.innerHTML = `
      <div class="bid-panel" style="border:1.5px solid rgba(0,158,140,0.22);background:rgba(0,158,140,0.03)">
        <div class="bid-panel-title" style="color:var(--glow)">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:1em;height:1em;vertical-align:-0.125em;fill:currentColor"><path d="M222.716 311.307l-109.3-84.325c-8.698-6.709-21.195-5.09-27.898 3.602-6.708 8.691-5.103 21.189 3.601 27.898l109.293 84.318c8.705 6.708 21.196 5.103 27.905-3.595 7.709-9.699 6.097-22.19-2.601-28.898z"/><path d="M236.318 67.662l109.307 84.318c8.698 6.716 21.189 5.104 27.898-3.594 6.709-8.698 5.097-21.182-3.601-27.898l-109.3-84.324c-8.698-6.709-21.189-5.09-27.898 3.601-6.709 8.697-5.096 21.189 3.594 27.897z"/><polygon points="226.824,78.068 122.491,213.304 233.65,299.048 337.977,163.812"/><path d="M501.529 363.144l-185.626-143.2-32.864 42.598 185.633 143.2c11.764 9.075 28.652 6.901 37.72-4.864 9.082-11.771 6.901-28.659-4.863-37.734z"/><path d="M186.936 409.748c0-14.274-11.565-25.847-25.84-25.847H39.689c-14.274 0-25.84 11.572-25.84 25.847v19.166h173.087v-19.166z"/><rect x="0" y="445.143" width="200.786" height="34.833"/></svg>
          ${mySecret ? 'Update Your Bid' : 'Place Your Bid'}
        </div>

        ${mySecret ? `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 13px;margin-bottom:12px;
          background:linear-gradient(90deg,rgba(0,229,195,0.09),rgba(91,63,191,0.05));
          border:1px solid rgba(0,229,195,0.28);border-radius:var(--r2)">
          <span style="font-size:18px">✅</span>
          <div style="flex:1">
            <div style="font-size:11px;font-weight:600;color:var(--text2)">Your current bid is active</div>
            <div style="font-family:var(--font-mono);font-size:14px;color:var(--glow);font-weight:700">${existingBidAmt.toFixed(4)} ETH</div>
          </div>
          <div style="font-size:10px;color:var(--text3);text-align:right;line-height:1.5">Raise it<br>to win</div>
        </div>` : ''}

        <div style="display:flex;align-items:center;justify-content:space-between;
          padding:7px 10px;margin-bottom:12px;
          background:${urgencyColor}11;border:1px solid ${urgencyColor}30;border-radius:var(--r2)">
          <span style="font-size:11px;color:${urgencyColor};font-weight:600">${urgencyTxt}</span>
          <span style="font-family:var(--font-mono);font-size:11px;color:${urgencyColor}" data-ts="${a.biddingEnd}">${formatCountdown(a.biddingEnd)}</span>
        </div>

        <div class="inp-row">
          <label class="inp-lbl">Bid Amount (ETH)</label>
          <div style="position:relative">
            <input class="inp" id="bid-amt" type="number" step="0.001" min="${a.startPrice}"
              placeholder="Min ${a.startPrice} ETH"
              value="${existingBidAmt > 0 ? existingBidAmt : ''}"
              style="padding-right:48px;font-size:15px;font-weight:600"/>
            <span style="position:absolute;right:12px;top:50%;transform:translateY(-50%);
              font-size:11px;color:var(--text3);font-family:var(--font-mono);pointer-events:none">ETH</span>
          </div>
          <div style="margin-top:5px;font-size:10.5px;color:var(--text3);font-family:var(--font-mono)">
            Floor: <span style="color:var(--glow)">${a.startPrice} ETH</span>
            · Auction <span style="color:var(--text2)">${a.id ? '#' + a.id : '#' + a._fbKey}</span>
          </div>
        </div>

        <button class="btn btn-primary btn-full" style="padding:12px;font-size:14px;letter-spacing:0.03em" id="btn-commit-bid">
          <i class="bi bi-lightning-fill" style="margin-right:4px"></i>
          ${mySecret ? 'Raise My Bid On-Chain' : 'Lock In My Bid On-Chain'}
        </button>
      </div>`;

    document.getElementById('btn-commit-bid')?.addEventListener('click', () => {
      const amtVal = parseFloat((document.getElementById('bid-amt') as HTMLInputElement)?.value || '0');
      const minBid = parseFloat(a.startPrice || '0');
      if (!amtVal || isNaN(amtVal) || amtVal < minBid) {
        toast('Invalid Bid', `Minimum bid is ${a.startPrice} ETH`, 'err');
        return;
      }
      showBidConfirmModal(id!, amtVal, a, () => handleBid(id!));
    });

  // ── PHASE 1: ENDED — auto-finalizing in background ──────────────────────────
  } else if (phase === 1) {
    // Prefer winner read directly from contract (set by openDetail async)
    const resolvedWinner     = (a as any)._onchainWinner || a.winner || '';
    const resolvedWinningBid = (a as any)._onchainWinningBid || a.winningBid || '0';
    const endedHasWinner  = resolvedWinner && resolvedWinner !== '0x0000000000000000000000000000000000000000';
    const endedIsMyWin    = !!(endedHasWinner && S.wallet && S.wallet.address.toLowerCase() === resolvedWinner.toLowerCase());

    if (endedHasWinner) {
      // Winner determined — show immediately, winner just needs to Claim
      el.innerHTML = `
        <div class="bid-panel" style="border:1.5px solid rgba(200,150,10,0.3);background:rgba(200,150,10,0.03)">
          <div class="bid-panel-title" style="color:var(--gold)">
            <i class="bi bi-trophy-fill"></i> Auction Ended — Winner Determined
          </div>
          ${endedIsMyWin ? `
          <div style="text-align:center;padding:14px;margin-bottom:12px;
            background:linear-gradient(135deg,rgba(200,150,10,0.12),rgba(200,150,10,0.04));
            border:2px solid rgba(200,150,10,0.4);border-radius:var(--r)">
            <div style="font-size:2rem;margin-bottom:4px">🏆</div>
            <div style="font-family:var(--font-head);font-weight:800;font-size:1.05rem;color:var(--gold);margin-bottom:2px">You Won!</div>
            <div style="font-family:var(--font-mono);font-size:14px;color:var(--gold);font-weight:700;margin-bottom:10px">
              ${parseFloat(resolvedWinningBid||'0').toFixed(4)} ETH
            </div>
            <div style="font-size:11px;color:var(--text3)">The NFT is being prepared — Claim button will appear shortly.</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;
            background:rgba(0,229,195,0.06);border:1px solid rgba(0,229,195,0.2);border-radius:var(--r2)">
            <div class="spin-icon" style="flex-shrink:0"></div>
            <span style="font-size:12px;color:var(--text3)">Finalizing on-chain automatically…</span>
          </div>` : `
          <div style="padding:12px;text-align:center;margin-bottom:12px;
            background:linear-gradient(135deg,rgba(200,150,10,0.08),rgba(200,150,10,0.03));
            border:1px solid rgba(200,150,10,0.25);border-radius:var(--r)">
            <div style="font-size:1.5rem;margin-bottom:4px">🏆</div>
            <div style="font-size:11px;color:var(--text3);margin-bottom:3px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.05em">Winner</div>
            <div style="font-family:var(--font-mono);font-size:14px;color:var(--gold);font-weight:700">${shortAddr(resolvedWinner)}</div>
            <div style="font-family:var(--font-mono);font-size:13px;color:var(--gold);margin-top:3px">${parseFloat(resolvedWinningBid||'0').toFixed(4)} ETH</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;
            background:rgba(0,229,195,0.06);border:1px solid rgba(0,229,195,0.2);border-radius:var(--r2)">
            <div class="spin-icon" style="flex-shrink:0"></div>
            <span style="font-size:12px;color:var(--text3)">Finalizing on-chain automatically…</span>
          </div>`}
        </div>`;
    } else {
      // No winner yet — auto-finalizing, show loading
      el.innerHTML = `
        <div class="bid-panel" style="border:1.5px solid rgba(200,150,10,0.25);background:rgba(200,150,10,0.03)">
          <div class="bid-panel-title" style="color:var(--gold)">
            <i class="bi bi-hourglass-split"></i> Bidding Ended — Settling…
          </div>
          <div style="text-align:center;padding:1.5rem 1rem">
            <div class="spin-icon" style="margin:0 auto 12px;width:32px;height:32px;border-width:3px"></div>
            <div style="font-size:13px;color:var(--text2);line-height:1.6;margin-bottom:6px">
              The auction is being finalized automatically.<br>Winner will appear here in a moment.
            </div>
            <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono)">This happens on-chain — no action needed.</div>
          </div>
        </div>`;
    }

  // ── PHASE 2: FINALIZED ────────────────────────────────────────────────────
  } else {
    const isWinner   = !!(a.winner && S.wallet && S.wallet.address.toLowerCase() === a.winner.toLowerCase());
    const hasWinner  = !!(a.winner && a.winner !== '0x0000000000000000000000000000000000000000');
    const iAmBidder  = !!mySecret; // only show refund if I placed a bid

    // Claim deadline (3 days from finalize)
    const claimDl      = a.claimDeadline || (a.finalizedAt ? a.finalizedAt + 3*24*3600*1000 : 0);
    const claimDeadSec = Math.floor(claimDl / 1000);
    const claimExpired = claimDl > 0 && Date.now() > claimDl;

    const nftBadge = a.nftContract
      ? `<div style="margin-bottom:12px;padding:9px 12px;
           background:rgba(0,158,140,0.06);border:1px solid rgba(0,158,140,0.18);
           border-radius:var(--r2);font-size:11px;font-family:var(--font-mono)">
           <div style="color:var(--text3);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;font-size:9.5px">🖼️ NFT Asset</div>
           <div style="color:var(--glow);margin-bottom:2px">${esc(a.nftContract.slice(0,12))}…${esc(a.nftContract.slice(-6))}</div>
           <div style="color:var(--text2)">Token ID: <strong>#${esc(a.tokenId ?? '')}</strong></div>
         </div>` : '';

    // Winner section
    let winnerSection = '';
    if (isWinner && !a.itemClaimed && !claimExpired) {
      // Winner can claim — show 3-day countdown
      winnerSection = `
        <div style="margin-bottom:12px;padding:14px;text-align:center;
          background:linear-gradient(135deg,rgba(200,150,10,0.10),rgba(200,150,10,0.04));
          border:2px solid rgba(200,150,10,0.4);border-radius:var(--r)">
          <div style="font-size:1.8rem;margin-bottom:4px">🏆</div>
          <div style="font-family:var(--font-head);font-weight:800;font-size:1.05rem;color:var(--gold);margin-bottom:2px">You Won!</div>
          <div style="font-family:var(--font-mono);font-size:14px;color:var(--gold);font-weight:700;margin-bottom:10px">
            ${parseFloat(a.winningBid||'0').toFixed(4)} ETH
          </div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:6px">Claim your NFT before the deadline:</div>
          <div style="font-family:var(--font-mono);font-size:15px;font-weight:700;color:var(--red);
            background:rgba(217,53,96,0.08);border:1px solid rgba(217,53,96,0.2);
            border-radius:var(--r2);padding:6px 12px;display:inline-block;margin-bottom:10px"
            data-ts="${claimDeadSec}">${formatCountdown(claimDeadSec)}</div>
          <div style="font-size:10.5px;color:var(--text3);line-height:1.5">
            ⚠️ If you don't claim within 3 days,<br>the NFT returns to the seller and your ETH is forfeited.
          </div>
        </div>
        <button class="btn btn-full" style="padding:13px;margin-bottom:8px;
          background:linear-gradient(135deg,var(--gold),var(--gold2));
          border:none;color:#1a1000;font-weight:700;font-size:14px;border-radius:var(--r2)" id="btn-claim">
          <i class="bi bi-trophy-fill" style="margin-right:5px"></i> Claim My NFT — Token #${esc(a.tokenId ?? '')}
        </button>`;
    } else if (isWinner && a.itemClaimed) {
      winnerSection = `
        <div style="text-align:center;padding:1.2rem;
          background:rgba(0,158,140,0.06);border:1px solid rgba(0,158,140,0.2);
          border-radius:var(--r);margin-bottom:12px">
          <div style="font-size:1.8rem;margin-bottom:6px">✅</div>
          <div style="font-family:var(--font-head);font-weight:700;color:var(--glow);font-size:0.95rem">NFT Claimed Successfully!</div>
          <div style="font-size:12px;color:var(--text3);margin-top:4px">The NFT has been transferred to your wallet.</div>
        </div>`;
    } else if (isWinner && claimExpired) {
      winnerSection = `
        <div style="text-align:center;padding:1.2rem;
          background:rgba(217,53,96,0.06);border:1px solid rgba(217,53,96,0.2);
          border-radius:var(--r);margin-bottom:12px">
          <div style="font-size:1.8rem;margin-bottom:6px">⛔</div>
          <div style="font-family:var(--font-head);font-weight:700;color:var(--red);font-size:0.95rem">Claim Period Expired</div>
          <div style="font-size:12px;color:var(--text3);margin-top:4px">You did not claim within 3 days. The NFT has been returned to the seller.</div>
        </div>`;
    } else if (!hasWinner) {
      winnerSection = `
        <div style="text-align:center;padding:1rem;
          background:rgba(90,82,72,0.05);border:1px solid var(--border);
          border-radius:var(--r);margin-bottom:12px">
          <div style="font-size:1.5rem;margin-bottom:4px">🏁</div>
          <div style="font-size:13px;color:var(--text3)">No winner — auction closed with no qualifying bids.</div>
        </div>`;
    } else if (hasWinner && !isWinner) {
      // Someone else won — show winner info
      winnerSection = `
        <div style="padding:12px;
          background:linear-gradient(135deg,rgba(200,150,10,0.08),rgba(200,150,10,0.03));
          border:1px solid rgba(200,150,10,0.25);border-radius:var(--r);margin-bottom:12px;text-align:center">
          <div style="font-size:1.5rem;margin-bottom:4px">🏆</div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:3px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.05em">Winner</div>
          <div style="font-family:var(--font-mono);font-size:13px;color:var(--gold);font-weight:700">${shortAddr(a.winner)}</div>
          <div style="font-family:var(--font-mono);font-size:13px;color:var(--gold);margin-top:3px">${parseFloat(a.winningBid||'0').toFixed(4)} ETH</div>
        </div>`;
    }

    // Refund button — only shown to bidders (has mySecret) who are NOT the winner
    const refundSection = (!isWinner && iAmBidder && hasWinner)
      ? `<button class="btn btn-full" style="padding:11px;
           background:rgba(26,127,193,0.07);border:1.5px solid rgba(26,127,193,0.3);
           color:var(--blue);font-weight:600;margin-bottom:6px" id="btn-refund">
           <i class="bi bi-arrow-return-left" style="margin-right:5px"></i> Withdraw My ETH Deposit
         </button>
         <div style="font-size:10.5px;color:var(--text3);text-align:center;margin-bottom:8px;font-family:var(--font-mono)">
           Losing bidders can withdraw their ETH from the contract.
         </div>`
      : '';

    el.innerHTML = `
      <div class="bid-panel" style="border:1.5px solid var(--border2)">
        <div class="bid-panel-title">
          <i class="bi bi-flag-fill"></i> Auction Finalized
        </div>
        ${nftBadge}
        ${winnerSection}
        ${refundSection}
      </div>`;

    document.getElementById('btn-claim')?.addEventListener('click', () => handleClaim(id!));
    document.getElementById('btn-refund')?.addEventListener('click', () => handleRefund(id!));
  }
}

// toggleRex removed — new contract uses open bid, no REX relay needed

// ─────────────────────────────────────────────────────────────────────────────
//  WIN-PROBABILITY ORACLE
// ─────────────────────────────────────────────────────────────────────────────
function renderOracle(a: Auction, phase: 0|1|2): void {
  const box  = document.getElementById('modal-oracle-box')!;
  const body = document.getElementById('modal-oracle-body')!;

  if (phase !== 0) { box.style.display = 'none'; return; }

  const now      = Math.floor(Date.now() / 1000);
  const bidCount = a.totalBidders || 0;
  const timeLeft = Math.max(0, a.biddingEnd - now);
  const totalDuration = a.biddingEnd - (a.biddingStart ?? (a.createdAt ? Math.floor(a.createdAt / 1000) : now));
  const elapsed  = totalDuration > 0 ? 1 - timeLeft / totalDuration : 1;

  // ── Factor 1: Base win chance by bidder count
  //   0 bidders → 95% (first mover), 1 → 90%, 2 → 60%, 3 → 45%, 5 → 28%, 10 → 15%, 20+ → ~5%
  const basePct = bidCount === 0
    ? 95
    : Math.round(90 / Math.pow(bidCount, 0.75));

  // ── Factor 2: Time pressure — late stage boosts urgency signal, lowers
  //   window for new entrants (slightly raises the chance of the current leader)
  //   We apply a small upward nudge if > 80% of time has elapsed (fewer can still snipe)
  const lateStageFactor = elapsed > 0.8 ? 1.10 : elapsed > 0.5 ? 1.03 : 1.0;

  // ── Factor 3: Heat / velocity penalty — if many watchers/bids per hour,
  //   more competition is likely incoming; reduce estimate slightly
  const velocity = S.bidVelocities[String(a.id)] || S.bidVelocities[String(a._fbKey)] || 0;
  const watchers = S.watcherCounts[String(a.id)] || S.watcherCounts[String(a._fbKey)] || 0;
  const heatScore = Math.min(100, (velocity * 20) + (watchers * 10));
  const heatPenalty = heatScore > 60 ? 0.80 : heatScore > 30 ? 0.92 : 1.0;

  // ── Combine factors, clamp 3–90
  const raw       = basePct * lateStageFactor * heatPenalty;
  const winChance = Math.max(3, Math.min(90, Math.round(raw)));

  // ── Labels & colors
  const color   = winChance >= 65 ? 'var(--glow)' : winChance >= 35 ? 'var(--gold)' : 'var(--red)';
  const tier    = winChance >= 65 ? { icon: '🟢', label: 'High' } : winChance >= 35 ? { icon: '🟡', label: 'Medium' } : { icon: '🔴', label: 'Low' };

  let urgencyLabel: string;
  if (timeLeft === 0)       urgencyLabel = '🏁 Bidding has ended';
  else if (timeLeft < 600)  urgencyLabel = '🚨 Under 10 min left — act now!';
  else if (timeLeft < 3600) urgencyLabel = '⚡ Under 1 hour — closing soon';
  else if (timeLeft < 86400)urgencyLabel = '⏳ Less than a day remaining';
  else                      urgencyLabel = '🕐 Early stage — time to plan';

  const timeStr  = timeLeft > 0 ? formatCountdown(a.biddingEnd) : 'Ended';
  const mySecret = getMySecret(a);
  const myBidAmt = mySecret ? parseFloat(mySecret.amount) : 0;
  const floorAmt = parseFloat(a.startPrice || '0');

  // ── Personal insight (only if user has placed a bid)
  let personalInsight = '';
  if (mySecret && myBidAmt > 0) {
    const ratio = floorAmt > 0 ? myBidAmt / floorAmt : 1;
    if (ratio >= 2.0) {
      personalInsight = `<div style="margin-top:10px;padding:8px 10px;background:rgba(0,158,140,0.08);border:1px solid rgba(0,158,140,0.22);border-radius:var(--r2);font-size:11px;color:var(--glow)">
        💡 Your bid is <strong>${ratio.toFixed(1)}×</strong> the floor — competitive position.
      </div>`;
    } else if (ratio >= 1.3) {
      personalInsight = `<div style="margin-top:10px;padding:8px 10px;background:rgba(212,165,10,0.07);border:1px solid rgba(212,165,10,0.2);border-radius:var(--r2);font-size:11px;color:var(--gold)">
        💡 Your bid is <strong>${ratio.toFixed(1)}×</strong> the floor — moderate position.
      </div>`;
    } else {
      personalInsight = `<div style="margin-top:10px;padding:8px 10px;background:rgba(220,38,38,0.07);border:1px solid rgba(220,38,38,0.18);border-radius:var(--r2);font-size:11px;color:var(--red)">
        ⚠️ Your bid is only <strong>${ratio.toFixed(1)}×</strong> the floor — consider increasing to stay competitive.
      </div>`;
    }
  }

  box.style.display = 'block';

  // ── "No bids yet" state — first mover message, no win% shown ─────────────
  if (bidCount === 0) {
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:11px;color:var(--text3)">Win probability estimate</span>
        <span style="font-size:11px;background:rgba(0,158,140,0.12);color:var(--glow);border:1px solid rgba(0,158,140,0.3);border-radius:4px;padding:2px 7px;font-family:var(--font-mono)">🟢 First Mover</span>
      </div>
      <div style="text-align:center;padding:14px 10px 10px">
        <div style="font-size:2rem;margin-bottom:6px">🎯</div>
        <div style="font-family:var(--font-mono);font-size:1.1rem;font-weight:700;color:var(--glow);margin-bottom:4px">No bids yet</div>
        <div style="font-size:12px;color:var(--text3);line-height:1.6">
          Be the <strong style="color:var(--text2)">first bidder</strong> — first-mover advantage is real in sealed auctions.
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--r2);padding:6px 8px;text-align:center">
          <div style="font-size:16px">👥</div>
          <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--text)">0</div>
          <div style="font-size:10px;color:var(--text3)">bidders</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--r2);padding:6px 8px;text-align:center">
          <div style="font-size:16px">⏱</div>
          <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--text)">${timeStr}</div>
          <div style="font-size:10px;color:var(--text3)">remaining</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text3);text-align:center">${urgencyLabel}</div>
      <div style="font-size:10px;color:var(--text4);margin-top:8px;text-align:center;font-style:italic">
        Oracle activates once the first bid is placed.
      </div>`;
    return;
  }

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:12px;color:var(--text2)">Win probability estimate</span>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:11px;background:${color}18;color:${color};border:1px solid ${color}40;border-radius:4px;padding:2px 7px;font-family:var(--font-mono)">${tier.icon} ${tier.label}</span>
        <strong style="font-family:var(--font-mono);color:${color};font-size:1.15rem">${winChance}%</strong>
      </div>
    </div>
    <div class="oracle-bar" style="margin-bottom:10px">
      <div class="oracle-fill" style="width:${winChance}%;background:${color};transition:width 0.6s cubic-bezier(.4,0,.2,1)"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
      <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--r2);padding:6px 8px;text-align:center">
        <div style="font-size:16px">👥</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--text)">${bidCount}</div>
        <div style="font-size:10px;color:var(--text3)">bidder${bidCount !== 1 ? 's' : ''}</div>
      </div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--r2);padding:6px 8px;text-align:center">
        <div style="font-size:16px">⏱</div>
        <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--text)">${timeStr}</div>
        <div style="font-size:10px;color:var(--text3)">remaining</div>
      </div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--r2);padding:6px 8px;text-align:center">
        <div style="font-size:16px">${heatScore > 60 ? '🔥' : heatScore > 30 ? '⚡' : '❄️'}</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--text)">${heatScore}</div>
        <div style="font-size:10px;color:var(--text3)">heat score</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text3);text-align:center">${urgencyLabel}</div>
    ${personalInsight}
    <div style="font-size:10px;color:var(--text4);margin-top:8px;text-align:center;font-style:italic">
      Based on current bidders, time remaining &amp; market heat — not a guarantee.
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BID ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
async function handleBid(auctionId: number | string): Promise<void> {
  if (!S.wallet) { toast('Not connected', '', 'err'); return; }
  const a   = S.auctions.find(x => String(x.id) === String(auctionId) || x._fbKey === String(auctionId))!;
  const amt = parseFloat((document.getElementById('bid-amt') as HTMLInputElement)?.value || '0');


  // Guard: seller cannot bid on their own auction
  if (a && a.owner && S.wallet.address.toLowerCase() === a.owner.toLowerCase()) {
    toast('Cannot Bid', 'You are the seller — the contract blocks self-bidding. Use a different wallet to test.', 'err');
    return;
  }
  // Guard: auction not yet started (biddingStart in the future)
  if (a && a.biddingStart && a.biddingStart > Math.floor(Date.now() / 1000)) {
    const startStr = new Date(a.biddingStart * 1000).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
    toast('Not Started Yet', `Auction starts at ${startStr}.`, 'err');
    return;
  }
  // Check whitelist for private auction
  if (a && (a.isPrivate || a.auctionType === 'private') && Array.isArray(a.whitelist) && a.whitelist.length > 0) {
    const myAddr = S.wallet.address.toLowerCase();
    if (!a.whitelist.map(w => w.toLowerCase()).includes(myAddr)) {
      toast('Access Denied', 'Your wallet is not on the auction allowlist.', 'err');
      return;
    }
  }

  const minBid = parseFloat(a?.startPrice || '0');
  if (!a || amt <= 0 || isNaN(minBid) || amt < minBid) {
    toast('Invalid Bid', `Minimum bid is ${a?.startPrice} ETH`, 'err');
    return;
  }

  showTxOverlay('Placing Bid', 'Sending ETH bid to contract…');
  try {
    const amtWei = parseEther(amt.toString());

    if (!S.wallet.contract) {
      hideTxOverlay();
      toast('Contract Error', 'Could not connect to the smart contract. Please reconnect your wallet.', 'err');
      return;
    }

    showTxOverlay('Awaiting Signature', 'Confirm placeBid() in MetaMask — your ETH will be sent directly to the contract…');
    const contractId = typeof auctionId === 'string' && /^\d+$/.test(auctionId) ? Number(auctionId) : auctionId;
    const tx = await S.wallet.contract.placeBid(contractId, { value: amtWei });
    showTxOverlay('Broadcasting…', `Tx: ${tx.hash.slice(0, 20)}… — waiting for Sepolia confirmation`);
    const txHash = tx.hash;
    await tx.wait(1);
    showTxOverlay('Saving Bid', 'Transaction confirmed — syncing your bid to the feed…');

    // Sync to Firebase ONLY after on-chain tx confirmed
    const fbAuctionKey = a._fbKey || String(auctionId);
    // Re-read totalBidders from contract to avoid race condition with concurrent bids
    let freshBidderCount = (a.totalBidders || 0) + 1;
    try {
      if (S.wallet?.contract) {
        const info = await S.wallet.contract.getInfo(contractId);
        freshBidderCount = Number(info.totalBidders);
      }
    } catch {}
    await fbUpdate(`auctions/${fbAuctionKey}`, { totalBidders: freshBidderCount });
    // commitTimestamp — used for tie-breaking (first commit wins)
    const commitTs = Date.now();
    await fbWrite(`bids/${fbAuctionKey}/${S.wallet.address.toLowerCase()}`, {
      address: S.wallet.address, amountEth: String(amt),
      refunded: false, ts: commitTs,
      commitTimestamp: commitTs,
      txHash,
    });
    await fbPush('activity', {
      type:'bid', text:'New Bid', color:'green', icon:'💰',
      detail:`${shortAddr(S.wallet.address)} placed a sealed bid on ${a.itemName}`,
      ts: Date.now(), txHash,
      walletAddr: S.wallet.address.toLowerCase(),
      auctionId: String(auctionId),
      auctionName: a.itemName,
      amount: String(amt),
    });
    await fbPush('pulses', {
      auctionId: fbAuctionKey, auctionName: a.itemName, event: 'bid',
      addr: shortAddr(S.wallet.address), ts: Date.now(),
    });

    // Update bidder stats in Firebase
    try {
      const bAddr = S.wallet.address.toLowerCase();
      const user  = await fbRead(`users/${bAddr}`);
      if (user) {
        const prevSpent = parseFloat(user.totalSpent || '0');
        await fbUpdate(`users/${bAddr}`, {
          totalBids:  (user.totalBids || 0) + 1,
          totalSpent: (prevSpent + amt).toFixed(6),
          lastActivity: Date.now(),
        });
      } else {
        // User does not exist in Firebase yet — create new profile
        await fbWrite(`users/${bAddr}`, {
          address: S.wallet.address, joinedAt: Date.now(), lastSeen: Date.now(),
          totalBids: 1, auctionsWon: 0, totalSpent: amt.toFixed(6),
          totalWon: '0', auctionsCreated: 0, lastActivity: Date.now(),
        });
      }
    } catch {}

    if (S.vaultUnlocked) {
      // Record bid in vault (no nonce anymore, just amount)
      S.vaultEntries.push({ auctionId, auctionName: a.itemName, amount: String(amt), nonce: '', commitment: '', ts: Date.now() });
    }

    // ── Save bid to localSecrets + _mbBidCache so it appears in My Bids immediately
    const secretKey = a._fbKey || String(auctionId);
    const existingSecret = S.localSecrets[secretKey];
    const bidTs = existingSecret?.ts || Date.now();
    lsSaveSecret(secretKey, {
      amount: String(amt),
      nonce:  existingSecret?.nonce || '',
      commitment: existingSecret?.commitment || '',
      ts: bidTs,
    });
    // Update cache so renderMyBids can use it immediately
    (window as any)._mbBidCache = (window as any)._mbBidCache || {};
    _mbBidCache[secretKey] = { amount: String(amt), refunded: false, ts: bidTs, source: 'fb' };

    hideTxOverlay();
    toast('Bid Placed! 💰', `Bid ${amt} ETH placed on-chain.`, 'ok');
    closeOverlay('overlay-detail');

  } catch (e: any) {
    hideTxOverlay();
    // Prefer revert reason: contract > shortMessage > raw message
    const reason =
      e.reason ??
      e.error?.reason ??
      e.data?.message ??
      e.shortMessage ??
      e.message?.replace(/^.*execution reverted:\s*/i, '').replace(/\s*\(action=.*$/s, '') ??
      'Unknown error';
    toast('Bid Failed', reason.slice(0, 140), 'err');
  }
}

// ── Reveal phase removed in new contract (open bid, not sealed) ──
// handleReveal / handleRevealManual / doReveal have been removed.

async function handleFinalize(auctionId: number | string): Promise<void> {
  showTxOverlay('Finalizing', 'Settling auction results…');
  try {
    if (!S.wallet) { hideTxOverlay(); toast('Not connected', '', 'err'); return; }
    const a = S.auctions.find(x => String(x.id) === String(auctionId) || x._fbKey === String(auctionId))!;
    const fbKey = a?._fbKey || String(auctionId);

    let realWinner = '';
    let realWinningBid = a?.startPrice || '0';

    if (!S.wallet.contract) {
      hideTxOverlay();
      toast('Contract Error', 'Could not connect to the smart contract. Please reconnect your wallet.', 'err');
      return;
    }

    const contractId = typeof auctionId === 'string' && /^\d+$/.test(auctionId) ? Number(auctionId) : auctionId;
    showTxOverlay('Awaiting Signature', 'Confirm in wallet…');
    const tx = await S.wallet.contract.finalizeAuction(contractId);
    showTxOverlay('Broadcasting', tx.hash);
    const receipt = await tx.wait();

    // Read actual winner + sellerReceived from AuctionFinalized event in receipt
    const iface = new Interface(CONTRACT_ABI);
    let realSellerReceived = '';
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'AuctionFinalized') {
          realWinner         = parsed.args.winner;
          realWinningBid     = formatEther(parsed.args.winningBid);
          realSellerReceived = formatEther(parsed.args.sellerReceived);
        }
      } catch {}
    }
    // Fallback: read from contract if event not found
    if (!realWinner) {
      const onchainInfo = await S.wallet.contract.getInfo(contractId);
      realWinner     = onchainInfo.winner;
      realWinningBid = formatEther(onchainInfo.winningBid);
    }
    // Fallback calculation if contract did not emit sellerReceived
    if (!realSellerReceived && realWinningBid) {
      realSellerReceived = (parseFloat(realWinningBid) * 0.975).toFixed(6);
    }

    const nowMs = Date.now();
    const CLAIM_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
    await fbUpdate(`auctions/${fbKey}`, {
      finalized:        true,
      winner:           realWinner || '',
      winningBid:       realWinningBid,
      sellerReceived:   realSellerReceived,
      finalizedAt:      nowMs,
      claimDeadline:    realWinner ? nowMs + CLAIM_WINDOW_MS : 0,
      finalizedBy:      S.wallet?.address || '',
    });

    // Update winner stats in Firebase
    if (realWinner) {
      const wAddr = realWinner.toLowerCase();
      try {
        const wUser = await fbRead(`users/${wAddr}`);
        const prevWon = parseFloat(wUser?.totalWon || '0');
        if (wUser) {
          await fbUpdate(`users/${wAddr}`, {
            auctionsWon: (wUser.auctionsWon || 0) + 1,
            totalWon:    (prevWon + parseFloat(realWinningBid)).toFixed(6),
            lastActivity: Date.now(),
          });
        } else {
          // Winner has no profile yet — create new
          await fbWrite(`users/${wAddr}`, {
            address: realWinner, joinedAt: Date.now(), lastSeen: Date.now(),
            totalBids: 0, auctionsWon: 1,
            totalSpent: '0', totalWon: parseFloat(realWinningBid).toFixed(6),
            auctionsCreated: 0, lastActivity: Date.now(),
          });
        }
      } catch {}
    }

    const nowTs = Date.now();
    const sellerAddr = a?.owner?.toLowerCase() || '';
    const winnerAddr = realWinner?.toLowerCase() || '';
    const sellerReceived = realSellerReceived || (realWinner ? (parseFloat(realWinningBid) * 0.975).toFixed(6) : '0');

    // General activity — for whoever triggers finalize (seller, winner, or anyone)
    await fbPush('activity', {
      type:'finalized', text:'Auction Finalized', color:'gold', icon:'🏆',
      detail:`${a?.itemName} finalized · Winner: ${shortAddr(realWinner || '—')} · ${parseFloat(realWinningBid).toFixed(4)} ETH`,
      ts: nowTs,
      walletAddr: S.wallet?.address?.toLowerCase() || '',
      auctionId: String(auctionId),
      auctionName: a?.itemName || '',
      winner: realWinner,
      winningBid: realWinningBid,
    });

    // Winner-specific activity (if winner is different from the finalizer)
    if (winnerAddr && winnerAddr !== (S.wallet?.address?.toLowerCase() || '')) {
      await fbPush('activity', {
        type: 'finalized',
        text: 'Auction Won',
        color: 'gold',
        icon: '🏆',
        detail: `${shortAddr(winnerAddr)} won "${a?.itemName}" · Winning bid: ${parseFloat(realWinningBid).toFixed(4)} ETH · Claim your NFT within 3 days`,
        ts: nowTs,
        walletAddr: winnerAddr,
        auctionId: String(auctionId),
        auctionName: a?.itemName || '',
        winner: realWinner,
        winningBid: realWinningBid,
        amount: realWinningBid,
      });
    }

    // NOTE: eth_received activity cho seller KHÔNG ghi ở đây.
    // ETH chỉ được ghi nhận khi winner đã claimNFT (xem handleClaim).

    hideTxOverlay();
    toast('Finalized ✅', realWinner ? `Winner: ${shortAddr(realWinner)}` : 'No bids — auction settled.', 'ok');
    closeOverlay('overlay-detail');
  } catch (e: any) {
    hideTxOverlay();
    toast('Finalize Failed', e.message?.slice(0,80), 'err');
  }
}

async function handleClaim(auctionId: number | string): Promise<void> {
  showTxOverlay('Claiming Item', '');
  try {
    if (!S.wallet?.contract) {
      hideTxOverlay();
      toast('Contract Error', 'Could not connect to the smart contract. Please reconnect your wallet.', 'err');
      return;
    }
    // Guard: only winner can claim — avoid wasting gas
    const auc = S.auctions.find(x => String(x.id) === String(auctionId) || x._fbKey === String(auctionId));
    if (auc?.winner && auc.winner !== '0x0000000000000000000000000000000000000000') {
      if (S.wallet.address.toLowerCase() !== auc.winner.toLowerCase()) {
        hideTxOverlay();
        toast('Not Winner', 'Only the auction winner can claim the NFT.', 'err');
        return;
      }
    }
    showTxOverlay('Awaiting Signature', 'Confirm claimNFT() — a small gas fee will be charged in ETH…');
    const contractId = typeof auctionId === 'string' && /^\d+$/.test(auctionId) ? Number(auctionId) : auctionId;
    const tx = await S.wallet.contract.claimNFT(contractId);
    showTxOverlay('Broadcasting…', `Tx: ${tx.hash.slice(0, 20)}…`);
    await tx.wait(1);
    const a = S.auctions.find(x => String(x.id) === String(auctionId) || x._fbKey === String(auctionId));
    const fbKey = a?._fbKey || String(auctionId);
    const claimedAt = Date.now();
    await fbUpdate(`auctions/${fbKey}`, { itemClaimed: true, claimedAt });

    // Log nft_claim activity for winner
    const winnerAddr = S.wallet?.address?.toLowerCase() || '';
    await fbPush('activity', {
      type: 'nft_claim',
      text: 'NFT Claimed',
      color: 'blue',
      icon: '🖼️',
      detail: `${shortAddr(winnerAddr)} received the NFT "${a?.itemName || ''}"${a?.tokenId ? ' · Token #' + a.tokenId : ''}${a?.nftContract ? ' · Contract: ' + a.nftContract.slice(0,10) + '…' : ''}`,
      ts: claimedAt,
      walletAddr: winnerAddr,
      auctionId: String(auctionId),
      auctionName: a?.itemName || '',
      winner: S.wallet?.address || '',
      winningBid: a?.winningBid || '0',
      nftContract: a?.nftContract || '',
      tokenId: a?.tokenId || '',
    });

    // Log eth_received activity for seller — triggered when NFT is claimed (not at finalize)
    const sellerAddr = a?.owner?.toLowerCase() || '';
    if (sellerAddr) {
      const winningBid = a?.winningBid || '0';
      // Prefer sellerReceived saved from contract event (most accurate)
      const sellerReceived = (a as any)?.sellerReceived
        ? parseFloat((a as any).sellerReceived).toFixed(6)
        : (parseFloat(winningBid) * 0.975).toFixed(6);
      const isSellerWinner = sellerAddr === winnerAddr;
      await fbPush('activity', {
        type: 'eth_received',
        text: isSellerWinner ? 'ETH Received — Auction Settled' : 'ETH Received — NFT Delivered',
        color: 'green',
        icon: '💰',
        detail: isSellerWinner
          ? `"${a?.itemName || ''}" settled · ${shortAddr(sellerAddr)} received ${sellerReceived} ETH (after 2.5% platform fee)`
          : `"${a?.itemName || ''}" NFT claimed by ${shortAddr(winnerAddr)} · ${shortAddr(sellerAddr)} received ${sellerReceived} ETH`,
        ts: claimedAt,
        walletAddr: sellerAddr,
        auctionId: String(auctionId),
        auctionName: a?.itemName || '',
        winner: S.wallet?.address || '',
        winningBid,
        amount: sellerReceived,
      });
    }

    hideTxOverlay();
    toast('Item Claimed! 🏆', '', 'ok');
    closeOverlay('overlay-detail');
  } catch (e: any) { hideTxOverlay(); toast('Error', e.message?.slice(0,80), 'err'); }
}

async function handleRefund(auctionId: number | string): Promise<void> {
  showTxOverlay('Claiming Refund', '');
  try {
    if (!S.wallet?.contract) {
      hideTxOverlay();
      toast('Contract Error', 'Could not connect to the smart contract. Please reconnect your wallet.', 'err');
      return;
    }
    showTxOverlay('Awaiting Signature', 'Confirm refund() — a small gas fee will be charged in ETH…');
    const contractId = typeof auctionId === 'string' && /^\d+$/.test(auctionId) ? Number(auctionId) : auctionId;
    const tx = await S.wallet.contract.refund(contractId);
    showTxOverlay('Broadcasting…', `Tx: ${tx.hash.slice(0, 20)}…`);
    await tx.wait(1);
    // Null-safe check instead of S.wallet! assertion
    if (!S.wallet) { hideTxOverlay(); toast('Disconnected', '', 'err'); return; }
    const a = S.auctions.find(x => String(x.id) === String(auctionId) || x._fbKey === String(auctionId));
    const fbKey = a?._fbKey || String(auctionId);
    await fbUpdate(`bids/${fbKey}/${S.wallet.address.toLowerCase()}`, {
      refunded: true, refundedAt: Date.now(),
    });
    hideTxOverlay();
    toast('Refund Sent! 💸', '', 'ok');
    closeOverlay('overlay-detail');
  } catch (e: any) { hideTxOverlay(); toast('Error', e.message?.slice(0,80), 'err'); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CREATE AUCTION
//  Flow:
//    1. Wallet not connected → trigger connect (pending create) then return
//    2. Validate form
//    3a. Real contract → call createAuction() on-chain, pay gas with Sepolia ETH,
//        wait for receipt, parse auctionId from event log
//    3b. No contract (demo) → send 0-wei ETH self-tx
//        so user can confirm + pay gas with real Sepolia ETH
//        → wait for tx confirmation on-chain, get txHash
//    4. Save auction + activity + user to Firebase
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//  NFT LOADING — read ERC-721 tokens from seller wallet
// ─────────────────────────────────────────────────────────────────────────────

/** Check if contract is ERC-721 (supportsInterface 0x80ac58cd) */
async function isERC721(contractAddr: string): Promise<boolean> {
  try {
    const c = new Contract(contractAddr, ERC721_ABI, S.wallet!.provider);
    return await c.supportsInterface('0x80ac58cd');
  } catch { return false; }
}

/** Load NFT list for seller from a specific contract.
 *  - Try tokenOfOwnerByIndex (ERC721Enumerable) first
 *  - If contract does not implement Enumerable → fallback: scan Transfer events on-chain
 *    to find tokenIds currently owned by the wallet
 */
async function loadNftsFromContract(contractAddr: string): Promise<NftToken[]> {
  if (!S.wallet) return [];
  try {
    const c        = new Contract(contractAddr, ERC721_ABI, S.wallet.provider);
    const owner    = S.wallet.address;
    let name = '', symbol = '';
    try { name   = await c.name();   } catch {}
    try { symbol = await c.symbol(); } catch {}

    let bal = 0;
    try { bal = Number(await c.balanceOf(owner)); } catch { return []; }
    if (bal === 0) return [];

    const tokens: NftToken[] = [];

    // ── Method 1: ERC721Enumerable.tokenOfOwnerByIndex ─────────────────────
    let enumerable = false;
    try {
      // Try tokenOfOwnerByIndex(owner, 0) — if it does not revert, contract supports it
      await c.tokenOfOwnerByIndex(owner, 0);
      enumerable = true;
    } catch {}

    if (enumerable) {
      for (let i = 0; i < Math.min(bal, 30); i++) {
        try {
          const tokenId = (await c.tokenOfOwnerByIndex(owner, i)).toString();
          tokens.push({ contractAddress: contractAddr, tokenId, name, symbol,
                        imageURI: '', tokenURI: '' });
        } catch {}
      }
    } else {
      // ── Method 2: Scan Transfer events — topic[2] = owner (tokens received) ──
      try {
        const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        const paddedOwner    = '0x' + '0'.repeat(24) + owner.slice(2).toLowerCase();
        const latestBlock    = await S.wallet.provider.getBlockNumber();
        const fromBlock      = Math.max(0, latestBlock - 500000); // ~2 months on Sepolia

        // All transfers INTO the wallet
        const logsIn = await S.wallet.provider.getLogs({
          address: contractAddr,
          fromBlock,
          toBlock: 'latest',
          topics:  [TRANSFER_TOPIC, null, paddedOwner],
        });

        // All transfers OUT of the wallet
        const logsOut = await S.wallet.provider.getLogs({
          address: contractAddr,
          fromBlock,
          toBlock: 'latest',
          topics:  [TRANSFER_TOPIC, paddedOwner, null],
        });

        // Currently held tokenIds = in - out
        const inSet  = new Set(logsIn.map(l => BigInt(l.topics[3]).toString()));
        const outSet = new Set(logsOut.map(l => BigInt(l.topics[3]).toString()));
        const held   = [...inSet].filter(id => !outSet.has(id));

        // Confirm ownerOf() for each tokenId (avoid stale data after transfer)
      for (const tokenId of held.slice(0, 30)) {
  try {
    const currentOwner = await c.ownerOf(tokenId);

    if (currentOwner.toLowerCase() === owner.toLowerCase()) {
      tokens.push({
        contractAddress: contractAddr,
        tokenId: String(tokenId),
        name,
        symbol,
        imageURI: '',
        tokenURI: ''
      });
    }
  } catch {}
}
      } catch (e: any) {
        console.warn('[NFT] event-log fallback error:', e.message);
      }
    }

    // ── Fetch metadata for each token (parallel, silent on error) ────────
    await Promise.allSettled(tokens.map(async t => {
      try {
        const uri = await c.tokenURI(t.tokenId);
        t.tokenURI = uri;
        let imageURI = '';
        if (uri.startsWith('http') || uri.startsWith('ipfs')) {
          const url  = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
          const meta = await fetch(url, { signal: AbortSignal.timeout(5000) })
                             .then(r => r.json()).catch(() => null);
          if (meta?.image) imageURI = meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
        } else if (uri.startsWith('data:application/json')) {
          const json = JSON.parse(atob(uri.split(',')[1]));
          if (json?.image) imageURI = json.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }
        t.imageURI = imageURI;
      } catch {}
    }));

    return tokens;
  } catch (e: any) {
    console.warn('[NFT] loadNftsFromContract error:', contractAddr, e.message);
    return [];
  }
}

// ─── NFT Combobox — Auto-Scan ─────────────────────────────────────────────────

// Cache NFT tokens after first scan (cleared on wallet change or after create)
let _walletNftCache: NftToken[] | null = null;
let _walletNftScanInProgress           = false;

/**
 * Scan wallet for all held ERC-721 tokens — 3-tier fallback:
 *  1. Alchemy NFT API for Sepolia (specialized, no public API key needed)
 *  2. On-chain: scan Transfer events (topic[2] = wallet address) via eth_getLogs
 *  3. If both fail → return empty (user enters manually)
 */
/**
 * Scan all ERC-721 NFTs in the wallet on Sepolia.
 *
 * 3-tier strategy:
 *  1. Etherscan Sepolia API  — tokennfttx, free no key needed, returns full history
 *  2. Alchemy NFT API v3     — if VITE_ALCHEMY_KEY is in .env
 *  3. On-chain eth_getLogs   — final fallback, 10k block batches
 *
 * Large token IDs (uint256) handled entirely with BigInt, not Number().
 */
async function scanWalletNFTs(): Promise<NftToken[]> {
  if (!S.wallet) return [];
  if (_walletNftCache) return _walletNftCache;
  if (_walletNftScanInProgress) return [];
  _walletNftScanInProgress = true;

  const addr = S.wallet.address.toLowerCase();

  // Map: contractAddress → Set<tokenId string>
  // Use Map instead of Set to track specific tokenId per contract
  const owned = new Map<string, Set<string>>();

  const addOwned = (contract: string, tokenId: string) => {
    const k = contract.toLowerCase();
    if (!owned.has(k)) owned.set(k, new Set());
    owned.get(k)!.add(tokenId);
  };
  const removeOwned = (contract: string, tokenId: string) => {
    owned.get(contract.toLowerCase())?.delete(tokenId);
  };

  // ────────────────────────────────────────────────────────────────────────────
  // TIER 1: Etherscan Sepolia API — tokennfttx (full history, no API key required)
  // Endpoint: https://api-sepolia.etherscan.io/api?module=account&action=tokennfttx
  // ────────────────────────────────────────────────────────────────────────────
  let etherscanOk = false;
  try {
    const url = `https://api-sepolia.etherscan.io/api` +
      `?module=account&action=tokennfttx` +
      `&address=${addr}` +
      `&startblock=0&endblock=99999999` +
      `&sort=asc&apikey=YourApiKeyToken`;          // default key still works at low rate
    const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const json = await res.json();

    if (json.status === '1' && Array.isArray(json.result)) {
      // Replay full in/out history to determine currently held tokens
      for (const tx of json.result) {
        const contract = (tx.contractAddress as string).toLowerCase();
        const tokenId  = String(tx.tokenID ?? tx.tokenId ?? '');
        if (!tokenId) continue;
        if ((tx.to as string).toLowerCase() === addr) {
          addOwned(contract, tokenId);
        } else if ((tx.from as string).toLowerCase() === addr) {
          removeOwned(contract, tokenId);
        }
      }
      etherscanOk = true;
      console.info(`[NFT] Etherscan: ${json.result.length} tx → ${[...owned.values()].reduce((s,v)=>s+v.size,0)} tokens held`);
    } else {
      console.warn('[NFT] Etherscan returned:', json.message ?? json.status);
    }
  } catch (e) {
    console.warn('[NFT] Etherscan API failed:', (e as any).message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TIER 2: Alchemy NFT API v3 (use if VITE_ALCHEMY_KEY exists or "demo" is still alive)
  // ────────────────────────────────────────────────────────────────────────────
  if (!etherscanOk) {
    const alchemyKey = (import.meta as any).env?.VITE_ALCHEMY_KEY ?? 'demo';
    try {
      let pageKey = '';
      let page    = 0;
      do {
        const url = `https://eth-sepolia.g.alchemy.com/nft/v3/${alchemyKey}/getNFTsForOwner` +
          `?owner=${addr}&withMetadata=true&pageSize=100` +
          (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : '');
        const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const json = await res.json();
        if (!res.ok || !Array.isArray(json.ownedNfts)) break;

        for (const nft of json.ownedNfts) {
          const contract = (nft.contract?.address ?? '').toLowerCase();
          // Alchemy returns tokenId as hex string "0x..."
          const tokenId = nft.tokenId
            ? BigInt(nft.tokenId).toString()       // hex → decimal string, safe
            : '';
          if (contract && tokenId) addOwned(contract, tokenId);
        }
        pageKey = json.pageKey ?? '';
        page++;
      } while (pageKey && page < 10);

      if ([...owned.values()].some(s => s.size > 0)) {
        etherscanOk = true; // reuse flag to mean "found something"
        console.info(`[NFT] Alchemy: ${[...owned.values()].reduce((s,v)=>s+v.size,0)} tokens`);
      }
    } catch (e) {
      console.warn('[NFT] Alchemy failed:', (e as any).message);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TIER 3: On-chain eth_getLogs fallback — 10k block batches, max 50k
  // ────────────────────────────────────────────────────────────────────────────
  if (!etherscanOk) {
    try {
      const provider       = S.wallet.provider;
      const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const paddedAddr     = '0x' + '0'.repeat(24) + addr.slice(2);
      const latestBlock    = await provider.getBlockNumber();
      const SCAN_RANGE = 50000, BATCH_SIZE = 10000;
      const scanFrom   = Math.max(0, latestBlock - SCAN_RANGE);

      for (let from = scanFrom; from <= latestBlock; from += BATCH_SIZE) {
        const to = Math.min(from + BATCH_SIZE - 1, latestBlock);
        try {
          const [logsIn, logsOut] = await Promise.all([
            provider.getLogs({ fromBlock: from, toBlock: to, topics: [TRANSFER_TOPIC, null, paddedAddr] }),
            provider.getLogs({ fromBlock: from, toBlock: to, topics: [TRANSFER_TOPIC, paddedAddr, null] }),
          ]);
          for (const l of logsIn) {
            if (l.topics?.length >= 4) {
              try { addOwned(l.address, BigInt(l.topics[3]).toString()); } catch {}
            }
          }
          for (const l of logsOut) {
            if (l.topics?.length >= 4) {
              try { removeOwned(l.address, BigInt(l.topics[3]).toString()); } catch {}
            }
          }
        } catch { break; }
      }
      console.info(`[NFT] eth_getLogs: ${[...owned.values()].reduce((s,v)=>s+v.size,0)} tokens found`);
    } catch (e) {
      console.warn('[NFT] eth_getLogs failed:', (e as any).message);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // BUILD token list — confirm ownerOf on-chain + fetch metadata in parallel
  // ────────────────────────────────────────────────────────────────────────────
  const allTokens: NftToken[] = [];

  try {
    for (const [contractAddr, tokenIds] of owned.entries()) {
      if (tokenIds.size === 0) continue;
      try {
        const c = new Contract(contractAddr, ERC721_ABI, S.wallet.provider);
        let name = '', symbol = '';
        try { name   = await c.name();   } catch {}
        try { symbol = await c.symbol(); } catch {}

        // Confirm ownership + fetch metadata in parallel
        await Promise.allSettled([...tokenIds].map(async tokenId => {
          try {
            // ownerOf — confirm still held (Etherscan history can be stale)
            const currentOwner = await c.ownerOf(tokenId);
            if (currentOwner.toLowerCase() !== S.wallet!.address.toLowerCase()) return;

            let imageURI = '', tokenURI = '';
            try {
              const uri = await c.tokenURI(tokenId);
              tokenURI  = uri;
              if (uri.startsWith('data:application/json')) {
                const json = JSON.parse(atob(uri.split(',')[1]));
                if (json?.image) imageURI = json.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
              } else if (uri.startsWith('ipfs://') || uri.startsWith('http')) {
                const url  = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
                const meta = await fetch(url, { signal: AbortSignal.timeout(6000) }).then(r => r.json()).catch(() => null);
                if (meta?.image) imageURI = (meta.image as string).replace('ipfs://', 'https://ipfs.io/ipfs/');
              }
            } catch {}

            allTokens.push({ contractAddress: contractAddr, tokenId, name, symbol, imageURI, tokenURI });
          } catch {}
        }));
      } catch (e: any) {
        console.warn('[NFT] contract load error:', contractAddr, e.message);
      }
    }
  } finally {
    _walletNftScanInProgress = false;
  }

  console.info(`[NFT] Scan complete: ${allTokens.length} tokens confirmed`);
  _walletNftCache = allTokens;
  return allTokens;
}

/**
 * Render NFT selection combobox — auto-scans wallet, shows dropdown + thumbnail grid.
 */
async function renderNftCombobox(): Promise<void> {
  const container = document.getElementById('nft-picker-container');
  if (!container) return;

  if (!S.wallet) {
    container.innerHTML = `<div style="font-size:12px;color:var(--text3);padding:8px 0">
      <i class="bi bi-wallet2" style="margin-right:6px"></i>Connect wallet to load your NFTs.</div>`;
    return;
  }

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text3);padding:6px 0">
      <div class="spin-icon" style="width:16px;height:16px;border-width:2px;flex-shrink:0"></div>
      <span id="nft-scan-status">Scanning wallet via Etherscan Sepolia API...</span>
    </div>`;

  const tokens = await scanWalletNFTs();

  if (!tokens.length) {
    container.innerHTML = `
      <div style="font-size:12px;color:var(--text3);padding:8px 10px;line-height:1.7;
        background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--r2)">
        <i class="bi bi-inbox" style="margin-right:6px;color:var(--text4)"></i>
        No NFTs found in your wallet on Sepolia.<br/>
        <span style="color:var(--text4)">
          Switch to the tab <strong style="color:var(--glow)">MANUAL INPUT</strong>
          and enter the contract address and token ID directly.
        </span>
      </div>`;
    return;
  }

  // Group tokens by collection
  const groups: Record<string, NftToken[]> = {};
  for (const t of tokens) {
    const key = `${t.name || 'Unknown'} (${t.symbol || '?'})`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }

  container.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:6px;display:flex;align-items:center;gap:6px">
        <i class="bi bi-collection" style="color:var(--glow)"></i>
        SELECT NFT FROM WALLET
        <span style="background:rgba(0,158,140,0.1);border:1px solid rgba(0,158,140,0.2);border-radius:4px;padding:1px 6px;font-size:9px;color:var(--glow)">${tokens.length} asset</span>
      </div>
      <div style="position:relative">
        <select id="nft-asset-combobox" class="inp" style="font-family:var(--font-mono);font-size:12px">
          <option value="">— Select NFT to auction —</option>
          ${Object.entries(groups).map(([group, toks]) =>
            `<optgroup label="${esc(group)}">
              ${toks.map(t =>
                `<option value="${esc(t.contractAddress)}|${esc(t.tokenId)}" data-img="${esc(t.imageURI)}" data-name="${esc(t.name)}" data-symbol="${esc(t.symbol)}">
                  #${esc(t.tokenId)} — ${esc(t.name)}
                </option>`
              ).join('')}
            </optgroup>`
          ).join('')}
        </select>
        <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text3);font-size:12px">
          <i class="bi bi-chevron-down"></i>
        </span>
      </div>
    </div>

    <div id="nft-selected-preview" style="display:none;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;padding:10px;background:rgba(0,158,140,0.05);border:1px solid rgba(0,158,140,0.18);border-radius:var(--r2)">
        <div id="nft-prev-img" style="width:56px;height:56px;border-radius:var(--r2);overflow:hidden;background:var(--bg3);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:2rem">🖼️</div>
        <div style="min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="nft-prev-name">—</div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--text3);margin-top:2px" id="nft-prev-contract">—</div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--glow);margin-top:1px" id="nft-prev-tokenid">—</div>
        </div>
        <div style="margin-left:auto;flex-shrink:0">
          <a id="nft-prev-etherscan" href="#" target="_blank" rel="noopener"
             style="font-size:10px;color:var(--blue);text-decoration:none;display:flex;align-items:center;gap:4px;white-space:nowrap">
            <i class="bi bi-box-arrow-up-right"></i> On-Chain
          </a>
        </div>
      </div>
    </div>

    <div style="font-size:10px;color:var(--text3);margin-bottom:6px">Or click directly:</div>
    <div class="nft-token-grid" id="nft-combobox-grid">
      ${tokens.map(t => `
        <div class="nft-token-card"
             data-contract="${esc(t.contractAddress)}"
             data-tokenid="${esc(t.tokenId)}"
             data-img="${esc(t.imageURI)}"
             data-name="${esc(t.name)}"
             data-symbol="${esc(t.symbol)}">
          <div class="nft-token-img">
            ${t.imageURI
              ? `<img src="${esc(t.imageURI)}" loading="lazy"
                      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                      style="width:100%;height:100%;object-fit:cover;border-radius:4px"/>
                 <span style="display:none;font-size:1.8rem;align-items:center;justify-content:center;width:100%;height:100%">🖼️</span>`
              : `<span style="font-size:1.8rem;display:flex;align-items:center;justify-content:center;width:100%;height:100%">🖼️</span>`}
          </div>
          <div class="nft-token-id">#${esc(t.tokenId)}</div>
        </div>`).join('')}
    </div>`;

  // Event: combobox changed
  const select = document.getElementById('nft-asset-combobox') as HTMLSelectElement;
  select?.addEventListener('change', () => onNftSelected(select.value, tokens));

  // Event: click grid card
  container.querySelectorAll<HTMLElement>('.nft-token-card').forEach(card => {
    card.addEventListener('click', () => {
      const val = `${card.dataset.contract}|${card.dataset.tokenid}`;
      if (select) select.value = val;
      onNftSelected(val, tokens);
    });
  });
}

/** Handle user selecting an NFT from combobox or clicking grid */
function onNftSelected(value: string, tokens: NftToken[]): void {
  if (!value) {
    document.getElementById('nft-selected-preview')!.style.display = 'none';
    document.querySelectorAll('.nft-token-card').forEach(c => c.classList.remove('selected'));
    (document.getElementById('cf-nft-contract') as HTMLInputElement).value = '';
    (document.getElementById('cf-nft-tokenid')  as HTMLInputElement).value = '';
    return;
  }

  const [contractAddr, tokenId] = value.split('|');
  const token = tokens.find(t => t.contractAddress === contractAddr && t.tokenId === tokenId);

  // Fill hidden fields for handleCreateAuction to read
  (document.getElementById('cf-nft-contract') as HTMLInputElement).value = contractAddr || '';
  (document.getElementById('cf-nft-tokenid')  as HTMLInputElement).value = tokenId || '';

  // Highlight selected card
  document.querySelectorAll<HTMLElement>('.nft-token-card').forEach(c => {
    c.classList.toggle('selected',
      c.dataset.contract === contractAddr && c.dataset.tokenid === tokenId);
  });

  // Update preview panel
  const preview = document.getElementById('nft-selected-preview')!;
  preview.style.display = 'block';

  const imgEl   = document.getElementById('nft-prev-img')!;
  const nameEl  = document.getElementById('nft-prev-name')!;
  const cAddrEl = document.getElementById('nft-prev-contract')!;
  const tIdEl   = document.getElementById('nft-prev-tokenid')!;
  const linkEl  = document.getElementById('nft-prev-etherscan') as HTMLAnchorElement;

  if (token?.imageURI) {
    imgEl.innerHTML = `<img src="${esc(token.imageURI)}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='🖼️'"/>`;
  } else {
    imgEl.innerHTML = '🖼️';
  }
  nameEl.textContent  = token ? `${token.name} #${token.tokenId}` : `Token #${tokenId}`;
  cAddrEl.textContent = contractAddr ? `${contractAddr.slice(0,10)}…${contractAddr.slice(-6)}` : '';
  tIdEl.textContent   = `Token ID: #${tokenId}`;
  if (linkEl) linkEl.href = `https://sepolia.etherscan.io/token/${contractAddr}?a=${tokenId}`;

  // Auto-fill NFT image into preview box above if not already set
  const imgInput   = document.getElementById('cf-img') as HTMLInputElement;
  const previewBox = document.getElementById('img-preview-box');
  if (imgInput && !imgInput.value && token?.imageURI && previewBox) {
    imgInput.value = token.imageURI;
    previewBox.innerHTML = `<img src="${esc(token.imageURI)}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--r2)"/>`;
  }

  // Auto-fill NFT name if name field is empty
  const nameInput = document.getElementById('cf-name') as HTMLInputElement;
  if (nameInput && !nameInput.value && token) {
    nameInput.value = `${token.name} #${token.tokenId}`;
  }

  toast('NFT Selected ✅', `${token?.name || 'Token'} #${tokenId}`, 'ok');
}

/**
 * Initialize NFT combobox — call when create page loads or wallet connects.
 * clearCache=true when wallet changes or after creating an auction.
 */
async function initNftCombobox(clearCache = false): Promise<void> {
  if (clearCache) {
    _walletNftCache          = null;
    _walletNftScanInProgress = false;
  }
  await renderNftCombobox();
}

/**
 * Verify a specific NFT on-chain: ownerOf + tokenURI + metadata
 * Called when user clicks "Verify & Preview NFT" on the manual tab.
 */
async function verifyNft(): Promise<void> {
  if (!S.wallet) { toast('No Wallet', 'Connect your wallet first.', 'err'); return; }

  const contractAddr = (document.getElementById('cf-nft-contract-manual') as HTMLInputElement)?.value.trim();
  const tokenIdRaw   = (document.getElementById('cf-nft-tokenid-manual')  as HTMLInputElement)?.value.trim();

  if (!contractAddr || !/^0x[0-9a-fA-F]{40}$/.test(contractAddr)) {
    toast('Invalid Contract', 'Enter a valid ERC-721 contract address (0x...).', 'err'); return;
  }
  if (!tokenIdRaw) {
    toast('Missing Token ID', 'Enter the Token ID of the NFT.', 'err'); return;
  }

  const btn = document.getElementById('btn-nft-verify') as HTMLButtonElement;
  const prevBtn = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<div class="spin-icon" style="width:14px;height:14px;border-width:2px"></div> Verifying…';

  const preview = document.getElementById('nft-manual-preview') as HTMLElement;
  preview.style.display = 'none';

  try {
    const c = new Contract(contractAddr, ERC721_ABI, S.wallet.provider);

    // 1. Check ownerOf — confirm wallet holds this token
    let ownerOnChain = '';
    try {
      ownerOnChain = await c.ownerOf(tokenIdRaw);
    } catch (e: any) {
      toast('Token Not Found', `Could not locate Token #${tokenIdRaw} on this contract. Double-check the contract address and token ID.\n${e.message?.slice(0,80)}`, 'err');
      btn.disabled = false; btn.innerHTML = prevBtn;
      return;
    }

    const isOwner = ownerOnChain.toLowerCase() === S.wallet.address.toLowerCase();

    // 2. Get name + symbol
    let name = '', symbol = '';
    try { name   = await c.name();   } catch {}
    try { symbol = await c.symbol(); } catch {}

    // 3. Get tokenURI + fetch metadata for image
    let imageURI = '';
    let nftDisplayName = `${name || 'NFT'} #${tokenIdRaw}`;
    try {
      const uri = await c.tokenURI(tokenIdRaw);
      if (uri.startsWith('data:application/json')) {
        // Base64-encoded JSON
        const json = JSON.parse(atob(uri.split(',')[1]));
        if (json?.image) imageURI = json.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
        if (json?.name)  nftDisplayName = json.name;
      } else if (uri.startsWith('ipfs://') || uri.startsWith('http')) {
        const url  = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
        const meta = await fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => null);
        if (meta?.image) imageURI = (meta.image as string).replace('ipfs://', 'https://ipfs.io/ipfs/');
        if (meta?.name)  nftDisplayName = meta.name;
      }
    } catch {}

    // 4. Update hidden inputs (use text to support large token IDs)
    (document.getElementById('cf-nft-contract') as HTMLInputElement).value = contractAddr;
    (document.getElementById('cf-nft-tokenid')  as HTMLInputElement).value = tokenIdRaw;

    // 5. Render preview
    const imgEl    = document.getElementById('nft-mp-img')!;
    const nameEl   = document.getElementById('nft-mp-name')!;
    const collEl   = document.getElementById('nft-mp-collection')!;
    const tidEl    = document.getElementById('nft-mp-tokenid')!;
    const ownEl    = document.getElementById('nft-mp-owner')!;
    const statusEl = document.getElementById('nft-mp-status')!;

    if (imageURI) {
      imgEl.innerHTML = `<img src="${esc(imageURI)}" style="width:100%;height:100%;object-fit:cover"
        onerror="this.parentElement.innerHTML='🖼️'"/>`;
    } else {
      imgEl.innerHTML = '🖼️';
    }
    nameEl.textContent  = nftDisplayName;
    collEl.textContent  = `${name}${symbol ? ' (' + symbol + ')' : ''} · ${contractAddr.slice(0,10)}…${contractAddr.slice(-6)}`;
    tidEl.textContent   = `Token ID: ${tokenIdRaw}`;
    ownEl.textContent   = isOwner
      ? `✅ This token belongs to your wallet`
      : `⚠️ Owner: ${ownerOnChain.slice(0,10)}…${ownerOnChain.slice(-6)} — NOT your wallet!`;
    statusEl.textContent = isOwner ? '✅' : '⚠️';

    preview.style.display = 'flex';

    // Auto-fill image into preview box and name if not already filled
    const imgInput   = document.getElementById('cf-img') as HTMLInputElement;
    const previewBox = document.getElementById('img-preview-box');
    if (imgInput && !imgInput.value && imageURI && previewBox) {
      imgInput.value = imageURI;
      previewBox.innerHTML = `<img src="${esc(imageURI)}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--r2)"/>`;
    }
    const nameInput = document.getElementById('cf-name') as HTMLInputElement;
    if (nameInput && !nameInput.value) nameInput.value = nftDisplayName;

    if (!isOwner) {
      toast('Not Your NFT', 'This token does not belong to your wallet. You may continue but the tx will fail.', 'err');
    } else {
      toast('NFT Verified ✅', `${nftDisplayName}`, 'ok');
    }
  } catch (e: any) {
    toast('Verify Failed', e.message?.slice(0, 100) ?? 'An unexpected error occurred', 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = prevBtn;
  }
}

/**
 * Initialize tab switcher for NFT picker (Manual / Auto-scan)
 */
function initNftTabs(): void {
  const tabManual = document.getElementById('nft-tab-manual');
  const tabScan   = document.getElementById('nft-tab-scan');
  const panelManual = document.getElementById('nft-panel-manual');
  const panelScan   = document.getElementById('nft-panel-scan');
  if (!tabManual || !tabScan) return;

  const activate = (tab: 'manual' | 'scan') => {
    const isManual = tab === 'manual';
    tabManual.style.background     = isManual ? 'rgba(0,158,140,0.12)' : 'transparent';
    tabManual.style.borderColor    = isManual ? 'var(--glow)' : 'var(--border)';
    tabManual.style.color          = isManual ? 'var(--glow)' : 'var(--text3)';
    tabScan.style.background       = !isManual ? 'rgba(0,158,140,0.12)' : 'transparent';
    tabScan.style.borderColor      = !isManual ? 'var(--glow)' : 'var(--border)';
    tabScan.style.color            = !isManual ? 'var(--glow)' : 'var(--text3)';
    if (panelManual) panelManual.style.display = isManual ? 'block' : 'none';
    if (panelScan)   panelScan.style.display   = !isManual ? 'block' : 'none';

    // When switching to scan tab → trigger scan if no cache yet
    if (!isManual && S.wallet) void initNftCombobox();
  };

  tabManual.addEventListener('click', () => activate('manual'));
  tabScan.addEventListener('click',   () => activate('scan'));
}

/** Approve NFT for the auction contract before creating */
async function approveNftForContract(nftContractAddr: string, tokenId: string): Promise<boolean> {
  if (!S.wallet) return false;
  try {
    // Always parse tokenId to BigInt — avoid errors if auto-scan returns hex string
    let tokenIdBig: bigint;
    try {
      tokenIdBig = BigInt(tokenId);
    } catch {
      toast('Invalid Token ID', `Invalid Token ID: "${tokenId}"`, 'err');
      return false;
    }

    console.info('[NFT] approveNftForContract:', { nftContractAddr, tokenId, tokenIdBig: tokenIdBig.toString() });

    const nftC = new Contract(nftContractAddr, ERC721_ABI, S.wallet.signer);

    // ── Step 0: confirm wallet actually owns the token ────────────────────
    try {
      const onchainOwner: string = await nftC.ownerOf(tokenIdBig);
      console.info('[NFT] ownerOf =', onchainOwner, '| wallet =', S.wallet.address);
      if (onchainOwner.toLowerCase() !== S.wallet.address.toLowerCase()) {
        toast('Not Your NFT', `Token #${tokenId} is currently owned by ${onchainOwner.slice(0,10)}… — not your wallet.`, 'err');
        return false;
      }
    } catch (ownerErr: any) {
      console.warn('[NFT] ownerOf check failed:', ownerErr.message);
      // Continue — some contracts do not implement ownerOf correctly
    }

    // ── Step 1: check isApprovedForAll ────────────────────────────────
    let approvedForAll = false;
    try {
      approvedForAll = await nftC.isApprovedForAll(S.wallet.address, CONTRACT_ADDRESS);
      console.info('[NFT] isApprovedForAll =', approvedForAll);
    } catch {}

    if (approvedForAll) {
      console.info('[NFT] isApprovedForAll = true, skipping approve');
      return true;
    }

    // ── Step 2: check single-token approval ───────────────────────────
    let currentApproval = '';
    try {
      currentApproval = (await nftC.getApproved(tokenIdBig)).toLowerCase();
      console.info('[NFT] getApproved =', currentApproval, '| need =', CONTRACT_ADDRESS.toLowerCase());
    } catch {}

    if (currentApproval === CONTRACT_ADDRESS.toLowerCase()) {
      console.info('[NFT] Already approved — skipping');
      return true;
    }

    // ── Step 3: try approve(tokenId) first, fallback to setApprovalForAll ──
    showTxOverlay('Approve NFT', `Approving Token #${tokenId} — confirm in MetaMask…`);

    let approveOk = false;
    try {
      const tx = await nftC.approve(CONTRACT_ADDRESS, tokenIdBig);
      showTxOverlay('Waiting for Approval Tx', `Tx: ${tx.hash.slice(0, 20)}… — confirming on-chain…`);
      await tx.wait(1);
      approveOk = true;
      console.info('[NFT] approve(tokenId) success');
    } catch (approveErr: any) {
      // Some NFT contracts (OpenSea Shared Storefront, custom contracts) do not support
      // single approve() → fallback to setApprovalForAll
      console.warn('[NFT] approve(tokenId) failed, trying setApprovalForAll:', approveErr.message);
      showTxOverlay('Approve All NFTs', `approve() failed — trying setApprovalForAll… confirm in MetaMask`);
      try {
        const tx2 = await nftC.setApprovalForAll(CONTRACT_ADDRESS, true);
        showTxOverlay('Waiting for Approval Tx', `Tx: ${tx2.hash.slice(0, 20)}… — confirming on-chain…`);
        await tx2.wait(1);
        approveOk = true;
        console.info('[NFT] setApprovalForAll success');
      } catch (allErr: any) {
        throw new Error(`Approval failed: ${approveErr.reason ?? approveErr.message?.slice(0,60)}`);
      }
    }

    if (!approveOk) return false;

    // ── Step 4: confirm approval on-chain ────────────────────────────
    try {
      const [confirmedApprove, confirmedAll] = await Promise.all([
        nftC.getApproved(tokenIdBig).catch(() => ''),
        nftC.isApprovedForAll(S.wallet.address, CONTRACT_ADDRESS).catch(() => false),
      ]);
      const isConfirmed =
        (confirmedApprove as string).toLowerCase() === CONTRACT_ADDRESS.toLowerCase() || confirmedAll;
      console.info('[NFT] Post-approve check:', { confirmedApprove, confirmedAll, isConfirmed });
      if (!isConfirmed) {
        console.warn('[NFT] Approval not confirmed on-chain — proceeding anyway');
      }
    } catch {}

    toast('NFT Approved ✅', `Token #${tokenId} is now approved for transfer.`, 'ok');
    return true;
  } catch (e: any) {
    hideTxOverlay();
    console.error('[NFT] approveNftForContract error:', e);
    toast('Approve Failed', e.reason ?? e.message?.slice(0, 120) ?? 'Error', 'err');
    return false;
  }
}

/**
 * Upload auction image to Firebase Storage.
 *  - img is a data: URL (base64)  →  upload → return short Firebase download URL
 *  - img is already https:// or empty  →  return as-is, no upload
 * Path: auction-images/{timestamp}_{random}.{ext}
 */
async function uploadAuctionImage(img: string): Promise<string> {
  if (!img || !img.startsWith('data:')) return img;
  if (!FB_CONFIGURED) {
    console.warn('[Storage] Firebase not configured — skipping image upload');
    return '';
  }
  try {
    const mime = img.match(/^data:([^;]+);base64,/)?.[1] ?? 'image/jpeg';
    const ext  = mime.split('/')[1]?.replace('jpeg','jpg') ?? 'jpg';
    const path = `auction-images/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const ref  = storageRef(fbStorage, path);
    await uploadString(ref, img, 'data_url');
    const url  = await getDownloadURL(ref);
    console.info('[Storage] Upload OK:', url);
    return url;
  } catch (e: any) {
    console.warn('[Storage] Upload failed (non-fatal):', e.message);
    return '';   // do not block auction creation — image will just be missing
  }
}

async function handleCreateAuction(): Promise<void> {
  // ── Step 1: validate all form fields BEFORE touching the wallet ─────────
  const name   = (document.getElementById('cf-name')    as HTMLInputElement).value.trim();
  const desc   = (document.getElementById('cf-desc')    as HTMLTextAreaElement).value.trim();
  const price  = parseFloat((document.getElementById('cf-price')   as HTMLInputElement).value || '0');
  const bidHrs = parseFloat((document.getElementById('cf-bid-hrs') as HTMLInputElement).value || '0');

  // Start date (optional) — blank means start immediately after deployment
  const sdInputEl = document.getElementById('cf-start-date') as HTMLInputElement | null;
  const startDateVal = sdInputEl?.value || '';
  // Detect partial input: user typed a date but browser rejected it (no time → value="" but
  // the raw text in the input box is non-empty). valueAsNumber is NaN in that case too, but
  // the element's validity state will be invalid, which we use as the signal.
  if (sdInputEl && sdInputEl.value === '' && sdInputEl.validity && !sdInputEl.validity.valid && sdInputEl.validationMessage) {
    // Browser says the field has content but it's incomplete (e.g. only date, no time)
    toast('Incomplete Start Date', 'Please enter both date AND time (hh:mm).', 'err');
    sdInputEl.style.borderColor = 'var(--red)';
    sdInputEl.style.boxShadow = '0 0 0 2px rgba(220,50,50,0.25)';
    sdInputEl.focus();
    sdInputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { sdInputEl.style.borderColor = ''; sdInputEl.style.boxShadow = ''; }, 4000);
    const sdHint = document.getElementById('start-date-hint');
    if (sdHint) { sdHint.textContent = '⚠ Please enter both date and time (e.g. 25/06/2025 14:30).'; sdHint.style.color = 'var(--red)'; }
    return;
  }
  let biddingStartTs: number | undefined;
  if (startDateVal) {
    const parsed = new Date(startDateVal).getTime();
    if (isNaN(parsed)) {
      toast('Invalid Start Date', 'Start date is invalid.', 'err');
      const sdEl = document.getElementById('cf-start-date') as HTMLInputElement | null;
      if (sdEl) { sdEl.style.borderColor = 'var(--red)'; sdEl.style.boxShadow = '0 0 0 2px rgba(220,50,50,0.25)'; sdEl.focus(); sdEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      const sdHint = document.getElementById('start-date-hint');
      if (sdHint) { sdHint.textContent = 'Start date is invalid.'; sdHint.style.color = 'var(--red)'; }
      return;
    }
    biddingStartTs = Math.floor(parsed / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    if (biddingStartTs <= nowSec) {
      toast('Start Date in the Past', 'Start date must be in the future. Please pick a later date and time.', 'err');
      const sdEl = document.getElementById('cf-start-date') as HTMLInputElement | null;
      if (sdEl) {
        sdEl.style.borderColor = 'var(--red)';
        sdEl.style.boxShadow = '0 0 0 2px rgba(220,50,50,0.25)';
        sdEl.focus();
        sdEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => { sdEl.style.borderColor = ''; sdEl.style.boxShadow = ''; }, 4000);
      }
      const sdHint = document.getElementById('start-date-hint');
      if (sdHint) { sdHint.textContent = '⚠ Start date cannot be in the past. Please choose a future date and time.'; sdHint.style.color = 'var(--red)'; }
      return;
    }
    if (biddingStartTs <= nowSec + 60) {
      toast('Start Date Too Soon', 'Start date must be at least 1 minute in the future.', 'err');
      const sdEl = document.getElementById('cf-start-date') as HTMLInputElement | null;
      if (sdEl) {
        sdEl.style.borderColor = 'var(--red)';
        sdEl.style.boxShadow = '0 0 0 2px rgba(220,50,50,0.25)';
        sdEl.focus();
        sdEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => { sdEl.style.borderColor = ''; sdEl.style.boxShadow = ''; }, 4000);
      }
      const sdHint = document.getElementById('start-date-hint');
      if (sdHint) { sdHint.textContent = '⚠ Start date must be at least 1 minute in the future.'; sdHint.style.color = 'var(--red)'; }
      return;
    }
    const maxFuture = nowSec + 90 * 24 * 3600;
    if (biddingStartTs > maxFuture) {
      toast('Start Date Too Far', 'Start date cannot be more than 90 days from now.', 'err');
      return;
    }
  }

  // NFT fields
  const nftContractAddr = (document.getElementById('cf-nft-contract') as HTMLInputElement)?.value.trim() || '';
  const nftTokenIdStr   = (document.getElementById('cf-nft-tokenid')  as HTMLInputElement)?.value.trim() || '';

  if (!nftContractAddr || !/^0x[0-9a-fA-F]{40}$/.test(nftContractAddr)) {
    toast('Missing NFT Contract', 'Enter a valid ERC-721 contract address.', 'err');
    return;
  }
  // Use BigInt for validation — Number() lacks precision for large token IDs (>53 bits)
  let _nftTokenIdBig: bigint;
  try {
    if (!nftTokenIdStr) throw new Error('empty');
    _nftTokenIdBig = BigInt(nftTokenIdStr);
    if (_nftTokenIdBig < 0n) throw new Error('negative');
  } catch {
    toast('Invalid Token ID', 'Token ID must be a non-negative integer.', 'err');
    return;
  }

  const bidDurationSecs = Math.floor(bidHrs * 3600);
  if (!name || price <= 0 || bidDurationSecs < 60) {
    toast('Missing Fields', 'Fill in all required fields. Minimum bid duration is 60 seconds (0.017 hours).', 'err');
    return;
  }

  // Validate whitelist for private auctions
  const activeTypeBtnV = document.querySelector<HTMLElement>('.type-btn.active');
  if (activeTypeBtnV?.dataset.type === 'private') {
    const wlRaw = (document.getElementById('cf-whitelist') as HTMLTextAreaElement)?.value || '';
    const wlValid = wlRaw.split('\n').map(s => s.trim()).filter(s => /^0x[0-9a-fA-F]{40}$/.test(s));
    if (wlValid.length === 0) {
      toast('No Whitelist', 'Private auction requires at least 1 valid wallet address.', 'err');
      return;
    }
  }

  // ── Step 2: wallet check (only after all fields are valid) ─────────────
  if (!S.wallet) {
    // Mark pending then trigger connect — will re-invoke after connect
    (window as any)._pendingCreate = true;
    await handleWalletClick();
    return;
  }

  const btn = document.getElementById('btn-create-auction') as HTMLButtonElement;
  btn.disabled = true;
  btn.innerHTML = '<div class="spin-icon"></div> Deploying…';

  try {
    const now = Math.floor(Date.now() / 1000);
    // Generate random ID: prefix SB + 6 random alphanumeric chars + timestamp suffix
    function genRandomAuctionId(): string {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let r = 'SB-';
      for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
      return r;
    }
    let auctionId: number | string = genRandomAuctionId();
    let txHash = '';

    if (!S.wallet.contract) {
      toast('Contract Error', 'Could not connect to the smart contract. Please reconnect your wallet.', 'err');
      btn.disabled = false;
      btn.innerHTML = '🚀 Deploy Sealed Auction';
      return;
    }

    // Step 2b: No image upload (feature removed)
    let imgUrl = '';   // No image upload from form

    // Step 3a: Verify NFT ownership (allow already-escrowed NFT)
    showTxOverlay('Checking NFT', `Verifying ownership of Token #${nftTokenIdStr}…`);
    let nftAlreadyInContract = false;
    try {
      const nftCheckC = new Contract(nftContractAddr, ERC721_ABI, S.wallet.provider);
      const ownerOnChain = (await nftCheckC.ownerOf(BigInt(nftTokenIdStr))).toLowerCase();
      const myAddr       = S.wallet.address.toLowerCase();
      const contractAddr = CONTRACT_ADDRESS.toLowerCase();

      if (ownerOnChain === contractAddr) {
        // NFT already transferred into the auction contract from a previous
        // session — skip approve, go straight to createAuction()
        nftAlreadyInContract = true;
        toast('NFT already in contract', 'Skipping approve — proceeding to create auction.', 'info');
      } else if (ownerOnChain !== myAddr) {
        hideTxOverlay();
        toast('Not Your NFT', `Token #${nftTokenIdStr} is owned by ${ownerOnChain.slice(0,10)}… — not your wallet.`, 'err');
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-rocket-takeoff"></i> Deploy Sealed Auction';
        return;
      }
    } catch (e: any) {
      hideTxOverlay();
      toast('NFT Check Failed', e.message?.slice(0, 80) ?? 'Unable to verify NFT.', 'err');
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-rocket-takeoff"></i> Deploy Sealed Auction';
      return;
    }

    // Step 3b: Approve NFT (skip if already escrowed)
    if (!nftAlreadyInContract) {
      const approved = await approveNftForContract(nftContractAddr, nftTokenIdStr);
      if (!approved) {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-rocket-takeoff"></i> Deploy Sealed Auction';
        return;
      }
    }

    // Step 3c: Manual pre-checks then call createAuction on-chain
    // NOTE: Do not use staticCall — safeTransferFrom is a side-effect on the NFT contract
    // → staticCall always reverts with data=null. Use manual pre-checks instead.
    showTxOverlay('Pre-flight Check', 'Checking approval and contract conditions…');

    const priceWei = parseEther(price.toString());
    const tokenIdBig = BigInt(nftTokenIdStr);

    // Check 1: startPrice > 0 (already validated above, double-check)
    if (priceWei === 0n) {
      hideTxOverlay();
      toast('Invalid Price', 'Start price must be > 0 ETH.', 'err');
      btn.disabled = false; btn.innerHTML = '🚀 Deploy Sealed Auction'; return;
    }

    // Check 2: on-chain approval still valid
    try {
      const nftPreCheck = new Contract(nftContractAddr, ERC721_ABI, S.wallet.provider);
      // Run in parallel, catch individually to avoid blocking
      const [approvedAddr, approvedForAll] = await Promise.all([
        nftPreCheck.getApproved(tokenIdBig).catch(() => ''),
        nftPreCheck.isApprovedForAll(S.wallet.address, CONTRACT_ADDRESS).catch(() => false),
      ]);
      const isApproved = approvedForAll ||
        (approvedAddr as string).toLowerCase() === CONTRACT_ADDRESS.toLowerCase();

      console.info('[createAuction] approval check:', { approvedAddr, approvedForAll, isApproved });

      if (!isApproved && !nftAlreadyInContract) {
        hideTxOverlay();
        toast('Not Approved', 'NFT not yet approved. Please retry to approve.', 'err');
        btn.disabled = false; btn.innerHTML = '<i class="bi bi-rocket-takeoff"></i> Deploy Sealed Auction'; return;
      }
    } catch (preErr: any) {
      // Non-fatal — some NFT contracts do not implement getApproved correctly
      console.warn('[createAuction] pre-check error (non-fatal):', preErr.message);
    }

    showTxOverlay('Awaiting Signature', 'Confirm createAuction() in MetaMask — NFT will be escrowed into the contract...');
    // Signature: createAuction(address,uint256,uint256,uint8,string,string,string,uint256,uint256)
    const tx = await S.wallet.contract.createAuction(
      nftContractAddr,
      tokenIdBig,
      1n,               // nftAmount = 1 (ERC721)
      0,                // nftType = 0 (ERC721)
      name, desc, imgUrl,   // imgUrl = Firebase Storage URL (not base64)
      priceWei,
      BigInt(bidDurationSecs),
    );
    txHash = tx.hash;
    showTxOverlay('Broadcasting…', `Tx: ${txHash.slice(0, 20)}… — NFT is being transferred to the contract...`);
    const receipt = await tx.wait();

    // Parse auctionId from AuctionCreated event
    const iface = new Interface(CONTRACT_ABI);
    let onChainId: number | null = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'AuctionCreated') {
          onChainId = Number(parsed.args.auctionId);
          auctionId = onChainId; // use on-chain numeric ID as primary
        }
      } catch {}
    }

    // Step 4: save data to Firebase
    const auctionData: Omit<Auction, '_fbKey'> = {
      id:              auctionId,
      itemName:        name,
      itemDescription: desc,
      itemImageURI:    imgUrl,  // Firebase Storage URL — synced with on-chain
      startPrice:      price.toString(),
      owner:           S.wallet.address,
      biddingEnd:      (biddingStartTs ?? now) + bidDurationSecs,
      biddingStart:    biddingStartTs,   // undefined = start immediately
      // revealEnd removed
      totalBidders:    0,
      phase:           0,
      finalized:       false,
      itemClaimed:     false,
      winner:          '',
      winningBid:      '0',
      createdAt:       Date.now(),
      nftContract:     nftContractAddr,
      tokenId:         nftTokenIdStr,
      nftAmount:       1,
      nftType:         0,
    };

    // Read auction type and whitelist from UI controls
    const activeTypeBtn = document.querySelector<HTMLElement>('.type-btn.active');
    const auctionTypeVal: 'public' | 'private' =
      (activeTypeBtn?.dataset.type === 'private') ? 'private' : 'public';
    const whitelistRaw = (document.getElementById('cf-whitelist') as HTMLTextAreaElement)?.value || '';
    const whitelistAddrs: string[] = whitelistRaw
      .split('\n')
      .map(s => s.trim())
      .filter(s => /^0x[0-9a-fA-F]{40}$/.test(s))
      .map(s => s.toLowerCase());

    await fbWrite('auctions/' + auctionId, {
      ...auctionData,
      auctionType:  auctionTypeVal,
      whitelist:    auctionTypeVal === 'private' ? whitelistAddrs : [],
      isPrivate:    auctionTypeVal === 'private',
      nftContract:  nftContractAddr,
      tokenId:      nftTokenIdStr,
      txHash,
    });

    await fbPush('activity', {
      type:   'create',
      text:   'Auction Created',
      color:  'purple',
      icon:   '🏷️',
      detail: `${shortAddr(S.wallet.address)} created "${name}" · min ${price} ETH`,
      ts:     Date.now(),
      txHash,
      walletAddr: S.wallet.address.toLowerCase(),
      auctionName: name,
      amount: price,
    });

    // Update user profile in Firebase
    const addr = S.wallet.address.toLowerCase();
    const user = await fbRead(`users/${addr}`);
    if (user) {
      await fbUpdate(`users/${addr}`, {
        auctionsCreated: (user.auctionsCreated || 0) + 1,
        lastActivity:    Date.now(),
      });
    } else {
      // User does not exist yet — create new profile
      await fbWrite(`users/${addr}`, {
        address:         S.wallet.address,
        joinedAt:        Date.now(),
        lastSeen:        Date.now(),
        totalBids:       0,
        auctionsWon:     0,
        totalSpent:      '0',
        totalWon:        '0',
        auctionsCreated: 1,
        lastActivity:    Date.now(),
      });
    }

    // Show oracle estimate and reset form
    showCreateOracle(name, price);
    hideTxOverlay();
    toast('Auction Created! 🎉', `"${name}" is live on Sepolia.${txHash ? ' Tx: ' + txHash.slice(0, 14) + '…' : ''}`, 'ok');
    navigate('auctions');

    // Reset form fields
    (['cf-name','cf-desc','cf-price','cf-bid-hrs','cf-start-date','cf-nft-contract','cf-nft-tokenid'] as const).forEach(fid => {
      const el = document.getElementById(fid) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el) el.value = '';
    });
    (document.getElementById('cf-img') as HTMLInputElement | null)?.setAttribute('value', '');
    const fileInput = document.getElementById('cf-img-file') as HTMLInputElement | null;
    if (fileInput) fileInput.value = '';
    // Reset auction type to public
    document.querySelectorAll<HTMLElement>('.type-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('type-btn-public')?.classList.add('active');
    (document.getElementById('whitelist-row') as HTMLElement | null)!.style.display = 'none';
    (document.getElementById('cf-whitelist') as HTMLTextAreaElement | null)!.value = '';
    (document.getElementById('whitelist-count') as HTMLElement | null)!.textContent = '0 addresses';
    // Reset NFT picker — clear cache and re-scan (token just transferred out)
    _walletNftCache = null;
    await initNftCombobox(true);
    const previewBox = document.getElementById('img-preview-box') as HTMLElement | null;
    if (previewBox) previewBox.innerHTML = `
      <i class="bi bi-cloud-upload" style="font-size:2.4rem;color:var(--text3)"></i>
      <span style="font-size:13px;color:var(--text3)">Click or drag &amp; drop image here</span>
      <span style="font-size:10px;color:var(--text3);opacity:0.6">PNG, JPG, GIF, WebP — max 5MB</span>`;

  } catch (e: any) {
    hideTxOverlay();
    // Get the clearest revert reason available
    const reason =
      e.reason ??
      e.error?.reason ??
      e.data?.message ??
      e.shortMessage ??
      e.message?.replace('missing revert data', 'NFT not approved or you are not the owner — verify the NFT contract address and token ID') ??
      'Unknown error';
    console.error('[createAuction] failed:', e);
    toast('Create Failed', reason.slice(0, 160), 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🚀 Deploy Sealed Auction';
  }
}

function showCreateOracle(name: string, price: number): void {
  const box      = document.getElementById('oracle-box')!;
  const body     = document.getElementById('oracle-body')!;
  const estimate = (price * 2.2).toFixed(5).replace(/\.?0+$/, '');
  box.style.display = 'block';
  body.innerHTML = `
    <div style="margin-bottom:6px">🤖 Based on similar items, expected winning bid: <strong style="color:var(--glow)">${estimate} ETH</strong></div>
    <div style="font-size:11px;color:var(--text3)">Set your min bid lower to attract more bidders, or higher to signal premium value.</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MY BIDS PAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * My Bids data sources (in priority order):
 *  1. Firebase collection "bids" — queried by connected wallet address
 *  2. on-chain getBid() — used when Firebase is unavailable or offline
 *  3. S.localSecrets — last resort fallback (localStorage)
 *
 * Each bid entry is merged with auction data from S.auctions to determine:
 *  - Status: BIDDING / ENDED / WON / LOST
 *  - Actual bid amount (on-chain > Firebase > local)
 */

// Cache of bids loaded from Firebase/on-chain, keyed by auctionKey
const _mbBidCache: Record<string, { amount: string; refunded: boolean; ts: number; source: 'chain'|'fb'|'local' }> = {};

async function syncMyBidsFromFirebase(): Promise<void> {
  if (!S.wallet || !FB_CONFIGURED) return;
  try {
    const addrLower = S.wallet.address.toLowerCase();
    const addrOrig  = S.wallet.address;

    // Firestore does not support case-insensitive queries — query both cases
    const [snap1, snap2] = await Promise.all([
      getDocs(query(collection(db, 'bids'), where('address', '==', addrOrig))),
      getDocs(query(collection(db, 'bids'), where('address', '==', addrLower))),
    ]);

    const seenIds = new Set<string>();
    const allDocs: Array<{ id: string; data: () => any }> = [];
    for (const d of [...snap1.docs, ...snap2.docs]) {
      if (!seenIds.has(d.id)) { seenIds.add(d.id); allDocs.push(d); }
    }
    if (!allDocs.length) return;

    let changed = false;
    allDocs.forEach(d => {
      const data  = d.data();
      const docId = d.id; // format: "{auctionKey}_{addrLower}"
      const addrSuffix = '_' + addrLower;
      const auctionKey = docId.endsWith(addrSuffix)
        ? docId.slice(0, docId.length - addrSuffix.length)
        : docId.slice(0, docId.lastIndexOf('_0x'));
      if (!auctionKey) return;

      const amt = data.amountEth || '0';
      const ts  = typeof data.ts === 'number' ? data.ts : Date.now();
      const refunded = !!data.refunded;

      // Update cache
      const existing = _mbBidCache[auctionKey];
      if (!existing || existing.source !== 'chain') {
        _mbBidCache[auctionKey] = { amount: amt, refunded, ts, source: 'fb' };
      }

      // Sync into localSecrets if not already present
      if (!S.localSecrets[auctionKey]) {
        S.localSecrets[auctionKey] = { amount: amt, nonce: '', commitment: '', ts };
        changed = true;
      }
    });

    if (changed) {
      localStorage.setItem(LS_SECRETS, JSON.stringify(S.localSecrets));
    }

    renderMyBids();
  } catch (e: any) {
    console.warn('[MyBids] syncFromFirebase error:', e.message);
  }
}

/**
 * Sync bid amounts directly from on-chain getBid() for all auctions this wallet has bid on.
 * Run after syncMyBidsFromFirebase to get the most accurate data.
 */
async function syncMyBidsOnChain(): Promise<void> {
  if (!S.wallet?.contract) return;
  try {
    const myAddr = S.wallet.address;
    // Only check auctions with numeric IDs (on-chain)
    const onchainAuctions = S.auctions.filter(a => a.id && !isNaN(Number(a.id)));
    if (!onchainAuctions.length) return;

    const checks = onchainAuctions.map(async a => {
      try {
        const contractId = Number(a.id);
        const bid = await S.wallet!.contract.getBid(contractId, myAddr);
        const amt = parseFloat(formatEther(bid.amount));
        if (amt > 0) {
          const key = a._fbKey || String(a.id);
          _mbBidCache[key] = {
            amount: formatEther(bid.amount),
            refunded: bid.refunded,
            ts: _mbBidCache[key]?.ts || Date.now(),
            source: 'chain',
          };
          // Sync into localSecrets
          if (!S.localSecrets[key] || parseFloat(S.localSecrets[key].amount) !== amt) {
            S.localSecrets[key] = {
              amount: formatEther(bid.amount),
              nonce: S.localSecrets[key]?.nonce || '',
              commitment: S.localSecrets[key]?.commitment || '',
              ts: S.localSecrets[key]?.ts || Date.now(),
            };
          }
        }
      } catch {}
    });
    await Promise.allSettled(checks);
    localStorage.setItem(LS_SECRETS, JSON.stringify(S.localSecrets));
    renderMyBids();
  } catch (e: any) {
    console.warn('[MyBids] syncOnChain error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIE-LOSS INFO CACHE
//  Maps auctionFbKey → { winnerAddr, winnerCommitTs, isTie }
//  Populated lazily when a "Lost" card is rendered and my bid = winning bid.
// ─────────────────────────────────────────────────────────────────────────────
const _tieLossCache: Record<string, { winnerAddr: string; winnerCommitTs: number; isTie: boolean }> = {};

/**
 * Fetch the winner's bid record from Firebase to get their commitTimestamp.
 * Used to show "Lost because winner committed at HH:MM:SS" on tie-loss cards.
 */
async function fetchWinnerCommitInfo(fbKey: string, winnerAddr: string): Promise<void> {
  if (_tieLossCache[fbKey]) return; // already cached
  if (!FB_CONFIGURED || !winnerAddr || winnerAddr === '0x0000000000000000000000000000000000000000') return;
  try {
    const data = await fbRead(`bids/${fbKey}/${winnerAddr.toLowerCase()}`);
    if (!data) return;
    _tieLossCache[fbKey] = {
      winnerAddr,
      winnerCommitTs: data.commitTimestamp || data.ts || 0,
      isTie: true,
    };
    // Re-render My Bids so the card updates with tie info
    if (document.getElementById('page-bids')?.classList.contains('active')) {
      renderMyBids();
    }
  } catch {}
}

function renderMyBids(): void {
  const el    = document.getElementById('mybids-list')!;
  const pagEl = document.getElementById('mybids-pagination')!;

  if (!S.wallet) {
    el.innerHTML = `<div class="empty"><div class="empty-ico">🔐</div>
      <div class="empty-title">Connect wallet to see your bids</div>
      <button class="btn btn-primary" style="margin-top:1rem" id="mybids-connect-btn">Connect Wallet</button></div>`;
    pagEl.style.display = 'none';
    document.getElementById('mybids-connect-btn')?.addEventListener('click', handleWalletClick);
    return;
  }

  // ── Render filter bar (once) ──
  let filterBar = document.getElementById('mb-filter-bar');
  if (!filterBar) {
    const header = document.querySelector('#page-mybids .page-header');
    if (header) {
      const bar = document.createElement('div');
      bar.id = 'mb-filter-bar';
      bar.className = 'mb-filter-bar';
      bar.innerHTML = `
        <div class="mb-filter-left">
          <div class="mb-filter-tabs" id="mb-filter-tabs">
            <button class="mb-ftab active" data-f="all">All <span class="mb-badge" id="mb-badge-all">0</span></button>
            <button class="mb-ftab" data-f="active">Bidding <span class="mb-badge" id="mb-badge-active">0</span></button>
            <button class="mb-ftab" data-f="ended">Ended <span class="mb-badge" id="mb-badge-ended">0</span></button>
            <button class="mb-ftab" data-f="won">Won <span class="mb-badge" id="mb-badge-won">0</span></button>
            <button class="mb-ftab" data-f="lost">Lost <span class="mb-badge" id="mb-badge-lost">0</span></button>
            <button class="mb-ftab" data-f="created">My Auctions <span class="mb-badge" id="mb-badge-created">0</span></button>
          </div>
        </div>
        <div class="mb-filter-right">
          <div class="mb-search-wrap">
            <i class="bi bi-search mb-search-ico"></i>
            <input class="mb-search-inp" id="mb-search-inp" placeholder="Search auction name…" value="${esc(S.mbSearch)}"/>
            <button class="mb-search-clear" id="mb-search-clear" style="${S.mbSearch ? '' : 'display:none'}">
              <i class="bi bi-x"></i>
            </button>
          </div>
          <div class="mb-sort-wrap">
            <i class="bi bi-arrow-down-up" style="font-size:12px;color:var(--text3)"></i>
            <select class="mb-sort-sel" id="mb-sort-sel">
              <option value="newest" ${S.mbSort==='newest'?'selected':''}>Newest</option>
              <option value="oldest" ${S.mbSort==='oldest'?'selected':''}>Oldest</option>
              <option value="amount_high" ${S.mbSort==='amount_high'?'selected':''}>Highest Bid</option>
              <option value="amount_low" ${S.mbSort==='amount_low'?'selected':''}>Lowest Bid</option>
            </select>
          </div>
        </div>`;
      header.insertAdjacentElement('afterend', bar);

      bar.querySelectorAll<HTMLElement>('.mb-ftab').forEach(btn => {
        btn.addEventListener('click', () => {
          S.mbFilter = btn.dataset.f as typeof S.mbFilter;
          S.mbPage = 1;
          renderMyBids();
        });
      });
      document.getElementById('mb-search-inp')?.addEventListener('input', (e) => {
        S.mbSearch = (e.target as HTMLInputElement).value;
        S.mbPage = 1;
        const clr = document.getElementById('mb-search-clear');
        if (clr) clr.style.display = S.mbSearch ? '' : 'none';
        renderMyBids();
      });
      document.getElementById('mb-search-clear')?.addEventListener('click', () => {
        S.mbSearch = '';
        S.mbPage = 1;
        (document.getElementById('mb-search-inp') as HTMLInputElement).value = '';
        const clr = document.getElementById('mb-search-clear');
        if (clr) clr.style.display = 'none';
        renderMyBids();
      });
      document.getElementById('mb-sort-sel')?.addEventListener('change', (e) => {
        S.mbSort = (e.target as HTMLSelectElement).value as typeof S.mbSort;
        S.mbPage = 1;
        renderMyBids();
      });
    }
    filterBar = document.getElementById('mb-filter-bar');
  }

  // Sync active tab
  filterBar?.querySelectorAll<HTMLElement>('.mb-ftab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.f === S.mbFilter);
  });

  // ── Build unified bid list ──
  // Priority: cache (on-chain/fb) > localSecrets
  // Merge keys from both _mbBidCache and S.localSecrets
  const allKeys = new Set([
    ...Object.keys(_mbBidCache),
    ...Object.keys(S.localSecrets),
  ]);

  interface BidEntry {
    key: string;
    amount: string;
    ts: number;
    refunded: boolean;
    nonce: string;
    commitment: string;
    auction: Auction | undefined;
    phase: 0 | 1 | 2;
    isMyWin: boolean;
    hasWinner: boolean;
  }

  const myAddr = S.wallet.address.toLowerCase();
  const entries: BidEntry[] = [];

  // S.auctions is loaded once at least 1 entry exists (Firebase listener has fired)
  const auctionsLoaded = S.auctions.length > 0;

  allKeys.forEach(key => {
    const cached  = _mbBidCache[key];
    const local   = S.localSecrets[key];
    const amount  = cached?.amount || local?.amount || '0';
    const ts      = cached?.ts     || local?.ts     || 0;
    const refunded= cached?.refunded ?? false;

    // Skip fully refunded bids
    if (refunded && parseFloat(amount) === 0) return;

    const auction = S.auctions.find(x => String(x.id) === key || x._fbKey === key);

    // If auctions are loaded but no matching auction found
    // → this is a stale localStorage entry, skip and clean up
    if (auctionsLoaded && !auction) {
    // Only delete if key is not in Firebase cache (source = 'fb'|'chain')
    // to avoid removing valid bids not yet synced to S.auctions
      if (!cached || cached.source === 'local') {
        delete S.localSecrets[key];
        localStorage.setItem(LS_SECRETS, JSON.stringify(S.localSecrets));
      }
      return;
    }

    const phase   = auction ? calcPhase(auction) : 0; // default BIDDING if not loaded yet

    const winner  = auction?.winner || '';
    const isMyWin = !!(
      (phase === 2 || auction?.finalized) &&
      winner &&
      winner !== '0x0000000000000000000000000000000000000000' &&
      winner.toLowerCase() === myAddr
    );
    const hasWinner = !!(
      winner &&
      winner !== '0x0000000000000000000000000000000000000000'
    );

    entries.push({
      key, amount, ts, refunded,
      nonce:      local?.nonce      || '',
      commitment: local?.commitment || '',
      auction, phase, isMyWin, hasWinner,
    });
  });

  // ── My Auctions (created by this wallet) ──
  const myAuctions = S.auctions.filter(a =>
    a.owner && a.owner.toLowerCase() === myAddr
  );
  const countCreated = myAuctions.length;

  // ── Badges ──
  const countActive = entries.filter(e => e.phase === 0).length;
  const countEnded  = entries.filter(e => e.phase === 1).length;
  const countWon    = entries.filter(e => e.isMyWin).length;
  const countLost   = entries.filter(e => !e.isMyWin && e.hasWinner && (e.phase === 2 || e.auction?.finalized)).length;
  const countAll    = entries.length + countCreated;

  const badgeMap: Record<string, number> = {
    'mb-badge-all': countAll, 'mb-badge-active': countActive,
    'mb-badge-ended': countEnded, 'mb-badge-won': countWon, 'mb-badge-lost': countLost,
    'mb-badge-created': countCreated,
  };
  Object.entries(badgeMap).forEach(([id, n]) => {
    const el2 = document.getElementById(id);
    if (el2) el2.textContent = String(n);
  });

  // ── My Auctions tab: render separately, bypass bid entries ──
  if (S.mbFilter === 'created') {
    renderMyAuctions(myAuctions, el, pagEl);
    return;
  }

  // ── Filter ──
  let filtered = entries.filter(e => {
    const name = (e.auction?.itemName || 'Auction #' + e.key).toLowerCase();
    if (S.mbSearch && !name.includes(S.mbSearch.toLowerCase())) return false;
    if (S.mbFilter === 'all')    return true;
    if (S.mbFilter === 'active') return e.phase === 0;
    if (S.mbFilter === 'ended')  return e.phase === 1;
    if (S.mbFilter === 'won')    return e.isMyWin;
    if (S.mbFilter === 'lost')   return !e.isMyWin && e.hasWinner && (e.phase === 2 || !!e.auction?.finalized);
    return true;
  });

  // ── Sort bid entries (non-all tabs only, all is sorted in unifiedList below) ──
  if (S.mbFilter !== 'all') {
    filtered.sort((a, b) => {
      if (S.mbSort === 'newest')      return b.ts - a.ts;
      if (S.mbSort === 'oldest')      return a.ts - b.ts;
      if (S.mbSort === 'amount_high') return parseFloat(b.amount) - parseFloat(a.amount);
      if (S.mbSort === 'amount_low')  return parseFloat(a.amount) - parseFloat(b.amount);
      return 0;
    });
  }

  // ── When filter = 'all': merge created auctions into the list ──
  // Build unified list: bid entries (type='bid') + created auctions (type='created')
  type UnifiedItem = { type: 'bid'; data: typeof filtered[0] } | { type: 'created'; data: Auction };
  let unifiedList: UnifiedItem[];
  if (S.mbFilter === 'all') {
    // Filter created auctions by search if present
    const filteredCreated = myAuctions.filter(a => {
      if (!S.mbSearch) return true;
      const name = (a.itemName || '').toLowerCase();
      return name.includes(S.mbSearch.toLowerCase()) || String(a.id).includes(S.mbSearch);
    });
    unifiedList = [
      ...filtered.map(e => ({ type: 'bid' as const, data: e })),
      ...filteredCreated.map(a => ({ type: 'created' as const, data: a })),
    ];
    // Sort unified list
    unifiedList.sort((a, b) => {
      const tsA = a.type === 'bid' ? a.data.ts : (a.data.createdAt || 0);
      const tsB = b.type === 'bid' ? b.data.ts : (b.data.createdAt || 0);
      const amtA = a.type === 'bid' ? parseFloat(a.data.amount) : parseFloat((a.data as Auction).startPrice || '0');
      const amtB = b.type === 'bid' ? parseFloat(b.data.amount) : parseFloat((b.data as Auction).startPrice || '0');
      if (S.mbSort === 'newest')      return tsB - tsA;
      if (S.mbSort === 'oldest')      return tsA - tsB;
      if (S.mbSort === 'amount_high') return amtB - amtA;
      if (S.mbSort === 'amount_low')  return amtA - amtB;
      return 0;
    });
  } else {
    unifiedList = filtered.map(e => ({ type: 'bid' as const, data: e }));
  }

  if (!unifiedList.length) {
    const msg = allKeys.size === 0 && myAuctions.length === 0
      ? `<div class="empty"><div class="empty-ico">🔒</div>
           <div class="empty-title">No bids yet</div>
           <p style="font-size:13px;margin-top:4px;color:var(--text3)">Your bids will appear here after placing them.</p></div>`
      : `<div class="empty"><div class="empty-ico">🔍</div>
           <div class="empty-title">No bids match this filter</div>
           <p style="font-size:13px;margin-top:4px;color:var(--text3)">Try a different filter or clear the search.</p>
           <button class="btn btn-ghost btn-sm" style="margin-top:12px" id="mb-clear-filter">
             <i class="bi bi-x-circle"></i> Clear Filters
           </button></div>`;
    el.innerHTML = msg;
    document.getElementById('mb-clear-filter')?.addEventListener('click', () => {
      S.mbFilter = 'all'; S.mbSearch = ''; S.mbPage = 1;
      (document.getElementById('mb-search-inp') as HTMLInputElement|null)?.value != null &&
        ((document.getElementById('mb-search-inp') as HTMLInputElement).value = '');
      renderMyBids();
    });
    mbRenderPagination(0, 1);
    return;
  }

  const total      = unifiedList.length;
  const totalPages = Math.max(1, Math.ceil(total / S.mbPerPage));
  S.mbPage         = Math.min(S.mbPage, totalPages);
  const start      = (S.mbPage - 1) * S.mbPerPage;
  const pageItems  = unifiedList.slice(start, start + S.mbPerPage);

  el.innerHTML = pageItems.map(item => {
    // ── Render created auction card ──
    if (item.type === 'created') {
      const a = item.data as Auction;
      const key   = a._fbKey || String(a.id);
      const phase = calcPhase(a);
      const emoji = EMOJIS[((parseInt(String(a.id)) || Math.abs(key.split('').reduce((acc: number, c: string) => acc + c.charCodeAt(0), 0))) % EMOJIS.length)];
      const phaseLbl   = ['BIDDING', 'ENDED', 'FINALIZED'][phase];
      const phaseClass = ['p0', 'p1', ''][phase];
      const hasWinner  = !!(a.winner && a.winner !== '0x0000000000000000000000000000000000000000');
      let statusBadge  = '';
      if (a.finalized && hasWinner)
        statusBadge = `<span class="mb-status-badge mb-status-won">✅ Sold</span>`;
      else if (a.finalized && !hasWinner)
        statusBadge = `<span class="mb-status-badge mb-status-lost">⚪ No Bids</span>`;
      else if (phase === 0)
        statusBadge = `<span class="mb-status-badge mb-status-live">🔴 Live</span>`;
      else if (phase === 1)
        statusBadge = `<span class="mb-status-badge mb-status-ended">⏳ Ended</span>`;
      const needsFinalize = phase === 1;
      let actionBtn = '';
      if (needsFinalize)
        actionBtn = `<button class="btn btn-primary btn-sm btn-ma-finalize" data-id="${key}"><i class="bi bi-flag-fill"></i> Settle Auction</button>`;
      else if (phase === 0)
        actionBtn = `<button class="btn btn-ghost btn-sm" disabled style="opacity:0.5"><i class="bi bi-clock"></i> In Progress</button>`;
      const winningBidSection = (a.finalized || phase === 2) && a.winningBid && hasWinner
        ? `<div class="mb-bid-stat"><span class="mb-stat-lbl">Sold For</span><span class="mb-stat-val" style="color:var(--gold)">${parseFloat(a.winningBid).toFixed(4)} ETH</span></div>` : '';
      const imgSection = a.itemImageURI
        ? `<div class="my-bid-img"><img src="${esc(a.itemImageURI)}" alt="${esc(a.itemName||'')}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/><span class="my-bid-img-emoji" style="display:none;font-size:2.5rem">${emoji}</span><div class="my-bid-img-overlay"><span class="my-bid-img-phase ${phaseClass}">${phaseLbl}</span><span style="font-size:11px;color:rgba(255,255,255,0.85);font-family:var(--font-mono)">Floor ${a.startPrice} ETH</span></div></div>`
        : `<div class="my-bid-img"><span class="my-bid-img-emoji">${emoji}</span><div class="my-bid-img-overlay"><span class="my-bid-img-phase ${phaseClass}">${phaseLbl}</span><span style="font-size:11px;color:rgba(255,255,255,0.85);font-family:var(--font-mono)">Floor ${a.startPrice} ETH</span></div></div>`;
      return `<div class="my-bid-card" data-bid-id="${key}">
        ${imgSection}
        <div class="my-bid-content">
          <div class="my-bid-header">
            <div class="my-bid-header-left">
              <div class="my-bid-name">${esc(a.itemName || 'Auction #' + key)}</div>
              <div class="my-bid-id">
                ${a.id ? '#' + a.id : '#' + key}
                <span class="mb-status-badge" style="background:rgba(91,63,191,0.18);color:#a78bfa;border-color:rgba(91,63,191,0.35)">🏗️ Seller</span>
                ${statusBadge}
              </div>
            </div>
          </div>
          <div class="mb-bid-stats">
            <div class="mb-bid-stat"><span class="mb-stat-lbl">Floor Price</span><span class="mb-stat-val" style="color:var(--glow)">${a.startPrice} ETH</span></div>
            <div class="mb-bid-stat"><span class="mb-stat-lbl">Bidders</span><span class="mb-stat-val">${a.totalBidders || 0}</span></div>
            ${winningBidSection}
            ${a.createdAt ? `<div class="mb-bid-stat"><span class="mb-stat-lbl">Created</span><span class="mb-stat-val" style="font-size:11px;color:var(--text3)">${new Date(a.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span></div>` : ''}
          </div>
          <div class="my-bid-actions">
            ${actionBtn}
            <button class="btn btn-ghost btn-sm btn-ma-view" data-id="${key}"><i class="bi bi-eye"></i> View</button>
          </div>
        </div>
      </div>`;
    }

    // ── Render bid entry card ──
    const e = item.data as typeof filtered[0];
    const { key, amount, ts, auction: a, phase, isMyWin, hasWinner } = e;
    const emoji      = EMOJIS[((parseInt(key) || Math.abs(key.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0))) % EMOJIS.length)];
    const phaseLbl   = ['BIDDING', 'ENDED', 'FINALIZED'][phase];
    const phaseClass = ['p0', 'p1', ''][phase];

    const claimDl  = a?.claimDeadline || (a?.finalizedAt ? a.finalizedAt + 3*24*3600*1000 : 0);
    const claimExp = claimDl > 0 && Date.now() > claimDl;

    // ── Tie-loss detection ──
    // If I lost but my bid equals the winning bid → I lost due to tie (later commit)
    const isLost      = !isMyWin && hasWinner && (phase === 2 || !!a?.finalized);
    const myBidFloat  = parseFloat(amount || '0');
    const winBidFloat = parseFloat(a?.winningBid || '0');
    const isTieLoss   = isLost && winBidFloat > 0 && Math.abs(myBidFloat - winBidFloat) < 0.000001;

    // If tie-loss and not yet cached → fetch winner commit time in background
    if (isTieLoss && a?.winner && !_tieLossCache[key]) {
      fetchWinnerCommitInfo(key, a.winner);
    }
    const tieInfo     = isTieLoss ? _tieLossCache[key] : null;
    const winnerCommitStr = tieInfo?.winnerCommitTs
      ? new Date(tieInfo.winnerCommitTs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : null;
    const winnerCommitDateStr = tieInfo?.winnerCommitTs
      ? new Date(tieInfo.winnerCommitTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : null;
    const myCommitStr = ts
      ? new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : null;
    const myCommitDateStr = ts
      ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : null;

    // ── Status badge ──
    let statusBadge = '';
    if (isMyWin && !a?.itemClaimed && !claimExp)
      statusBadge = `<span class="mb-status-badge mb-status-won">🏆 Won</span>`;
    else if (isMyWin && a?.itemClaimed)
      statusBadge = `<span class="mb-status-badge mb-status-claimed">✅ Claimed</span>`;
    else if (isTieLoss)
      statusBadge = `<span class="mb-status-badge mb-status-lost" title="Same bid as winner but committed later">❌ Tie loss</span>`;
    else if (!isMyWin && hasWinner && (phase === 2 || a?.finalized))
      statusBadge = `<span class="mb-status-badge mb-status-lost">❌ Lost</span>`;
    else if (phase === 0)
      statusBadge = `<span class="mb-status-badge mb-status-live">🔴 Live</span>`;
    else if (phase === 1)
      statusBadge = `<span class="mb-status-badge mb-status-ended">⏳ Ended</span>`;

    // ── Tie-loss info block ──
    const tieLossBlock = isTieLoss ? `
    <div style="margin-top:8px;padding:8px 10px;background:rgba(239,68,68,0.07);border:0.5px solid rgba(239,68,68,0.25);border-radius:var(--r2);font-family:var(--font-mono);font-size:10.5px;line-height:1.7">
      <div style="color:var(--red);font-weight:600;margin-bottom:4px">⚠️ Tie loss — same bid, later commit</div>
      <div style="color:var(--text2)">
        Your bid:
        <span style="color:var(--glow)">${myBidFloat.toFixed(4)} ETH</span>
        · Committed at
        <span style="color:var(--text1)">${myCommitStr || '—'}</span>
        <span style="color:var(--text3)">(${myCommitDateStr || '—'})</span>
      </div>
      <div style="color:var(--text2)">
        Winner:
        <span style="color:var(--gold)">${a?.winner ? shortAddr(a.winner) : '—'}</span>
        · Committed at
        <span style="color:var(--text1)">${winnerCommitStr
          ? `<span style="color:var(--green)">${winnerCommitStr}</span>`
          : '<span style="color:var(--text3)">loading…</span>'}
        </span>
        ${winnerCommitDateStr ? `<span style="color:var(--text3)">(${winnerCommitDateStr})</span>` : ''}
      </div>
      ${winnerCommitStr && myCommitStr && tieInfo?.winnerCommitTs && ts ? (() => {
        const diffMs  = ts - tieInfo.winnerCommitTs;
        const diffSec = Math.abs(Math.round(diffMs / 1000));
        const diffMin = Math.floor(diffSec / 60);
        const remSec  = diffSec % 60;
        const diffStr = diffMin > 0 ? `${diffMin}m ${remSec}s` : `${diffSec}s`;
        return `<div style="color:var(--text3);margin-top:2px">You committed <span style="color:var(--red)">${diffStr} later</span></div>`;
      })() : ''}
    </div>` : '';

    // ── Action buttons ──
    let actionBtns = '';
    if (phase === 0) {
      actionBtns = `<button class="btn btn-primary btn-sm btn-update-bid" data-id="${key}"><i class="bi bi-pencil"></i> Update Bid</button>`;
    } else if (phase === 1) {
      actionBtns = `<button class="btn btn-ghost btn-sm" disabled style="opacity:0.5;cursor:not-allowed"><i class="bi bi-hourglass-split"></i> Awaiting Result</button>`;
    } else if (phase === 2 || a?.finalized) {
      if (isMyWin && !a?.itemClaimed && !claimExp)
        actionBtns = `<button class="btn btn-sm btn-claim-nft" style="background:linear-gradient(135deg,var(--gold),var(--gold2));color:#1a1000;font-weight:700;border:none" data-id="${key}"><i class="bi bi-trophy-fill"></i> Claim NFT</button>`;
      else if (!isMyWin && hasWinner)
        actionBtns = `<button class="btn btn-ghost btn-sm btn-refund-bid" data-id="${key}"><i class="bi bi-arrow-return-left"></i> Refund ETH</button>`;
    }

    const imgSection = a?.itemImageURI
      ? `<div class="my-bid-img">
           <img src="${esc(a.itemImageURI)}" alt="${esc(a.itemName||'')}"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
           <span class="my-bid-img-emoji" style="display:none;font-size:2.5rem">${emoji}</span>
           <div class="my-bid-img-overlay">
             <span class="my-bid-img-phase ${phaseClass}">${phaseLbl}</span>
             <span style="font-size:11px;color:rgba(255,255,255,0.85);font-family:var(--font-mono)">${amount} ETH</span>
           </div>
         </div>`
      : `<div class="my-bid-img">
           <span class="my-bid-img-emoji">${emoji}</span>
           <div class="my-bid-img-overlay">
             <span class="my-bid-img-phase ${phaseClass}">${phaseLbl}</span>
             <span style="font-size:11px;color:rgba(255,255,255,0.85);font-family:var(--font-mono)">${amount} ETH</span>
           </div>
         </div>`;

    const usdVal = S.ethPrice ? `≈ $${(parseFloat(amount||'0') * S.ethPrice).toFixed(2)}` : '';

    // ── Claim deadline banner (only for winner, not yet claimed) ──
    const claimDeadSec = claimDl > 0 ? Math.floor(claimDl / 1000) : 0;
    const claimHoursLeft = claimDl > 0 ? Math.max(0, (claimDl - Date.now()) / 3600_000) : 0;
    const claimBanner = isMyWin && !a?.itemClaimed
      ? claimExp
        ? `<div style="margin-bottom:10px;padding:9px 12px;background:rgba(220,38,38,0.09);border:1.5px solid rgba(220,38,38,0.4);border-radius:var(--r2);font-size:12px;color:var(--red);font-weight:600">
             ⛔ Claim period expired — NFT returned to seller
           </div>`
        : `<div style="margin-bottom:10px;padding:9px 12px;background:${claimHoursLeft < 24 ? 'rgba(220,38,38,0.09)' : 'rgba(200,150,10,0.08)'};border:1.5px solid ${claimHoursLeft < 24 ? 'rgba(220,38,38,0.45)' : 'rgba(200,150,10,0.35)'};border-radius:var(--r2);display:flex;align-items:center;gap:8px">
             <span style="font-size:16px">${claimHoursLeft < 24 ? '🚨' : '⏰'}</span>
             <div style="flex:1">
               <div style="font-size:11.5px;font-weight:700;color:${claimHoursLeft < 24 ? 'var(--red)' : 'var(--gold)'}">
                 ${claimHoursLeft < 24 ? 'Claim expires soon!' : 'Claim your NFT'}
               </div>
               <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono);margin-top:2px">
                 <span data-ts="${claimDeadSec}">${formatCountdown(claimDeadSec)}</span> remaining
               </div>
             </div>
           </div>`
      : '';

    return `<div class="my-bid-card" data-bid-id="${key}">
      ${imgSection}
      <div class="my-bid-content">
        <div class="my-bid-header">
          <div class="my-bid-header-left">
            <div class="my-bid-name">${esc(a?.itemName || 'Auction #' + key)}</div>
            <div class="my-bid-id">
              ${a?.id ? '#' + a.id : '#' + key}
              ${statusBadge}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm btn-export-secret" data-id="${key}" title="Export nonce">
            <i class="bi bi-upload"></i>
          </button>
        </div>
        <div class="mb-bid-stats">
          <div class="mb-bid-stat">
            <span class="mb-stat-lbl">Your Bid</span>
            <span class="mb-stat-val" style="color:var(--glow)">${parseFloat(amount).toFixed(4)} ETH</span>
            ${usdVal ? `<span class="mb-stat-usd">${usdVal}</span>` : ''}
          </div>
          ${a?.winningBid && (a.finalized || phase === 2) ? `
          <div class="mb-bid-stat">
            <span class="mb-stat-lbl">Winning Bid</span>
            <span class="mb-stat-val" style="color:var(--gold)">${parseFloat(a.winningBid).toFixed(4)} ETH</span>
          </div>` : ''}
          ${a?.totalBidders !== undefined ? `
          <div class="mb-bid-stat">
            <span class="mb-stat-lbl">Bidders</span>
            <span class="mb-stat-val">${a.totalBidders}</span>
          </div>` : ''}
          <div class="mb-bid-stat">
            <span class="mb-stat-lbl">Placed</span>
            <span class="mb-stat-val" style="font-size:11px;color:var(--text3)">${new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>
          </div>
        </div>
        ${e.nonce ? `
        <div class="secret-reveal">
          <div class="s-line">NONCE: <span style="font-size:10px;word-break:break-all">${e.nonce}</span></div>
          ${e.commitment ? `<div class="s-line">COMMITMENT: <span style="font-size:10px">${e.commitment.slice(0,28)}…</span></div>` : ''}
        </div>` : ''}
        ${claimBanner}
        ${tieLossBlock}
        <div class="my-bid-actions">
          ${actionBtns}
          <button class="btn btn-ghost btn-sm btn-view-auction" data-id="${key}"><i class="bi bi-eye"></i> View</button>
        </div>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll<HTMLElement>('.btn-export-secret').forEach(btn =>
    btn.addEventListener('click', () => exportSecret(btn.dataset.id!)));
  el.querySelectorAll<HTMLElement>('.btn-update-bid').forEach(btn =>
    btn.addEventListener('click', () => openDetail(btn.dataset.id!)));
  el.querySelectorAll<HTMLElement>('.btn-claim-nft').forEach(btn =>
    btn.addEventListener('click', () => handleClaim(btn.dataset.id!)));
  el.querySelectorAll<HTMLElement>('.btn-refund-bid').forEach(btn =>
    btn.addEventListener('click', () => handleRefund(btn.dataset.id!)));
  el.querySelectorAll<HTMLElement>('.btn-view-auction').forEach(btn =>
    btn.addEventListener('click', () => openDetail(btn.dataset.id!)));
  // Created auction buttons (shown in 'all' tab)
  el.querySelectorAll<HTMLElement>('.btn-ma-finalize').forEach(btn =>
    btn.addEventListener('click', () => handleFinalize(btn.dataset.id!)));
  el.querySelectorAll<HTMLElement>('.btn-ma-view').forEach(btn =>
    btn.addEventListener('click', () => openDetail(btn.dataset.id!)));

  mbRenderPagination(total, totalPages);
}
function renderMyAuctions(auctions: Auction[], el: HTMLElement, pagEl: HTMLElement): void {
  const myAddr = S.wallet!.address.toLowerCase();
  let list = auctions;

  // Search
  if (S.mbSearch) {
    const q = S.mbSearch.toLowerCase();
    list = list.filter(a =>
      (a.itemName || '').toLowerCase().includes(q) ||
      String(a.id).includes(q) ||
      (a._fbKey || '').toLowerCase().includes(q)
    );
  }

  // Sort (reuse mbSort — amount fields refer to startPrice / winningBid)
  list = [...list].sort((a, b) => {
    if (S.mbSort === 'newest')      return (b.createdAt || 0) - (a.createdAt || 0);
    if (S.mbSort === 'oldest')      return (a.createdAt || 0) - (b.createdAt || 0);
    if (S.mbSort === 'amount_high') return parseFloat(b.startPrice || '0') - parseFloat(a.startPrice || '0');
    if (S.mbSort === 'amount_low')  return parseFloat(a.startPrice || '0') - parseFloat(b.startPrice || '0');
    return 0;
  });

  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="empty-ico">🏗️</div>
      <div class="empty-title">${S.mbSearch ? 'No auctions match' : 'No auctions created yet'}</div>
      <p style="font-size:13px;margin-top:4px;color:var(--text3)">
        ${S.mbSearch ? 'Try a different search term.' : 'Auctions you create will appear here.'}
      </p></div>`;
    mbRenderPagination(0, 1);
    return;
  }

  const total      = list.length;
  const totalPages = Math.max(1, Math.ceil(total / S.mbPerPage));
  S.mbPage         = Math.min(S.mbPage, totalPages);
  const start      = (S.mbPage - 1) * S.mbPerPage;
  const pageItems  = list.slice(start, start + S.mbPerPage);

  el.innerHTML = pageItems.map(a => {
    const key   = a._fbKey || String(a.id);
    const phase = calcPhase(a);
    const emoji = EMOJIS[((parseInt(String(a.id)) || Math.abs(key.split('').reduce((acc: number, c: string) => acc + c.charCodeAt(0), 0))) % EMOJIS.length)];
    const phaseLbl   = ['BIDDING', 'ENDED', 'FINALIZED'][phase];
    const phaseClass = ['p0', 'p1', ''][phase];

    // Status badge
    const hasWinner = !!(a.winner && a.winner !== '0x0000000000000000000000000000000000000000');
    let statusBadge = '';
    if (a.finalized && hasWinner)
      statusBadge = `<span class="mb-status-badge mb-status-won">✅ Sold</span>`;
    else if (a.finalized && !hasWinner)
      statusBadge = `<span class="mb-status-badge mb-status-lost">⚪ No Bids</span>`;
    else if (phase === 0)
      statusBadge = `<span class="mb-status-badge mb-status-live">🔴 Live</span>`;
    else if (phase === 1)
      statusBadge = `<span class="mb-status-badge mb-status-ended">⏳ Ended</span>`;

    // Seller action button
    const needsFinalize = phase === 1;
    let actionBtn = '';
    if (needsFinalize)
      actionBtn = `<button class="btn btn-primary btn-sm btn-ma-finalize" data-id="${key}"><i class="bi bi-flag-fill"></i> Settle Auction</button>`;
    else if (phase === 0)
      actionBtn = `<button class="btn btn-ghost btn-sm" disabled style="opacity:0.5"><i class="bi bi-clock"></i> In Progress</button>`;

    const winningBidSection = (a.finalized || phase === 2) && a.winningBid && hasWinner ? `
    <div class="mb-bid-stat">
      <span class="mb-stat-lbl">Sold For</span>
      <span class="mb-stat-val" style="color:var(--gold)">${parseFloat(a.winningBid).toFixed(4)} ETH</span>
    </div>` : '';

    const sellerReceived = (a.finalized || phase === 2) && a.winningBid && hasWinner
      ? `<div class="mb-bid-stat">
           <span class="mb-stat-lbl">You Received</span>
           <span class="mb-stat-val" style="color:var(--glow)">${(parseFloat(a.winningBid) * 0.975).toFixed(4)} ETH</span>
         </div>`
      : '';

    const imgSection = a.itemImageURI
      ? `<div class="my-bid-img">
           <img src="${esc(a.itemImageURI)}" alt="${esc(a.itemName||'')}"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
           <span class="my-bid-img-emoji" style="display:none;font-size:2.5rem">${emoji}</span>
           <div class="my-bid-img-overlay">
             <span class="my-bid-img-phase ${phaseClass}">${phaseLbl}</span>
             <span style="font-size:11px;color:rgba(255,255,255,0.85);font-family:var(--font-mono)">Floor ${a.startPrice} ETH</span>
           </div>
         </div>`
      : `<div class="my-bid-img">
           <span class="my-bid-img-emoji">${emoji}</span>
           <div class="my-bid-img-overlay">
             <span class="my-bid-img-phase ${phaseClass}">${phaseLbl}</span>
             <span style="font-size:11px;color:rgba(255,255,255,0.85);font-family:var(--font-mono)">Floor ${a.startPrice} ETH</span>
           </div>
         </div>`;

    return `<div class="my-bid-card" data-bid-id="${key}">
      ${imgSection}
      <div class="my-bid-content">
        <div class="my-bid-header">
          <div class="my-bid-header-left">
            <div class="my-bid-name">${esc(a.itemName || 'Auction #' + key)}</div>
            <div class="my-bid-id">
              ${a.id ? '#' + a.id : '#' + key}
              <span class="mb-status-badge" style="background:rgba(91,63,191,0.18);color:#a78bfa;border-color:rgba(91,63,191,0.35)">🏗️ Seller</span>
              ${statusBadge}
            </div>
          </div>
        </div>
        <div class="mb-bid-stats">
          <div class="mb-bid-stat">
            <span class="mb-stat-lbl">Floor Price</span>
            <span class="mb-stat-val" style="color:var(--glow)">${a.startPrice} ETH</span>
          </div>
          <div class="mb-bid-stat">
            <span class="mb-stat-lbl">Bidders</span>
            <span class="mb-stat-val">${a.totalBidders || 0}</span>
          </div>
          ${winningBidSection}
          ${sellerReceived}
          ${a.createdAt ? `
          <div class="mb-bid-stat">
            <span class="mb-stat-lbl">Created</span>
            <span class="mb-stat-val" style="font-size:11px;color:var(--text3)">${new Date(a.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>
          </div>` : ''}
        </div>
        <div class="my-bid-actions">
          ${actionBtn}
          <button class="btn btn-ghost btn-sm btn-ma-view" data-id="${key}"><i class="bi bi-eye"></i> View</button>
        </div>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll<HTMLElement>('.btn-ma-finalize').forEach(btn =>
    btn.addEventListener('click', () => handleFinalize(btn.dataset.id!)));
  el.querySelectorAll<HTMLElement>('.btn-ma-view').forEach(btn =>
    btn.addEventListener('click', () => openDetail(btn.dataset.id!)));

  mbRenderPagination(total, totalPages);
}


function mbRenderPagination(total: number, totalPages: number): void {
  const pagEl  = document.getElementById('mybids-pagination')!;
  const infoEl = document.getElementById('mb-info')!;
  const btnsEl = document.getElementById('mb-btns')!;

  if (totalPages <= 1) {
    pagEl.style.display = 'none';
    btnsEl.innerHTML = '';
    return;
  }

  pagEl.style.display = 'flex';
  const start = (S.mbPage - 1) * S.mbPerPage + 1;
  const end   = Math.min(S.mbPage * S.mbPerPage, total);
  infoEl.textContent = `Showing ${start}–${end} of ${total}`;

  let html = `<button class="ra-pg-btn" id="mb-prev" ${S.mbPage===1?'disabled':''}><i class="bi bi-chevron-left"></i></button>`;
  const pages: (number|string)[] = [];
  if (totalPages <= 7) { for (let i=1;i<=totalPages;i++) pages.push(i); }
  else {
    pages.push(1);
    if (S.mbPage > 3) pages.push('…');
    for (let i=Math.max(2,S.mbPage-1);i<=Math.min(totalPages-1,S.mbPage+1);i++) pages.push(i);
    if (S.mbPage < totalPages-2) pages.push('…');
    pages.push(totalPages);
  }
  pages.forEach(p => {
    if (p==='…') html+=`<span class="ap-ellipsis">…</span>`;
    else html+=`<button class="ra-pg-btn${p===S.mbPage?' active':''}" data-p="${p}">${p}</button>`;
  });
  html += `<button class="ra-pg-btn" id="mb-next" ${S.mbPage===totalPages?'disabled':''}><i class="bi bi-chevron-right"></i></button>`;
  btnsEl.innerHTML = html;
  btnsEl.querySelectorAll<HTMLElement>('[data-p]').forEach(btn =>
    btn.addEventListener('click', () => { S.mbPage=+btn.dataset.p!; renderMyBids(); }));
  btnsEl.querySelector<HTMLElement>('#mb-prev')?.addEventListener('click', () => { if(S.mbPage>1){S.mbPage--;renderMyBids();} });
  btnsEl.querySelector<HTMLElement>('#mb-next')?.addEventListener('click', () => { if(S.mbPage<totalPages){S.mbPage++;renderMyBids();} });
}

function exportSecret(id: number | string): void {
  const s = S.localSecrets[id];
  if (!s) return;
  const blob = new Blob([JSON.stringify({ auctionId: id, ...s }, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: `secretbid-nonce-${id}.json` }).click();
  URL.revokeObjectURL(url);
  toast('Exported!', `Nonce for Auction #${id} saved.`, 'ok');
}

function exportAllSecrets(): void {
  const data = { exportedAt: new Date().toISOString(), wallet: S.wallet?.address, secrets: S.localSecrets };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'secretbid-all-nonces.json' }).click();
  URL.revokeObjectURL(url);
  toast('All Exported!', 'All nonce secrets backed up.', 'ok');
}

// ─────────────────────────────────────────────────────────────────────────────
//  NONCE VAULT — AES-256-GCM ENCRYPTION
// ─────────────────────────────────────────────────────────────────────────────
async function vaultDeriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc  = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations: 250_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt','decrypt']
  );
}

async function vaultEncrypt(data: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await vaultDeriveKey(password, salt);
  const enc  = new TextEncoder();
  const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(data));
  const ctArr = new Uint8Array(ct);
  const buf  = new Uint8Array(16 + 12 + ctArr.byteLength);
  buf.set(salt, 0); buf.set(iv, 16); buf.set(ctArr, 28);
  return btoa(String.fromCharCode(...buf));
}

async function vaultDecrypt(blob: string, password: string): Promise<string> {
  const buf  = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
  const salt = buf.slice(0, 16);
  const iv   = buf.slice(16, 28);
  const ct   = buf.slice(28);
  const key  = await vaultDeriveKey(password, salt);
  const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

async function vaultCreate(): Promise<void> {
  const pw = (document.getElementById('vault-password') as HTMLInputElement).value;
  if (!pw || pw.length < 8) { toast('Weak Password', 'Use at least 8 characters.', 'err'); return; }

  showTxOverlay('Creating Vault', 'Encrypting with AES-256…');
  try {
    const entries: VaultEntry[] = Object.entries(S.localSecrets).map(([id, s]) => {
      const a = S.auctions.find(x => String(x.id) === String(id) || x._fbKey === String(id));
      return { auctionId: id, auctionName: a?.itemName || 'Auction #' + id, ...s };
    });
    const encrypted = await vaultEncrypt(JSON.stringify(entries), pw);
    localStorage.setItem(LS_VAULT, encrypted);
    S.vaultUnlocked = true;
    S.vaultEntries  = entries;
    hideTxOverlay();
    toast('Vault Created! 🔐', `${entries.length} secret(s) encrypted.`, 'ok');
    renderVaultPage();
  } catch (e: any) {
    hideTxOverlay();
    toast('Vault Error', e.message?.slice(0,80), 'err');
  }
}

async function vaultUnlock(): Promise<void> {
  const pw   = (document.getElementById('vault-password') as HTMLInputElement).value;
  const blob = localStorage.getItem(LS_VAULT);
  if (!blob) { toast('No Vault', 'Create a vault first.', 'err'); return; }
  if (!pw)   { toast('Password Required', '', 'err'); return; }

  showTxOverlay('Unlocking Vault', 'Decrypting…');
  try {
    const decrypted = await vaultDecrypt(blob, pw);
    S.vaultEntries  = JSON.parse(decrypted);
    S.vaultUnlocked = true;
    hideTxOverlay();
    toast('Vault Unlocked! 🔓', `${S.vaultEntries.length} secret(s) loaded.`, 'ok');
    renderVaultPage();
  } catch {
    hideTxOverlay();
    toast('Wrong Password', 'Could not decrypt vault.', 'err');
  }
}

function vaultLock(): void {
  S.vaultUnlocked = false;
  S.vaultEntries  = [];
  (document.getElementById('vault-password') as HTMLInputElement).value = '';
  renderVaultPage();
  toast('Vault Locked 🔒', '', 'info');
}

async function vaultExport(): Promise<void> {
  const blob = localStorage.getItem(LS_VAULT);
  if (!blob) { toast('No Vault', '', 'err'); return; }
  const json = JSON.stringify({ version: 1, encrypted: blob }, null, 2);
  const b    = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(b);
  Object.assign(document.createElement('a'), { href: url, download: 'secretbid-vault-backup.json' }).click();
  URL.revokeObjectURL(url);
  toast('Vault Exported!', 'Keep this file safe.', 'ok');
}

async function vaultAddEntry(auctionId: number | string): Promise<void> {
  if (!S.vaultUnlocked) {
    toast('Vault Locked', 'Unlock vault first from the Nonce Vault tab.', 'err');
    return;
  }
  const secret = S.localSecrets[auctionId];
  if (!secret) { toast('No Secret', '', 'err'); return; }
  const a = S.auctions.find(x => String(x.id) === String(auctionId) || x._fbKey === String(auctionId));
  const entry: VaultEntry = { auctionId, auctionName: a?.itemName || 'Auction #' + auctionId, ...secret };
  const exists = S.vaultEntries.findIndex(e => String(e.auctionId) === String(auctionId));
  if (exists >= 0) S.vaultEntries[exists] = entry;
  else S.vaultEntries.push(entry);

  const pw = (document.getElementById('vault-password') as HTMLInputElement)?.value;
  if (pw) {
    const encrypted = await vaultEncrypt(JSON.stringify(S.vaultEntries), pw);
    localStorage.setItem(LS_VAULT, encrypted);
    toast('Added to Vault! 🔐', `Secret for Auction #${auctionId} encrypted.`, 'ok');
  } else {
    toast('Added (memory only)', 'Unlock vault to persist.', 'info');
  }
}

function renderVaultPage(): void {
  const hasVault    = !!localStorage.getItem(LS_VAULT);
  const lockSection = document.getElementById('vault-lock-section')!;
  void lockSection; // present but not directly manipulated below
  const vaultTitle  = document.getElementById('vault-lock-title')!;
  const vaultSub    = document.getElementById('vault-lock-sub')!;
  const btnCreate   = document.getElementById('btn-vault-create')!;
  const btnUnlock   = document.getElementById('btn-vault-unlock')!;
  const contents    = document.getElementById('vault-contents')!;
  const items       = document.getElementById('vault-items')!;

  // ── Render Recent Activity section (always visible, replaces locked placeholder) ──
  const activitySection = document.getElementById('vault-recent-activity');
  if (activitySection) {
    renderVaultRecentActivity(activitySection);
  }

  if (S.vaultUnlocked) {
    contents.style.display = 'block';
    vaultTitle.textContent = '🔓 Vault Unlocked';
    vaultSub.textContent   = `${S.vaultEntries.length} encrypted secret${S.vaultEntries.length !== 1 ? 's' : ''} loaded`;
    btnCreate.style.display = 'none';
    btnUnlock.style.display = 'none';

    const getPhaseById = (id: string | number): 0|1|2 => {
      const found = S.auctions.find(x => String(x.id) === String(id) || x._fbKey === String(id));
      return found ? calcPhase(found) : 2;
    };

    items.innerHTML = S.vaultEntries.length === 0
      ? `<div class="empty" style="padding:1rem"><div class="empty-title">No entries yet</div></div>`
      : S.vaultEntries.map(e => {
          const p           = getPhaseById(e.auctionId);
          const statusClass = p === 0 ? 'vs-active' : p === 1 ? 'vs-revealed' : 'vs-ended';
          const statusLbl   = p === 0 ? 'BIDDING'   : p === 1 ? 'ENDED'      : 'FINALIZED';
          return `<div class="vault-item-card" data-vault-id="${e.auctionId}">
            <div class="vault-item-header">
              <div>
                <div style="font-family:var(--font-head);font-weight:700;font-size:0.9rem">${esc(e.auctionName)}</div>
                <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono)">Auction #${e.auctionId}</div>
              </div>
              <span class="vault-status-badge ${statusClass}">${statusLbl}</span>
            </div>
            <div class="s-line">AMOUNT: <span style="color:var(--glow)">${e.amount} ETH</span></div>
            <div class="s-line" style="font-size:10px">NONCE: <span>${e.nonce}</span></div>
            <div style="margin-top:8px;display:flex;gap:8px">
              ${p === 1 ? `<span style="font-size:11px;color:var(--text3)">⏳ Awaiting settlement — hold tight</span>` : ''}
              <button class="btn btn-ghost btn-sm vault-export-btn" data-id="${e.auctionId}">📤 Export</button>
            </div>
          </div>`;
        }).join('');

    items.querySelectorAll<HTMLElement>('.vault-export-btn').forEach(btn =>
      btn.addEventListener('click', () => exportSecret(btn.dataset.id!)));
  } else {
    contents.style.display = 'none';
    vaultTitle.textContent = hasVault ? '🔒 Vault Locked' : '🔐 No Vault Yet';
    vaultSub.textContent   = hasVault
      ? 'Enter your password to access encrypted bid secrets'
      : 'Create a vault to protect your bid data with AES-256';
    btnCreate.style.display = hasVault ? 'none' : 'block';
    btnUnlock.style.display = hasVault ? 'block' : 'none';
  }
}

/** Renders recent on-platform activity into the vault page activity section */
function renderVaultRecentActivity(container: HTMLElement): void {
  // Pull from Firebase activity collection via S.auctions + localSecrets for context
  // We render from already-fetched auction data since firebase listener keeps it fresh

  const myAddr = S.wallet?.address?.toLowerCase() ?? '';

  // Build activity events from auction data
  const events: Array<{ ts: number; html: string }> = [];

  S.auctions.forEach(a => {
    const phase = calcPhase(a);

    // Finalized with winner — ETH received by seller
    if (a.finalized && a.winner && a.winner !== '0x0000000000000000000000000000000000000000' && parseFloat(a.winningBid || '0') > 0) {
      const winAmt    = parseFloat(a.winningBid);
      // Use sellerReceived from contract event if available (most accurate), fallback to 97.5%
      const sellerAmt = (a as any).sellerReceived
        ? parseFloat((a as any).sellerReceived).toFixed(4)
        : (winAmt * 0.975).toFixed(4);
      const isMe      = a.owner && a.owner.toLowerCase() === myAddr;
      const isMyWin   = a.winner.toLowerCase() === myAddr;
      const finalizedTs = a.finalizedAt || a.createdAt || 0;
      events.push({
        ts: finalizedTs,
        html: `<div class="activity-item" style="align-items:flex-start">
          <div style="width:28px;height:28px;border-radius:50%;background:rgba(245,200,66,0.12);border:1px solid rgba(245,200,66,0.3);
            display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">🏆</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;color:var(--text)">
              Auction Settled${isMe ? ' <span style="color:var(--gold)">(Your Auction)</span>' : ''}
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;line-height:1.5">
              <span style="color:var(--text2)">${esc(a.itemName)}</span> ·
              Winner: <span style="font-family:var(--font-mono);color:${isMyWin ? 'var(--glow)' : 'var(--text2)'}">${shortAddr(a.winner)}${isMyWin ? ' (You)' : ''}</span><br>
              Winning bid: <span style="color:var(--gold);font-family:var(--font-mono)">${winAmt.toFixed(4)} ETH</span> ·
              Seller received: <span style="color:var(--glow);font-family:var(--font-mono)">${sellerAmt} ETH</span>
            </div>
          </div>
          <div style="font-size:10px;color:var(--text4);white-space:nowrap">${timeAgo(finalizedTs)}</div>
        </div>`,
      });

      // ETH received — seller perspective (only shown if wallet is seller)
      if (isMe && !isMyWin) {
        events.push({
          ts: finalizedTs + 1,
          html: `<div class="activity-item" style="align-items:flex-start">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(0,158,140,0.12);border:1px solid rgba(0,158,140,0.3);
              display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">💰</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;color:var(--text)">ETH Received <span style="color:var(--glow)">(Your Sale)</span></div>
              <div style="font-size:11px;color:var(--text3);margin-top:2px;line-height:1.5">
                <span style="color:var(--text2)">${esc(a.itemName)}</span> sold ·
                You received: <span style="color:var(--glow);font-family:var(--font-mono);font-weight:700">${sellerAmt} ETH</span>
                <span style="color:var(--text4)">(after 2.5% fee)</span>
              </div>
            </div>
            <div style="font-size:10px;color:var(--text4);white-space:nowrap">${timeAgo(finalizedTs + 1)}</div>
          </div>`,
        });
      }

      // NFT claimed by winner
      if (a.itemClaimed) {
        const claimedTs = (a as any).claimedAt || finalizedTs + 10;
        events.push({
          ts: claimedTs,
          html: `<div class="activity-item" style="align-items:flex-start">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(26,127,193,0.12);border:1px solid rgba(26,127,193,0.3);
              display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">🖼️</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;color:var(--text)">NFT Delivered to Winner${isMyWin ? ' <span style="color:var(--blue)">(Yours)</span>' : ''}</div>
              <div style="font-size:11px;color:var(--text3);margin-top:2px;line-height:1.5">
                <span style="color:var(--text2)">${esc(a.itemName)}</span> NFT was transferred to
                <span style="font-family:var(--font-mono);color:${isMyWin ? 'var(--glow)' : 'var(--text2)'}">${shortAddr(a.winner)}${isMyWin ? ' (You)' : ''}</span>
                ${a.tokenId ? `· Token <span style="font-family:var(--font-mono);color:var(--blue)">#${esc(a.tokenId)}</span>` : ''}
              </div>
            </div>
            <div style="font-size:10px;color:var(--text4);white-space:nowrap">${timeAgo(claimedTs)}</div>
          </div>`,
        });
      }

    } // end if (a.finalized && a.winner ...)

    // My bids in active auctions
    const mySecret = S.localSecrets[a.id] ?? S.localSecrets[a._fbKey ?? ''];
    if (mySecret && myAddr) {
      const phaseColors = ['var(--glow)', 'var(--gold)', 'var(--text3)'];
      const phaseLbls   = ['Active — bidding open', 'Bidding closed — pending settlement', 'Finalized'];
      events.push({
        ts: mySecret.ts || 0,
        html: `<div class="activity-item" style="align-items:flex-start">
          <div style="width:28px;height:28px;border-radius:50%;background:rgba(0,229,195,0.10);border:1px solid rgba(0,229,195,0.25);
            display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">💰</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;color:var(--text)">Your Bid Committed</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;line-height:1.5">
              <span style="color:var(--text2)">${esc(a.itemName)}</span> ·
              Bid: <span style="font-family:var(--font-mono);color:var(--glow)">${parseFloat(mySecret.amount || '0').toFixed(4)} ETH</span><br>
              <span style="color:${phaseColors[phase]}">${phaseLbls[phase]}</span>
            </div>
          </div>
          <div style="font-size:10px;color:var(--text4);white-space:nowrap">${timeAgo(mySecret.ts || 0)}</div>
        </div>`,
      });
    }
  });

  if (!events.length) {
    container.innerHTML = `
      <div style="font-size:12px;color:var(--text3);padding:1rem 0;text-align:center;line-height:1.7">
        <div style="font-size:1.5rem;margin-bottom:6px">🌐</div>
        No activity recorded yet.<br>Bids, settlements, and NFT transfers will appear here.
      </div>`;
    return;
  }

  events.sort((a, b) => b.ts - a.ts);
  container.innerHTML = events.slice(0, 10).map(e => e.html).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECENT ACTIVITY PAGE — Firebase realtime, filtered by logged-in wallet
// ─────────────────────────────────────────────────────────────────────────────

const RA_TYPE_ICONS: Record<string, string> = {
  bid:          'bi-receipt-cutoff',
  create:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:1em;height:1em;vertical-align:-0.125em;fill:currentColor"><path d="M222.716 311.307l-109.3-84.325c-8.698-6.709-21.195-5.09-27.898 3.602-6.708 8.691-5.103 21.189 3.601 27.898l109.293 84.318c8.705 6.708 21.196 5.103 27.905-3.595 7.709-9.699 6.097-22.19-2.601-28.898z"/><path d="M236.318 67.662l109.307 84.318c8.698 6.716 21.189 5.104 27.898-3.594 6.709-8.698 5.097-21.182-3.601-27.898l-109.3-84.324c-8.698-6.709-21.189-5.09-27.898 3.601-6.709 8.697-5.096 21.189 3.594 27.897z"/><polygon points="226.824,78.068 122.491,213.304 233.65,299.048 337.977,163.812"/><path d="M501.529 363.144l-185.626-143.2-32.864 42.598 185.633 143.2c11.764 9.075 28.652 6.901 37.72-4.864 9.082-11.771 6.901-28.659-4.863-37.734z"/><path d="M186.936 409.748c0-14.274-11.565-25.847-25.84-25.847H39.689c-14.274 0-25.84 11.572-25.84 25.847v19.166h173.087v-19.166z"/><rect x="0" y="445.143" width="200.786" height="34.833"/></svg>`,
  finalized:    'bi-trophy-fill',
  nft_claim:    'bi-image-fill',
  eth_received: 'bi-coin',
  refund:       'bi-arrow-counterclockwise',
  connect:      'bi-wallet2',
  transfer:     'bi-send-fill',
};
const RA_TYPE_LABELS: Record<string, string> = {
  bid:          'BID',
  create:       'CREATE',
  finalized:    'SETTLED',
  nft_claim:    'NFT CLAIM',
  eth_received: 'ETH RECEIVED',
  refund:       'REFUND',
  connect:      'CONNECT',
  transfer:     'TRANSFER',
};
const RA_TYPE_CLASS: Record<string, string> = {
  bid:          'bid',
  create:       'auction',
  finalized:    'win',
  nft_claim:    'bid',
  eth_received: 'win',
  refund:       'error',
  connect:      'system',
  transfer:     'reveal',
};

function raApplyFilter(): void {
  const q = S.raSearch.toLowerCase();
  S.raFiltered = S.raAllItems.filter(it => {
    const typeClass = RA_TYPE_CLASS[it.type || it.event || ''] || 'system';
    // map filter tab → type groups
    let matchFilter = true;
    if (S.raFilter === 'bid')     matchFilter = (it.type === 'bid');
    else if (S.raFilter === 'reveal')  matchFilter = (it.type === 'finalized' || it.type === 'nft_claim' || it.type === 'eth_received');
    else if (S.raFilter === 'auction') matchFilter = (it.type === 'create');
    else if (S.raFilter === 'system')  matchFilter = (it.type === 'connect' || it.type === 'refund' || it.type === 'transfer');
    const detail = (it.detail || it.text || '').toLowerCase();
    const matchSearch = !q || detail.includes(q) || (it.auctionName||'').toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });
  S.raPage = 1;
  raRenderPage();
}

function raRenderItem(it: any): string {
  const type      = it.type || it.event || 'connect';
  const icon      = RA_TYPE_ICONS[type] || 'bi-circle-fill';
  const tagClass  = RA_TYPE_CLASS[type] || 'system';
  const tagLabel  = RA_TYPE_LABELS[type] || type.toUpperCase();
  // For bids: conceal amount — auction is sealed until reveal
  const isBid     = type === 'bid';
  const rawDetail = it.detail || it.text || '—';
  const detail    = isBid
    ? rawDetail.replace(/placed a bid of [\d.]+ ETH on /i, 'placed a sealed bid on ')
               .replace(/ of [\d.]+ ETH /i, ' ')
    : rawDetail;
  // Only show ETH amount for non-bid events
  const amt       = (!isBid && it.amount) ? `<div class="ra-amount">${parseFloat(it.amount).toFixed(4)} ETH</div>` : '';
  const txLink    = it.txHash
    ? `<a href="https://sepolia.etherscan.io/tx/${it.txHash}" target="_blank" rel="noopener"
         style="font-size:10px;color:var(--blue);text-decoration:none;font-family:var(--font-mono);
                display:inline-flex;align-items:center;gap:2px;margin-top:3px">
         <i class="bi bi-box-arrow-up-right" style="font-size:9px"></i>
         ${it.txHash.slice(0,10)}…${it.txHash.slice(-6)}
       </a>` : '';
  const titleMap: Record<string,string> = {
    bid: 'Bid Placed', create: 'Auction Created', finalized: 'Auction Settled',
    nft_claim: 'NFT Claimed', eth_received: 'ETH Received', refund: 'Bid Refunded',
    connect: 'Wallet Connected', transfer: 'ETH Transferred',
  };
  const title = titleMap[type] || esc(it.text || 'Activity');
  const auctionTag = it.auctionName
    ? `<span style="font-size:10px;color:var(--text3);font-family:var(--font-mono)">${esc(it.auctionName)}</span>` : '';

  const iconHTML = icon.startsWith('<svg') ? icon : `<i class="bi ${icon}"></i>`;
  return `<div class="ra-item">
    <div class="ra-icon-wrap ${tagClass}">
      ${iconHTML}
    </div>
    <div class="ra-body">
      <div class="ra-title">${title}${auctionTag ? ' — ' : ''}${auctionTag}</div>
      <div class="ra-desc">${esc(detail)}</div>
      <div class="ra-meta">
        <span class="ra-tag ${tagClass}">${tagLabel}</span>
        <span class="ra-time"><i class="bi bi-clock" style="margin-right:3px"></i>${timeAgo(it.ts || 0)}</span>
        ${txLink}
      </div>
    </div>
    ${amt}
  </div>`;
}

function raRenderPage(): void {
  const listEl = document.getElementById('ra-list');
  if (!listEl) return;

  const total      = S.raFiltered.length;
  const totalPages = Math.max(1, Math.ceil(total / S.raPerPage));
  S.raPage         = Math.min(S.raPage, totalPages);
  const start      = (S.raPage - 1) * S.raPerPage;
  const slice      = S.raFiltered.slice(start, start + S.raPerPage);

  if (slice.length === 0) {
    listEl.innerHTML = `<div class="ra-empty">
      <div class="ra-empty-ico"><i class="bi bi-clock-history"></i></div>
      <div class="ra-empty-title">${S.wallet ? 'No activity found' : 'Connect wallet to view activity'}</div>
      <div class="ra-empty-sub">${S.wallet ? 'Try changing the filter or search query.' : 'Your bids, auctions, and transactions will appear here.'}</div>
    </div>`;
  } else {
    listEl.innerHTML = slice.map(raRenderItem).join('');
  }

  // Page info
  const infoEl = document.getElementById('ra-page-info');
  if (infoEl) infoEl.textContent = total === 0 ? 'No results' : (totalPages > 1 ? `Page ${S.raPage} of ${totalPages} · ${total} events` : `${total} event${total !== 1 ? 's' : ''}`);

  // Summary
  const sumEl = document.getElementById('ra-summary');
  if (sumEl) sumEl.textContent = `${S.raAllItems.length} total events`;

  raRenderPagination(totalPages);
  raUpdateStats();
  raUpdateTimeline();
}

function raRenderPagination(totalPages: number): void {
  const wrap = document.getElementById('ra-page-btns');
  if (!wrap) return;
  if (totalPages <= 1) { wrap.innerHTML = ''; return; }
  let html = `<button class="ra-pg-btn" id="ra-prev" ${S.raPage===1?'disabled':''}><i class="bi bi-chevron-left"></i></button>`;
  const pages: (number | string)[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (S.raPage > 3) pages.push('…');
    for (let i = Math.max(2, S.raPage-1); i <= Math.min(totalPages-1, S.raPage+1); i++) pages.push(i);
    if (S.raPage < totalPages-2) pages.push('…');
    pages.push(totalPages);
  }
  pages.forEach(p => {
    if (p === '…') html += `<span style="padding:0 4px;color:var(--text3);font-size:13px">…</span>`;
    else html += `<button class="ra-pg-btn${p===S.raPage?' active':''}" data-p="${p}">${p}</button>`;
  });
  html += `<button class="ra-pg-btn" id="ra-next" ${S.raPage===totalPages?'disabled':''}><i class="bi bi-chevron-right"></i></button>`;
  wrap.innerHTML = html;
  wrap.querySelectorAll<HTMLElement>('[data-p]').forEach(btn =>
    btn.addEventListener('click', () => { S.raPage = +btn.dataset.p!; raRenderPage(); }));
  wrap.querySelector<HTMLElement>('#ra-prev')?.addEventListener('click', () => { if (S.raPage>1){S.raPage--;raRenderPage();} });
  wrap.querySelector<HTMLElement>('#ra-next')?.addEventListener('click', () => { if (S.raPage<totalPages){S.raPage++;raRenderPage();} });
}

function raUpdateStats(): void {
  const all = S.raAllItems;
  const byType = (t: string) => all.filter(a => (a.type||a.event) === t).length;
  const s = (id: string, v: string | number) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  s('ra-stat-total',   all.length);
  s('ra-stat-bids',    byType('bid'));
  s('ra-stat-reveals', byType('finalized') + byType('nft_claim') + byType('eth_received'));
  s('ra-stat-auctions',byType('create'));
  s('ra-stat-last',    all[0] ? timeAgo(all[0].ts || 0) : '—');
  // badge counts
  s('ra-f-all',    all.length);
  s('ra-f-bid',    byType('bid'));
  s('ra-f-reveal', byType('finalized') + byType('nft_claim') + byType('eth_received'));
  s('ra-f-auction',byType('create'));
  s('ra-f-system', byType('connect') + byType('refund') + byType('transfer'));
}

function raUpdateTimeline(): void {
  const wrap = document.getElementById('ra-timeline');
  if (!wrap) return;
  const colors: Record<string,string> = {
    bid:'var(--blue)', create:'var(--purple)', finalized:'var(--gold)',
    nft_claim:'var(--blue)', refund:'var(--red)', connect:'var(--glow)', transfer:'var(--glow)',
  };
  wrap.innerHTML = S.raAllItems.slice(0, 6).map(it => {
    const type  = it.type || it.event || 'connect';
    const label = it.auctionName || it.text || type;
    return `<div class="ra-tl-item">
      <div class="ra-tl-dot" style="background:${colors[type]||'var(--text3)'}"></div>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(label)}</span>
      <span class="ra-tl-time">${timeAgo(it.ts||0)}</span>
    </div>`;
  }).join('') || '<div style="font-size:12px;color:var(--text3)">No events yet</div>';
}

/** Main entry point — called when navigating to vault/Recent Activity page */
function renderRecentActivityPage(): void {
  // Bind UI controls only once
  if (!(window as any)._raInitialized) {
    (window as any)._raInitialized = true;

    document.querySelectorAll<HTMLElement>('[data-ra-filter]').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('[data-ra-filter]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        S.raFilter = tab.dataset.raFilter!;
        raApplyFilter();
      });
    });

    document.getElementById('ra-search')?.addEventListener('input', e => {
      S.raSearch = (e.target as HTMLInputElement).value;
      raApplyFilter();
    });

    document.getElementById('ra-per-page')?.addEventListener('change', e => {
      S.raPerPage = +(e.target as HTMLSelectElement).value;
      S.raPage = 1;
      raRenderPage();
    });

    document.getElementById('btn-ra-clear')?.addEventListener('click', () => {
      if (!S.wallet) return;
      if (!confirm('Clear all activity history for this wallet?')) return;
      if (S.raUnsub) { S.raUnsub(); S.raUnsub = null; }
      S.raAllItems = [];
      S.raFiltered = [];
      raRenderPage();
    });
  }

  raLoadFromFirebase();
}

function raLoadFromFirebase(): void {
  // Unsubscribe previous listener
  if (S.raUnsub) { S.raUnsub(); S.raUnsub = null; }

  if (!S.wallet) {
    S.raAllItems = [];
    S.raFiltered = [];
    raRenderPage();
    return;
  }

  const addr = S.wallet.address.toLowerCase();

  if (!FB_CONFIGURED) {
    // Offline: build from local auction data (same as renderVaultRecentActivity)
    _raBuildFromLocal(addr);
    return;
  }

  // Show loading state
  const listEl = document.getElementById('ra-list');
  if (listEl) listEl.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:2rem;color:var(--text3)"><div class="spin-icon"></div> Loading activity...</div>`;

  try {
    // Primary query: all activity for this wallet (bid, create, connect, refund, ...)
    const q = query(
      collection(db, 'activity'),
      where('walletAddr', '==', addr),
      orderBy('ts', 'desc'),
      limit(200)
    );

    // Secondary query: events where this wallet is winner (nft_claim, finalized by others)
    const qWinner = query(
      collection(db, 'activity'),
      where('winner', '==', addr), // note: winner field stores checksum address
      orderBy('ts', 'desc'),
      limit(100)
    );

    // Secondary query: eth_received events for seller (written with walletAddr = seller)
    // already handled in primary query (walletAddr == addr), but need to handle winner (checksum)
    // Use winner lowercase field to match
    const qWinnerLower = query(
      collection(db, 'activity'),
      where('winnerAddr', '==', addr),
      orderBy('ts', 'desc'),
      limit(100)
    );

    // Merge multiple snapshots, deduplicate by _id
    const merge = (snapshots: any[][]): any[] => {
      const seen = new Set<string>();
      const result: any[] = [];
      for (const snap of snapshots) {
        for (const item of snap) {
          if (!seen.has(item._id)) { seen.add(item._id); result.push(item); }
        }
      }
      return result.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    };

    let mainItems: any[] = [];
    let winnerItems: any[] = [];

    // Run primary snapshot
    const unsub1 = onSnapshot(q, snap => {
      mainItems = [];
      snap.forEach(d => mainItems.push({ _id: d.id, ...d.data() }));
      const merged = merge([mainItems, winnerItems]);
      _raMergeLocalBids(merged, addr);
      S.raAllItems = merged;
      raApplyFilter();
    }, err => {
      console.warn('[RA] Data listener error:', err.message);
      _raBuildFromLocal(addr);
    });

    // Run winner snapshot (checksum address)
    const unsub2 = onSnapshot(qWinner, snap => {
      winnerItems = [];
      snap.forEach(d => winnerItems.push({ _id: d.id, ...d.data() }));
      const merged = merge([mainItems, winnerItems]);
      _raMergeLocalBids(merged, addr);
      S.raAllItems = merged;
      raApplyFilter();
    }, _err => {
      // Non-critical — winner query may fail if index not yet created
      console.warn('[RA] winner query error (non-critical):', _err.message);
    });

    // Combine unsubscribe
    S.raUnsub = () => { unsub1(); unsub2(); };
  } catch (e: any) {
    console.warn('[RA] query error:', e.message);
    _raBuildFromLocal(addr);
  }
}

/** Build activity list from local auction data when Firebase is unavailable */
function _raBuildFromLocal(addr: string): void {
  const items: any[] = [];
  S.auctions.forEach(a => {
    const isOwner  = a.owner?.toLowerCase() === addr;
    const isWinner = a.winner?.toLowerCase() === addr;
    const mySecret = S.localSecrets[a.id] ?? S.localSecrets[a._fbKey ?? ''];

    if (isOwner) {
      items.push({ type: 'create', auctionName: a.itemName, ts: a.createdAt || 0, walletAddr: addr });
    }
    if (a.finalized && isWinner) {
      items.push({ type: 'finalized', auctionName: a.itemName, amount: a.winningBid, ts: a.finalizedAt || a.createdAt || 0, walletAddr: addr });
    }
    if (a.itemClaimed && isWinner) {
      const ts = (a as any).claimedAt || (a.finalizedAt || a.createdAt || 0) + 10;
      items.push({ type: 'nft_claim', auctionName: a.itemName, ts, walletAddr: addr,
        detail: `${shortAddr(addr)} received the NFT "${a.itemName}"${a.tokenId ? ' · Token #' + a.tokenId : ''}`,
        nftContract: a.nftContract || '', tokenId: a.tokenId || '' });
    }
    // ETH received — seller when auction is finalized with a winner AND NFT has been claimed
    if (a.finalized && a.itemClaimed && isOwner && a.winner && a.winner !== '0x0000000000000000000000000000000000000000' && parseFloat(a.winningBid || '0') > 0) {
      const sellerReceived = (a as any).sellerReceived
        ? parseFloat((a as any).sellerReceived).toFixed(6)
        : (parseFloat(a.winningBid) * 0.975).toFixed(6);
      const ts = a.itemClaimed ? ((a as any).claimedAt || (a.finalizedAt || a.createdAt || 0) + 20) : (a.finalizedAt || a.createdAt || 0);
      items.push({ type: 'eth_received', auctionName: a.itemName, amount: sellerReceived, ts, walletAddr: addr,
        detail: `"${a.itemName}" settled · ${shortAddr(addr)} received ${sellerReceived} ETH (after 2.5% platform fee)`,
        winner: a.winner, winningBid: a.winningBid });
    }
    if (mySecret) {
      items.push({ type: 'bid', auctionName: a.itemName, amount: mySecret.amount, ts: mySecret.ts || 0, walletAddr: addr });
    }
  });
  items.sort((a, b) => b.ts - a.ts);
  S.raAllItems = items;
  raApplyFilter();
}

/** Merge local bid secrets that might not yet be in Firebase */
function _raMergeLocalBids(items: any[], addr: string): void {
  Object.entries(S.localSecrets).forEach(([auctionId, secret]) => {
    const alreadyIn = items.some(it => it.type === 'bid' && it.auctionId === String(auctionId));
    if (!alreadyIn && secret.ts) {
      const a = S.auctions.find(x => String(x.id) === String(auctionId) || x._fbKey === String(auctionId));
      items.push({
        type: 'bid',
        auctionName: a?.itemName || `Auction #${auctionId}`,
        auctionId: String(auctionId),
        amount: secret.amount,
        ts: secret.ts,
        walletAddr: addr,
        _local: true,
      });
    }
  });
  items.sort((a, b) => (b.ts||0) - (a.ts||0));
}


function startScanner(): void {
  renderScannerGrid();

  // Sort tabs
  document.querySelectorAll<HTMLElement>('.scanner-sort-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.scanner-sort-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      _scannerSort = tab.dataset.sort as 'heat' | 'bidders' | 'time';
      renderScannerGrid();
    });
  });

  fbListen('pulses', (data: any) => {
    if (!data) return;
    const events = (Object.values(data) as any[]).sort((a,b) => (b.ts||0) - (a.ts||0));
    renderPulseFeed(events.slice(0, 20));
    const now = Date.now();
    // Reset trước khi tính lại — tránh cộng dồn mỗi lần snapshot fire
    S.bidVelocities = {};
    events.forEach(e => {
      if (e.event === 'bid' && e.ts && (now - e.ts) < 3_600_000) {
        const key = String(e.auctionId);
        S.bidVelocities[key] = (S.bidVelocities[key] || 0) + 1;
      }
    });
    renderScannerGrid();
  });

  fbListen('watchers', (data: any) => {
    if (!data) return;
    // Firestore flat: each doc has { auctionId, address, ts }
    // Count docs per auctionId
    const counts: Record<string, number> = {};
    Object.values(data).forEach((v: any) => {
      if (v?.auctionId) counts[v.auctionId] = (counts[v.auctionId] || 0) + 1;
    });
    S.watcherCounts = counts;
    renderScannerGrid();
    renderWatcherList();
    renderVelocityChart();
  });
}

// Cache heat positions so scanner cards don't flicker on re-render
const _heatPos: Record<string, { x: number; y: number }> = {};
let _scannerSort: 'heat' | 'bidders' | 'time' = 'heat';

function renderScannerGrid(): void {
  const grid = document.getElementById('scanner-grid')!;
  const allActive = S.auctions.filter(a => calcPhase(a) <= 1);

  if (!allActive.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      <div class="empty-ico"><i class="bi bi-broadcast" style="color:var(--text4)"></i></div>
      <div class="empty-title">No active auctions to scan</div>
    </div>`;
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // Compute heat scores
  const withHeat = allActive.map(a => {
    const watchers = S.watcherCounts[String(a.id)] || S.watcherCounts[String(a._fbKey)] || 0;
    const velocity = S.bidVelocities[String(a.id)] || S.bidVelocities[String(a._fbKey)] || 0;
    const heat     = Math.min(100, (watchers * 15) + (velocity * 20) + ((a.totalBidders || 0) * 5));
    return { a, watchers, velocity, heat };
  });

  // Sort
  if (_scannerSort === 'heat')    withHeat.sort((x,y) => y.heat - x.heat);
  if (_scannerSort === 'bidders') withHeat.sort((x,y) => (y.a.totalBidders||0) - (x.a.totalBidders||0));
  if (_scannerSort === 'time')    withHeat.sort((x,y) => (x.a.biddingEnd||0) - (y.a.biddingEnd||0));

  // Update summary bar
  const hotCount      = withHeat.filter(x => x.heat > 60).length;
  const totalWatchers = withHeat.reduce((s,x) => s + x.watchers, 0);
  const avgVelocity   = withHeat.length ? (withHeat.reduce((s,x) => s + x.velocity, 0) / withHeat.length).toFixed(1) : '0';
  const scHot = document.getElementById('sc-hot-count');
  const scWat = document.getElementById('sc-watcher-total');
  const scVel = document.getElementById('sc-velocity-avg');
  const scCnt = document.getElementById('sc-card-count');
  if (scHot) scHot.textContent = String(hotCount);
  if (scWat) scWat.textContent = String(totalWatchers);
  if (scVel) scVel.textContent = avgVelocity;
  if (scCnt) scCnt.textContent = String(allActive.length);

  grid.innerHTML = withHeat.map(({ a, watchers, velocity, heat }) => {
    const heatClass = heat > 60 ? 'heat-high' : heat > 30 ? 'heat-medium' : 'heat-low';
    const heatColor = heat > 60 ? 'var(--red)' : heat > 30 ? 'var(--gold)' : 'var(--glow)';
    const heatIcon  = heat > 60 ? '🔥' : heat > 30 ? '⚡' : '❄️';
    const emoji     = EMOJIS[(((parseInt(String(a.id)) || 1) - 1) % EMOJIS.length + EMOJIS.length) % EMOJIS.length];
    const phase     = calcPhase(a);
    const phaseLbl  = ['BIDDING', 'ENDED', 'FINALIZED'][phase];
    const aKey      = String(a.id || a._fbKey);
    const idAttr    = a.id || a._fbKey;
    if (!_heatPos[aKey]) _heatPos[aKey] = { x: 30 + Math.random() * 40, y: 30 + Math.random() * 40 };
    const heatX     = _heatPos[aKey].x;
    const heatY     = _heatPos[aKey].y;
    const timeLeft  = a.biddingEnd > now ? formatCountdown(a.biddingEnd) : 'Ended';

    return `<div class="scanner-card ${heatClass}"
        style="--heat-x:${heatX}%;--heat-y:${heatY}%;--heat-opacity:${(heat/100)*0.18}"
        data-auction-id="${idAttr}">
      <div class="sc-header">
        <div class="sc-emoji">${emoji}</div>
        <div class="sc-title-block">
          <div class="sc-name">${esc(a.itemName)}</div>
          <div class="sc-meta">
            <span style="color:${heatColor};font-weight:600">${phaseLbl}</span>
            <span class="sc-meta-sep">·</span>
            <span>${parseFloat(a.startPrice||'0').toFixed(5).replace(/\.?0+$/, '')} ETH</span>
            <span class="sc-meta-sep">·</span>
            <span>⏱ ${timeLeft}</span>
          </div>
        </div>
        <div class="sc-heat-icon">${heatIcon}</div>
      </div>
      <div class="sc-body">
        <div class="sc-heat-row">
          <span class="sc-heat-label">HEAT SCORE</span>
          <div class="sc-heat-track">
            <div class="sc-heat-fill" style="width:${heat}%"></div>
          </div>
          <span class="sc-heat-val">${heat}</span>
        </div>
        <div class="sc-stats">
          <div class="sc-stat">
            <span class="sc-stat-lbl">👁 Watchers</span>
            <span class="sc-stat-val" style="color:${heatColor}">${watchers}</span>
          </div>
          <div class="sc-stat">
            <span class="sc-stat-lbl">⚡ Bids/hr</span>
            <span class="sc-stat-val" style="color:${heatColor}">${velocity}</span>
          </div>
          <div class="sc-stat">
            <span class="sc-stat-lbl">👥 Bidders</span>
            <span class="sc-stat-val">${a.totalBidders || 0}</span>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll<HTMLElement>('.scanner-card[data-auction-id]').forEach(card =>
    card.addEventListener('click', () => openDetail(card.dataset.auctionId!)));
}

function renderPulseFeed(events: any[]): void {
  const el = document.getElementById('pulse-feed')!;
  const countEl = document.getElementById('pulse-count');
  if (countEl) countEl.textContent = events.length + ' events';
  const icons:  Record<string,string> = { bid:'💰', reveal:'👁', create:'🏷', finalized:'🏆' };
  const colors: Record<string,string> = { bid:'var(--glow)', reveal:'var(--gold)', create:'#a78bfa', finalized:'var(--red)' };
  if (!events.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:0.5rem 0">No events yet…</div>';
    return;
  }
  el.innerHTML = events.map(e => `
    <div class="pulse-event">
      <div class="pulse-dot-sm" style="background:${colors[e.event]||'var(--glow)'};color:${colors[e.event]||'var(--glow)'}"></div>
      <div class="pulse-ico">${icons[e.event]||'📡'}</div>
      <div class="pulse-txt"><strong>${e.event||'event'}</strong> · ${e.auctionName || '#'+e.auctionId || '?'}</div>
      <div class="pulse-time">${timeAgo(e.ts)}</div>
    </div>`).join('');
}

function renderWatcherList(): void {
  const el = document.getElementById('watcher-list')!;
  const sorted = Object.entries(S.watcherCounts).sort((a,b) => b[1] - a[1]).slice(0, 6);
  if (!sorted.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:0.3rem 0">No active watchers.</div>';
    return;
  }
  const max = sorted[0][1] || 1;
  el.innerHTML = sorted.map(([id, count]) => {
    const a = S.auctions.find(x => String(x.id) === String(id) || x._fbKey === String(id));
    return `<div class="vel-row">
      <div class="vel-label">${esc(a?.itemName || '#'+id)}</div>
      <div class="vel-bar-wrap"><div class="vel-bar" style="width:${(count/max)*100}%;background:linear-gradient(90deg,rgba(0,158,140,0.5),var(--glow))"></div></div>
      <div class="vel-val" style="color:var(--glow)">👁 ${count}</div>
    </div>`;
  }).join('');
}

function renderVelocityChart(): void {
  const el   = document.getElementById('velocity-chart')!;
  const data = Object.entries(S.bidVelocities).sort((a,b) => b[1] - a[1]).slice(0, 6);
  if (!data.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:0.3rem 0">No bid activity yet.</div>';
    return;
  }
  const maxV = Math.max(...data.map(d => d[1]));
  el.innerHTML = data.map(([id, v]) => {
    const a = S.auctions.find(x => String(x.id) === String(id) || x._fbKey === String(id));
    return `<div class="vel-row">
      <div class="vel-label">${esc(a?.itemName || '#'+id)}</div>
      <div class="vel-bar-wrap"><div class="vel-bar" style="width:${(v/maxV)*100}%"></div></div>
      <div class="vel-val">${v}</div>
    </div>`;
  }).join('');
}


// ─────────────────────────────────────────────────────────────────────────────
//  ANALYTICS  —  Firebase realtime data
// ─────────────────────────────────────────────────────────────────────────────
function renderAnalytics(): void {
  renderAnalyticsKPIs();
  renderActivityBarChart();
  renderPhaseDonut();
  renderBidHistory();
  renderTopAuctions();
}

/** KPI mini-cards above charts */
function renderAnalyticsKPIs(): void {
  const total     = S.auctions.length;
  const live      = S.auctions.filter(a => calcPhase(a) === 0).length;
  const completed = S.auctions.filter(a => a.finalized).length;

  // Volume: only count finalized auctions with a real winner (winningBid > 0)
  const finalizedWithWinner = S.auctions.filter(a =>
    a.finalized && a.winner && a.winner !== '0x0000000000000000000000000000000000000000'
  );
  const vol = finalizedWithWinner.reduce((s, a) => {
    const bid = parseFloat(a.winningBid || '0');
    return s + (isNaN(bid) || bid <= 0 ? 0 : bid);
  }, 0);

  const bidders = S.auctions.reduce((s,a) => s + (a.totalBidders || 0), 0);

  // avgBid: calculated from bidder count of finalized auctions with a winner
  const finalizedBidders = finalizedWithWinner.reduce((s,a) => s + (a.totalBidders || 0), 0);
  const avgBid = finalizedBidders > 0 && vol > 0
    ? (vol / finalizedBidders).toFixed(4)
    : '—';
  const winRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  const grid = document.getElementById('analytics-kpi-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="analytics-mini-card">
      <div class="analytics-mini-label">Total Auctions</div>
      <div class="analytics-mini-val" style="color:var(--glow)">${total}</div>
      <div class="analytics-mini-sub">${live} active now</div>
    </div>
    <div class="analytics-mini-card">
      <div class="analytics-mini-label">Total Volume</div>
      <div class="analytics-mini-val" style="color:var(--gold)">${vol > 0 ? vol.toFixed(4) : '0'} ETH</div>
      <div class="analytics-mini-sub">${finalizedWithWinner.length} auction${finalizedWithWinner.length !== 1 ? 's' : ''} with winner</div>
    </div>
    <div class="analytics-mini-card">
      <div class="analytics-mini-label">Total Bidders</div>
      <div class="analytics-mini-val" style="color:var(--purple)">${bidders}</div>
      <div class="analytics-mini-sub">avg winning bid: ${avgBid} ETH</div>
    </div>
    <div class="analytics-mini-card">
      <div class="analytics-mini-label">Completion Rate</div>
      <div class="analytics-mini-val" style="color:var(--blue)">${winRate}%</div>
      <div class="analytics-mini-sub">${completed} of ${total} finalized</div>
    </div>`;
}

/** Bar chart — auctions created per day (last 7 days) from Firebase data */
function renderActivityBarChart(): void {
  const chartEl  = document.getElementById('chart-activity');
  const labelsEl = document.getElementById('chart-labels');
  if (!chartEl || !labelsEl) return;

  // Build 7-day buckets from real auction data
  const dayLabels: string[] = [];
  const dayVals: number[]   = [];
  const now = Date.now();

  for (let i = 6; i >= 0; i--) {
    const dayStart = now - (i + 1) * 86400000;
    const dayEnd   = now - i * 86400000;
    const d        = new Date(dayEnd);
    dayLabels.push(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]);
    const count = S.auctions.filter(a => {
      const ts = a.createdAt || 0;
      return ts >= dayStart && ts < dayEnd;
    }).length;
    dayVals.push(count);
  }

  // If no real data, show some simulated data for demo
  const hasRealData = dayVals.some(v => v > 0);
  const vals = hasRealData ? dayVals : [2,5,3,8,4,7, S.auctions.length || 1];
  const max  = Math.max(...vals, 1);

  // Today is the last bar — highlight it
  chartEl.innerHTML = vals.map((v, i) =>
    `<div class="bar${i === 6 ? ' today' : ''}" style="height:${Math.max(4, (v/max)*110)}px" data-val="${v}"></div>`
  ).join('');
  labelsEl.innerHTML = dayLabels.map(d => `<div class="bar-lbl">${d}</div>`).join('');
}

/** SVG donut chart for auction phases */
function renderPhaseDonut(): void {
  const phaseEl = document.getElementById('phase-stats');
  if (!phaseEl) return;

  const b = S.auctions.filter(a => calcPhase(a) === 0).length;
  const r = S.auctions.filter(a => calcPhase(a) === 1).length;
  const e = S.auctions.filter(a => calcPhase(a) === 2).length;
  const total = b + r + e || 1;

  // Build SVG donut
  const cx = 60, cy = 60, radius = 48, stroke = 14;
  const circumference = 2 * Math.PI * radius;
  const segments = [
    { val: b, color: '#00E5C3', label: 'Bidding' },
    { val: r, color: '#F5C842', label: 'Reveal' },
    { val: e, color: '#465070', label: 'Ended' },
  ];

  let offset = 0;
  const arcs = segments.map(seg => {
    const pct  = seg.val / total;
    const dash = pct * circumference;
    const gap  = circumference - dash;
    const arc  = `<circle cx="${cx}" cy="${cy}" r="${radius}"
      fill="none" stroke="${seg.color}" stroke-width="${stroke}"
      stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
      stroke-dashoffset="${(-offset * circumference / total).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})" opacity="${seg.val > 0 ? 0.9 : 0.12}"/>`;
    offset += seg.val;
    return arc;
  }).join('');

  const totalLabel = `<text x="${cx}" y="${cy - 6}" text-anchor="middle" font-family="var(--font-head)"
    font-size="18" font-weight="700" fill="var(--text)">${total}</text>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-family="var(--font-mono)"
    font-size="9" fill="var(--text3)" letter-spacing="0.06em">TOTAL</text>`;

  const legendItems = segments.map(seg => `
    <div class="phase-legend-item">
      <div class="phase-legend-dot" style="background:${seg.color}"></div>
      <span class="phase-legend-label">${seg.label}</span>
      <span class="phase-legend-val" style="color:${seg.color}">${seg.val}</span>
    </div>`).join('');

  phaseEl.innerHTML = `
    <div class="phase-donut-wrap">
      <svg class="phase-donut-svg" width="120" height="120" viewBox="0 0 120 120">
        <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--bg3)" stroke-width="${stroke}"/>
        ${arcs}
        ${totalLabel}
      </svg>
      <div class="phase-legend">${legendItems}</div>
    </div>`;
}

/** Bid history list */
function renderBidHistory(): void {
  const bhEl    = document.getElementById('bid-history-list');
  if (!bhEl) return;
  const secrets = Object.entries(S.localSecrets);
  if (!secrets.length) {
    bhEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:0.5rem 0">No bids yet.</div>';
    return;
  }
  bhEl.innerHTML = secrets.slice(0, 5).map(([id, s]) => {
    const a     = S.auctions.find(x => String(x.id) === String(id) || x._fbKey === String(id));
    const phase = a ? calcPhase(a) : 2;
    const phaseColor = ['var(--glow)', 'var(--gold)', 'var(--text3)'][phase];
    const phaseLbl   = ['BIDDING', 'ENDED', 'FINALIZED'][phase];
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;gap:8px">
      <div>
        <div style="font-family:var(--font-head);font-style:italic;font-size:0.85rem">${esc(a?.itemName || 'Auction #' + id)}</div>
        <div style="font-family:var(--font-mono);font-size:10px;color:${phaseColor};margin-top:2px">${phaseLbl}</div>
      </div>
      <div style="color:var(--glow);font-family:var(--font-mono);white-space:nowrap">${s.amount} ETH</div>
    </div>`;
  }).join('');
}

/** Top auctions by winning bid */
function renderTopAuctions(): void {
  const taEl = document.getElementById('top-auctions-list');
  if (!taEl) return;
  const top = [...S.auctions]
    .sort((a, b) => parseFloat(b.winningBid || '0') - parseFloat(a.winningBid || '0'))
    .slice(0, 5);
  if (!top.length || !top.some(a => parseFloat(a.winningBid || '0') > 0)) {
    taEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:0.5rem 0">No finalized auctions yet.</div>';
    return;
  }
  taEl.innerHTML = top.map((a, i) => {
    const bid = parseFloat(a.winningBid || '0');
    if (!bid) return '';
    const colors = ['var(--gold)', '#9CA3AF', '#d97706', 'var(--text2)', 'var(--text2)'];
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
      <div style="width:20px;height:20px;border-radius:50%;background:var(--bg3);border:1px solid var(--border);
        display:flex;align-items:center;justify-content:center;font-size:10px;font-family:var(--font-mono);
        color:${colors[i] || 'var(--text3)'};flex-shrink:0">${i + 1}</div>
      <div style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        font-family:var(--font-head);font-style:italic;font-size:0.85rem">${esc(a.itemName)}</div>
      <div style="color:var(--gold);font-family:var(--font-mono);white-space:nowrap">${bid.toFixed(5).replace(/\.?0+$/, '')} ETH</div>
    </div>`;
  }).join('');
}

function analyticsBar(label: string, val: number, total: number, color: string): string {
  const pct = total > 0 ? Math.round((val/total)*100) : 0;
  return `<div>
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
      <span style="color:var(--text2)">${label}</span>
      <span style="font-family:var(--font-mono);color:${color}">${val}</span>
    </div>
    <div style="height:6px;background:var(--bg3);border-radius:3px;overflow:hidden">
      <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width 0.5s"></div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  LEADERBOARD
// ─────────────────────────────────────────────────────────────────────────────
function renderLeaderboard(): void {
  const rankClasses = ['gold','silver','bronze','normal','normal'];
  const rowHTML = (addr: string, score: string, i: number) => `
    <div class="lb-row">
      <div class="lb-rank ${rankClasses[Math.min(i, 4)]}">${i+1}</div>
      <div class="lb-addr">${addr}</div>
      <div class="lb-score">${score}</div>
    </div>`;

  const NULL_ADDR = '0x0000000000000000000000000000000000000000';

  // Build bidder leaderboard from real auction data
  // Group by full lowercase address to avoid shortAddr collision, display with shortAddr
  const bidderMap: Record<string, number> = {};
  S.auctions
    .filter(a => a.finalized && a.winner && a.winner !== NULL_ADDR)
    .forEach(a => {
      const key = a.winner.toLowerCase();
      bidderMap[key] = (bidderMap[key] || 0) + parseFloat(a.winningBid || '0');
    });
  const bidderRows = Object.entries(bidderMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([addr, vol], i) => rowHTML(shortAddr(addr), vol.toFixed(6) + ' ETH', i));

  document.getElementById('lb-bidders')!.innerHTML = bidderRows.length
    ? bidderRows.join('')
    : '<div style="font-size:12px;color:var(--text3);padding:0.5rem">No finalized auctions yet.</div>';

  // Build creator leaderboard from real auction data
  // Group by full lowercase address to avoid shortAddr collision
  const creatorMap: Record<string, number> = {};
  S.auctions
    .filter(a => a.owner && a.owner !== NULL_ADDR)
    .forEach(a => {
      const key = a.owner.toLowerCase();
      creatorMap[key] = (creatorMap[key] || 0) + 1;
    });
  const creatorRows = Object.entries(creatorMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([addr, count], i) => rowHTML(shortAddr(addr), count + ' auction' + (count !== 1 ? 's' : ''), i));

  document.getElementById('lb-creators')!.innerHTML = creatorRows.length
    ? creatorRows.join('')
    : '<div style="font-size:12px;color:var(--text3);padding:0.5rem">No auctions created yet.</div>';
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACTIVITY FEED
// ─────────────────────────────────────────────────────────────────────────────
function activityIcon(type: string): string {
  const map: Record<string,string> = {
    bid:       '💰',
    create:    '🏷️',
    finalized: '🏆',
    nft_claim: '🖼️',
    refund:    '↩️',
    reveal:    '👁️',
    transfer:  '📤',
  };
  return map[type] || '📡';
}

function activityColor(type: string): string {
  const map: Record<string,string> = {
    bid:       'var(--glow)',
    create:    '#a78bfa',
    finalized: 'var(--gold)',
    nft_claim: 'var(--blue)',
    refund:    'var(--red)',
    reveal:    'var(--gold)',
    transfer:  'var(--text2)',
  };
  return map[type] || 'var(--glow)';
}

function activityTitle(it: any): string {
  switch (it.type || it.event) {
    case 'bid':       return '🔥 New Bid Placed';
    case 'create':    return '🎯 Auction Launched';
    case 'finalized': return '🏆 Auction Settled';
    case 'nft_claim': return '🖼️ NFT Claimed by Winner';
    case 'refund':    return '↩️ Bid Refunded';
    case 'reveal':    return '👁️ Bid Revealed';
    case 'transfer':  return '📤 ETH Transferred to Seller';
    default:          return esc(it.text || 'Activity');
  }
}

function shortAddrFmt(addr: string | undefined): string {
  if (!addr || addr.length < 10) return addr || '—';
  return `${addr.slice(0,6)}…${addr.slice(-4)}`;
}

function activityDetail(it: any): string {
  if (it.detail) return esc(it.detail);
  const name = it.auctionName || `Auction #${it.auctionId}`;
  switch (it.type || it.event) {
    case 'bid': {
      const bidder = shortAddrFmt(it.addr);
      // Conceal bid amount — sealed auction, amount hidden until reveal
      return `${bidder} placed a sealed bid on ${name}`;
    }
    case 'create': {
      const creator = shortAddrFmt(it.addr || it.seller);
      const minBid  = it.startPrice || it.amount;
      const minPart = minBid ? ` · min ${minBid} ETH` : '';
      return `${creator} created "${name}"${minPart}`;
    }
    case 'finalized': {
      const winner = shortAddrFmt(it.winner || it.addr);
      const price  = it.winningBid || it.amount || '?';
      return `${name} finalized · Winner: ${winner} · ${price} ETH`;
    }
    case 'nft_claim': {
      const claimer = shortAddrFmt(it.winner || it.addr);
      return `${claimer} claimed NFT from "${name}"`;
    }
    case 'refund': {
      const bidder = shortAddrFmt(it.addr);
      return `${bidder}'s bid of ${it.amount || '?'} ETH refunded from "${name}"`;
    }
    case 'transfer': {
      const seller = shortAddrFmt(it.seller || it.addr);
      return `${seller} received ${it.amount || '?'} ETH from "${name}"`;
    }
    default:
      return it.detail || '';
  }
}


function buildActivityFeedHTML(data: any, maxItems: number = 8): string {
  if (!data) return '<div style="font-size:12px;color:var(--text3);padding:0.5rem 0">No activity yet — auctions and results will appear here.</div>';
  // Sidebar shows meaningful public events: auction created, bid placed, settled, NFT claimed.
  const SIDEBAR_TYPES = new Set(['create', 'bid', 'finalized', 'nft_claim', 'eth_received', 'connect']);
  const items = (Object.values(data) as any[])
    .filter(it => SIDEBAR_TYPES.has(it.type || it.event || ''))
    .sort((a,b) => (b.ts||0)-(a.ts||0))
    .slice(0, maxItems);
  if (!items.length) return '<div style="font-size:12px;color:var(--text3);padding:0.5rem 0">No auction events yet — check back soon.</div>';
  return items.map(it => {
    const color  = it.color ? `var(--${it.color === 'green' ? 'glow' : it.color})` : activityColor(it.type || it.event || '');
    const title  = activityTitle(it);
    const detail = activityDetail(it);
    const txLink = it.txHash
      ? `<a href="https://sepolia.etherscan.io/tx/${it.txHash}" target="_blank" rel="noopener"
           style="font-size:10px;color:var(--blue);text-decoration:none;font-family:var(--font-mono);
                  display:inline-flex;align-items:center;gap:2px;margin-top:3px">
           <i class="bi bi-box-arrow-up-right" style="font-size:9px"></i>
           ${it.txHash.slice(0,10)}…${it.txHash.slice(-6)}
         </a>` : '';
    return `
    <div class="activity-item" style="align-items:flex-start;gap:10px">
      <div style="width:28px;height:28px;border-radius:50%;background:${color}18;border:1px solid ${color}40;
        display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;margin-top:1px">
        ${activityIcon(it.type || it.event || '')}
      </div>
      <div class="activity-text" style="flex:1;min-width:0">
        <div class="activity-action" style="color:var(--text);font-size:12px;font-weight:600">${title}</div>
        <div class="activity-detail" style="font-size:11px;color:var(--text3);margin-top:2px;line-height:1.4">${detail}</div>
        ${txLink}
      </div>
      <div class="activity-time" style="flex-shrink:0;white-space:nowrap">${timeAgo(it.ts)}</div>
    </div>`;
  }).join('');
}

function renderActivityFeed(data: any): void {
  const html = buildActivityFeedHTML(data, 8);
  // Render into main sidebar (#activity-feed on Auctions page)
  const el = document.getElementById('activity-feed');
  if (el) el.innerHTML = html;
  // Also render into How It Works sidebar (#how-activity-feed)
  const elHow = document.getElementById('how-activity-feed');
  if (elHow) elHow.innerHTML = html;
  // Also render into Recent Activity page (#vault-activity-body)
  const elVault = document.getElementById('vault-activity-body');
  if (elVault) elVault.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATS ROW
// ─────────────────────────────────────────────────────────────────────────────
function updateStats(): void {
  const total     = S.auctions.length;
  const live      = S.auctions.filter(a => calcPhase(a) === 0).length;
  const bidders   = S.auctions.reduce((s,a) => s + (a.totalBidders || 0), 0);
  const completed = S.auctions.filter(a => a.finalized).length;

  // Volume: only count winning bids of finalized auctions with a real winner
  const finalizedWithWinner = S.auctions.filter(a =>
    a.finalized && a.winner && a.winner !== '0x0000000000000000000000000000000000000000'
  );
  const vol = finalizedWithWinner.reduce((sum, a) => {
    const bid = parseFloat(a.winningBid || '0');
    return sum + (isNaN(bid) || bid <= 0 ? 0 : bid);
  }, 0);

  const fees = vol * 0.025;

  const sTotal     = document.getElementById('s-total');
  const sLive      = document.getElementById('s-live');
  const sBidders   = document.getElementById('s-bidders');
  const sVol       = document.getElementById('s-vol');
  const sCompleted = document.getElementById('s-completed');
  const sFees      = document.getElementById('s-fees');

  if (sTotal)     sTotal.textContent     = String(total);
  if (sLive)      sLive.textContent      = String(live);
  if (sBidders)   sBidders.textContent   = String(bidders);
  if (sVol)       sVol.textContent       = vol > 0 ? vol.toFixed(4) + ' ETH' : '0 ETH';
  if (sCompleted) sCompleted.textContent = String(completed);
  if (sFees)      sFees.textContent      = fees > 0 ? fees.toFixed(5).replace(/\.?0+$/, '') + ' ETH' : '0 ETH';
}

// ─────────────────────────────────────────────────────────────────────────────
//  OVERLAY HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function openOverlay(id: string): void  { document.getElementById(id)?.classList.add('open'); }
function closeOverlay(id: string): void { document.getElementById(id)?.classList.remove('open'); }

function showTxOverlay(title: string, msg: string): void {
  (document.getElementById('tx-ico')    as HTMLElement).textContent = '⏳';
  (document.getElementById('tx-title')  as HTMLElement).textContent = title;
  (document.getElementById('tx-msg')    as HTMLElement).textContent = msg;
  (document.getElementById('tx-footer') as HTMLElement).innerHTML  = '<div class="spin-icon" style="margin:0 auto"></div>';
  openOverlay('overlay-tx');
}
function hideTxOverlay(): void { closeOverlay('overlay-tx'); }

// ─────────────────────────────────────────────────────────────────────────────
//  TOAST
// ─────────────────────────────────────────────────────────────────────────────
function toast(title: string, msg: string, type: 'ok'|'err'|'info'): void {
  const icons: Record<string,string> = { ok:'✅', err:'❌', info:'💡' };
  const wrap = document.getElementById('toast-wrap')!;
  const el   = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-ico">${icons[type]||'ℹ️'}</div>
    <div><div class="toast-title">${esc(title)}</div><div class="toast-msg">${esc(msg)}</div></div>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 4600);
  setTimeout(() => el.remove(), 5100);
}


// ─────────────────────────────────────────────────────────────────────────────
//  AUTO-FINALIZE — detect ended auctions and re-render to show the button
//  IMPORTANT: finalizeAuction() is an on-chain tx → wallet signature REQUIRED.
//  Cannot run silently without prompting the wallet.
//  Instead: just re-render UI to show "Finalize" / "Cancel & Reclaim" button.
//  Seller clicks → MetaMask prompts exactly once when needed.
// ─────────────────────────────────────────────────────────────────────────────

// Track auction IDs that have already been detected as ended so we don't re-render repeatedly
const _detectedEndedIds = new Set<string>();

async function autoFinalizeEndedAuctions(): Promise<void> {
  // Re-render only when a NEW auction transitions to ended for the first time
  const now = Math.floor(Date.now() / 1000);
  let hasNew = false;
  for (const a of S.auctions) {
    if (!a.finalized && a.phase !== 2 && a.biddingEnd && now >= a.biddingEnd) {
      const key = String(a.id || a._fbKey);
      if (!_detectedEndedIds.has(key)) {
        _detectedEndedIds.add(key);
        hasNew = true;
      }
    }
  }
  // Clear stale keys for auctions that no longer exist
  for (const key of _detectedEndedIds) {
    if (!S.auctions.some(a => String(a.id || a._fbKey) === key)) {
      _detectedEndedIds.delete(key);
    }
  }
  if (hasNew) renderAuctions();
}

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL COUNTDOWN TIMERS
// ─────────────────────────────────────────────────────────────────────────────
function startGlobalTimers(): void {
  setInterval(() => {
    document.querySelectorAll<HTMLElement>('[data-ts]').forEach(el => {
      const ts = parseInt(el.dataset.ts || '0');
      if (!ts) return;
      const cd = formatCountdown(ts);
      // .a-card-timer has a <span> for the text so the pulse dot is preserved
      if (el.classList.contains('a-card-timer')) {
        const span = el.querySelector('span');
        if (span) span.textContent = cd;
      } else {
        el.textContent = cd;
      }
    });

    // Refresh auction cards that just ended bidding (phase 0→1 transition)
    // or claim deadline expired — re-render grid automatically
    // Only trigger for auctions CURRENTLY in phase 0 (active) that are about to end
    const now = Math.floor(Date.now() / 1000);
    const needsRefresh = S.auctions.some(a => {
      if (calcPhase(a) === 0 && a.biddingEnd && a.biddingEnd - now >= 0 && a.biddingEnd - now < 2) return true;
      const claimDl = (a as any).claimDeadline;
      if (claimDl && Math.abs(Math.floor(claimDl/1000) - now) < 2) return true;
      return false;
    });
    if (needsRefresh) renderAuctions();

  }, 1000);

  // Auto-finalize on a separate 5s interval — less aggressive than every tick
  setInterval(() => { void autoFinalizeEndedAuctions(); }, 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
//  CURSOR GLOW
// ─────────────────────────────────────────────────────────────────────────────
function initCursorGlow(): void {
  const glow = document.getElementById('cursor-glow')!;
  let ticking = false;
  document.addEventListener('mousemove', e => {
    if (!ticking) {
      requestAnimationFrame(() => {
        glow.style.left    = e.clientX + 'px';
        glow.style.top     = e.clientY + 'px';
        glow.style.opacity = '1';
        ticking = false;
      });
      ticking = true;
    }
  });
  document.addEventListener('mouseleave', () => glow.style.opacity = '0');
}

// ─────────────────────────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────────────────────────
function calcPhase(a: Auction): 0|1|2 {
  // Contract Phase: 0=BIDDING, 1=ENDED, 2=FINALIZED
  // Already finalized (phase=2) — return 2
  if (a.finalized || a.phase === 2) return 2;
  // On-chain phase=1 (ENDED) — trust contract over local time
  if (a.phase === 1) return 1;
  const now = Math.floor(Date.now() / 1000);
  if (!a?.biddingEnd) return 2;
  // If biddingStart is set and hasn't arrived yet → treat as BIDDING (phase 0)
  // but caller should check isUpcoming() separately to show correct tab
  if (now < a.biddingEnd) return 0;   // BIDDING (or upcoming — check biddingStart separately)
  return 1;                            // ENDED (awaiting finalize)
}

/** Returns true when auction has a future biddingStart that hasn't arrived yet */
function isUpcoming(a: Auction): boolean {
  if (a.finalized || a.phase === 2 || a.phase === 1) return false;
  if (!a.biddingStart) return false;
  return a.biddingStart > Math.floor(Date.now() / 1000);
}

function formatCountdown(ts: number): string {
  const diff = ts - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'Ended';
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h >= 24) return `${Math.floor(h/24)}d ${h%24}h`;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr || '—';
  return addr.slice(0,6) + '…' + addr.slice(-4);
}

function timeAgo(ts: number): string {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)    return diff + 's ago';
  if (diff < 3600)  return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}

function esc(s: string | undefined | null): string {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
//  AI CHATBOX — powered by Groq (llama-3.3-70b-versatile)
//  Env: VITE_GROQ_API_KEY in .env
// ─────────────────────────────────────────────────────────────────────────────
const GROQ_KEY = (import.meta as any).env?.VITE_GROQ_API_KEY ?? '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; }
const chatHistory: ChatMessage[] = [];

function getAuctionContext(): string {
  const now = Math.floor(Date.now() / 1000);
  const activeAuctions = S.auctions.filter(a => calcPhase(a) === 0);
  const completed = S.auctions.filter(a => a.finalized && a.winner && a.winner !== '0x0000000000000000000000000000000000000000');
  const totalVol = completed.reduce((s, a) => s + parseFloat(a.winningBid || '0'), 0);

  const auctionList = S.auctions.slice(0, 10).map(a => {
    const ph = calcPhase(a);
    const phaseName = ['BIDDING', 'ENDED', 'FINALIZED'][ph];
    return `  - #${a.id || a._fbKey}: "${a.itemName}" | Phase: ${phaseName} | Min: ${a.startPrice} ETH | Bidders: ${a.totalBidders || 0}${a.finalized && a.winner && a.winner !== '0x0000000000000000000000000000000000000000' ? ` | Winner: ${shortAddr(a.winner)} @ ${parseFloat(a.winningBid||'0').toFixed(4)} ETH` : ''}`;
  }).join('\n');

  const walletInfo = S.wallet
    ? `Connected wallet: ${shortAddr(S.wallet.address)} on Sepolia`
    : 'No wallet connected';

  return `[CURRENT AUCTION STATE]
- ${walletInfo}
- Total auctions: ${S.auctions.length}
- Active (bidding): ${activeAuctions.length}
- Completed with winner: ${completed.length}
- Total volume: ${totalVol.toFixed(4)} ETH
- ETH price: ~$${S.ethPrice}
- Contract: ${CONTRACT_ADDRESS} (Sepolia)

Recent auctions (up to 10):
${auctionList || '  (none yet)'}`;
}

function initChatbox(): void {
  // Create chatbox HTML
  const chatEl = document.createElement('div');
  chatEl.id = 'ai-chatbox';
  chatEl.innerHTML = `
    <div id="chat-toggle-btn" title="AI Assistant">
      <span id="chat-toggle-ico">🤖</span>
      <span id="chat-toggle-label">AI</span>
    </div>
    <div id="chat-panel">
      <div id="chat-header">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="chat-avatar-ring">
            <span style="font-size:1.1rem">🤖</span>
          </div>
          <div>
            <div style="font-family:var(--font-head);font-weight:700;font-size:13px;letter-spacing:0.02em">SecretBid AI</div>
            <div style="font-size:10px;color:rgba(255,255,255,0.55);font-family:var(--font-mono);display:flex;align-items:center;gap:4px">
              <span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:#4ade80;box-shadow:0 0 5px #4ade80"></span>
              Assistant
            </div>
          </div>
        </div>
        <button id="chat-close-btn" style="background:none;border:none;color:rgba(255,255,255,0.55);cursor:pointer;font-size:18px;padding:2px;line-height:1;border-radius:6px;transition:all 0.15s" onmouseenter="this.style.color='#fff'" onmouseleave="this.style.color='rgba(255,255,255,0.55)'">✕</button>
      </div>
      <div id="chat-messages">
        <div class="chat-msg assistant">
          <div class="chat-bubble">
            👋 Hi there! I'm the SecretBid AI assistant. I can help you with:<br><br>
            • How sealed auctions work<br>
            • Live auction info &amp; stats<br>
            • Bidding strategy tips<br>
            • DeFi / NFT concepts<br><br>
            What can I help you with?
          </div>
        </div>
      </div>
      <div id="chat-input-area">
        <div id="chat-suggestions">
          <button class="chat-sug" data-q="How many auctions are currently live?">📊 Live auctions</button>
          <button class="chat-sug" data-q="How do I win a bid?">🏆 Bid strategy</button>
          <button class="chat-sug" data-q="What are the platform fees?">💰 Fees</button>
          <button class="chat-sug" data-q="Can I get a refund on my ETH bid?">↩️ Refund ETH</button>
        </div>
        <div id="chat-input-row">
          <textarea id="chat-input" placeholder="Ask about auctions, bidding, NFTs…" rows="1"></textarea>
          <button id="chat-send-btn" ${GROQ_KEY ? '' : 'disabled title="VITE_GROQ_API_KEY required"'}>
            <i class="bi bi-send-fill"></i>
          </button>
        </div>
        ${!GROQ_KEY ? `<div style="font-size:10px;color:var(--red);font-family:var(--font-mono);margin-top:4px;text-align:center">⚠️ Set VITE_GROQ_API_KEY in .env to enable AI</div>` : ''}
      </div>
    </div>`;
  document.body.appendChild(chatEl);

  // Toggle panel
  const toggleBtn = document.getElementById('chat-toggle-btn')!;
  const panel     = document.getElementById('chat-panel')!;
  const closeBtn  = document.getElementById('chat-close-btn')!;
  let panelOpen = false;

  toggleBtn.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    toggleBtn.classList.toggle('active', panelOpen);
  });
  closeBtn.addEventListener('click', () => {
    panelOpen = false;
    panel.classList.remove('open');
    toggleBtn.classList.remove('active');
  });

  // Suggestions
  document.querySelectorAll<HTMLElement>('.chat-sug').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.q!;
      const input = document.getElementById('chat-input') as HTMLTextAreaElement;
      input.value = q;
      sendChatMessage();
    });
  });

  // Send on btn / Enter
  document.getElementById('chat-send-btn')!.addEventListener('click', sendChatMessage);
  (document.getElementById('chat-input') as HTMLTextAreaElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });

  // Auto-resize textarea
  const ta = document.getElementById('chat-input') as HTMLTextAreaElement;
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
  });
}

function appendChatMsg(role: 'user' | 'assistant', text: string, isStreaming = false): HTMLElement {
  const messages = document.getElementById('chat-messages')!;
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `<div class="chat-bubble">${isStreaming ? '<span class="chat-typing"><span></span><span></span><span></span></span>' : esc(text).replace(/\n/g, '<br>')}</div>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

async function sendChatMessage(): Promise<void> {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('chat-send-btn') as HTMLButtonElement;
  const text = input.value.trim();
  if (!text || !GROQ_KEY) return;

  input.value = '';
  input.style.height = 'auto';

  // Hide suggestions after first message
  const sug = document.getElementById('chat-suggestions');
  if (sug) sug.style.display = 'none';

  appendChatMsg('user', text);
  chatHistory.push({ role: 'user', content: text });

  sendBtn.disabled = true;
  const assistantDiv = appendChatMsg('assistant', '', true);
  const bubble = assistantDiv.querySelector('.chat-bubble')!;

  const systemPrompt = `You are the AI assistant for SecretBid — a sealed-bid NFT auction platform on the Sepolia Ethereum testnet. Always respond in English.

Platform facts:
- Each auction requires an NFT (ERC-721 or ERC-1155) deposited into the smart contract
- Bidders send ETH directly to the contract — highest bid wins
- Platform fee: 2.5% of the winning bid
- Seller receives 97.5% of the winning amount
- After finalization, the winner has 3 days to claim the NFT
- If the NFT is not claimed within 3 days: NFT returns to seller, ETH is forfeited
- Losing bidders can refund their full ETH bid at any time
- Smart contract: ${CONTRACT_ADDRESS} on Sepolia

${getAuctionContext()}

Reply concisely, factually, and helpfully. Use real data from the context above when answering specific questions about auctions.`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 600,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          ...chatHistory.slice(-10),  // send at most 10 recent turns
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any)?.error?.message ?? `HTTP ${res.status}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    bubble.innerHTML = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');
      for (const line of lines) {
        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            fullText += delta;
            bubble.innerHTML = esc(fullText).replace(/\n/g, '<br>');
            document.getElementById('chat-messages')!.scrollTop = 99999;
          }
        } catch {}
      }
    }

    chatHistory.push({ role: 'assistant', content: fullText });
  } catch (e: any) {
    bubble.innerHTML = `<span style="color:var(--red)">❌ Error: ${esc(e.message?.slice(0, 100) ?? 'Unknown error')}</span>`;
  } finally {
    sendBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BID CONFIRMATION MODAL
// ─────────────────────────────────────────────────────────────────────────────
function showBidConfirmModal(auctionId: number | string, amt: number, a: Auction, onConfirm: () => void): void {
  const existing = document.getElementById('overlay-bid-confirm');
  if (existing) existing.remove();

  const usd = S.ethPrice ? ` ≈ $${(amt * S.ethPrice).toLocaleString('en', { maximumFractionDigits: 2 })}` : '';
  const isUpdate = !!(S.localSecrets[a._fbKey ?? ''] || S.localSecrets[String(a.id)]);
  const timeLeft = a.biddingEnd - Math.floor(Date.now() / 1000);
  const urgencyNote = timeLeft < 3600
    ? `<div style="padding:8px 11px;background:rgba(220,38,38,0.07);border:1px solid rgba(220,38,38,0.25);border-radius:var(--r2);font-size:11.5px;color:var(--red);font-weight:600">⚡ Closing in ${formatCountdown(a.biddingEnd)} — act fast!</div>`
    : '';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'overlay-bid-confirm';
  overlay.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-header">
        <div class="modal-title">Confirm ${isUpdate ? 'Bid Update' : 'Bid'}</div>
        <button class="modal-close" id="bid-confirm-close"><i class="bi bi-x-lg"></i></button>
      </div>
      <div class="modal-body">
        <div style="text-align:center;padding:1rem 0 1.2rem">
          <div style="font-size:2.8rem;font-family:var(--font-mono);font-weight:800;color:var(--glow);line-height:1">${amt.toFixed(4)}</div>
          <div style="font-size:13px;color:var(--text3);margin-top:4px">ETH${usd}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);padding:9px 11px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Item</div>
            <div style="font-size:12px;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.itemName)}</div>
          </div>
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);padding:9px 11px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Auction</div>
            <div style="font-size:12px;color:var(--text);font-weight:600">#${a.id || a._fbKey}</div>
          </div>
        </div>
        ${urgencyNote}
        <div style="margin:12px 0;padding:10px 12px;background:rgba(220,38,38,0.05);border:1px solid rgba(220,38,38,0.2);border-radius:var(--r2);font-size:11.5px;color:var(--text2);line-height:1.7">
          ⚠️ <strong style="color:var(--text)">Sealed bids cannot be withdrawn.</strong> Once placed, your ETH is locked until the auction is finalized and you either win or get refunded.
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px">
          <button class="btn btn-ghost" id="bid-confirm-cancel">Cancel</button>
          <button class="btn btn-primary" id="bid-confirm-ok" style="background:linear-gradient(135deg,var(--glow),#00b8a0)">
            <i class="bi bi-lightning-fill"></i> ${isUpdate ? 'Raise Bid' : 'Place Bid'}
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 220); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('bid-confirm-close')?.addEventListener('click', close);
  document.getElementById('bid-confirm-cancel')?.addEventListener('click', close);
  document.getElementById('bid-confirm-ok')?.addEventListener('click', () => {
    close();
    onConfirm();
  });

  requestAnimationFrame(() => overlay.classList.add('open'));
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISPUTES
// ─────────────────────────────────────────────────────────────────────────────
function openDisputeModal(): void {
  if (!S.wallet) { toast('Connect Wallet', 'Please connect your wallet to open a dispute.', 'err'); return; }

  // Populate auction dropdown with user's auctions/bids
  const myKeys = Object.keys(S.localSecrets);
  const myAuctions = S.auctions.filter(a =>
    myKeys.includes(a._fbKey ?? '') || myKeys.includes(String(a.id)) ||
    a.owner?.toLowerCase() === S.wallet!.address.toLowerCase()
  );

  const opts = myAuctions.length
    ? myAuctions.map(a => `<option value="${esc(a._fbKey || String(a.id))}">#${a.id || a._fbKey} — ${esc(a.itemName)}</option>`).join('')
    : `<option value="">No related auctions found</option>`;

  const sel = document.getElementById('dispute-auction-sel');
  if (sel) sel.innerHTML = `<option value="">Select auction…</option>` + opts;

  openOverlay('overlay-dispute');
}

async function handleDisputeSubmit(): Promise<void> {
  const auctionVal  = (document.getElementById('dispute-auction-sel') as HTMLSelectElement)?.value?.trim();
  const typeVal     = (document.getElementById('dispute-type-sel') as HTMLSelectElement)?.value?.trim();
  const descVal     = (document.getElementById('dispute-desc-inp') as HTMLTextAreaElement)?.value?.trim();
  const evidenceVal = (document.getElementById('dispute-evidence-inp') as HTMLInputElement)?.value?.trim();

  if (!auctionVal) { toast('Required', 'Please select an auction.', 'err'); return; }
  if (!typeVal)    { toast('Required', 'Please select a dispute type.', 'err'); return; }
  if (!descVal || descVal.length < 20) { toast('Too short', 'Please describe the issue in at least 20 characters.', 'err'); return; }
  if (!S.wallet)   { toast('Not connected', '', 'err'); return; }

  const btn = document.getElementById('dispute-submit-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  try {
    const auction = S.auctions.find(a => (a._fbKey || String(a.id)) === auctionVal);
    const disputeData = {
      auctionId:     auctionVal,
      auctionName:   auction?.itemName || auctionVal,
      type:          typeVal,
      description:   descVal,
      evidence:      evidenceVal || '',
      walletAddr:    S.wallet.address.toLowerCase(),
      status:        'open',
      ts:            Date.now(),
    };
    await fbPush('disputes', disputeData);
    await fbPush('activity', {
      type: 'system', text: 'Dispute Filed', color: 'red', icon: '🚩',
      detail: `${shortAddr(S.wallet.address)} filed a dispute on ${auction?.itemName || auctionVal}`,
      ts: Date.now(),
      walletAddr: S.wallet.address.toLowerCase(),
    });

    closeOverlay('overlay-dispute');
    toast('Dispute Filed ✅', 'Your dispute has been submitted and will be reviewed by the DAO.', 'ok');
    loadDisputesList();

    // Reset form
    (document.getElementById('dispute-desc-inp') as HTMLTextAreaElement|null && (
      (document.getElementById('dispute-desc-inp') as HTMLTextAreaElement).value = ''
    ));
    (document.getElementById('dispute-evidence-inp') as HTMLInputElement|null && (
      (document.getElementById('dispute-evidence-inp') as HTMLInputElement).value = ''
    ));
  } catch (e: any) {
    toast('Failed', e.message?.slice(0, 80) ?? 'Unknown error', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Dispute'; }
  }
}

async function loadDisputesList(): Promise<void> {
  const container = document.getElementById('disputes-list-wrap');
  if (!container) return;
  if (!FB_CONFIGURED) {
    // Keep the static demo cards that are already in HTML
    return;
  }
  container.innerHTML = `<div style="padding:1.5rem;text-align:center"><div class="spin-icon" style="margin:0 auto"></div></div>`;
  try {
    const walletFilter = S.wallet?.address?.toLowerCase();
    const colRef = collection(db, 'disputes');
    const snap = walletFilter
      ? await getDocs(query(colRef, where('walletAddr', '==', walletFilter), orderBy('ts', 'desc'), limit(20)))
      : await getDocs(query(colRef, orderBy('ts', 'desc'), limit(20)));

    if (snap.empty) {
      container.innerHTML = `<div class="empty" style="padding:2rem 0"><div class="empty-ico">🏳️</div><div class="empty-title">No disputes yet</div><p style="font-size:13px;color:var(--text3);margin-top:4px">Click "Open Dispute" if you have an issue with an auction.</p></div>`;
      return;
    }

    const cards = snap.docs.map(d => {
      const it = d.data();
      const ago = (() => {
        const diff = Math.floor((Date.now() - (it.ts || 0)) / 1000);
        if (diff < 60)   return 'just now';
        if (diff < 3600) return Math.floor(diff/60) + 'm ago';
        if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
        return Math.floor(diff/86400) + 'd ago';
      })();
      const statusClass = it.status === 'resolved' ? 'resolved' : it.status === 'rejected' ? 'open' : 'open';
      const statusLabel = (it.status || 'open').toUpperCase();
      return `<div class="dispute-card">
        <div class="dispute-badge ${statusClass}">${statusLabel}</div>
        <div style="font-family:var(--font-head);font-weight:700;margin-bottom:4px;font-size:0.9rem;letter-spacing:0.04em;margin-top:8px">${esc(it.auctionName || it.auctionId)} — ${esc(it.type || 'General')}</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:10px">${esc(it.description?.slice(0,120) || '')}${it.description?.length > 120 ? '…' : ''}</div>
        ${it.evidence ? `<div style="font-size:11px;color:var(--text3);margin-bottom:6px;font-family:var(--font-mono)">Evidence: ${esc(it.evidence.slice(0,60))}</div>` : ''}
        <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono)">
          <i class="bi bi-clock" style="margin-right:4px"></i>Opened ${ago} · ${esc(it.walletAddr?.slice(0,6) ?? '')}…${esc(it.walletAddr?.slice(-4) ?? '')}
        </div>
      </div>`;
    }).join('');
    container.innerHTML = cards || `<div class="empty"><div class="empty-title">No disputes found</div></div>`;
  } catch (e: any) {
    console.warn('[Disputes] load error:', e.message);
    container.innerHTML = `<div class="empty"><div class="empty-title">Could not load disputes</div></div>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  lsLoadSecrets();
  startGlobalTimers();
  initCursorGlow();
  initChatbox();

  // ── Offline/demo mode banner ─────────────────────────────────────────────
  if (!FB_CONFIGURED) {
    const banner = document.createElement('div');
    banner.id = 'firebase-banner';
    banner.style.cssText = [
      'position:fixed;bottom:0;left:0;right:0;z-index:9999',
      'background:#7c3aed;color:#fff;font-size:12px;text-align:center',
      'padding:8px 16px;font-family:var(--font-mono,monospace)',
      'display:flex;align-items:center;justify-content:center;gap:10px',
    ].join(';');
    banner.innerHTML = `
      <span>⚠️ Firebase not configured — running in demo mode. Realtime features disabled.</span>
      <a href="https://console.firebase.google.com" target="_blank"
         style="color:#fde68a;text-decoration:underline;white-space:nowrap">Set up Firebase →</a>
      <button onclick="this.parentElement.remove()"
              style="background:none;border:none;color:#fff;cursor:pointer;font-size:14px;padding:0 4px">✕</button>`;
    document.body.appendChild(banner);
  }

  // Overlay backdrop close
  document.querySelectorAll('.overlay').forEach(o => {
    o.addEventListener('click', e => {
      if (e.target === o) closeOverlay((o as HTMLElement).id);
    });
  });

  // ── NAV bindings ────────────────────────────────────────────────────────
  const navBrand = document.querySelector<HTMLElement>('.nav-brand');
  navBrand?.addEventListener('click', e => { e.preventDefault(); navigate('auctions'); });

  document.querySelectorAll<HTMLElement>('.nav-tab[data-page]').forEach(tab =>
    tab.addEventListener('click', () => navigate(tab.dataset.page!))
  );
  document.querySelectorAll<HTMLElement>('.mob-nav-item[data-page]').forEach(item =>
    item.addEventListener('click', () => navigate(item.dataset.page!))
  );

  document.getElementById('nav-wallet-btn')?.addEventListener('click', handleWalletClick);

  // ── Filter tabs ─────────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.filter-tab[data-filter]').forEach(tab =>
    tab.addEventListener('click', () => setFilter(tab.dataset.filter as AppState['filter']))
  );

  // ── Search ──────────────────────────────────────────────────────────────
  document.getElementById('search-inp')?.addEventListener('input', () => { S.apPage = 1; renderAuctions(); });

  // ── Auctions per-page ───────────────────────────────────────────────────
  document.getElementById('ap-per-page')?.addEventListener('change', e => {
    S.apPerPage = +(e.target as HTMLSelectElement).value;
    S.apPage = 1;
    renderAuctions();
  });

  // ── MyBids per-page ─────────────────────────────────────────────────────
  document.getElementById('mb-per-page')?.addEventListener('change', e => {
    S.mbPerPage = +(e.target as HTMLSelectElement).value;
    S.mbPage = 1;
    renderMyBids();
  });

  // ── My Bids page ─────────────────────────────────────────────────────────
  document.getElementById('btn-export-all')?.addEventListener('click', exportAllSecrets);

  // ── Create page ──────────────────────────────────────────────
  document.getElementById('create-wall-connect')?.addEventListener('click', handleWalletClick);
  document.getElementById('btn-create-auction')?.addEventListener('click', handleCreateAuction);

  // ── NFT picker: tab switcher + verify button + rescan button
  initNftTabs();
  document.getElementById('btn-nft-verify')?.addEventListener('click', () => void verifyNft());
  document.getElementById('btn-rescan-nfts')?.addEventListener('click', () => void initNftCombobox(true));

  // ── Auction type toggle (Public / Private) ────────────────────────────────
  document.querySelectorAll<HTMLElement>('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const whitelistRow = document.getElementById('whitelist-row') as HTMLElement | null;
      if (whitelistRow) {
        whitelistRow.style.display = btn.dataset.type === 'private' ? 'block' : 'none';
      }
    });
  });

  // ── Whitelist address counter ─────────────────────────────────────────────
  document.getElementById('cf-whitelist')?.addEventListener('input', (e) => {
    const val = (e.target as HTMLTextAreaElement).value;
    const count = val.split('\n').map(s => s.trim()).filter(s => /^0x[0-9a-fA-F]{40}$/.test(s)).length;
    const hint = document.getElementById('whitelist-count');
    if (hint) hint.textContent = `${count} valid address${count !== 1 ? 'es' : ''}`;
  });

  // ── Start Date hint — show bidding end time ────────────────────────────────
  function updateStartDateHint(): void {
    const hint    = document.getElementById('start-date-hint');
    const sdEl    = document.getElementById('cf-start-date') as HTMLInputElement | null;
    if (!hint) return;
    const dateVal = sdEl?.value || '';
    const bidHrsV = parseFloat((document.getElementById('cf-bid-hrs') as HTMLInputElement)?.value || '0');
    const clearBorder = () => { if (sdEl) { sdEl.style.borderColor = ''; sdEl.style.boxShadow = ''; } };
    if (!dateVal) {
      hint.textContent = 'Leave blank to start immediately after deployment.';
      hint.style.color = '';
      clearBorder();
      return;
    }
    const startMs = new Date(dateVal).getTime();
    if (isNaN(startMs)) {
      hint.textContent = 'Invalid date.';
      hint.style.color = 'var(--red)';
      return;
    }
    const now = Date.now();
    if (startMs <= now) {
      hint.textContent = '⚠ Start date is in the past. Please choose a future date and time.';
      hint.style.color = 'var(--red)';
      if (sdEl) { sdEl.style.borderColor = 'var(--red)'; sdEl.style.boxShadow = '0 0 0 2px rgba(220,50,50,0.25)'; }
      return;
    }
    if (startMs <= now + 60_000) {
      hint.textContent = '⚠ Start date must be at least 1 minute in the future.';
      hint.style.color = 'var(--red)';
      if (sdEl) { sdEl.style.borderColor = 'var(--red)'; sdEl.style.boxShadow = '0 0 0 2px rgba(220,50,50,0.25)'; }
      return;
    }
    clearBorder();
    const endMs  = startMs + (bidHrsV > 0 ? bidHrsV * 3600_000 : 0);
    const endStr = bidHrsV > 0
      ? new Date(endMs).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      : '—';
    hint.style.color = 'var(--text3)';
    hint.textContent = bidHrsV > 0
      ? `Bidding: ${new Date(startMs).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })} → ${endStr}`
      : 'Enter Bidding Hours to see end time.';
  }
  document.getElementById('cf-start-date')?.addEventListener('change', updateStartDateHint);
  document.getElementById('cf-bid-hrs')?.addEventListener('input', updateStartDateHint);

  // ── File upload → base64 (stored in hidden #cf-img, shown in preview) ────
  document.getElementById('cf-img-file')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('File Too Large', 'Max 5MB for image.', 'err'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      (document.getElementById('cf-img') as HTMLInputElement).value = dataUrl;
      const box = document.getElementById('img-preview-box')!;
      box.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--r2)"/>`;
    };
    reader.readAsDataURL(file);
  });

  // ── Drag & drop on upload zone ────────────────────────────────────────────
  const uploadZone = document.getElementById('upload-zone-label');
  if (uploadZone) {
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault(); uploadZone.classList.remove('dragover');
      const file = e.dataTransfer?.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const input = document.getElementById('cf-img-file') as HTMLInputElement;
      const dt = new DataTransfer(); dt.items.add(file);
      if (input) input.files = dt.files;
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // ── Create banner connect link ─────────────────────────────────────────────
  document.getElementById('create-banner-connect')?.addEventListener('click', (e) => {
    e.preventDefault(); handleWalletClick();
  });

  // ── Modal close buttons ──────────────────────────────────────────────────
  document.getElementById('close-overlay-wallet')?.addEventListener('click', () => {
    (window as any)._pendingCreate = false;
    closeOverlay('overlay-wallet');
  });
  document.getElementById('close-overlay-detail')?.addEventListener('click', () => closeOverlay('overlay-detail'));

  // ── Wallet modal confirm / cancel ────────────────────────────────────────
  document.getElementById('btn-wallet-cancel')?.addEventListener('click', () => {
    (window as any)._pendingCreate = false;
    closeOverlay('overlay-wallet');
  });
  // btn-wallet-confirm only triggers the connect flow when not yet connected
  document.getElementById('btn-wallet-confirm')?.addEventListener('click', () => {
    if (!S.wallet) confirmWalletConnect();
    else closeOverlay('overlay-wallet');
  });

  // ── Disputes page ────────────────────────────────────────────────────────
  document.getElementById('btn-open-dispute')?.addEventListener('click', openDisputeModal);
  document.getElementById('dispute-modal-close')?.addEventListener('click', () => closeOverlay('overlay-dispute'));
  document.getElementById('dispute-cancel-btn')?.addEventListener('click', () => closeOverlay('overlay-dispute'));
  document.getElementById('dispute-submit-btn')?.addEventListener('click', handleDisputeSubmit);
  // Populate auction selector when modal opens
  // Disputes list load
  loadDisputesList();

  // ── Quick actions sidebar ────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.qa-item[data-page]').forEach(item =>
    item.addEventListener('click', () => navigate(item.dataset.page!))
  );

  // ── Sidebar utility links ────────────────────────────────────────────────
  document.getElementById('sidebar-view-all')?.addEventListener('click', () => navigate('analytics'));
  document.getElementById('sidebar-view-profile')?.addEventListener('click', () => navigate('mybids'));
  document.getElementById('sidebar-view-all-activity')?.addEventListener('click', () => navigate('analytics'));

  await autoConnect();
  // updateWalletUI already called inside autoConnect when session is restored.
  // Call again here to ensure disconnected state renders correctly if autoConnect skipped.
  if (!S.wallet) await updateWalletUI();
  await detectStaleSession();
  await loadAuctions();
  if (S.wallet?.contract) void syncOnChainAuctions();
  renderAnalytics();

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const d = await r.json();
    if (d?.ethereum?.usd) S.ethPrice = d.ethereum.usd;
  } catch {}
}


// ─────────────────────────────────────────────────────────────────────────────
//  WALLET SESSION RESET
//  Use when the user is stuck in a broken login state.
//  Call from console: resetWalletSession()
//  Or shown automatically when a stale session is detected.
// ─────────────────────────────────────────────────────────────────────────────
function resetWalletSession(): void {
  // Clear wallet state from localStorage
  localStorage.removeItem(LS_WALLET);

  // Reset in-memory state
  S.wallet       = null;
  S.presencePath = null;

  // Remove ethereum listeners if any
  const eth = getEthereum();
  eth?.removeAllListeners?.('accountsChanged');
  eth?.removeAllListeners?.('chainChanged');

  // Update UI
  updateWalletUI();

  // Remove reset banner if visible
  document.getElementById('wallet-reset-banner')?.remove();

  toast('Reset!', 'Please reconnect your wallet.', 'info');
  console.log('[SecretBid] Wallet session reset. Call handleWalletClick() to reconnect.');
}

// Expose on window for use from DevTools console
(window as any).resetWalletSession = resetWalletSession;

/**
 * Check whether a saved wallet exists but MetaMask is no longer connected.
 * If so, show a reset banner.
 */
async function detectStaleSession(): Promise<void> {
  // autoConnect already restored the session — nothing to do
  if (S.wallet) return;

  const saved = lsLoadWallet();
  if (!saved) return; // No saved wallet — nothing to do

  const eth = getEthereum();
  if (!eth) {
    // Saved wallet exists but MetaMask not found — stale session
    showResetBanner('MetaMask wallet not found. Please reconnect.');
    return;
  }

  try {
    const accounts: string[] = await eth.request({ method: 'eth_accounts' });
    if (!accounts.length) {
      // MetaMask is locked or the account was removed
      showResetBanner('Session expired. Please reconnect your wallet.');
      return;
    }
    if (accounts[0].toLowerCase() !== saved.toLowerCase()) {
      // MetaMask is on a different account than saved
      showResetBanner(`Wallet switched to ${shortAddr(accounts[0])}. Click to reconnect.`);
      return;
    }
    // Check chain ID
    const chainIdHex: string = await eth.request({ method: 'eth_chainId' });
    if (parseInt(chainIdHex, 16) !== SEPOLIA_CHAIN_ID) {
      showResetBanner('Wrong network. Please switch to Sepolia and reconnect.');
    }
  } catch {
    showResetBanner('Unable to connect wallet. Click to reset and try again.');
  }
}

function showResetBanner(msg: string): void {
  // Prevent duplicate banners
  if (document.getElementById('wallet-reset-banner')) return;

  // Skip banner if autoConnect already succeeded
  if (S.wallet) return;

  const banner = document.createElement('div');
  banner.id = 'wallet-reset-banner';
  banner.style.cssText = [
    'position:fixed;top:0;left:0;right:0;z-index:99999',
    'background:#dc2626;color:#fff;font-size:13px',
    'padding:10px 16px;font-family:var(--font-mono,monospace)',
    'display:flex;align-items:center;justify-content:center;gap:12px',
    'box-shadow:0 2px 12px rgba(0,0,0,0.4)',
  ].join(';');
  banner.innerHTML = `
    <span>⚠️ ${msg}</span>
    <button id="btn-reset-reconnect"
      style="background:#fff;color:#dc2626;border:none;border-radius:6px;
             padding:4px 12px;cursor:pointer;font-weight:700;font-size:12px">
      🔄 Reconnect
    </button>
    <button id="btn-reset-dismiss"
      style="background:none;border:none;color:#fff;cursor:pointer;font-size:16px;padding:0 4px">
      ✕
    </button>`;
  document.body.prepend(banner);

  document.getElementById('btn-reset-reconnect')?.addEventListener('click', () => {
    resetWalletSession();
    setTimeout(() => handleWalletClick(), 300);
  });
  document.getElementById('btn-reset-dismiss')?.addEventListener('click', () => {
    banner.remove();
    // Clear stale localStorage when user dismisses
    localStorage.removeItem(LS_WALLET);
  });
}

// type="module" scripts are deferred — DOM is always ready here.
// Guard kept for safety in case script is loaded differently.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot().catch(console.error));
} else {
  boot().catch(console.error);
}
