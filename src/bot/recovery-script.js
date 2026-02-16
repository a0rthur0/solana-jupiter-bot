require("dotenv").config();

const bs58 = require("bs58");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

/**
 * 🔧 RECOVERY SCRIPT
 * 
 * Использование:
 *   node recovery-script.js
 * 
 * Что делает:
 * - Проверяет реальный баланс в блокчейне
 * - Показывает что в cache (если есть)
 * - Предлагает синхронизировать
 */

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("🔧 RECOVERY & BALANCE CHECK SCRIPT");
  console.log("=".repeat(70));

  try {
    // Load config
    const config = require("./config.json");

    // Setup connection
    const rpc = Array.isArray(config.rpc) ? config.rpc[0] : config.rpc;
    const connection = new Connection(rpc, { commitment: "confirmed" });
    console.log("\n✅ Connected to:", rpc);

    // Load wallet
    const secretKey = process.env.SOLANA_WALLET_PRIVATE_KEY;
    if (!secretKey) {
      throw new Error("SOLANA_WALLET_PRIVATE_KEY not found in .env");
    }

    let wallet;
    try {
      const decoded = bs58.decode(secretKey);
      wallet = Keypair.fromSecretKey(decoded);
    } catch (error) {
      const parsedKey = JSON.parse(secretKey);
      wallet = Keypair.fromSecretKey(Uint8Array.from(parsedKey));
    }

    console.log("✅ Wallet:", wallet.publicKey.toString());
    console.log("   Solscan: https://solscan.io/account/" + wallet.publicKey.toString());

    // Get real SOL balance
    console.log("\n" + "=".repeat(70));
    console.log("📊 REAL BALANCE (from blockchain):");
    console.log("=".repeat(70));

    const solLamports = await connection.getBalance(wallet.publicKey);
    const solBalance = solLamports / 1_000_000_000;
    console.log(`SOL:  ${solLamports} lamports = ${solBalance.toFixed(9)} SOL`);

    // Get real USDC balance
    let usdcMicro = 0;
    let usdcBalance = 0;
    try {
      const usdcMint = new PublicKey(config.tokenB.address);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: usdcMint }
      );

      if (tokenAccounts.value.length > 0) {
        const tokenAmount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
        usdcMicro = parseInt(tokenAmount.amount);
        usdcBalance = usdcMicro / 1_000_000;
      }
    } catch (error) {
      console.log("⚠️ No USDC account found");
    }

    console.log(`USDC: ${usdcMicro} micro = ${usdcBalance.toFixed(6)} USDC`);

    // Determine position
    console.log("\n" + "=".repeat(70));
    console.log("📍 CURRENT POSITION:");
    console.log("=".repeat(70));

    if (usdcBalance > 1.0) {
      console.log("✅ Holding USDC → Next trade should be: BUY SOL");
      console.log("   sideBuy should be: false");
    } else {
      console.log("✅ Holding SOL → Next trade should be: SELL SOL for USDC");
      console.log("   sideBuy should be: true");
    }

    // Check cache if exists
    console.log("\n" + "=".repeat(70));
    console.log("💾 CACHE STATUS:");
    console.log("=".repeat(70));

    try {
      const fs = require("fs");
      const path = require("path");
      const cachePath = path.join(__dirname, "temp", "cache.json");

      if (fs.existsSync(cachePath)) {
        const cacheData = JSON.parse(fs.readFileSync(cachePath, "utf8"));

        console.log("Cache exists:");
        console.log(`  Current SOL:  ${cacheData.currentBalance?.tokenA || "N/A"}`);
        console.log(`  Current USDC: ${cacheData.currentBalance?.tokenB || "N/A"}`);
        console.log(`  sideBuy: ${cacheData.sideBuy}`);

        // Compare with real balance
        const cacheSol = parseInt(cacheData.currentBalance?.tokenA || "0");
        const cacheUsdc = parseInt(cacheData.currentBalance?.tokenB || "0");

        const solDiff = Math.abs(solLamports - cacheSol);
        const usdcDiff = Math.abs(usdcMicro - cacheUsdc);

        if (solDiff > 1000000 || usdcDiff > 100000) {
          console.log("\n⚠️ WARNING: Cache is out of sync with blockchain!");
          console.log(`  SOL difference:  ${solDiff} lamports`);
          console.log(`  USDC difference: ${usdcDiff} micro`);
          console.log("\n💡 Recommended action: Delete ./temp/cache.json and restart bot");
        } else {
          console.log("\n✅ Cache is in sync with blockchain");
        }

      } else {
        console.log("No cache file found (./temp/cache.json)");
        console.log("This is normal on first run.");
      }

    } catch (error) {
      console.log("Could not read cache:", error.message);
    }

    // Recommendations
    console.log("\n" + "=".repeat(70));
    console.log("💡 RECOMMENDATIONS:");
    console.log("=".repeat(70));
    console.log("1. If cache is wrong: Delete ./temp/cache.json");
    console.log("2. Restart bot: npm run trade");
    console.log("3. New setup.js will auto-sync with blockchain");
    console.log("=".repeat(70) + "\n");

  } catch (error) {
    console.error("\n❌ Error:", error.message);
    process.exit(1);
  }
}

main();
