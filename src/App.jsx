import React, { useState, useEffect, useCallback, useRef } from "react";
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "./contractSetup";

// ==========================================
// BLOCKCHAIN UTILITIES
// ==========================================

/** Dapatkan provider: window.ethereum atau fallback read-only ke Infura/public RPC */
const getRpcProvider = () => {
  // Ganti dengan RPC endpoint Anda (Infura, Alchemy, atau public)
  return "https://sepolia.infura.io/v3/ab667a629dba4fb6bad51b20324df3c3"; // atau mainnet
};

/** Wei → ETH string dengan 4 desimal */
const weiToEth = (wei) => {
  if (!wei) return "0";
  const eth = Number(BigInt(wei)) / 1e18;
  return eth.toFixed(4).replace(/\.?0+$/, "") || "0";
};

/** ETH → Wei BigInt */
const ethToWei = (eth) => {
  const val = parseFloat(eth);
  if (isNaN(val) || val <= 0) return null;
  return BigInt(Math.round(val * 1e18)).toString(16);
};

/** Sederhanakan alamat wallet */
const shortAddr = (addr) => addr ? `${addr.substring(0, 6)}…${addr.substring(addr.length - 4)}` : "";

/** Hitung sisa hari dari deadline (unix timestamp) */
const daysLeft = (deadline) => {
  const now = Math.floor(Date.now() / 1000);
  const diff = Number(deadline) - now;
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86400);
};

/** Encode function call untuk eth_call (ABI encoding sederhana) */
const encodeCall = (funcSig, ...params) => {
  // Keccak-256 4 byte selector – implementasi manual sederhana
  // Untuk produksi gunakan ethers.js / viem
  // Di sini kita gunakan eth_call langsung dengan hex encoding
  const keccak4 = (sig) => {
    // Fungsi ini memerlukan library; karena tidak ada, kita kirim via eth_call dengan format JSON
    // Untuk integrasi penuh, gunakan ethers.js sebagai CDN
    return sig;
  };
  return keccak4(funcSig);
};

/**
 * Buat raw eth_call dengan JSON-RPC langsung ke window.ethereum
 * Menggunakan encoding sederhana; untuk produksi gunakan ethers.js.
 */
const callContract = async (method, params = []) => {
  if (!window.ethereum) throw new Error("No wallet");
  return await window.ethereum.request({ method, params });
};

// ==========================================
// ETHERS.JS LOADER (loaded once from CDN)
// ==========================================
let ethersLib = null;

const loadEthers = () => new Promise((resolve, reject) => {
  if (ethersLib) { resolve(ethersLib); return; }
  if (window.ethers) { ethersLib = window.ethers; resolve(ethersLib); return; }

  // Avoid injecting duplicate ethers scripts which causes 'Identifier ... already declared'
  const existing = Array.from(document.getElementsByTagName('script')).find(s => s.src && s.src.includes('ethers'));
  if (existing) {
    // If global is already available, use it; otherwise wait for script to load or timeout
    if (window.ethers) { ethersLib = window.ethers; resolve(ethersLib); return; }
    const onLoad = () => { ethersLib = window.ethers; cleanup(); resolve(ethersLib); };
    const onError = () => { cleanup(); reject(new Error('Gagal memuat ethers.js (existing script)')); };
    const cleanup = () => { existing.removeEventListener('load', onLoad); existing.removeEventListener('error', onError); };
    existing.addEventListener('load', onLoad);
    existing.addEventListener('error', onError);
    // fallback timeout
    setTimeout(() => {
      if (window.ethers) { ethersLib = window.ethers; resolve(ethersLib); } else { reject(new Error('Timeout memuat ethers.js')); }
    }, 8000);
    return;
  }

  const script = document.createElement('script');
  script.setAttribute('data-ethers', 'carefund');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.umd.min.js';
  script.onload = () => { try { ethersLib = window.ethers; resolve(ethersLib); } catch (e) { reject(e); } };
  script.onerror = (e) => reject(new Error('Gagal memuat ethers.js'));
  document.head.appendChild(script);
});

/** Dapatkan contract instance (read-only atau read-write) */
const getContract = async (withSigner = false) => {
  const ethers = await loadEthers();
  try {
    if (withSigner) {
      if (!window.ethereum) throw new Error('MetaMask tidak ditemukan');
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    }
    // For read-only calls prefer a stable JSON-RPC provider to avoid
    // triggering wallet extension selection popups or errors.
    const provider = new ethers.JsonRpcProvider(getRpcProvider());
    return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
  } catch (err) {
    // Fallback: if signer requested but failed, rethrow to let caller handle it.
    if (withSigner) throw err;
    // For read-only, return a contract with RPC provider as a last resort.
    const provider = new ethers.JsonRpcProvider(getRpcProvider());
    return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
  }
};

/** Fetch semua kampanye dari contract */
const fetchAllCampaigns = async () => {
  try {
    const contract = await getContract();
    const countBig = await contract.getCampaignCount();
    const count = Number(countBig);
    if (count === 0) return [];

    const promises = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        contract.getCampaign(i).then(c => ({
          id: i,
          contractId: i,
          creator: c.creator,
          title: c.title,
          desc: c.description,
          goal: weiToEth(c.goalAmount.toString()),
          eth: weiToEth(c.raisedAmount.toString()),
          pct: c.goalAmount > 0n
            ? Math.min(100, Math.round((Number(c.raisedAmount) / Number(c.goalAmount)) * 100))
            : 0,
          deadline: Number(c.deadline),
          cat: c.category,
          active: c.active,
          donorCount: Number(c.donorCount),
          // Visual props mapped dari kategori
          ...categoryVisuals(c.category),
        })).catch(() => null)
      );
    }
    const results = await Promise.all(promises);
    return results.filter(Boolean);
  } catch (err) {
    console.error("fetchAllCampaigns error:", err);
    return [];
  }
};

/** Fetch satu kampanye */
const fetchCampaign = async (id) => {
  const contract = await getContract();
  const c = await contract.getCampaign(id);
  return {
    id,
    contractId: id,
    creator: c.creator,
    title: c.title,
    desc: c.description,
    goal: weiToEth(c.goalAmount.toString()),
    eth: weiToEth(c.raisedAmount.toString()),
    pct: c.goalAmount > 0n
      ? Math.min(100, Math.round((Number(c.raisedAmount) / Number(c.goalAmount)) * 100))
      : 0,
    deadline: Number(c.deadline),
    cat: c.category,
    active: c.active,
    donorCount: Number(c.donorCount),
    ...categoryVisuals(c.category),
  };
};

/** Fetch event log DonationReceived untuk sebuah campaign */
const fetchDonationEvents = async (contractId) => {
  try {
    const ethers = await loadEthers();
    const contract = await getContract();
    const filter = contract.filters.DonationReceived(contractId);
    const events = await contract.queryFilter(filter, -10000); // last 10k blocks
    return events.map(e => ({
      from: e.args.donor,
      amount: weiToEth(e.args.amount.toString()),
      txHash: e.transactionHash,
      blockNumber: e.blockNumber,
      type: "Donation",
    })).reverse();
  } catch (err) {
    console.error("fetchDonationEvents error:", err);
    return [];
  }
};

/** Fetch riwayat donasi user */
const fetchUserDonations = async (address) => {
  try {
    const contract = await getContract();
    const [campaignIds, amounts, timestamps] = await contract.getDonationHistory(address);
    return campaignIds.map((cid, i) => ({
      campaignId: Number(cid),
      amount: weiToEth(amounts[i].toString()),
      timestamp: Number(timestamps[i]),
    }));
  } catch (err) {
    console.error("fetchUserDonations error:", err);
    return [];
  }
};

/** Fetch kampanye milik user */
const fetchUserCampaigns = async (address) => {
  try {
    const contract = await getContract();
    const ids = await contract.getCampaignsByCreator(address);
    const campaigns = await Promise.all(ids.map(id => fetchCampaign(Number(id))));
    return campaigns;
  } catch (err) {
    console.error("fetchUserCampaigns error:", err);
    return [];
  }
};

/** Kirim donasi ke kontrak */
const sendDonation = async (campaignId, amountEth) => {
  try {
    const ethers = await loadEthers();
    const contract = await getContract(true);
    
    // Validate inputs
    if (!campaignId && campaignId !== 0) {
      throw new Error("Campaign ID tidak valid");
    }
    if (!amountEth || parseFloat(amountEth) <= 0) {
      throw new Error("Jumlah donasi tidak valid");
    }
    
    const value = ethers.parseEther(amountEth.toString());
    console.log("Sending donation:", { campaignId, amountEth, valueWei: value.toString() });
    
    const tx = await contract.donate(campaignId, { value });
    return tx;
  } catch (err) {
    console.error("sendDonation error:", err);
    throw err;
  }
};

/** Buat kampanye baru */
const createCampaignTx = async ({ title, description, goalEth, durationDays, category }) => {
  const ethers = await loadEthers();
  const contract = await getContract(true);
  const goalWei = ethers.parseEther(goalEth.toString());
  const tx = await contract.createCampaign(title, description, goalWei, durationDays, category);
  return tx;
};

/** Ambil block number terkini */
const getLatestBlock = async () => {
  try {
    // Use JsonRpcProvider untuk read-only operations,
    // JANGAN gunakan window.ethereum.request karena trigger evmAsk.js errors
    const ethers = await loadEthers();
    const provider = new ethers.JsonRpcProvider(getRpcProvider());
    const blockNumber = await provider.getBlockNumber();
    return blockNumber;
  } catch { return null; }
};

/** Ambil saldo ETH wallet */
const getBalance = async (address) => {
  try {
    const ethers = await loadEthers();
    // Always use JsonRpcProvider untuk read-only balance queries
    // Avoid triggering window.ethereum unnecessarily
    const provider = new ethers.JsonRpcProvider(getRpcProvider());
    const bal = await provider.getBalance(address);
    return weiToEth(bal.toString());
  } catch { return "0"; }
};

// ==========================================
// KATEGORI → VISUAL MAPPING
// ==========================================
const CATEGORY_VISUALS = {
  "Environment":    { emoji: "🌱", bg: "from-green-900 to-green-700", catColor: "text-green-600", orgColor: "bg-green-600", tags: ["✓ Verified", "🌿 Environment"], tagStyles: ["bg-green-100 text-green-800", "bg-green-50 text-green-700"] },
  "Health":         { emoji: "🏥", bg: "from-blue-900 to-blue-700", catColor: "text-blue-600", orgColor: "bg-blue-600", tags: ["✓ Verified", "🏥 Health"], tagStyles: ["bg-blue-100 text-blue-800", "bg-blue-50 text-blue-700"] },
  "Education":      { emoji: "📚", bg: "from-purple-900 to-purple-700", catColor: "text-purple-600", orgColor: "bg-purple-600", tags: ["✓ Verified", "📚 Education"], tagStyles: ["bg-purple-100 text-purple-800", "bg-purple-50 text-purple-700"] },
  "Disaster Relief":{ emoji: "🆘", bg: "from-red-900 to-red-700",     catColor: "text-red-600",   orgColor: "bg-red-600",   tags: ["✓ Verified", "🆘 Relief", "⚡ Urgent"], tagStyles: ["bg-red-100 text-red-800", "bg-red-50 text-red-700", "bg-amber-50 text-amber-800"] },
  "Human Rights":   { emoji: "✊", bg: "from-amber-900 to-amber-700",  catColor: "text-amber-600", orgColor: "bg-amber-600", tags: ["✓ Verified", "✊ Rights"],     tagStyles: ["bg-amber-100 text-amber-800", "bg-amber-50 text-amber-700"] },
};

const categoryVisuals = (cat) => CATEGORY_VISUALS[cat] || {
  emoji: "🌍", bg: "from-slate-800 to-slate-600", catColor: "text-slate-600", orgColor: "bg-slate-600",
  tags: ["✓ Verified"], tagStyles: ["bg-slate-100 text-slate-800"],
  org: "CareFund DAO", orgAbbr: "CF",
};

// ==========================================
// VALIDATION
// ==========================================
const validateDonationAmount = (amount) => {
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    return { valid: false, message: "Masukkan nominal donasi yang valid (> 0)!" };
  }
  if (parseFloat(amount) > 1000) {
    return { valid: false, message: "Nominal terlalu besar, maksimal 1000 ETH." };
  }
  return { valid: true };
};

// ==========================================
// WALLET CONNECTION
// ==========================================
const connectWalletReal = async () => {
  try {
    if (!window.ethereum) {
      return { success: false, message: "Silakan install MetaMask terlebih dahulu!" };
    }
    
    console.log("[connectWalletReal] Starting wallet connection...");
    
    // Request accounts with explicit error handling
    let accounts;
    try {
      accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    } catch (err) {
      console.error("[connectWalletReal] eth_requestAccounts failed:", err);
      throw err;
    }
    
    if (!accounts || accounts.length === 0) {
      return { success: false, message: "Tidak ada akun yang dipilih." };
    }
    
    console.log("[connectWalletReal] Account selected:", accounts[0]);
    
    // Get chain ID (non-critical)
    let chainId = "unknown";
    try {
      chainId = await window.ethereum.request({ method: "eth_chainId" });
      console.log("[connectWalletReal] Chain ID:", chainId);
    } catch (err) {
      console.warn("[connectWalletReal] Failed to get chain ID (non-critical):", err.message);
    }
    
    console.log("✓ Wallet connected. Account:", accounts[0], "ChainId:", chainId);
    return { success: true, account: accounts[0], chainId };
  } catch (error) {
    console.error("[connectWalletReal] Catch block error:", error);
    
    // User rejected
    if (error.code === 4001 || error.code === "ACTION_REJECTED") {
      return { success: false, message: "Koneksi wallet ditolak pengguna." };
    }
    
    // Network error or timeout
    const msg = error.message || "Gagal terhubung ke wallet.";
    if (msg.includes("timeout") || msg.includes("network")) {
      return { success: false, message: "Timeout atau network error. Refresh halaman dan coba ulang." };
    }
    
    // evmAsk or extension errors
    if (msg.includes("Unexpected") || msg.includes("selectExtension") || msg.includes("extension")) {
      return { success: false, message: "MetaMask tidak merespons. Pastikan extension enabled dan coba refresh." };
    }
    
    return { success: false, message: msg };
  }
};

// ==========================================
// SHARED COMPONENTS
// ==========================================
function ProgressBar({ pct, className = "" }) {
  return (
    <div className={`h-1.5 bg-slate-200 rounded-full overflow-hidden ${className}`}>
      <div
        className="h-full bg-gradient-to-r from-teal-500 to-teal-400 rounded-full transition-all duration-1000"
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function Spinner({ size = "4" }) {
  return (
    <svg className={`animate-spin h-${size} w-${size} text-current`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function Toast({ msg, type = "success", onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);

  const colors = {
    success: "bg-green-600",
    error:   "bg-red-600",
    info:    "bg-teal-600",
    warning: "bg-amber-500",
  };

  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 ${colors[type]} text-white text-sm font-semibold px-5 py-3.5 rounded-2xl shadow-2xl max-w-sm animate-bounce-in`}>
      <span>{type === "success" ? "✓" : type === "error" ? "✗" : "ℹ"}</span>
      <span className="flex-1">{msg}</span>
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100 text-lg leading-none">×</button>
    </div>
  );
}

function CampaignCard({ campaign, onClick }) {
  const pct = campaign.pct || 0;
  return (
    <div
      className="bg-white rounded-2xl overflow-hidden border border-slate-200 hover:border-teal-300 hover:shadow-xl hover:-translate-y-1 transition-all duration-200 cursor-pointer"
      onClick={() => onClick(campaign)}
    >
      <div className={`h-44 flex items-center justify-center relative bg-gradient-to-br ${campaign.bg}`}>
        <span className="text-5xl">{campaign.emoji}</span>
        <span className={`absolute top-3 right-3 bg-white text-xs font-bold px-3 py-1 rounded-full ${campaign.catColor}`}>{campaign.cat}</span>
        {!campaign.active && (
          <span className="absolute bottom-3 left-3 bg-black/60 text-white text-[0.65rem] font-bold px-2 py-0.5 rounded-full">ENDED</span>
        )}
      </div>
      <div className="p-4">
        <h3 className="font-bold text-slate-900 mb-1.5 leading-snug text-[0.97rem]">{campaign.title}</h3>
        <p className="text-slate-500 text-xs leading-relaxed mb-3 line-clamp-2">{campaign.desc}</p>
        <div className="text-sm font-bold text-teal-700 mb-1">
          {campaign.eth} ETH <span className="font-medium text-slate-400 text-xs">RAISED</span>
          <span className="text-teal-500 text-xs ml-2">{pct}%</span>
        </div>
        <ProgressBar pct={pct} className="mb-3" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-[0.6rem] font-bold ${campaign.orgColor}`}>
              {shortAddr(campaign.creator).slice(0, 2).toUpperCase() || "CF"}
            </div>
            <span className="text-xs font-semibold text-slate-600">{shortAddr(campaign.creator)}</span>
          </div>
          <span className="text-xs font-bold text-teal-600 hover:underline">Donate →</span>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// PAGES
// ==========================================

function HomePage({ navigate, campaigns, globalStats, blockNumber }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setTimeout(() => setLoaded(true), 50); }, []);

  const hero = campaigns[0];
  const totalEth = campaigns.reduce((s, c) => s + parseFloat(c.eth || 0), 0).toFixed(2);

  return (
    <div>
      {/* HERO */}
      <section className="bg-gradient-to-br from-slate-900 via-teal-950 to-slate-900 relative overflow-hidden py-20 px-8">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-teal-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/4 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className={`max-w-5xl mx-auto grid grid-cols-2 gap-14 items-center transition-all duration-700 ${loaded ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}>
          <div>
            <div className="inline-flex items-center gap-2 bg-teal-500/20 border border-teal-400/40 text-teal-300 text-xs font-semibold px-3 py-1.5 rounded-full mb-5 tracking-wide">
              <span className="w-1.5 h-1.5 bg-teal-300 rounded-full animate-pulse" />
              BLOCKCHAIN-VERIFIED GIVING
            </div>
            <h1 className="text-5xl font-extrabold text-white leading-[1.1] mb-4">
              Donate with <em className="not-italic text-teal-400">Total Transparency</em>
            </h1>
            <p className="text-white/65 text-[0.95rem] leading-relaxed mb-8 max-w-md">
              Every rupiah, every wei tracked on-chain. CareFund uses Ethereum smart contracts to guarantee your donation reaches its destination — no middlemen, no corruption.
            </p>
            <div className="flex gap-3 flex-wrap">
              <button onClick={() => navigate("browse")} className="flex items-center gap-2 bg-teal-500 hover:bg-teal-600 text-white font-semibold px-6 py-2.5 rounded-full transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-teal-500/30 text-sm">🔍 Explore Campaigns</button>
              <button onClick={() => navigate("create")} className="flex items-center gap-2 bg-white/10 hover:bg-white/20 border border-white/25 text-white font-semibold px-6 py-2.5 rounded-full transition-all text-sm">+ Start a Campaign</button>
            </div>
            <div className="flex items-center gap-3 mt-7">
              <div className="flex">
                {["bg-blue-500","bg-purple-600","bg-red-500"].map((c,i) => (
                  <div key={i} className={`w-8 h-8 rounded-full border-2 border-white/60 flex items-center justify-center text-white text-[0.65rem] font-bold -ml-2 first:ml-0 ${c}`}>
                    {["AJ","KL","MS"][i]}
                  </div>
                ))}
              </div>
              <p className="text-white/66 text-xs">
                {globalStats.totalDonors > 0 ? `+${globalStats.totalDonors.toLocaleString()} donors already on-chain` : "Loading donor data…"}
              </p>
            </div>
          </div>

          {/* HERO CARD */}
          <div className={`transition-all duration-700 delay-200 ${loaded ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}>
            {hero ? (
              <div className="bg-white rounded-2xl overflow-hidden shadow-2xl animate-float-card cursor-pointer" onClick={() => navigate("detail", hero)}>
                <div className={`h-48 flex items-center justify-center bg-gradient-to-br ${hero.bg} relative overflow-hidden`}>
  {hero.image && (
    <img 
      src={hero.image} 
      alt={hero.title}
      // Kita hapus mix-blend-overlay dan naikkan opacity menjadi 100 agar gambar terlihat jelas
      className="absolute inset-0 w-full h-full object-cover opacity-100 z-0" 
    />
  )}
</div>
                <div className="p-4">
                  <span className="text-xs font-bold bg-teal-50 text-teal-700 px-2.5 py-0.5 rounded-full">{hero.cat}</span>
                  <h3 className="font-bold text-slate-900 text-sm mt-2 mb-3">{hero.title}</h3>
                  <div className="flex justify-between text-xs mb-1.5">
                    <strong className="text-slate-900">{hero.eth} ETH raised</strong>
                    <span className="text-teal-600 font-bold">{hero.pct}%</span>
                  </div>
                  <ProgressBar pct={hero.pct} />
                  <div className="flex justify-between text-[0.7rem] text-slate-400 mt-1.5">
                    <span>{shortAddr(hero.creator)}</span>
                    <span>Goal: {hero.goal} ETH</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white/10 rounded-2xl h-64 flex items-center justify-center text-white/40">
                <Spinner size="8" />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* STATS */}
      <section className="bg-teal-600 py-10 px-8">
        <div className="max-w-5xl mx-auto grid grid-cols-4 gap-6 text-center text-white">
          {[
            [totalEth > 0 ? `${totalEth} ETH` : "—", "Total Raised"],
            [globalStats.activeCampaigns || campaigns.filter(c => c.active).length, "Active Campaigns"],
            [globalStats.totalDonors > 0 ? globalStats.totalDonors.toLocaleString() : "—", "Donors Worldwide"],
            ["100%","On-Chain Verified"],
          ].map(([val,label]) => (
            <div key={label}>
              <div className="text-3xl font-extrabold mb-1">{val}</div>
              <div className="text-teal-100 text-xs opacity-90">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* WHY CAREFUND */}
      <section className="bg-white py-20 px-8">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-extrabold text-slate-900 mb-3">Why CareFund?</h2>
            <p className="text-slate-500 text-sm">Built on trust, verified by math.</p>
          </div>
          <div className="grid grid-cols-3 gap-6">
            {[
              { icon: "🔗", bg: "bg-teal-50", title: "Wallet Integration", desc: "Connect MetaMask dan donate langsung dari wallet crypto Anda dalam hitungan detik." },
              { icon: "⚙️", bg: "bg-blue-50", title: "Smart Contracts", desc: "Donasi mengalir melalui smart contract Ethereum yang telah diaudit — otomatis, immutable, dan dapat diverifikasi publik." },
              { icon: "🔍", bg: "bg-amber-50", title: "Full Transparency", desc: "Setiap transaksi dicatat permanen di blockchain Ethereum, dapat dilihat siapa saja, kapan saja." },
              { icon: "🏛️", bg: "bg-purple-50", title: "DAO Governance", desc: "Anggota komunitas memilih pencairan. Dana hanya dilepas saat milestone terverifikasi on-chain." },
              { icon: "🛡️", bg: "bg-green-50", title: "Verified Orgs", desc: "Setiap pembuat kampanye menjalani verifikasi KYC. Pelaku buruk diblokir di level smart contract." },
              { icon: "🌍", bg: "bg-red-50", title: "Global Impact", desc: "Dukung sebab di 80+ negara. Tanpa konversi mata uang — ETH melampaui batas seketika." },
            ].map(f => (
              <div key={f.title} className="bg-slate-50 border border-slate-200 rounded-2xl p-6 hover:border-teal-300 hover:shadow-md hover:-translate-y-1 transition-all duration-200">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl mb-4 ${f.bg}`}>{f.icon}</div>
                <h3 className="font-bold text-slate-900 mb-2">{f.title}</h3>
                <p className="text-slate-500 text-xs leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURED CAMPAIGNS */}
<section className="bg-slate-50 py-20 px-8">
  <div className="max-w-5xl mx-auto">
    <div className="flex justify-between items-end mb-8">
      <div>
        <h2 className="text-2xl font-extrabold text-slate-900">Featured Campaigns</h2>
        <p className="text-slate-500 text-sm mt-1">Verified, transparent, impactful</p>
      </div>
      <button onClick={() => navigate("browse")} className="text-teal-600 font-semibold text-sm hover:underline">View all →</button>
    </div>
    
    {campaigns.length === 0 ? (
      <div className="text-center py-16 text-slate-400">
        <Spinner size="8" />
        <p className="mt-4 text-sm">Memuat kampanye dari blockchain…</p>
      </div>
    ) : (
      <div className="grid grid-cols-3 gap-6">
        {campaigns.slice(0, 3).map(c => (
          
          /* DI SINI PERUBAHANNYA: Mengganti <CampaignCard /> bawaan dengan struktur card baru bergambar */
          <div 
            key={c.id}
            onClick={() => navigate("detail", c)} 
            className="bg-white border border-slate-100 rounded-3xl overflow-hidden shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all cursor-pointer flex flex-col h-full group"
          >
            {/* BAGIAN ATAS CARD: Gambar Latar Belakang dari public/gambar.png */}
            <div className="h-48 w-full relative bg-slate-100 overflow-hidden">
              <img 
                src="/gambar.png" 
  alt="Campaign Background" 
  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" 
/>
              <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent" />
              <span className="absolute top-4 right-4 bg-white/90 backdrop-blur-md text-blue-600 text-xs font-bold px-4 py-1.5 rounded-full shadow-sm">
                {c.category || "Health"}
              </span>
            </div>

            {/* BAGIAN BAWAH CARD: Informasi Kampanye */}
            <div className="p-5 flex-1 flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-lg line-clamp-1 group-hover:text-teal-600 transition-colors">
                  {c.title || "Donasi"}
                </h3>
                <p className="text-slate-500 text-sm mt-1 line-clamp-2">
                  {c.description || "1"}
                </p>
              </div>

              {/* Progress Bar & Indikator Dana */}
              <div className="mt-4">
                <div className="flex justify-between items-baseline mb-1.5">
                  <span className="text-teal-600 font-extrabold text-base">{c.raised || "0.05"} ETH</span>
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Raised <span className="text-teal-500 font-bold">{c.progress || "1"}%</span>
                  </span>
                </div>
                <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                  <div className="bg-teal-500 h-full rounded-full transition-all duration-500" style={{ width: `${c.progress || 1}%` }} />
                </div>
              </div>

              {/* Footer Card */}
              <div className="flex justify-between items-center mt-5 pt-4 border-t border-slate-50">
                <div className="flex items-center gap-2 bg-blue-50 text-blue-700 font-mono text-xs px-3 py-1.5 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  {c.owner ? `${c.owner.substring(0, 6)}...${c.owner.substring(c.owner.length - 4)}` : "0xF480...E55b"}
                </div>
                <span className="text-teal-600 font-bold text-sm flex items-center gap-1 group-hover:gap-2 transition-all">
                  Donate <span className="text-xs">→</span>
                </span>
              </div>
            </div>

          </div>
        ))}
      </div>
    )}
  </div>
</section>

      {/* VERIFIED BY SMART CONTRACTS */}
      <section className="bg-gradient-to-br from-slate-900 to-teal-950 py-20 px-8 text-white">
        <div className="max-w-5xl mx-auto grid grid-cols-2 gap-16 items-center">
          <div>
            <h2 className="text-3xl font-extrabold mb-4 leading-snug">Verified by Smart Contracts</h2>
            <p className="text-white/65 text-sm leading-relaxed mb-6">Platform kami tidak berbasis janji — berbasis matematika. Kode otomatis yang telah diaudit memastikan donasi Anda sampai ke tujuan dengan tepat.</p>
            <ul className="space-y-3">
              {["Pencairan otomatis berdasarkan proof-of-impact","Audit publik 24/7 atas semua treasury wallet","Tata kelola komunitas bawaan untuk pengawasan","Milestone terverifikasi sebelum dana dilepas","Treasury publik — setiap transaksi terlihat"].map(item => (
                <li key={item} className="flex items-center gap-3 text-sm text-white/85">
                  <span className="w-5 h-5 bg-teal-500/20 border border-teal-400/50 rounded-full flex items-center justify-center text-teal-300 text-xs font-bold flex-shrink-0">✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center gap-4 mb-6 flex-wrap">
              {[
                {icon:"💳",label:"Donor",col:"bg-blue-500/25 border-blue-400/50"},
                {icon:"⚙️",label:"Smart Contract",col:"bg-teal-500/30 border-teal-400/60",highlight:true},
                {icon:"🏥",label:"Recipient",col:"bg-amber-500/20 border-amber-400/40"}
              ].map((node, i) => (
                <div key={node.label} className="flex items-center gap-3">
                  <div className="text-center">
                    <div className={`w-12 h-12 border rounded-xl flex items-center justify-center text-2xl mx-auto mb-1.5 ${node.col}`}>{node.icon}</div>
                    <p className={`text-[0.65rem] font-semibold ${node.highlight ? "text-teal-300 font-bold" : "text-white/65"}`}>{node.label}</p>
                  </div>
                  {i < 2 && <span className="text-white/30 text-xl">→</span>}
                </div>
              ))}
            </div>
            <div className="bg-black/35 rounded-xl p-4 border border-teal-500/25 font-mono text-xs leading-relaxed">
              <div className="flex gap-1.5 mb-3">
                <div className="w-2.5 h-2.5 bg-red-500 rounded-full" />
                <div className="w-2.5 h-2.5 bg-amber-400 rounded-full" />
                <div className="w-2.5 h-2.5 bg-green-400 rounded-full" />
              </div>
              <pre className="text-white/70">
                <span className="text-teal-300">{"// CONTRACT: " + CONTRACT_ADDRESS.slice(0, 18) + "…"}</span>{"\n"}
                {"donate(campaignId, { value: 0.10_eth })\n"}
                <span className="text-green-400 font-bold">{"STATUS: VERIFIED ON-CHAIN ✓"}</span>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-slate-950 text-white/60 py-12 px-8">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-4 gap-8 mb-8">
            <div>
              <h3 className="text-white font-bold text-lg mb-2">❤️ CareFund</h3>
              <p className="text-xs leading-relaxed">Empowering global change through decentralized finance and radical transparency.</p>
            </div>
            {[
              ["Platform",["Browse Campaigns","Create Campaign","How It Works","Smart Contract Audit"]],
              ["Community",["Twitter (X)","Discord","Governance"]],
              ["Legal",["Privacy Policy","Terms of Service","Security"]]
            ].map(([title, links]) => (
              <div key={title}>
                <h4 className="text-white font-semibold text-sm mb-3">{title}</h4>
                <ul className="space-y-2">
                  {links.map(l => <li key={l}><a href="#" className="text-xs hover:text-teal-400 transition-colors">{l}</a></li>)}
                </ul>
              </div>
            ))}
          </div>
          <div className="border-t border-white/10 pt-6 flex justify-between items-center text-xs">
            <span>© 2024 CareFund. Powered by Ethereum.</span>
            <div className="flex items-center gap-2 bg-blue-900/50 px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
              {blockNumber ? `Block #${blockNumber.toLocaleString()}` : "Connecting…"}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function BrowsePage({ navigate, campaigns, loading }) {
  const [activeSort, setActiveSort] = useState("Popular");
  const [activeCategories, setActiveCategories] = useState({});
  const sortIcons = { Popular: "↗", Newest: "🕐", "Near Goal": "🏁" };
  const [search, setSearch] = useState("");

  const filteredCats = Object.entries(activeCategories).filter(([,v]) => v).map(([k]) => k);

  const sorted = [...campaigns]
    .filter(c => {
      if (filteredCats.length > 0 && !filteredCats.includes(c.cat)) return false;
      if (search && !c.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (activeSort === "Popular")   return b.donorCount - a.donorCount;
      if (activeSort === "Newest")    return b.id - a.id;
      if (activeSort === "Near Goal") return b.pct - a.pct;
      return 0;
    });

  const totalDonationsToday = campaigns.reduce((s, c) => s + c.donorCount, 0);

  return (
    <div className="max-w-5xl mx-auto grid grid-cols-[220px_1fr] gap-8 p-10">
      <aside className="bg-white rounded-2xl border border-slate-200 p-6 h-fit sticky top-20">
        <div className="mb-4">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-teal-400"
          />
        </div>
        <h3 className="font-bold text-slate-900 text-sm mb-4">Sort By</h3>
        {["Popular","Newest","Near Goal"].map(s => (
          <button
            key={s}
            onClick={() => setActiveSort(s)}
            className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl mb-2 text-sm font-medium border transition-all ${activeSort === s ? "bg-teal-500 text-white border-teal-500" : "bg-slate-50 border-slate-200 hover:border-teal-300 text-slate-700"}`}
          >
            {s} <span>{sortIcons[s]}</span>
          </button>
        ))}
        <hr className="border-slate-200 my-5" />
        <h3 className="font-bold text-slate-900 text-sm mb-3">Categories</h3>
        {["Health","Education","Disaster Relief","Environment","Human Rights"].map(cat => (
          <div key={cat} onClick={() => setActiveCategories(p => ({ ...p, [cat]: !p[cat] }))} className="flex items-center gap-2.5 py-2 cursor-pointer text-sm text-slate-700">
            <div className={`w-4 h-4 rounded flex items-center justify-center border-2 transition-all ${activeCategories[cat] ? "bg-teal-500 border-teal-500" : "border-slate-300"}`}>
              {activeCategories[cat] && <span className="text-white text-[0.5rem] font-bold">✓</span>}
            </div>
            {cat}
          </div>
        ))}
        <div className="bg-blue-50 rounded-xl p-3.5 mt-5">
          <div className="text-blue-600 text-[0.65rem] font-bold uppercase tracking-widest mb-1">Live Transactions</div>
          <div className="text-blue-900 font-extrabold text-2xl leading-none">
            {totalDonationsToday} <span className="text-slate-500 text-xs font-medium">Total Donors</span>
          </div>
          <ProgressBar pct={Math.min((totalDonationsToday / 100) * 100, 100)} className="mt-2" />
        </div>
      </aside>

      <div>
        <h2 className="text-3xl font-extrabold text-slate-900 mb-1">Explore Impact</h2>
        <p className="text-slate-500 text-sm mb-6">
          {loading ? "Memuat kampanye dari blockchain…" : `${campaigns.length} verified Ethereum-based campaign${campaigns.length !== 1 ? "s" : ""}`}
        </p>
        {loading ? (
          <div className="flex justify-center py-20"><Spinner size="10" /></div>
        ) : sorted.length === 0 ? (
          <div className="text-center py-20 text-slate-400">
            <p className="text-4xl mb-3">🔍</p>
            <p className="font-semibold">Tidak ada kampanye ditemukan</p>
            <p className="text-sm mt-1">Coba ubah filter atau mulai kampanye baru</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-6">
            {sorted.map(c => (
              <CampaignCard key={c.id} campaign={c} onClick={(c) => navigate("detail", c)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailPage({ campaign: initialCampaign, navigate, wallet, onToast }) {
  const [campaign, setCampaign] = useState(initialCampaign);
  const [donateAmt, setDonateAmt] = useState("0.10");
  const [donating, setDonating] = useState(false);
  const [txLog, setTxLog] = useState([]);
  const [loadingLog, setLoadingLog] = useState(true);

  const c = campaign;

  // Refresh campaign data dari chain
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const fresh = await fetchCampaign(initialCampaign.contractId);
        if (active) setCampaign(fresh);
      } catch {}
    };
    refresh();
    return () => { active = false; };
  }, [initialCampaign.contractId]);

  // Load donation events
  useEffect(() => {
    let active = true;
    setLoadingLog(true);
    fetchDonationEvents(initialCampaign.contractId)
      .then(logs => { if (active) setTxLog(logs); })
      .finally(() => { if (active) setLoadingLog(false); });
    return () => { active = false; };
  }, [initialCampaign.contractId]);

  const handleDonate = async () => {
    const validation = validateDonationAmount(donateAmt);
    if (!validation.valid) { onToast(validation.message, "error"); return; }
    if (!wallet) { onToast("Hubungkan wallet terlebih dahulu!", "warning"); return; }
    if (!c.active) { onToast("Kampanye ini sudah berakhir.", "error"); return; }

    setDonating(true);
    try {
      const tx = await sendDonation(c.contractId, donateAmt);
      onToast("Transaksi dikirim! Menunggu konfirmasi…", "info");
      const receipt = await tx.wait();
      // Refresh data
      const fresh = await fetchCampaign(c.contractId);
      setCampaign(fresh);
      // Refresh log
      const logs = await fetchDonationEvents(c.contractId);
      setTxLog(logs);
      navigate("success", {
        amount: donateAmt,
        campaign: c.title,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        status: "confirmed",
      });
    } catch (err) {
      console.error("Donation error details:", {
        code: err.code,
        message: err.message,
        reason: err.reason,
        data: err.data,
        transaction: err.transaction,
      });
      
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        onToast("Transaksi dibatalkan pengguna.", "warning");
      } else if (err.code === "CALL_EXCEPTION") {
        // Handle contract revert errors
        const errorMsg = err.reason || "Smart contract call gagal. Periksa apakah kampanye masih aktif dan input valid.";
        onToast(errorMsg, "error");
      } else {
        onToast(err.reason || err.message || "Transaksi gagal.", "error");
      }
    } finally {
      setDonating(false);
    }
  };

  const etherscanBase = "https://sepolia.etherscan.io"; // ganti jika mainnet

  return (
    <div>
      <div className="max-w-5xl mx-auto px-10 pt-7">
        <button onClick={() => navigate("browse")} className="text-slate-400 hover:text-teal-500 text-sm flex items-center gap-1.5 mb-5 transition-colors">← Back to campaigns</button>
      </div>
      <div className="max-w-5xl mx-auto px-10 pb-12 grid grid-cols-[1fr_320px] gap-8">
        <div>
          <div className={`w-full h-72 rounded-2xl flex items-center justify-center text-6xl mb-6 bg-gradient-to-br ${c.bg}`}>{c.emoji}</div>
          <div className="flex gap-2 mb-4 flex-wrap">
            {c.tags.map((tag, i) => (
              <span key={tag} className={`text-xs font-semibold px-3 py-1 rounded-full ${c.tagStyles[i]}`}>{tag}</span>
            ))}
            {!c.active && <span className="text-xs font-semibold px-3 py-1 rounded-full bg-red-100 text-red-700">⛔ Ended</span>}
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 mb-5 leading-snug">{c.title}</h1>

          <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-5">
            <h3 className="font-bold text-slate-900 mb-3">About This Campaign</h3>
            <p className="text-slate-600 text-sm leading-relaxed mb-3">{c.desc}</p>
            <p className="text-slate-600 text-sm leading-relaxed">
              Dana dikelola oleh smart contract yang telah diaudit.
              Pencairan membutuhkan milestone proof-of-impact on-chain sebelum ETH dilepaskan ke wallet penerima.
            </p>
            <div className="mt-4 pt-4 border-t border-slate-100 flex items-center gap-3">
              <span className="text-xs text-slate-400 font-mono">Creator:</span>
              <a
                href={`${etherscanBase}/address/${c.creator}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-teal-600 hover:underline"
              >
                {c.creator}
              </a>
            </div>
          </div>

          {/* Transparency Log */}
          <div className="mt-6">
            <div className="flex justify-between items-center mb-1">
              <h3 className="font-bold text-slate-900 text-lg">Transparency Log</h3>
              <a
                href={`${etherscanBase}/address/${CONTRACT_ADDRESS}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-600 text-xs font-semibold hover:underline"
              >
                View on Etherscan →
              </a>
            </div>
            <p className="text-slate-400 text-xs mb-4">Semua transaksi dapat diverifikasi on-chain</p>
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              {loadingLog ? (
                <div className="flex justify-center py-10"><Spinner size="6" /></div>
              ) : txLog.length === 0 ? (
                <div className="text-center py-10 text-slate-400 text-sm">Belum ada transaksi untuk kampanye ini.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {["From","Amount","Type","Block","Tx Hash"].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {txLog.slice(0, 20).map((row, i) => (
                      <tr key={i} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3 font-mono text-xs text-teal-600">{shortAddr(row.from)}</td>
                        <td className="px-4 py-3 font-bold text-slate-900 text-xs">{row.amount} ETH</td>
                        <td className="px-4 py-3">
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700">Donation</span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">#{row.blockNumber?.toLocaleString()}</td>
                        <td className="px-4 py-3 font-mono text-xs">
                          <a
                            href={`${etherscanBase}/tx/${row.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-teal-600 hover:underline"
                          >
                            {row.txHash?.slice(0, 10)}…
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* DONATE SIDEBAR */}
        <div className="sticky top-20 h-fit">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <div className="text-3xl font-extrabold text-slate-900 mb-0.5">{c.eth} ETH</div>
            <div className="text-slate-500 text-sm mb-3">
              raised of {c.goal} ETH goal &nbsp;
              <span className="bg-teal-50 text-teal-700 text-xs font-bold px-2 py-0.5 rounded-full">{c.pct}% COMPLETED</span>
            </div>
            <ProgressBar pct={c.pct} className="mb-4" />
            <div className="grid grid-cols-2 gap-3 text-center mb-5">
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="font-extrabold text-slate-900">{c.donorCount}</div>
                <div className="text-slate-400 text-xs">Donors</div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="font-extrabold text-slate-900">{daysLeft(c.deadline)}</div>
                <div className="text-slate-400 text-xs">Days Left</div>
              </div>
            </div>

            {c.active ? (
              <>
                <div className="mb-4">
                  <label className="text-xs font-semibold text-slate-700 mb-2 block">Donation Amount (ETH)</label>
                  <div className="flex gap-2 mb-2">
                    {["0.05","0.10","0.50","1.00"].map(v => (
                      <button
                        key={v}
                        onClick={() => setDonateAmt(v)}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-all ${donateAmt===v ? "bg-teal-500 text-white border-teal-500" : "bg-slate-50 border-slate-200 text-slate-600 hover:border-teal-300"}`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  <input
                    value={donateAmt}
                    onChange={e => setDonateAmt(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-teal-400 font-mono"
                    placeholder="Custom amount"
                  />
                </div>
                <button
                  onClick={handleDonate}
                  disabled={donating}
                  className="w-full bg-teal-500 hover:bg-teal-600 disabled:bg-teal-300 text-white font-bold py-3 rounded-xl transition-all hover:shadow-lg hover:shadow-teal-200 text-sm mb-2 flex items-center justify-center gap-2"
                >
                  {donating ? <><Spinner size="4" /> Processing…</> : "❤️ Donate Now"}
                </button>
                <p className="text-center text-slate-400 text-[0.65rem]">Secured by Ethereum smart contract</p>
              </>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-center text-sm text-red-600 font-semibold">
                ⛔ Kampanye ini telah berakhir
              </div>
            )}

            <div className="mt-5 pt-5 border-t border-slate-100">
              <h4 className="font-bold text-slate-900 text-sm mb-3">Creator</h4>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold ${c.orgColor}`}>
                  {shortAddr(c.creator).slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <a
                    href={`${etherscanBase}/address/${c.creator}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-slate-900 text-sm hover:text-teal-600 font-mono"
                  >
                    {shortAddr(c.creator)}
                  </a>
                  <div className="text-green-600 text-xs font-semibold">✓ On-Chain Verified</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreatePage({ navigate, wallet, onToast }) {
  const [form, setForm] = useState({
    title: "",
    category: "Health",
    goal: "",
    duration: "",
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});

  const validate = () => {
    const e = {};
    if (!form.title || !form.title.trim()) e.title = "Judul kampanye wajib diisi.";
    if (!form.goal || parseFloat(form.goal) <= 0) e.goal = "Target dana harus lebih dari 0 ETH.";
    if (!form.duration || parseInt(form.duration) < 1) e.duration = "Durasi minimal 1 hari.";
    if (!form.description || !form.description.trim()) e.description = "Deskripsi wajib diisi.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault(); // Mencegah page refresh otomatis
    if (!wallet) { onToast("Hubungkan wallet terlebih dahulu!", "warning"); return; }
    if (!validate()) return;

    setSubmitting(true);
    try {
      const tx = await createCampaignTx({
        title: form.title,
        description: form.description,
        goalEth: form.goal,
        durationDays: parseInt(form.duration),
        category: form.category,
      });
      onToast("Transaksi dikirim! Menunggu konfirmasi…", "info");
      await tx.wait();
      onToast("Kampanye berhasil dibuat on-chain! 🎉", "success");
      navigate("browse");
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        onToast("Transaksi dibatalkan pengguna.", "warning");
      } else {
        onToast(err.reason || err.message || "Gagal membuat kampanye.", "error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-8 py-12">
      <h1 className="text-3xl font-extrabold text-slate-900 mb-2">Create a Campaign</h1>
      <p className="text-slate-500 text-sm mb-8">Launch a transparent, blockchain-verified fundraising campaign in minutes.</p>

      {!wallet && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-6 text-amber-700 text-sm font-semibold">
          ⚠️ Hubungkan wallet Anda terlebih dahulu untuk membuat kampanye.
        </div>
      )}

      {/* Membungkus struktur tabel/input menggunakan tag form standar React */}
      <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
        
        {/* Campaign Title Input */}
        <div className="mb-5">
          <label className="text-xs font-semibold text-slate-700 mb-2 block">Campaign Title</label>
          <input
            type="text"
            value={form.title}
            onChange={e => {
              setForm(p => ({ ...p, title: e.target.value }));
              if (errors.title) setErrors(p => ({ ...p, title: null }));
            }}
            placeholder="e.g. Clean Water for Rural Kenya"
            className={`w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-400 transition-colors ${errors.title ? "border-red-400 bg-red-50" : "border-slate-200"}`}
          />
          {errors.title && <p className="text-xs text-red-500 mt-1">{errors.title}</p>}
        </div>

        {/* Funding Goal Input */}
        <div className="mb-5">
          <label className="text-xs font-semibold text-slate-700 mb-2 block">Funding Goal (ETH)</label>
          <input
            type="number"
            step="any"
            value={form.goal}
            onChange={e => {
              setForm(p => ({ ...p, goal: e.target.value }));
              if (errors.goal) setErrors(p => ({ ...p, goal: null }));
            }}
            placeholder="e.g. 50"
            className={`w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-400 transition-colors ${errors.goal ? "border-red-400 bg-red-50" : "border-slate-200"}`}
          />
          {errors.goal && <p className="text-xs text-red-500 mt-1">{errors.goal}</p>}
        </div>

        {/* Duration Input */}
        <div className="mb-5">
          <label className="text-xs font-semibold text-slate-700 mb-2 block">Duration (Days)</label>
          <input
            type="number"
            value={form.duration}
            onChange={e => {
              setForm(p => ({ ...p, duration: e.target.value }));
              if (errors.duration) setErrors(p => ({ ...p, duration: null }));
            }}
            placeholder="e.g. 30"
            className={`w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-400 transition-colors ${errors.duration ? "border-red-400 bg-red-50" : "border-slate-200"}`}
          />
          {errors.duration && <p className="text-xs text-red-500 mt-1">{errors.duration}</p>}
        </div>

        {/* Category Selector */}
        <div className="mb-5">
          <label className="text-xs font-semibold text-slate-700 mb-2 block">Category</label>
          <select
            value={form.category}
            onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
            className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-400 bg-white"
          >
            {["Health","Education","Environment","Disaster Relief","Human Rights"].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Description Input */}
        <div className="mb-5">
          <label className="text-xs font-semibold text-slate-700 mb-2 block">Description</label>
          <textarea
            rows={5}
            value={form.description}
            onChange={e => {
              setForm(p => ({ ...p, description: e.target.value }));
              if (errors.description) setErrors(p => ({ ...p, description: null }));
            }}
            placeholder="Describe your campaign, its goals, and how funds will be used…"
            className={`w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-400 resize-vertical transition-colors ${errors.description ? "border-red-400 bg-red-50" : "border-slate-200"}`}
          />
          {errors.description && <p className="text-xs text-red-500 mt-1">{errors.description}</p>}
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={submitting || !wallet}
          className="w-full bg-teal-500 hover:bg-teal-600 disabled:bg-teal-300 text-white font-bold py-3.5 rounded-xl transition-all hover:shadow-lg hover:shadow-teal-200 text-sm flex items-center justify-center gap-2"
        >
          {submitting ? <><Spinner size="4" /> Deploying to Blockchain…</> : "🚀 Launch Campaign on Blockchain"}
        </button>
        <p className="text-center text-slate-400 text-xs mt-3">Your campaign will be deployed as an audited smart contract.</p>
      </form>
    </div>
  );
}
function DashboardPage({ navigate, wallet, onToast }) {
  const [activeNav, setActiveNav] = useState("Overview");
  const [balance, setBalance] = useState(null);
  const [userCampaigns, setUserCampaigns] = useState([]);
  const [userDonations, setUserDonations] = useState([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loadingDonations, setLoadingDonations] = useState(false);
  const [campaignDetails, setCampaignDetails] = useState({});

  useEffect(() => {
    if (!wallet) return;
    getBalance(wallet).then(setBalance);
    setLoadingCampaigns(true);
    fetchUserCampaigns(wallet)
      .then(setUserCampaigns)
      .finally(() => setLoadingCampaigns(false));
    setLoadingDonations(true);
    fetchUserDonations(wallet)
      .then(async (donations) => {
        setUserDonations(donations);
        // Fetch detail tiap campaign yang didonasi
        const ids = [...new Set(donations.map(d => d.campaignId))];
        const details = {};
        await Promise.all(ids.map(async (id) => {
          try {
            const c = await fetchCampaign(id);
            details[id] = c;
          } catch {}
        }));
        setCampaignDetails(details);
      })
      .finally(() => setLoadingDonations(false));
  }, [wallet]);

  const totalContributed = userDonations.reduce((s, d) => s + parseFloat(d.amount || 0), 0).toFixed(4);
  const uniqueCauses = [...new Set(userDonations.map(d => d.campaignId))].length;

  const maxDonation = Math.max(...userDonations.map(d => parseFloat(d.amount || 0)), 0.001);

  // Group donations by month for chart
  const monthlyData = (() => {
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const now = new Date();
    const last6 = Array.from({length: 6}, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
      return { m: months[d.getMonth()], year: d.getFullYear(), month: d.getMonth(), total: 0 };
    });
    userDonations.forEach(d => {
      const date = new Date(d.timestamp * 1000);
      const entry = last6.find(e => e.year === date.getFullYear() && e.month === date.getMonth());
      if (entry) entry.total += parseFloat(d.amount || 0);
    });
    const maxVal = Math.max(...last6.map(e => e.total), 0.001);
    return last6.map((e, i) => ({ ...e, h: Math.round((e.total / maxVal) * 100) || 5, active: i === 5 }));
  })();

  return (
    <div className="grid grid-cols-[220px_1fr] min-h-[calc(100vh-64px)]">
      <aside className="bg-slate-900 text-white flex flex-col p-6">
        <div className="font-extrabold text-xl mb-1">❤️ CareFund</div>
        <div className="text-slate-400 text-xs mb-8">Manage your impact</div>
        <nav className="flex flex-col gap-1 flex-1">
          {[["⊞","Overview"],["📋","My Campaigns"],["🕐","Donation History"],["⚙️","Settings"]].map(([icon, label]) => (
            <button
              key={label}
              onClick={() => setActiveNav(label)}
              className={`text-left px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${activeNav===label ? "bg-teal-600 text-white" : "text-slate-400 hover:bg-white/10 hover:text-white"}`}
            >
              {icon} {label}
            </button>
          ))}
        </nav>
        <button onClick={() => navigate("create")} className="w-full bg-teal-500 hover:bg-teal-600 text-white font-semibold py-2.5 rounded-xl text-sm transition-all">+ New Campaign</button>
      </aside>

      <div className="bg-slate-50 p-8">
        {/* HEADER */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <div className="text-slate-400 text-xs font-semibold uppercase tracking-widest mb-1">WELCOME BACK</div>
            <h2 className="text-2xl font-extrabold text-slate-900">
              {wallet ? shortAddr(wallet) : "Connect Wallet"}
            </h2>
          </div>
          {wallet && (
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-teal-600 text-xs font-bold bg-teal-50 px-2 py-0.5 rounded-full">ON-CHAIN</div>
                <div className="font-mono text-xs text-slate-500 mt-0.5">{shortAddr(wallet)}</div>
              </div>
              <div className="w-10 h-10 rounded-full bg-teal-500 flex items-center justify-center text-white font-bold">
                {wallet.slice(2, 4).toUpperCase()}
              </div>
            </div>
          )}
        </div>

        {!wallet ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <p className="text-5xl mb-4">🦊</p>
            <p className="font-semibold text-lg text-slate-600">Wallet belum terhubung</p>
            <p className="text-sm mt-1">Hubungkan wallet untuk melihat dashboard Anda.</p>
          </div>
        ) : (
          <>
            {/* OVERVIEW */}
            {activeNav === "Overview" && (
              <>
                <h3 className="font-bold text-slate-900 mb-4">Your Impact</h3>
                <div className="grid grid-cols-3 gap-4 mb-8">
                  <div className="bg-teal-500 text-white rounded-2xl p-5">
                    <div className="text-white/75 text-xs mb-2">Total Contributed</div>
                    <div className="text-2xl font-extrabold mb-1">{totalContributed} ETH</div>
                    <div className="text-white/80 text-xs">Balance: {balance !== null ? `${balance} ETH` : "Loading…"}</div>
                  </div>
                  <div className="bg-blue-500 text-white rounded-2xl p-5">
                    <div className="text-white/75 text-xs mb-2">Causes Supported</div>
                    <div className="text-2xl font-extrabold mb-1">{uniqueCauses}</div>
                    <div className="text-white/80 text-xs">{userDonations.length} total donations</div>
                  </div>
                  <div className="bg-amber-500 text-white rounded-2xl p-5">
                    <div className="text-white/75 text-xs mb-2">Campaigns Created</div>
                    <div className="text-2xl font-extrabold mb-1">{userCampaigns.length}</div>
                    <div className="mt-2 h-1.5 bg-white/25 rounded-full">
                      <div className="h-full bg-white rounded-full" style={{width:`${Math.min(userCampaigns.length * 10, 100)}%`}} />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-6 mb-6">
                  {/* Chart */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-5">
                    <h3 className="font-bold text-slate-900 mb-4">Contribution Trends <span className="text-slate-400 font-normal text-xs">6M</span></h3>
                    <div className="flex items-end gap-2 h-28">
                      {monthlyData.map(b => (
                        <div key={b.m} className="flex-1 flex flex-col items-center gap-1">
                          <div
                            className={`w-full rounded-t-lg transition-all ${b.active ? "bg-teal-500" : "bg-teal-200"}`}
                            style={{height:`${b.h}%`}}
                            title={`${b.total.toFixed(4)} ETH`}
                          />
                          <span className={`text-[0.6rem] font-bold ${b.active ? "text-teal-600" : "text-slate-400"}`}>{b.m}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Active campaigns */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-5">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-slate-900">My Campaigns</h3>
                      <button onClick={() => setActiveNav("My Campaigns")} className="text-teal-600 text-xs font-semibold hover:underline">View All →</button>
                    </div>
                    {loadingCampaigns ? (
                      <div className="flex justify-center py-6"><Spinner size="6" /></div>
                    ) : userCampaigns.length === 0 ? (
                      <div className="text-center py-6 text-slate-400 text-sm">Belum ada kampanye</div>
                    ) : (
                      userCampaigns.slice(0, 2).map(item => (
                        <div key={item.id} className="flex items-center gap-3 mb-4 cursor-pointer" onClick={() => navigate("detail", item)}>
                          <div className={`w-10 h-10 bg-gradient-to-br ${item.bg} rounded-xl flex items-center justify-center text-lg flex-shrink-0`}>{item.emoji}</div>
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-slate-900 text-sm truncate">{item.title}</div>
                            <ProgressBar pct={item.pct} className="my-1" />
                            <div className="flex justify-between text-xs text-slate-400">
                              <span>{item.goal} ETH goal</span>
                              <span className="text-teal-600 font-bold">{item.pct}%</span>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                    <button onClick={() => navigate("create")} className="text-teal-600 text-xs font-semibold flex items-center gap-1 hover:underline">⊕ Launch another campaign</button>
                  </div>
                </div>
              </>
            )}

            {/* MY CAMPAIGNS */}
            {activeNav === "My Campaigns" && (
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="flex justify-between items-center px-5 py-4 border-b border-slate-100">
                  <h3 className="font-bold text-slate-900">My Campaigns</h3>
                  <button onClick={() => navigate("create")} className="text-teal-600 text-xs font-semibold hover:underline">+ New Campaign</button>
                </div>
                {loadingCampaigns ? (
                  <div className="flex justify-center py-10"><Spinner size="6" /></div>
                ) : userCampaigns.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">
                    <p className="text-4xl mb-2">📋</p>
                    <p className="font-semibold">Belum ada kampanye</p>
                    <p className="text-sm mt-1">Buat kampanye pertama Anda!</p>
                  </div>
                ) : (
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>{["Campaign","Raised","Goal","Progress","Status"].map(h => <th key={h} className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {userCampaigns.map(c => (
                        <tr key={c.id} className="border-t border-slate-100 cursor-pointer hover:bg-slate-50" onClick={() => navigate("detail", c)}>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <span className="text-xl">{c.emoji}</span>
                              <span className="font-semibold text-slate-900 text-sm">{c.title}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3 font-bold text-teal-700 text-sm">{c.eth} ETH</td>
                          <td className="px-5 py-3 text-slate-500 text-sm">{c.goal} ETH</td>
                          <td className="px-5 py-3 w-32">
                            <ProgressBar pct={c.pct} />
                            <span className="text-xs text-teal-600 font-bold">{c.pct}%</span>
                          </td>
                          <td className="px-5 py-3">
                            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${c.active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${c.active ? "bg-green-500" : "bg-slate-400"}`} />
                              {c.active ? "Active" : "Ended"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* DONATION HISTORY */}
            {activeNav === "Donation History" && (
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="flex justify-between items-center px-5 py-4 border-b border-slate-100">
                  <h3 className="font-bold text-slate-900">Donation History</h3>
                  <span className="text-slate-400 text-xs">{userDonations.length} total donations</span>
                </div>
                {loadingDonations ? (
                  <div className="flex justify-center py-10"><Spinner size="6" /></div>
                ) : userDonations.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">
                    <p className="text-4xl mb-2">🕐</p>
                    <p className="font-semibold">Belum ada riwayat donasi</p>
                  </div>
                ) : (
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>{["Campaign","Amount","Date","Status"].map(h => <th key={h} className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wide">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {userDonations.map((d, i) => {
                        const detail = campaignDetails[d.campaignId];
                        return (
                          <tr key={i} className="border-t border-slate-100">
                            <td className="px-5 py-3">
                              <div className="flex items-center gap-2">
                                {detail && <span className="text-lg">{detail.emoji}</span>}
                                <span className="font-semibold text-slate-900 text-sm">
                                  {detail ? detail.title : `Campaign #${d.campaignId}`}
                                </span>
                              </div>
                            </td>
                            <td className="px-5 py-3 font-bold text-teal-700 text-sm">{d.amount} ETH</td>
                            <td className="px-5 py-3 text-slate-500 text-sm">
                              {d.timestamp ? new Date(d.timestamp * 1000).toLocaleDateString("id-ID") : "—"}
                            </td>
                            <td className="px-5 py-3">
                              <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-green-50 text-green-700">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                Confirmed
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* SETTINGS */}
            {activeNav === "Settings" && (
              <div className="bg-white border border-slate-200 rounded-2xl p-6">
                <h3 className="font-bold text-slate-900 mb-4">Account Settings</h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
                    <div>
                      <p className="font-semibold text-slate-900 text-sm">Wallet Address</p>
                      <p className="font-mono text-xs text-teal-600 mt-0.5">{wallet}</p>
                    </div>
                    <button
                      onClick={() => { navigator.clipboard.writeText(wallet); onToast("Alamat disalin!", "success"); }}
                      className="text-xs font-semibold text-teal-600 hover:underline"
                    >
                      Copy
                    </button>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
                    <div>
                      <p className="font-semibold text-slate-900 text-sm">ETH Balance</p>
                      <p className="text-xs text-slate-500 mt-0.5">{balance !== null ? `${balance} ETH` : "Memuat…"}</p>
                    </div>
                    <button onClick={() => getBalance(wallet).then(setBalance)} className="text-xs font-semibold text-teal-600 hover:underline">Refresh</button>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
                    <div>
                      <p className="font-semibold text-slate-900 text-sm">Smart Contract</p>
                      <p className="font-mono text-xs text-slate-500 mt-0.5">{CONTRACT_ADDRESS}</p>
                    </div>
                    <a
                      href={`https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold text-teal-600 hover:underline"
                    >
                      Etherscan →
                    </a>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SuccessPage({ data, navigate }) {
  const etherscanBase = "https://sepolia.etherscan.io";

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-8 py-16">
      <div className="max-w-md w-full text-center">
        <div className="w-20 h-20 bg-teal-500 rounded-full flex items-center justify-center text-white text-3xl font-extrabold mx-auto mb-6 shadow-lg shadow-teal-200">✓</div>
        <h2 className="text-2xl font-extrabold text-slate-900 mb-3">Donation Successful!</h2>
        <p className="text-slate-500 text-sm leading-relaxed mb-7">
          Kontribusi Anda telah dicatat secara aman di blockchain Ethereum. Setiap wei akan sampai ke tujuannya.
        </p>
        <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-7 text-left">
          {[
            ["Amount",   <span key="a" className="font-bold text-teal-600">{data?.amount || "0.10"} ETH</span>],
            ["Campaign", data?.campaign || "—"],
            ["Tx Hash",  data?.txHash ? (
              <a
                key="h"
                href={`${etherscanBase}/tx/${data.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-teal-600 text-xs hover:underline"
              >
                {data.txHash.slice(0, 18)}…
              </a>
            ) : <span key="h2" className="font-mono text-slate-400 text-xs">Pending…</span>],
            ["Status",   <span key="s" className="inline-flex items-center gap-1.5 text-xs font-semibold bg-green-50 text-green-700 px-2.5 py-1 rounded-full"><span className="w-1.5 h-1.5 bg-green-500 rounded-full" />Confirmed</span>],
            ["Block",    data?.blockNumber ? `#${Number(data.blockNumber).toLocaleString()}` : "—"],
          ].map(([label, val]) => (
            <div key={label} className="flex justify-between items-center py-2.5 border-b border-slate-100 last:border-0">
              <span className="text-slate-500 text-sm">{label}</span>
              <span className="text-slate-900 text-sm font-medium">{val}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-3 justify-center">
          <button onClick={() => navigate("browse")} className="bg-teal-500 hover:bg-teal-600 text-white font-semibold px-6 py-2.5 rounded-full text-sm transition-all">Browse More Campaigns</button>
          <button onClick={() => navigate("dashboard")} className="border-2 border-teal-500 text-teal-600 hover:bg-teal-50 font-semibold px-6 py-2.5 rounded-full text-sm transition-all">View Dashboard</button>
        </div>
      </div>
    </div>
  );
}

function WalletModal({ onClose, onConnect, connecting, metamaskDetected }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
        <h3 className="font-extrabold text-slate-900 text-lg mb-2">Connect Wallet</h3>
        <p className="text-slate-500 text-sm mb-5">
          Pilih wallet untuk terhubung ke CareFund dan mulai donasi transparan.
        </p>

        {/* MetaMask */}
        <button
          onClick={() => metamaskDetected && onConnect("MetaMask")}
          disabled={connecting || !metamaskDetected}
          className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all mb-2 text-left ${
            metamaskDetected
              ? "border-slate-200 hover:border-teal-300 hover:bg-teal-50/50 cursor-pointer"
              : "border-slate-100 bg-slate-50 opacity-50 cursor-not-allowed"
          }`}
        >
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-amber-50">🦊</div>
          <div>
            <span className="font-semibold text-slate-900 block">MetaMask</span>
            <span className={`text-xs ${metamaskDetected ? "text-green-600" : "text-slate-400"}`}>
              {metamaskDetected ? "● Tersedia via window.ethereum" : "● Tidak terdeteksi"}
            </span>
          </div>
          {connecting && <Spinner size="4" />}
        </button>

        {/* WalletConnect — coming soon */}
        <div className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-slate-100 bg-slate-50 mb-2 opacity-50 cursor-not-allowed">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-sky-50">🔗</div>
          <div>
            <span className="font-semibold text-slate-600 block">WalletConnect</span>
            <span className="text-xs text-slate-400">Coming soon</span>
          </div>
        </div>

        {/* Coinbase — coming soon */}
        <div className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-slate-100 bg-slate-50 mb-2 opacity-50 cursor-not-allowed">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-green-50">💰</div>
          <div>
            <span className="font-semibold text-slate-600 block">Coinbase Wallet</span>
            <span className="text-xs text-slate-400">Coming soon</span>
          </div>
        </div>

        <button onClick={onClose} className="w-full text-slate-500 font-medium py-2.5 mt-2 text-sm hover:text-slate-700">Cancel</button>
      </div>
    </div>
  );
}

// ==========================================
// ROOT APP
// ==========================================
function AppInner() {
  const [page, setPage]           = useState("home");
  const [pageData, setPageData]   = useState(null);
  const [walletModal, setWalletModal] = useState(false);
  const [wallet, setWallet]       = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [toast, setToast]         = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [blockNumber, setBlockNumber] = useState(null);
  const [metamaskDetected, setMetamaskDetected] = useState(false);

  const navigate = (target, data = null) => {
    setPage(target);
    setPageData(data);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type, id: Date.now() });
  }, []);

  // Global error handlers to surface uncaught errors and promise rejections
  useEffect(() => {
    const onErr = (ev) => {
      try {
        console.error("Global error:", ev.error || ev.message || ev);
        showToast((ev && (ev.error?.message || ev.message)) || "Terjadi kesalahan tak terduga", "error");
      } catch (e) { console.error(e); }
    };
    const onRej = (ev) => {
      try {
        console.error("Unhandled rejection:", ev.reason || ev);
        const msg = ev && (ev.reason?.message || (typeof ev.reason === 'string' && ev.reason) || 'Unhandled promise rejection');
        showToast(msg, "error");
      } catch (e) { console.error(e); }
    };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, [showToast]);

  // Muat ethers + campaigns saat pertama kali
  useEffect(() => {
    loadEthers().catch(() => {});
    setLoadingCampaigns(true);
    fetchAllCampaigns()
      .then(setCampaigns)
      .catch(() => {})
      .finally(() => setLoadingCampaigns(false));
    getLatestBlock().then(setBlockNumber);
    
    // HANYA cek availability MetaMask, jangan panggil request apapun
    // (itu akan trigger evmAsk.js errors di startup)
    if (window.ethereum) {
      setMetamaskDetected(true);
      console.log("✓ MetaMask detected via window.ethereum");
    } else {
      setMetamaskDetected(false);
      console.log("✗ MetaMask not found");
    }
  }, []);

  // Poll block number setiap 12 detik
  useEffect(() => {
    const interval = setInterval(() => getLatestBlock().then(setBlockNumber), 12000);
    return () => clearInterval(interval);
  }, []);

  // Dengarkan event accountsChanged & chainChanged dari MetaMask
  // HANYA setup jika wallet sudah connected (user klik Connect)
  useEffect(() => {
    if (!window.ethereum) return;
    if (!wallet) return; // Hanya pasang listener kalau wallet sudah terkoneksi
    
    try {
      const onAccountsChanged = (accounts) => {
        if (accounts.length === 0) {
          setWallet(null);
          showToast("Wallet terputus.", "warning");
        } else if (accounts[0] !== wallet) {
          setWallet(accounts[0]);
          showToast(`Akun berganti ke ${shortAddr(accounts[0])}`, "info");
        }
      };
      const onChainChanged = () => {
        showToast("Network berganti, memuat ulang data…", "info");
        setLoadingCampaigns(true);
        fetchAllCampaigns()
          .then(setCampaigns)
          .finally(() => setLoadingCampaigns(false));
      };
      
      if (typeof window.ethereum.on === 'function') {
        window.ethereum.on("accountsChanged", onAccountsChanged);
        window.ethereum.on("chainChanged", onChainChanged);
      }
      
      return () => {
        if (typeof window.ethereum.removeListener === 'function') {
          window.ethereum.removeListener("accountsChanged", onAccountsChanged);
          window.ethereum.removeListener("chainChanged", onChainChanged);
        }
      };
    } catch (err) {
      console.error("Failed to setup MetaMask listeners:", err);
    }
  }, [wallet, showToast]);

  // Refresh campaigns setelah create/donate
  const refreshCampaigns = useCallback(() => {
    setLoadingCampaigns(true);
    fetchAllCampaigns()
      .then(setCampaigns)
      .finally(() => setLoadingCampaigns(false));
  }, []);

  const handleConnect = async (walletName) => {
    if (walletName !== "MetaMask") return;
    if (!window.ethereum) {
      showToast("MetaMask tidak terdeteksi. Refresh halaman dan coba ulang.", "error");
      return;
    }
    
    setConnecting(true);
    console.log("[handleConnect] Initiating wallet connection...");
    
    try {
      // Increase timeout to 30 seconds to allow user to interact with MetaMask popup
      const result = await Promise.race([
        connectWalletReal(),
        new Promise((_, reject) => 
          setTimeout(() => {
            reject(new Error("Connection timeout - MetaMask popup took too long. Please try again."));
          }, 30000)
        )
      ]);
      
      setConnecting(false);
      
      if (result.success) {
        setWallet(result.account);
        setWalletModal(false);
        showToast(`✓ Wallet terhubung: ${shortAddr(result.account)}`, "success");
        console.log("[handleConnect] Success!");
      } else {
        showToast(result.message, "error");
        console.log("[handleConnect] Connection failed:", result.message);
      }
    } catch (err) {
      setConnecting(false);
      console.error("[handleConnect] Error:", err);
      
      // Provide user-friendly error message
      if (err.message.includes("timeout")) {
        showToast("Timeout - MetaMask popup tidak direspons. Cek apakah popup terbuka.", "error");
      } else if (err.message.includes("Unexpected")) {
        showToast("MetaMask error. Refresh halaman dan coba ulang.", "error");
      } else {
        showToast(err.message || "Gagal connect wallet.", "error");
      }
    }
  };

  const globalStats = {
    totalDonors:      campaigns.reduce((s, c) => s + c.donorCount, 0),
    activeCampaigns:  campaigns.filter(c => c.active).length,
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');
        @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
        .animate-float-card { animation: float 4s ease-in-out infinite; }
        .line-clamp-2 { display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
        @keyframes bounce-in { 0%{transform:translateY(20px);opacity:0} 100%{transform:translateY(0);opacity:1} }
        .animate-bounce-in { animation: bounce-in 0.3s ease-out; }
      `}</style>

      {/* NAVBAR */}
     <nav className="sticky top-0 z-40 bg-white/95 backdrop-blur-xl border-b border-slate-100 shadow-sm">
  <div className="flex items-center justify-between px-10 h-16">
    
    <button 
      onClick={() => navigate("home")} 
      className="flex items-center bg-none border-none cursor-pointer transition-transform active:scale-95"
    >
      <img 
        src="/logo.jpeg" 
        alt="CareFund Logo" 
        className="h-10 w-auto object-contain" 
      />
    </button>
    
    {/* BAGIAN NAVIGASI MENU */}
    <div className="flex items-center gap-1">
      {[ 
        { id: "home", label: "Home" }, 
        { id: "browse", label: "Browse" }, 
        { id: "create", label: "Create" }, 
        { id: "dashboard", label: "Dashboard" } 
      ].map(n => (
        <button 
          key={n.id} 
          onClick={() => navigate(n.id)} 
          className={`text-sm font-medium px-4 py-1.5 rounded-lg transition-all ${
            page === n.id 
              ? "text-[#009ca6] bg-teal-50/60 font-bold" 
              : "text-slate-600 hover:text-[#009ca6] hover:bg-slate-50"
          }`}
        >
          {n.label}
        </button>
      ))}
    </div>
    
    {/* BAGIAN KANAN: SEARCH & WALLET */}
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-full px-4 py-1.5 text-xs text-slate-400 hover:border-teal-300 cursor-pointer transition-colors">
        🔍 Search campaigns…
      </div>
      
      <button 
        onClick={() => setWalletModal(true)} 
        className={`flex items-center gap-2 font-semibold px-5 py-2 rounded-full text-sm transition-all text-white hover:-translate-y-0.5 hover:shadow-md ${
          wallet 
            ? "bg-[#0c2340] hover:bg-[#123054] shadow-indigo-100" 
            : "bg-[#009ca6] hover:bg-[#00838c] shadow-teal-100"   
        }`}
      >
        {wallet ? `✓ ${wallet.substring(0,8)}…` : "🦊 Connect Wallet"}
      </button>
    </div>

  </div>
</nav>
      {/* PAGES */}
      <div>
        {page === "home"      && <HomePage      navigate={navigate} campaigns={campaigns} globalStats={globalStats} blockNumber={blockNumber} />}
        {page === "browse"    && <BrowsePage    navigate={navigate} campaigns={campaigns} loading={loadingCampaigns} />}
        {page === "detail"    && pageData       && <DetailPage campaign={pageData} navigate={navigate} wallet={wallet} onToast={showToast} />}
        {page === "create"    && <CreatePage    navigate={navigate} wallet={wallet} onToast={showToast} />}
        {page === "dashboard" && <DashboardPage navigate={navigate} wallet={wallet}  onToast={showToast} />}
        {page === "success"   && <SuccessPage   data={pageData}     navigate={navigate} />}
      </div>

      {/* WALLET MODAL */}
      {walletModal && (
        <WalletModal
          onClose={() => setWalletModal(false)}
          onConnect={handleConnect}
          connecting={connecting}
          metamaskDetected={metamaskDetected}
        />
      )}

      {/* TOAST */}
      {toast && (
        <Toast
          key={toast.id}
          msg={toast.msg}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}

// Simple React Error Boundary to catch render errors and show a fallback UI.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { console.error('Uncaught error in component tree:', error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-8 bg-slate-50">
          <div className="max-w-2xl w-full bg-white border rounded-2xl p-6 shadow">
            <h2 className="text-lg font-bold mb-3">Terjadi kesalahan</h2>
            <p className="text-sm text-slate-600 mb-4">Aplikasi mengalami error tak terduga. Silakan refresh atau hubungi pengembang.</p>
            <pre className="text-xs bg-slate-50 p-3 rounded text-left overflow-auto">{String(this.state.error)}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}