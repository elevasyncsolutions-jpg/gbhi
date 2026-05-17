import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const cfg = {
  port: Number(process.env.PORT || 3000),
  appPassword: process.env.APP_PASSWORD || 'Flowwwww1234',
  dryRun: String(process.env.DRY_RUN || 'true') === 'true',
  autoTrading: String(process.env.AUTO_TRADING_ENABLED || 'false') === 'true',
  autoPayout: String(process.env.AUTO_PAYOUT_ENABLED || 'false') === 'true',
  loopSeconds: Number(process.env.AUTO_LOOP_SECONDS || 90),
  rpc: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  jupBase: (process.env.JUPITER_API_BASE || 'https://api.jup.ag').replace(/\/$/, ''),
  jupKey: process.env.JUPITER_API_KEY || '',
  birdKey: process.env.BIRDEYE_API_KEY || '',
  groqKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
  secretKey: process.env.SERVER_WALLET_SECRET_KEY_BASE58 || '',
  payoutWallet: process.env.PAYOUT_WALLET || '',
  reserveSol: Number(process.env.RESERVE_SOL || 0.006),
  maxTradeSol: Number(process.env.MAX_TRADE_SOL || 0.015),
  maxDailyLossUsd: Number(process.env.MAX_DAILY_LOSS_USD || 3),
  minProfitUsd: Number(process.env.MIN_EXPECTED_PROFIT_USD || 0.15),
  minScore: Number(process.env.MIN_SCORE_TO_TRADE || 82),
  takeProfitPct: Number(process.env.TAKE_PROFIT_PCT || 18),
  stopLossPct: Number(process.env.STOP_LOSS_PCT || 8),
  maxPositions: Number(process.env.MAX_OPEN_POSITIONS || 2),
  baseMint: process.env.BASE_MINT || 'So11111111111111111111111111111111111111112',
  usdcMint: process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qGfjnKqwe9Ss623VQ5DA',
  minLiquidity: Number(process.env.MIN_LIQUIDITY_USD || 20000),
  minVol1h: Number(process.env.MIN_VOLUME_1H_USD || 5000),
  maxAgeHours: Number(process.env.MAX_TOKEN_AGE_HOURS || 72),
  blacklist: new Set(String(process.env.BLACKLIST_MINTS || '').split(',').map(s => s.trim()).filter(Boolean))
};

const connection = new Connection(cfg.rpc, 'confirmed');
let wallet = null;
if (cfg.secretKey) {
  try { wallet = Keypair.fromSecretKey(bs58.decode(cfg.secretKey)); }
  catch (e) { console.error('Invalid SERVER_WALLET_SECRET_KEY_BASE58:', e.message); }
}

const state = {
  startedAt: new Date().toISOString(),
  autoRunning: cfg.autoTrading,
  panic: false,
  lastScan: null,
  trades: [],
  alerts: [],
  positions: [],
  daily: { day: new Date().toISOString().slice(0,10), realizedPnlUsd: 0, lossUsd: 0 },
  loop: null
};

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sde_session;
  if (token && verifyToken(token)) return next();
  res.status(401).json({ ok:false, error:'Unauthorized' });
}

function signToken() {
  const payload = JSON.stringify({ exp: Date.now() + 1000*60*60*12 });
  const b = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(b).digest('base64url');
  return `${b}.${sig}`;
}
function verifyToken(t) {
  try {
    const [b,sig] = t.split('.');
    const good = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(b).digest('base64url');
    if (sig !== good) return false;
    const p = JSON.parse(Buffer.from(b,'base64url').toString());
    return p.exp > Date.now();
  } catch { return false; }
}

async function tg(text) {
  state.alerts.unshift({ at: new Date().toISOString(), text });
  state.alerts = state.alerts.slice(0, 100);
  if (!cfg.tgToken || !cfg.tgChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: cfg.tgChat, text, parse_mode:'HTML', disable_web_page_preview:true })
    });
  } catch(e) { console.error('Telegram error', e.message); }
}

function jupHeaders() {
  return cfg.jupKey ? { 'x-api-key': cfg.jupKey, 'content-type':'application/json' } : { 'content-type':'application/json' };
}
function birdHeaders() {
  return { 'accept':'application/json', 'x-chain':'solana', 'X-API-KEY': cfg.birdKey };
}

async function getBalanceSol() {
  if (!wallet) return null;
  const lamports = await connection.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

async function birdeyeTokenList() {
  if (!cfg.birdKey) throw new Error('Missing BIRDEYE_API_KEY');
  const url = new URL('https://public-api.birdeye.so/defi/v3/token/list');
  url.searchParams.set('chain','solana');
  url.searchParams.set('sort_by','volume_1h_usd');
  url.searchParams.set('sort_type','desc');
  url.searchParams.set('min_liquidity', String(cfg.minLiquidity));
  url.searchParams.set('min_volume_1h_usd', String(cfg.minVol1h));
  url.searchParams.set('limit','30');
  const r = await fetch(url, { headers: birdHeaders() });
  const j = await r.json();
  if (!r.ok) throw new Error(`Birdeye list ${r.status}: ${JSON.stringify(j).slice(0,300)}`);
  return j?.data?.items || j?.data?.tokens || j?.data || [];
}

async function birdeyeOverview(address) {
  if (!cfg.birdKey) return null;
  const url = new URL('https://public-api.birdeye.so/defi/token_overview');
  url.searchParams.set('address', address);
  url.searchParams.set('frames','5m,1h,24h');
  const r = await fetch(url, { headers: birdHeaders() });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) return null;
  return j.data || null;
}

async function birdeyeSecurity(address) {
  if (!cfg.birdKey) return null;
  const url = new URL('https://public-api.birdeye.so/defi/token_security');
  url.searchParams.set('address', address);
  const r = await fetch(url, { headers: birdHeaders() });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) return null;
  return j.data || null;
}

async function quoteLegacy(inputMint, outputMint, amountLamports, slippageBps=200) {
  const url = new URL(`${cfg.jupBase}/swap/v1/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amountLamports));
  url.searchParams.set('slippageBps', String(slippageBps));
  const r = await fetch(url, { headers: jupHeaders() });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`Jupiter quote ${r.status}: ${JSON.stringify(j).slice(0,300)}`);
  return j;
}

async function buildSwapLegacy(quoteResponse) {
  if (!wallet) throw new Error('Missing server wallet');
  const r = await fetch(`${cfg.jupBase}/swap/v1/swap`, {
    method:'POST', headers: jupHeaders(),
    body: JSON.stringify({ quoteResponse, userPublicKey: wallet.publicKey.toBase58(), dynamicComputeUnitLimit:true, prioritizationFeeLamports:'auto' })
  });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`Jupiter swap ${r.status}: ${JSON.stringify(j).slice(0,300)}`);
  return j.swapTransaction;
}

async function signAndSendBase64(txBase64) {
  if (cfg.dryRun) return { dryRun:true, signature:'DRY_RUN_NO_BROADCAST' };
  if (!wallet) throw new Error('Missing server wallet');
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight:false, maxRetries:3 });
  await connection.confirmTransaction(sig, 'confirmed');
  return { dryRun:false, signature:sig };
}

function hardScore(t, overview, security) {
  const flags = [];
  let score = 50;
  const address = t.address || t.mint || t.token_address;
  if (!address || cfg.blacklist.has(address)) { flags.push('blacklisted/missing address'); score -= 100; }
  const liq = Number(t.liquidity || t.liquidity_usd || overview?.liquidity || 0);
  const vol1h = Number(t.volume_1h_usd || overview?.v1hUSD || overview?.volume1h || 0);
  const holders = Number(t.holder || t.holder_count || overview?.holder || 0);
  const pc1h = Number(t.price_change_1h_percent || overview?.priceChange1hPercent || 0);
  const pc5m = Number(t.price_change_5m_percent || overview?.priceChange5mPercent || 0);
  if (liq >= cfg.minLiquidity) score += 12; else { score -= 25; flags.push('low liquidity'); }
  if (vol1h >= cfg.minVol1h) score += 12; else { score -= 20; flags.push('low 1h volume'); }
  if (holders >= 100) score += 8; else flags.push('low holders/unknown holders');
  if (pc5m > 2 && pc5m < 35) score += 10;
  if (pc1h > 5 && pc1h < 120) score += 10;
  if (pc5m > 60 || pc1h > 250) { score -= 25; flags.push('vertical pump risk'); }
  if (security) {
    if (security.freezeable || security.freezeAuthority || security.isFreezeAuthority) { score -= 40; flags.push('freeze authority risk'); }
    if (security.mintable || security.mintAuthority || security.isMintable) { score -= 35; flags.push('mint authority risk'); }
    if (security.honeypot || security.isHoneypot) { score -= 100; flags.push('honeypot risk'); }
  } else flags.push('security unavailable');
  return { score: Math.max(0, Math.min(100, Math.round(score))), flags, liq, vol1h, holders, pc1h, pc5m };
}

async function groqScore(candidate) {
  if (!cfg.groqKey) return { aiScore:null, note:'Groq key missing; used hard score only' };
  try {
    const prompt = `You are a risk filter for a tiny Solana auto-trading bot. Return JSON only: {"score":0-100,"decision":"BUY|WATCH|REJECT","reason":"short"}. Candidate: ${JSON.stringify(candidate).slice(0,3500)}`;
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${cfg.groqKey}`},
      body: JSON.stringify({ model: cfg.groqModel, messages:[{role:'user', content:prompt}], temperature:0.1, response_format:{type:'json_object'} })
    });
    const j = await r.json();
    const txt = j?.choices?.[0]?.message?.content || '{}';
    return JSON.parse(txt);
  } catch(e) { return { aiScore:null, decision:'WATCH', reason:`Groq error: ${e.message}` }; }
}

async function scan() {
  resetDailyIfNeeded();
  const items = await birdeyeTokenList();
  const out = [];
  for (const raw of items.slice(0, 12)) {
    const address = raw.address || raw.mint || raw.token_address;
    if (!address || address === cfg.baseMint || address === cfg.usdcMint) continue;
    if (cfg.blacklist.has(address)) continue;
    const [overview, security] = await Promise.all([birdeyeOverview(address), birdeyeSecurity(address)]);
    const h = hardScore(raw, overview, security);
    const candidate = { address, symbol: raw.symbol || overview?.symbol, name: raw.name || overview?.name, hard:h, raw };
    const ai = await groqScore(candidate);
    const aiScore = Number(ai.score ?? ai.aiScore ?? h.score);
    const finalScore = Math.round((h.score * 0.72) + (aiScore * 0.28));
    const decision = finalScore >= cfg.minScore && h.flags.length <= 1 ? 'AUTO_CANDIDATE' : finalScore >= 70 ? 'WATCH' : 'REJECT';
    out.push({ ...candidate, ai, finalScore, decision, at:new Date().toISOString() });
  }
  out.sort((a,b)=>b.finalScore-a.finalScore);
  state.lastScan = { at: new Date().toISOString(), count: out.length, items: out.slice(0,10) };
  await tg(`🧠 <b>Dream Engine scan</b>\nTop: ${out[0]?.symbol || 'none'} score ${out[0]?.finalScore || 0}\nDecision: ${out[0]?.decision || 'none'}\nMode: ${cfg.dryRun ? 'DRY_RUN' : 'LIVE'}`);
  return state.lastScan;
}

async function executeBuy(candidate) {
  if (state.panic) throw new Error('Panic mode active');
  if (!wallet) throw new Error('Missing hot wallet');
  if (state.positions.length >= cfg.maxPositions) throw new Error('Max positions reached');
  if (state.daily.lossUsd >= cfg.maxDailyLossUsd) throw new Error('Daily loss limit reached');
  const balance = await getBalanceSol();
  if (balance === null || balance < cfg.reserveSol + cfg.maxTradeSol) throw new Error(`Insufficient SOL. Balance=${balance}`);
  const amountLamports = Math.floor(cfg.maxTradeSol * LAMPORTS_PER_SOL);
  const quote = await quoteLegacy(cfg.baseMint, candidate.address, amountLamports, 250);
  const expectedOut = quote.outAmount;
  const swapTx = await buildSwapLegacy(quote);
  const sent = await signAndSendBase64(swapTx);
  const pos = { id: crypto.randomUUID(), mint:candidate.address, symbol:candidate.symbol, buySol:cfg.maxTradeSol, expectedOut, buyScore:candidate.finalScore, openedAt:new Date().toISOString(), signature:sent.signature, dryRun:cfg.dryRun };
  state.positions.push(pos);
  state.trades.unshift({ type:'BUY', ...pos });
  await tg(`✅ <b>${cfg.dryRun ? 'DRY-RUN ' : ''}BUY</b> ${candidate.symbol}\nScore: ${candidate.finalScore}\nAmount: ${cfg.maxTradeSol} SOL\nSig: ${sent.signature}`);
  return pos;
}

async function autopilotTick() {
  try {
    if (!state.autoRunning || state.panic) return;
    const s = await scan();
    const top = s.items.find(x => x.decision === 'AUTO_CANDIDATE');
    if (!top) return;
    if (!cfg.autoTrading) return await tg('⚠️ AUTO_TRADING_ENABLED=false. Candidate found, execution skipped.');
    await executeBuy(top);
  } catch(e) {
    await tg(`⚠️ Autopilot error: ${e.message}`);
  }
}

function startLoop() {
  if (state.loop) clearInterval(state.loop);
  state.loop = setInterval(autopilotTick, Math.max(30, cfg.loopSeconds) * 1000);
}
function resetDailyIfNeeded() {
  const day = new Date().toISOString().slice(0,10);
  if (state.daily.day !== day) state.daily = { day, realizedPnlUsd:0, lossUsd:0 };
}

async function payout() {
  if (!wallet) throw new Error('Missing hot wallet');
  if (!cfg.payoutWallet) throw new Error('Missing PAYOUT_WALLET');
  const balance = await getBalanceSol();
  const available = balance - cfg.reserveSol;
  if (available <= 0) throw new Error(`Nothing available. Balance ${balance}, reserve ${cfg.reserveSol}`);
  const lamports = Math.floor(available * LAMPORTS_PER_SOL);
  const to = new PublicKey(cfg.payoutWallet);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: to, lamports }));
  let signature = 'DRY_RUN_NO_BROADCAST';
  if (!cfg.dryRun) {
    signature = await connection.sendTransaction(tx, [wallet], { skipPreflight:false });
    await connection.confirmTransaction(signature, 'confirmed');
  }
  await tg(`💸 <b>${cfg.dryRun ? 'DRY-RUN ' : ''}PAYOUT</b>\nAmount: ${available.toFixed(6)} SOL\nTo: ${cfg.payoutWallet}\nSig: ${signature}`);
  return { ok:true, dryRun:cfg.dryRun, amountSol:available, signature };
}

app.post('/api/login', (req,res)=> {
  if (req.body?.password === cfg.appPassword) return res.json({ ok:true, token:signToken() });
  res.status(401).json({ ok:false });
});
app.get('/api/status', auth, async (req,res)=> {
  res.json({ ok:true, cfg:{ dryRun:cfg.dryRun, autoTradingEnv:cfg.autoTrading, autoRunning:state.autoRunning, panic:state.panic, wallet:wallet?.publicKey?.toBase58() || null, maxTradeSol:cfg.maxTradeSol, minScore:cfg.minScore, reserveSol:cfg.reserveSol }, balanceSol: await getBalanceSol().catch(()=>null), state });
});
app.post('/api/scan', auth, async (req,res)=> { try { res.json({ok:true, scan: await scan()}); } catch(e){ res.status(500).json({ok:false,error:e.message}); } });
app.post('/api/autopilot/start', auth, async (req,res)=> { state.autoRunning=true; await tg('🟢 Autopilot started'); res.json({ok:true}); });
app.post('/api/autopilot/stop', auth, async (req,res)=> { state.autoRunning=false; await tg('🟡 Autopilot stopped'); res.json({ok:true}); });
app.post('/api/panic', auth, async (req,res)=> { state.panic=true; state.autoRunning=false; await tg('🔴 PANIC MODE: autopilot stopped'); res.json({ok:true}); });
app.post('/api/payout', auth, async (req,res)=> { try { res.json(await payout()); } catch(e){ res.status(500).json({ok:false,error:e.message}); } });

if (process.argv.includes('--scan-once')) {
  scan().then(x=>{ console.log(JSON.stringify(x,null,2)); process.exit(0); }).catch(e=>{ console.error(e); process.exit(1); });
} else {
  startLoop();
  app.listen(cfg.port, ()=> console.log(`Solana Dream Engine V3 Auto running on :${cfg.port}`));
  setTimeout(()=>tg(`🚀 Dream Engine V3 online. Mode=${cfg.dryRun?'DRY_RUN':'LIVE'} Auto=${cfg.autoTrading}`), 1500);
}
