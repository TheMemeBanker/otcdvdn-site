/* OTC DVDN — everything is read from the chain in the browser. No backend,
   no signing. Program aggregates come from data/params.json (labeled sync). */
import { deriveAta, TOKEN_2022_PROGRAM, b58decode } from "./ata.mjs";

const RPCS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
const $ = (id) => document.getElementById(id);

let P = null; // params
let live = { walletSol: null, solUsd: null, otcUsd: null };

async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      if (d.result !== undefined) return d.result;
    } catch { /* next */ }
  }
  return null;
}

async function price(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8000) });
    const d = await res.json();
    const pairs = (d.pairs || []).filter((p) => p.chainId === "solana");
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return pairs.length ? Number(pairs[0].priceUsd) : null;
  } catch { return null; }
}

const fmtSol = (n) => n >= 100 ? n.toFixed(2) : n.toFixed(4);
const fmtUsd = (n) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 });
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n.toLocaleString("en-US", { maximumFractionDigits: 0 });

async function boot() {
  P = await (await fetch("./data/params.json")).json();
  $("stWallet").href = `https://solscan.io/account/${P.dividend_wallet}`;
  $("stHolders").textContent = P.eligible_holders.toLocaleString();
  $("stPaid").textContent = P.paid_all_time_sol.toFixed(2) + " SOL";
  $("stRounds").textContent = `over ${P.rounds_all_time} rounds`;
  $("footSync").textContent = P.as_of;
  $("boostX").textContent = P.dvdn.multiplier;
  $("multX").textContent = "×" + P.dvdn.multiplier;

  if (P.dvdn.mint) {
    const a = document.createElement("a");
    a.href = `https://solscan.io/token/${P.dvdn.mint}`;
    a.target = "_blank"; a.rel = "noopener";
    a.textContent = P.dvdn.mint;
    $("dvdnMint").replaceChildren(a);
    $("multStatus").textContent = "This desk reads your $DVDN balance from the chain and applies the multiplier to your displayed payout automatically.";
    const pill = $("dvdnTokenLink");
    pill.href = `https://solscan.io/token/${P.dvdn.mint}`;
    pill.removeAttribute("aria-disabled");
    pill.removeAttribute("title");
    pill.target = "_blank"; pill.rel = "noopener";
  }

  // live wallet balance + prices, in parallel
  const [bal, solUsd, otcUsd] = await Promise.all([
    rpc("getBalance", [P.dividend_wallet]),
    price("So11111111111111111111111111111111111111112"),
    price(P.otc_mint),
  ]);
  if (bal && typeof bal.value === "number") {
    live.walletSol = bal.value / 1e9;
    $("stSol").textContent = fmtSol(live.walletSol);
  } else {
    $("stSol").textContent = "verify ↗";
  }
  live.solUsd = solUsd;
  live.otcUsd = otcUsd;
  if (live.walletSol != null && solUsd) $("stUsd").textContent = fmtUsd(live.walletSol * solUsd) + " · live from the chain";
}

async function tokenBalance(owner, mint) {
  const ata = await deriveAta(owner, mint, TOKEN_2022_PROGRAM);
  const info = await rpc("getAccountInfo", [ata, { encoding: "jsonParsed" }]);
  const parsed = info?.value?.data?.parsed?.info;
  if (parsed && parsed.mint === mint) return Number(parsed.tokenAmount.uiAmount) || 0;
  return 0;
}

async function lookup() {
  const w = $("wallet").value.trim();
  $("lookupErr").hidden = true;
  $("lookupOut").hidden = true;
  try {
    if (b58decode(w).length !== 32) throw new Error("bad");
  } catch {
    $("lookupErr").textContent = "That doesn't look like a Solana wallet address.";
    $("lookupErr").hidden = false;
    return;
  }
  $("go").disabled = true;
  $("go").textContent = "Reading…";
  try {
    const otc = await tokenBalance(w, P.otc_mint);
    const usd = live.otcUsd != null ? otc * live.otcUsd : null;
    const eligible = usd != null ? usd >= P.min_usd : otc > 0;
    const share = otc / P.eligible_total_otc;
    const due = live.walletSol != null ? live.walletSol * share : null;

    $("oBal").textContent = fmtTok(otc) + " OTC";
    $("oUsd").textContent = usd != null ? fmtUsd(usd) : "—";
    $("oElig").textContent = eligible ? "Yes" : usd != null ? `No — hold ${fmtUsd(P.min_usd)}+` : "—";
    $("oElig").className = "dv-big " + (eligible ? "dv-elig-yes" : "dv-elig-no");
    $("oShare").textContent = otc > 0 ? (share * 100).toFixed(share > 0.001 ? 2 : 4) + "%" : "0%";
    $("oDue").textContent = due != null && eligible ? fmtSol(due) + " SOL" : "0 SOL";

    // $DVDN multiplier
    let boosted = false;
    if (P.dvdn.mint) {
      const dvdn = await tokenBalance(w, P.dvdn.mint);
      boosted = dvdn > 0;
      $("boostState").textContent = boosted ? `×${P.dvdn.multiplier} active — you hold $DVDN` : "hold $DVDN to activate";
    }
    $("oDueBoost").textContent = due != null && eligible ? fmtSol(due * P.dvdn.multiplier) + " SOL" : "0 SOL";
    if (!P.dvdn.mint) $("boostState").textContent = "preview — $DVDN launches soon";

    $("oNote").textContent =
      (otc === 0 ? "No OTC found in this wallet's standard token account. Balances held in non-standard accounts may not appear here — check the wallet on Solscan. " : "") +
      `Estimates use the live dividend-wallet balance and the eligible pool synced ${P.as_of}. Payouts arrive automatically every ${P.round_every_hours} hours — nothing to sign.`;
    $("lookupOut").hidden = false;
  } catch (e) {
    $("lookupErr").textContent = "Chain read failed — try again in a moment, or verify directly on Solscan.";
    $("lookupErr").hidden = false;
  } finally {
    $("go").disabled = false;
    $("go").textContent = "Check";
  }
}

$("go").addEventListener("click", lookup);
$("wallet").addEventListener("keydown", (e) => { if (e.key === "Enter") lookup(); });
$("themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", cur);
  try { localStorage.setItem("dvdn-theme", cur); } catch { }
});

boot();

// sidebar drawer (mobile)
const side = document.getElementById("sidebar");
const scrim = document.getElementById("sideScrim");
document.getElementById("sideToggle").addEventListener("click", () => {
  const open = side.classList.toggle("open");
  scrim.hidden = !open;
});
scrim.addEventListener("click", () => { side.classList.remove("open"); scrim.hidden = true; });
