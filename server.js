import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
// Behind proxies (Cloudflare/NGINX), trust X-Forwarded-For / cf-connecting-ip
app.set('trust proxy', process.env.TRUST_PROXY === 'true');

// Faucet contract addresses
const FAUCET_CONTRACTS = {
  amoy: "0x9c33b5Ad90570262A4b49abAFf47e4Ef7DeC3c08",
  avax: "0x9c33b5Ad90570262A4b49abAFf47e4Ef7DeC3c08",
  sepolia: "0x9c33b5Ad90570262A4b49abAFf47e4Ef7DeC3c08",
  base: "0x9c33b5Ad90570262A4b49abAFf47e4Ef7DeC3c08",
};

// RPC URLs
const RPC = {
  amoy: process.env.POLYGON_RPC,
  avax: process.env.AVAX_RPC,
  sepolia: process.env.SEPOLIA_RPC,
  base: process.env.BASE_RPC,
};

const faucetABI = [
  "function adminClaimFor(address recipient)",
  "function claimAmount() view returns(uint256)",
  "function cooldown() view returns(uint256)",
  "function lastClaim(address) view returns(uint256)"
];

const ownerWallet = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY);

// --- hCaptcha verification ---
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET || '';

async function verifyHCaptcha(token, remoteip) {
  if (!HCAPTCHA_SECRET) return false;
  try {
    const params = new URLSearchParams();
    params.append('secret', HCAPTCHA_SECRET);
    params.append('response', token || '');
    if (remoteip) params.append('remoteip', remoteip);

    const resp = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const data = await resp.json();
    return !!data.success;
  } catch {
    return false;
  }
}

// --- IP cooldown using filesystem locks ---
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCK_DIR = path.join(os.tmpdir(), 'strawhat-faucet-locks');
const PENDING_MS = 60 * 1000; // short pending lock to avoid rapid successive claims

function hashKey(ip, network) {
  return crypto.createHash('sha256').update(`${ip}|${network}`).digest('hex');
}

function getClientIp(req) {
  // If explicitly behind a trusted proxy, use forwarded headers via req.ip
  if (process.env.TRUST_PROXY === 'true') {
    return (req.ip || '').replace('::ffff:', '') || req.socket?.remoteAddress || '0.0.0.0';
  }
  // Otherwise, do NOT trust client-sent forwarded headers
  const ra = (req.socket?.remoteAddress || '').replace('::ffff:', '');
  return ra || '0.0.0.0';
}

async function ensureLockDir() {
  try { await fs.mkdir(LOCK_DIR, { recursive: true }); } catch {}
}

function lockPathFor(ip, network) {
  return path.join(LOCK_DIR, `${hashKey(ip, network)}.lock`);
}

function pendingPathFor(ip, network) {
  return path.join(LOCK_DIR, `${hashKey(ip, network)}.pending`);
}

async function getIpCooldown(ip, network) {
  await ensureLockDir();
  try {
    const p = lockPathFor(ip, network);
    const raw = await fs.readFile(p, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    if (typeof data?.expiresAt === 'number' && data.expiresAt > now) {
      return data.expiresAt - now;
    }
    // expired -> cleanup
    try { await fs.unlink(p); } catch {}
    return 0;
  } catch {
    return 0;
  }
}

async function setIpCooldown(ip, network, meta = {}) {
  await ensureLockDir();
  const p = lockPathFor(ip, network);
  const payload = {
    firstSeenAt: Date.now(),
    expiresAt: Date.now() + COOLDOWN_MS,
    ...meta,
  };
  try { await fs.writeFile(p, JSON.stringify(payload), 'utf8'); } catch {}
}

async function clearIpCooldown(ip, network) {
  try { await fs.unlink(lockPathFor(ip, network)); } catch {}
}

async function getIpPending(ip, network) {
  await ensureLockDir();
  try {
    const p = pendingPathFor(ip, network);
    const raw = await fs.readFile(p, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    if (typeof data?.expiresAt === 'number' && data.expiresAt > now) {
      return data.expiresAt - now;
    }
    try { await fs.unlink(p); } catch {}
    return 0;
  } catch {
    return 0;
  }
}

async function setIpPending(ip, network, meta = {}) {
  await ensureLockDir();
  const p = pendingPathFor(ip, network);
  const payload = {
    firstSeenAt: Date.now(),
    expiresAt: Date.now() + PENDING_MS,
    ...meta,
  };
  try { await fs.writeFile(p, JSON.stringify(payload), 'utf8'); } catch {}
}

async function clearIpPending(ip, network) {
  try { await fs.unlink(pendingPathFor(ip, network)); } catch {}
}

function log(msg) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${msg}`);
}

app.post("/claim", async (req, res) => {
  log("➡ Received claim request");

  try {
    const { network, recipient, captchaToken } = req.body;
    const clientIp = getClientIp(req);
    log(`Request: ip=${clientIp}, network=${network}, recipient=${recipient}`);

    // 1) Human verification first
    if (!captchaToken) {
      return res.status(400).send({ success: false, error: "Invalid captcha" });
    }
    const captchaOk = await verifyHCaptcha(captchaToken, clientIp);
    if (!captchaOk) {
      return res.status(400).send({ success: false, error: "Invalid captcha" });
    }

    // 2) Enforce per-IP cooldown and pending lock (without DB)
    const remaining = await getIpCooldown(clientIp, network);
    if (remaining > 0) {
      log(`⛔ IP cooldown active for ${clientIp}. Wait ${Math.ceil(remaining/1000)}s`);
      return res.status(429).send({ 
        success: false, 
        error: "Wait before next claim", 
        wait: Math.ceil(remaining / 1000) 
      });
    }
    const pending = await getIpPending(clientIp, network);
    if (pending > 0) {
      log(`⏳ IP pending lock active for ${clientIp}. Wait ${Math.ceil(pending/1000)}s`);
      return res.status(429).send({
        success: false,
        error: "Wait before next claim",
        wait: Math.ceil(pending / 1000)
      });
    }
    // set short pending lock to avoid rapid multiple attempts
    await setIpPending(clientIp, network, { recipient, network });

    const rpcUrl = RPC[network];
    const contractAddress = FAUCET_CONTRACTS[network];

    if (!rpcUrl || !contractAddress)
      return res.status(400).send({ success: false, error: "Invalid network" });

    if (!ethers.isAddress(recipient))
      return res.status(400).send({ success: false, error: "Invalid recipient address" });

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = ownerWallet.connect(provider);
    const faucet = new ethers.Contract(contractAddress, faucetABI, signer);

    const claimAmt = await faucet.claimAmount();
    log(`💰 Attempting to send ${ethers.formatEther(claimAmt)} native to ${recipient}...`);

    try {
      const tx = await faucet.adminClaimFor(recipient);
      await tx.wait();
      log(`✅ Transaction confirmed: ${tx.hash}`);
      // On success, set IP cooldown for 24h to prevent multi-wallet draining
      await setIpCooldown(clientIp, network, { lastAddress: recipient, lastNetwork: network, txHash: tx.hash });
      await clearIpPending(clientIp, network);
      return res.send({ success: true, txHash: tx.hash });
    } catch (e) {
      if (e.code === "CALL_EXCEPTION" && e.reason === "Wait before next claim") {
        const last = await faucet.lastClaim(recipient);
        const cooldown = await faucet.cooldown();
        const now = Math.floor(Date.now() / 1000);
        const waitSeconds = Number(last + cooldown - BigInt(now));
        log(`⏱ Claim blocked. Wait ${waitSeconds} seconds more.`);
        await clearIpPending(clientIp, network);
        return res.status(400).send({ 
          success: false, 
          error: "Wait before next claim", 
          wait: waitSeconds > 0 ? waitSeconds : 0 
        });
      } else {
        await clearIpPending(clientIp, network);
        throw e;
      }
    }

  } catch (e) {
    log(`❌ Claim failed: ${e.message}`);
    console.error(e);
    res.status(500).send({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`🚀 Faucet server running on port ${PORT}`));
