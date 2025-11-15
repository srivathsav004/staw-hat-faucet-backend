import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const NET_ALIASES = { polygon: "amoy", amoy: "amoy", avax: "fuji", fuji: "fuji" };

const FAUCET_CONTRACTS = {
  fuji: "0xB5685a68C3de062918C9C31d111922E36fe71BE3",
  amoy: "0x5aA6275BC3CB6e219Deb8e1bC07747FF5cDeF1B9",
};

const RPC = {
  fuji: process.env.AVAX_RPC,
  amoy: process.env.POLYGON_RPC,
};

const faucetABI = [
  "function adminClaimFor(address recipient)",
  "function claimAmount() view returns(uint256)",
  "function cooldown() view returns(uint256)",
  "function lastClaim(address) view returns(uint256)"
];

const ownerWallet = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY);

function log(msg) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${msg}`);
}

app.post("/claim", async (req, res) => {
  log("➡ Received claim request");

  try {
    const { network, recipient } = req.body;
    log(`Request: network=${network}, recipient=${recipient}`);

    const key = NET_ALIASES[network];
    const rpcUrl = RPC[key];
    const contractAddress = FAUCET_CONTRACTS[key];

    if (!key || !rpcUrl || !contractAddress)
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
      return res.send({ success: true, txHash: tx.hash });
    } catch (e) {
      if (e.code === "CALL_EXCEPTION" && e.reason === "Wait before next claim") {
        // fetch lastClaim and cooldown to calculate remaining time
        const last = await faucet.lastClaim(recipient);
        const cooldown = await faucet.cooldown();
        const now = Math.floor(Date.now() / 1000);
        const waitSeconds = Number(last + cooldown - BigInt(now));
        log(`⏱ Claim blocked. Wait ${waitSeconds} seconds more.`);
        return res.status(400).send({ 
          success: false, 
          error: "Wait before next claim", 
          wait: waitSeconds > 0 ? waitSeconds : 0 
        });
      } else {
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
