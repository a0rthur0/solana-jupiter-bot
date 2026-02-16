const { PublicKey } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

/**
 * 🛡️ SAFETY MODULE - Critical safety checks before trading
 */

/**
 * 1. Check wallet balance before trade
 */
async function checkWalletBalance(connection, wallet, tokenAddress, requiredAmount, tokenDecimals) {
  try {
    let balance;

    // Convert requiredAmount to BigInt if it isn't already
    const requiredBigInt = typeof requiredAmount === 'bigint' 
      ? requiredAmount 
      : BigInt(requiredAmount);

    // Check SOL balance
    if (tokenAddress === "So11111111111111111111111111111111111111112") {
      const lamports = await connection.getBalance(wallet.publicKey);
      balance = BigInt(lamports);
    } else {
      // Check SPL token balance
      const tokenPubkey = new PublicKey(tokenAddress);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: tokenPubkey }
      );

      if (tokenAccounts.value.length === 0) {
        return {
          success: false,
          balance: BigInt(0),
          required: requiredBigInt,
          message: `No token account found for ${tokenAddress}`
        };
      }

      const tokenAmount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
      balance = BigInt(tokenAmount.amount);
    }

    // Check if balance is sufficient (with 5% buffer for fees)
    const requiredWithBuffer = (requiredBigInt * BigInt(105)) / BigInt(100); // 5% buffer

    if (balance < requiredWithBuffer) {
      return {
        success: false,
        balance,
        required: requiredWithBuffer,
        message: `Insufficient balance. Have: ${balance.toString()}, Need: ${requiredWithBuffer.toString()} (including 5% fee buffer)`
      };
    }

    return {
      success: true,
      balance,
      required: requiredBigInt,
      message: "Balance check passed"
    };

  } catch (error) {
    console.error("Balance check error:", error.message);
    return {
      success: true, // Don't block trading on balance check errors
      balance: BigInt(0),
      required: requiredAmount,
      message: `Balance check error (allowing trade): ${error.message}`
    };
  }
}

/**
 * 2. Check maximum loss protection
 * FIX: Proper calculation for pingpong strategy with BigInt support
 */
function checkMaxLoss(cache, config) {
  const maxLossPercentage = config.maxLossPercentage || 10; // default 10%

  try {
    // Get current side (buy = holding tokenA, sell = holding tokenB)
    const currentSide = cache.sideBuy ? "tokenA" : "tokenB";
    const oppositeSide = cache.sideBuy ? "tokenB" : "tokenA";

    // Get values, converting BigInt to Number for percentage calculations
    let currentValue = cache.currentBalance[currentSide];
    let initialValue = cache.initialBalance[currentSide];

    // Convert BigInt to Number if needed
    if (typeof currentValue === 'bigint') currentValue = Number(currentValue);
    if (typeof initialValue === 'bigint') initialValue = Number(initialValue);

    // If initial value is 0, use opposite side
    if (initialValue === 0 || isNaN(initialValue)) {
      currentValue = cache.currentBalance[oppositeSide];
      initialValue = cache.initialBalance[oppositeSide];
      
      if (typeof currentValue === 'bigint') currentValue = Number(currentValue);
      if (typeof initialValue === 'bigint') initialValue = Number(initialValue);
    }

    // Check data validity
    if (initialValue === 0 || isNaN(initialValue) || isNaN(currentValue)) {
      // Skip check on initial run (no data yet)
      return {
        success: true,
        currentLoss: "0.00",
        maxAllowed: maxLossPercentage,
        message: "Max loss check skipped (insufficient data)"
      };
    }

    // Calculate loss percentage
    const lossPercentage = ((currentValue - initialValue) / initialValue) * 100;

    // Check if limit exceeded (only if actual loss)
    if (lossPercentage < -maxLossPercentage) {
      return {
        success: false,
        currentLoss: lossPercentage.toFixed(2),
        maxAllowed: maxLossPercentage,
        message: `🛑 MAX LOSS EXCEEDED! Current loss: ${lossPercentage.toFixed(2)}%, Max allowed: -${maxLossPercentage}%`
      };
    }

    return {
      success: true,
      currentLoss: lossPercentage.toFixed(2),
      maxAllowed: maxLossPercentage,
      message: "Max loss check passed"
    };

  } catch (error) {
    console.error("Error in checkMaxLoss:", error.message);
    // On error, allow trade (safer than stopping bot)
    return {
      success: true,
      currentLoss: "N/A",
      maxAllowed: maxLossPercentage,
      message: `Max loss check error (allowing trade): ${error.message}`
    };
  }
}

/**
 * 3. Check Price Impact
 */
function checkPriceImpact(route, config) {
  const maxPriceImpact = config.maxPriceImpact || 1.0; // default 1.0%

  try {
    // Jupiter v6 returns priceImpactPct as percentage (e.g., 0.5 for 0.5%)
    const priceImpact = Math.abs(parseFloat(route.priceImpactPct) || 0);

    if (priceImpact > maxPriceImpact) {
      return {
        success: false,
        priceImpact: priceImpact.toFixed(4),
        maxAllowed: maxPriceImpact,
        message: `🛑 PRICE IMPACT TOO HIGH! Current: ${priceImpact.toFixed(4)}%, Max allowed: ${maxPriceImpact}%`
      };
    }

    return {
      success: true,
      priceImpact: priceImpact.toFixed(4),
      maxAllowed: maxPriceImpact,
      message: "Price impact check passed"
    };
  } catch (error) {
    console.error("Price impact check error:", error.message);
    // On error, allow trade
    return {
      success: true,
      priceImpact: "N/A",
      maxAllowed: maxPriceImpact,
      message: `Price impact check error (allowing trade): ${error.message}`
    };
  }
}

/**
 * 4. Cooldown between trades
 */
function checkTradeCooldown(cache, config) {
  const cooldownMs = config.cooldownBetweenTrades || 0; // default 0s (disabled)

  // If cooldown is 0 or not set, skip check
  if (!cooldownMs || cooldownMs === 0) {
    return {
      success: true,
      timeRemaining: 0,
      cooldownSeconds: 0,
      message: "Cooldown disabled"
    };
  }

  if (!cache.lastTradeTimestamp) {
    cache.lastTradeTimestamp = 0;
  }

  const timeSinceLastTrade = Date.now() - cache.lastTradeTimestamp;

  if (timeSinceLastTrade < cooldownMs) {
    return {
      success: false,
      timeRemaining: Math.ceil((cooldownMs - timeSinceLastTrade) / 1000),
      cooldownSeconds: cooldownMs / 1000,
      message: `⏳ Cooldown active. Wait ${Math.ceil((cooldownMs - timeSinceLastTrade) / 1000)}s`
    };
  }

  return {
    success: true,
    timeRemaining: 0,
    cooldownSeconds: cooldownMs / 1000,
    message: "Cooldown check passed"
  };
}

/**
 * 5. Log transactions to file
 */
function logTransaction(tradeEntry) {
  try {
    const logsDir = path.join(process.cwd(), "logs");

    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const logFile = path.join(logsDir, `trades_${today}.json`);

    // Read existing logs
    let logs = [];
    if (fs.existsSync(logFile)) {
      const fileContent = fs.readFileSync(logFile, 'utf8');
      if (fileContent.trim()) {
        try {
          logs = JSON.parse(fileContent);
        } catch (e) {
          console.warn("Could not parse log file, starting fresh");
          logs = [];
        }
      }
    }

    // Add new trade (convert BigInt to string for JSON compatibility)
    const tradeEntryForLog = JSON.parse(JSON.stringify(tradeEntry, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ));

    logs.push({
      ...tradeEntryForLog,
      timestamp: new Date().toISOString()
    });

    // Write back to file
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));

    return { success: true };

  } catch (error) {
    console.error(`❌ Failed to log transaction: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * 6. Comprehensive safety check before trade
 */
async function performSafetyChecks(options) {
  const {
    connection,
    wallet,
    cache,
    config,
    route,
    inputToken,
    amountToTrade
  } = options;

  const checks = [];

  // Only run checks if safety features are enabled in config
  const safetyEnabled = config.enableSafetyChecks !== false; // default true

  if (!safetyEnabled) {
    return { passed: true, checks: [], message: "Safety checks disabled" };
  }

  try {
    // 1. Balance check (skip if disabled)
    if (config.checkBalance !== false) {
      const balanceCheck = await checkWalletBalance(
        connection,
        wallet,
        inputToken.address,
        amountToTrade,
        inputToken.decimals
      );
      checks.push({ name: "Balance", ...balanceCheck });

      if (!balanceCheck.success) {
        console.error(`❌ ${balanceCheck.message}`);
        return { passed: false, checks };
      }
    }

    // 2. Max loss check (skip if disabled or no limit set)
    if (config.maxLossPercentage && config.maxLossPercentage > 0) {
      const lossCheck = checkMaxLoss(cache, config);
      checks.push({ name: "MaxLoss", ...lossCheck });

      if (!lossCheck.success) {
        console.error(`❌ ${lossCheck.message}`);
        console.log("🛑 BOT STOPPED DUE TO MAX LOSS EXCEEDED!");
        process.exit(0); // Stop bot completely
      }
    }

    // 3. Price impact check (skip if disabled or no limit set)
    if (config.maxPriceImpact && config.maxPriceImpact > 0) {
      const impactCheck = checkPriceImpact(route, config);
      checks.push({ name: "PriceImpact", ...impactCheck });

      if (!impactCheck.success) {
        console.warn(`⚠️ ${impactCheck.message}`);
        return { passed: false, checks };
      }
    }

    // 4. Cooldown check (skip if disabled or 0)
    if (config.cooldownBetweenTrades && config.cooldownBetweenTrades > 0) {
      const cooldownCheck = checkTradeCooldown(cache, config);
      checks.push({ name: "Cooldown", ...cooldownCheck });

      if (!cooldownCheck.success) {
        // Don't log error for cooldown, just skip silently
        return { passed: false, checks, silent: true };
      }
    }

    return { passed: true, checks };

  } catch (error) {
    console.error("Safety checks error:", error.message);
    // On error, allow trade (safer than stopping)
    return { passed: true, checks, message: `Safety checks error (allowing trade): ${error.message}` };
  }
}

module.exports = {
  checkWalletBalance,
  checkMaxLoss,
  checkPriceImpact,
  checkTradeCooldown,
  logTransaction,
  performSafetyChecks
};
