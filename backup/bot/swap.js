const { calculateProfit, toDecimal, storeItInTempAsJSON } = require("../utils");
const cache = require("./cache");
const { getSwapResultFromSolscanParser } = require("../services/solscan");

const swap = async (jupiter, route) => {
	try {
		const performanceOfTxStart = performance.now();
		cache.performanceOfTxStart = performanceOfTxStart;

		if (process.env.DEBUG) storeItInTempAsJSON("routeInfoBeforeSwap", route);

		const { execute } = await jupiter.exchange({
			routeInfo: route,
		});
		
		// OPTIMIZATION 1: Add timeout to prevent hanging transactions
		const executeWithTimeout = (timeoutMs = 60000) => {
			return Promise.race([
				execute(),
				new Promise((_, reject) => 
					setTimeout(() => reject(new Error('Transaction timeout')), timeoutMs)
				)
			]);
		};

		const result = await executeWithTimeout();

		if (process.env.DEBUG) storeItInTempAsJSON("result", result);

		const performanceOfTx = performance.now() - performanceOfTxStart;

		return [result, performanceOfTx];
	} catch (error) {
		console.log("Swap error: ", error);
		
		// OPTIMIZATION 2: Return error object instead of undefined
		return [{
			error: {
				message: error.message || 'Unknown swap error',
				code: error.code || 'SWAP_FAILED'
			}
		}, 0];
	}
};
exports.swap = swap;

const failedSwapHandler = (tradeEntry) => {
	// OPTIMIZATION 3: Add error counter tracking and auto-shutdown
	// Initialize error counter if it doesn't exist
	if (!cache.tradeCounter.errorCount) {
		cache.tradeCounter.errorCount = 0;
	}
	
	cache.tradeCounter.errorCount++;
	
	// update counter
	cache.tradeCounter[cache.sideBuy ? "buy" : "sell"].fail++;

	// CRITICAL SAFETY: Stop bot if too many errors (prevents endless failed transactions)
	const MAX_ERRORS = 50; // Lowered from potential default - adjust based on your risk tolerance
	if (cache.tradeCounter.errorCount > MAX_ERRORS) {
		console.log('\n========================================');
		console.log('🛑 ERROR COUNT TOO HIGH: ' + cache.tradeCounter.errorCount);
		console.log('🛑 STOPPING BOT TO PREVENT FURTHER LOSSES');
		console.log('========================================\n');
		
		// Log the last error for debugging
		if (tradeEntry.error) {
			console.log('Last error:', tradeEntry.error);
		}
		
		process.exit(1);
	}

	// OPTIMIZATION 4: Log consecutive errors to detect issues early
	if (!cache.consecutiveErrors) {
		cache.consecutiveErrors = 0;
	}
	cache.consecutiveErrors++;
	
	// Warn after 5 consecutive errors
	if (cache.consecutiveErrors >= 5) {
		console.log(`⚠️  WARNING: ${cache.consecutiveErrors} consecutive errors!`);
	}

	// update trade history only if configured
	if (cache.config.storeFailedTxInHistory) {
		let tempHistory = cache.tradeHistory;
		tempHistory.push(tradeEntry);
		cache.tradeHistory = tempHistory;
	}
};
exports.failedSwapHandler = failedSwapHandler;

const successSwapHandler = async (tx, tradeEntry, tokenA, tokenB) => {
	if (process.env.DEBUG) storeItInTempAsJSON(`txResultFromSDK_${tx?.txid}`, tx);

	// OPTIMIZATION 5: Reset consecutive error counter on success
	cache.consecutiveErrors = 0;

	// update counter
	cache.tradeCounter[cache.sideBuy ? "buy" : "sell"].success++;

	if (cache.config.tradingStrategy === "pingpong") {
		// update balance
		if (cache.sideBuy) {
			cache.lastBalance.tokenA = cache.currentBalance.tokenA;
			cache.currentBalance.tokenA = 0;
			cache.currentBalance.tokenB = tx.outputAmount;
		} else {
			cache.lastBalance.tokenB = cache.currentBalance.tokenB;
			cache.currentBalance.tokenB = 0;
			cache.currentBalance.tokenA = tx.outputAmount;
		}

		// update profit
		if (cache.sideBuy) {
			cache.currentProfit.tokenA = 0;
			cache.currentProfit.tokenB = calculateProfit(
				cache.initialBalance.tokenB,
				cache.currentBalance.tokenB
			);
		} else {
			cache.currentProfit.tokenB = 0;
			cache.currentProfit.tokenA = calculateProfit(
				cache.initialBalance.tokenA,
				cache.currentBalance.tokenA
			);
		}

		// update trade history
		let tempHistory = cache.tradeHistory;

		tradeEntry.inAmount = toDecimal(
			tx.inputAmount,
			cache.sideBuy ? tokenA.decimals : tokenB.decimals
		);
		tradeEntry.outAmount = toDecimal(
			tx.outputAmount,
			cache.sideBuy ? tokenB.decimals : tokenA.decimals
		);

		tradeEntry.profit = calculateProfit(
			cache.lastBalance[cache.sideBuy ? "tokenB" : "tokenA"],
			tx.outputAmount
		);
		tempHistory.push(tradeEntry);
		cache.tradeHistory = tempHistory;
	}
	if (cache.config.tradingStrategy === "arbitrage") {
		/** check real amounts on solscan because Jupiter SDK returns wrong amounts
		 *  when we trading TokenA <> TokenA (arbitrage)
		 */
		// OPTIMIZATION 6: Add retry logic for Solscan parser
		let inAmountFromSolscanParser, outAmountFromSolscanParser;
		let retries = 3;
		
		while (retries > 0) {
			try {
				[inAmountFromSolscanParser, outAmountFromSolscanParser] =
					await getSwapResultFromSolscanParser(tx?.txid);
				
				// If successful, break out of retry loop
				if (inAmountFromSolscanParser !== -1 && outAmountFromSolscanParser !== -1) {
					break;
				}
				
				// Wait before retry
				await new Promise(resolve => setTimeout(resolve, 1000));
				retries--;
			} catch (error) {
				console.log(`Solscan parser retry ${4 - retries}/3 failed:`, error.message);
				retries--;
				if (retries > 0) {
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}
		}

		if (inAmountFromSolscanParser === -1) {
			console.error(
				`⚠️  Solscan inputAmount error after retries\n	https://solscan.io/tx/${tx.txid}`
			);
			// OPTIMIZATION 7: Use fallback values instead of throwing
			inAmountFromSolscanParser = tx.inputAmount || cache.currentBalance.tokenA;
		}
		if (outAmountFromSolscanParser === -1) {
			console.error(
				`⚠️  Solscan outputAmount error after retries\n	https://solscan.io/tx/${tx.txid}`
			);
			// Use fallback
			outAmountFromSolscanParser = tx.outputAmount || cache.currentBalance.tokenA;
		}

		cache.lastBalance.tokenA = cache.currentBalance.tokenA;
		cache.currentBalance.tokenA = outAmountFromSolscanParser;

		cache.currentProfit.tokenA = calculateProfit(
			cache.initialBalance.tokenA,
			cache.currentBalance.tokenA
		);

		// update trade history
		let tempHistory = cache.tradeHistory;

		tradeEntry.inAmount = toDecimal(inAmountFromSolscanParser, tokenA.decimals);
		tradeEntry.outAmount = toDecimal(
			outAmountFromSolscanParser,
			tokenA.decimals
		);

		tradeEntry.profit = calculateProfit(
			cache.lastBalance["tokenA"],
			outAmountFromSolscanParser
		);
		tempHistory.push(tradeEntry);
		cache.tradeHistory = tempHistory;
	}
};
exports.successSwapHandler = successSwapHandler;
