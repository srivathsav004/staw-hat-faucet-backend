#!/usr/bin/env node
/*
  Deploy NativeFaucet to Polygon Amoy or Avalanche Fuji.
  - Requires env: OWNER_PRIVATE_KEY, POLYGON_RPC, AVAX_RPC
  - Prompts for network, claimAmount (in ether), cooldown (seconds), initial funding (in ether)
  - Logs: network, chainId, deployer, balance, tx hash, contract address, block number
  - Writes/updates deployments.json with results
*/
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ethers } from 'ethers';
import { fileURLToPath } from 'url';

// __dirname replacement in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env explicitly from parent folder (web3/.env)
dotenv.config({ path: path.join(__dirname, '../.env') });

// Dynamically read JSON artifact
const ARTIFACT_PATH = path.join(__dirname, '../artifacts/contracts/Faucet.sol/NativeFaucet.json');
const ARTIFACT = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));



const NETWORKS = {
  amoy: {
    label: "Polygon Amoy",
    rpcEnv: "POLYGON_RPC",
    chainHint: 80002,
  },
  fuji: {
    label: "Avalanche Fuji",
    rpcEnv: "AVAX_RPC",
    chainHint: 43113,
  },
};

function rlQuestion(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n=== NativeFaucet Deployment ===\n");
  console.log("Select network:");
  console.log("  1) Polygon Amoy (amoy)");
  console.log("  2) Avalanche Fuji (fuji)\n");

  let choice = (await rlQuestion(rl, "Enter choice [1/2] (default 1): ")).trim();
  if (!choice) choice = "1";
  let key = choice === "2" ? "fuji" : "amoy";
  const net = NETWORKS[key];

  const rpcUrl = process.env[net.rpcEnv];
  if (!rpcUrl) {
    rl.close();
    throw new Error(`Missing RPC URL env ${net.rpcEnv}`);
  }

  let pk = (process.env.OWNER_PRIVATE_KEY || "").trim();
  if (!pk) {
    pk = (await rlQuestion(rl, "Enter OWNER_PRIVATE_KEY (0x...): ")).trim();
  }
  if (!pk) {
    rl.close();
    throw new Error("Private key is required");
  }

  let claimEther = (await rlQuestion(rl, "Claim amount in native coin (ether) [default 0.01]: ")).trim();
  if (!claimEther) claimEther = "0.01";
  let cooldown = (await rlQuestion(rl, "Cooldown seconds [default 86400 (24h)]: ")).trim();
  if (!cooldown) cooldown = "86400";
  let initialFundEther = (await rlQuestion(rl, "Initial faucet funding (ether) [default 0.1]: ")).trim();
  if (!initialFundEther) initialFundEther = "0.1";

  rl.close();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);

  const network = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);

  console.log("\n--- Deploy Info ---");
  console.log("Network:", net.label);
  console.log("ChainId:", Number(network.chainId));
  console.log("Deployer:", wallet.address);
  console.log("Balance:", ethers.formatEther(balance), "native");

  const claimAmountWei = ethers.parseEther(claimEther);
  const cooldownSec = BigInt(cooldown);
  const initialFundWei = ethers.parseEther(initialFundEther);

  const factory = new ethers.ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode, wallet);

  console.log("\nDeploying NativeFaucet...");
  const deployTx = await factory.getDeployTransaction(claimAmountWei, cooldownSec, { value: initialFundWei });
  const sent = await wallet.sendTransaction(deployTx);
  console.log("Deploy Tx Hash:", sent.hash);
  const receipt = await sent.wait();

  const contractAddress = receipt.contractAddress;
  console.log("Contract Address:", contractAddress);
  console.log("Deployed In Block:", receipt.blockNumber);

  // Write deployments.json
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  let deployments = {};
  try {
    if (fs.existsSync(deploymentsPath)) {
      deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    }
  } catch (e) {
    console.warn("Warning: failed reading existing deployments.json, will overwrite.");
  }

  deployments[key] = {
    network: net.label,
    chainId: Number(network.chainId),
    address: contractAddress,
    txHash: sent.hash,
    blockNumber: receipt.blockNumber,
    claimAmountEther: claimEther,
    cooldownSeconds: Number(cooldown),
    initialFundingEther: initialFundEther,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log("\nSaved deployments.json at:", deploymentsPath);

  console.log("\nDone ✅");
}

main().catch((e) => {
  console.error("\nDeployment failed:", e.message);
  process.exit(1);
});
