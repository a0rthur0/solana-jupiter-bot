const { VersionedTransaction } = require("@solana/web3.js");
const { calculateProfit, toDecimal, storeItInTempAsJSON } = require("../utils");
const cache = require("./cache");

// Optional Solscan parser
let getSwapResultFromSolscanParser;
try {
	const solscan = require("../services/solscan");
	getSwapResultFromSolscanParser = solscan.getSwapResultFromSolscanParser;
} catch (e) {
	console.log("⚠️  Solscan parser not available");
	getSwapResultFromSolscanParser = null;
}

const swap = async (jupiterQuoteApi, quoteResponse, forceRevert = false) => {
	let txid;
	try {
		const performanceOfTxStart = performance.now();
		cache.performanceOfTxStart = performanceOfTxStart;

		if (process.env.DEBUG) storeItInTempAsJSON("quoteBeforeSwap", quoteResponse);

		// JUPITER V6: Get swap transaction
		const swapResult = await jupiterQuoteApi.swapPost({
			swapRequest: {
				quoteResponse,
				userPublicKey: cache.wallet.publicKey.toString(),
				wrapAndUnwrapSol: cache.wrapUnwrapSOL,
				computeUnitPriceMicroLamports: 'auto',
				...(forceRevert && {
					slippageBps: 0,
				}),
			},
		});

		if (process.env.DEBUG) storeItInTempAsJSON("swapResult", swapResult);

		// JUPITER V6: Deserialize the transaction
		const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
		let transaction = VersionedTransaction.deserialize(swapTransactionBuf);

		// Sign the transaction
		transaction.sign([cache.wallet]);

		// Get latest blockhash for confirmation
		const latestBlockHash = await cache.connection.getLatestBlockhash('confirmed');

		// Send transaction with timeout
		txid = await Promise.race([
			cache.connection.sendRawTransaction(transaction.serialize(), {
				skipPreflight: false,
				preflightCommitment: 'confirmed',
				maxRetries: 3,
			}),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Transaction send timeout')), 60000)
			),
		]);

		console.log(`📤 Transaction sent: ${txid}`);

		// IMPROVED: Try to confirm with longer timeout and retry logic
		let confirmed = false;
		let confirmError = null;
		
		try {
			// First attempt: standard confirmation (60s)
			const confirmation = await Promise.race([
				cache.connection.confirmTransaction(
					{
						blockhash: latestBlockHash.blockhash,
						lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
						signature: txid,
					},
					'confirmed'
				),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Confirmation timeout')), 60000)
				),
			]);

			if (confirmation.value.err) {
				throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
			}
			
			confirmed = true;
			console.log('✅ Transaction confirmed on-chain');

		} catch (confirmErr) {
			confirmError = confirmErr;
			console.log('⚠️  Confirmation timeout, will check Solscan...');
			
			// FALLBACK: Check if transaction actually succeeded via RPC
			try {
				await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s
				
				const status = await cache.connection.getSignatureStatus(txid);
				if (status && status.value && status.value.confirmationStatus) {
					confirmed = true;
					console.log(`✅ Transaction found on-chain: ${status.value.confirmationStatus}`);
				}
			} catch (e) {
				console.log('⚠️  Could not verify transaction status via RPC');
			}
		}

		const performanceOfTx = performance.now() - performanceOfTxStart;

		// If confirmed via RPC, try to get actual amounts
		if (confirmed) {
			// For PINGPONG: We can trust Jupiter's quote amounts
			// For ARBITRAGE: Need Solscan to get actual amounts
			
			if (cache.config.tradingStrategy === "pingpong") {
				// Use quote amounts (close enough for pingpong)
				const result = {
					txid,
					inputAmount: quoteResponse.inAmount,
					outputAmount: quoteResponse.outAmount,
					error: null,
				};

				if (process.env.DEBUG) storeItInTempAsJSON(`txResult_${txid}`, result);
				return [result, performanceOfTx];
			}
		}

		// If not confirmed OR is arbitrage strategy, try Solscan fallback
		if (getSwapResultFromSolscanParser) {
			console.log('🔍 Fetching actual amounts from Solscan...');
			
			let retries = 5; // More retries for Solscan
			let inAmount, outAmount;
			
			while (retries > 0) {
				try {
					await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3s
					
					[inAmount, outAmount] = await getSwapResultFromSolscanParser(txid);
					
					if (inAmount !== -1 && outAmount !== -1) {
						console.log('✅ Got actual amounts from Solscan');
						
						const result = {
							txid,
							inputAmount: inAmount,
							outputAmount: outAmount,
							error: null,
						};

						if (process.env.DEBUG) storeItInTempAsJSON(`txResult_${txid}`, result);
						return [result, performanceOfTx];
					}
					
					retries--;
				} catch (error) {
					console.log(`⚠️  Solscan retry ${6 - retries}/5 failed:`, error.message);
					retries--;
				}
			}
			
			console.log('⚠️  Solscan failed, using quote amounts as fallback');
		}

		// FINAL FALLBACK: Use quote amounts if everything else failed
		if (confirmed || txid) {
			const result = {
				txid,
				inputAmount: quoteResponse.inAmount,
				outputAmount: quoteResponse.outAmount,
				error: confirmError ? `Confirmation timeout (tx may succeed): ${confirmError.message}` : null,
			};

			if (process.env.DEBUG) storeItInTempAsJSON(`txResult_${txid}`, result);
			return [result, performanceOfTx];
		}

		// If we get here, transaction completely failed
		throw new Error(confirmError || 'Unknown transaction error');

	} catch (error) {
		console.log("❌ Swap error:", error.message);
		
		// If we have a txid, the transaction might still succeed
		if (txid) {
			console.log(`⚠️  Transaction sent but errored: ${txid}`);
			console.log(`🔗 Check manually: https://solscan.io/tx/${txid}`);
			
			return [
				{
					txid,
					error: {
						message: error.message || 'Transaction sent but confirmation failed',
						code: 'CONFIRMATION_TIMEOUT',
					},
					inputAmount: quoteResponse?.inAmount || 0,
					outputAmount: quoteResponse?.outAmount || 0, // Use quote as estimate
				},
				0,
			];
		}

		// Complete failure - no txid
		return [
			{
				error: {
					message: error.message || 'Unknown swap error',
					code: error.code || 'SWAP_FAILED',
				},
				inputAmount: quoteResponse?.inAmount || 0,
				outputAmount: 0,
			},
			0,
		];
	}
};
exports.swap = swap;

const failedSwapHandler = (tradeEntry) => {
	// Initialize error counter if it doesn't exist
	if (!cache.tradeCounter.errorCount) {
		cache.tradeCounter.errorCount = 0;
	}

	cache.tradeCounter.errorCount++;

	// update counter
	cache.tradeCounter[cache.sideBuy ? "buy" : "sell"].fail++;

	// CRITICAL SAFETY: Stop bot if too many errors
	const MAX_ERRORS = 50;
	if (cache.tradeCounter.errorCount > MAX_ERRORS) {
		console.log('\n========================================');
		console.log('🛑 ERROR COUNT TOO HIGH: ' + cache.tradeCounter.errorCount);
		console.log('🛑 STOPPING BOT TO PREVENT FURTHER LOSSES');
		console.log('========================================\n');

		if (tradeEntry.error) {
			console.log('Last error:', tradeEntry.error);
		}

		process.exit(1);
	}

	// Track consecutive errors
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

// CRITICAL FIX: successSwapHandler now receives the side BEFORE it was switched
const successSwapHandler = async (tx, tradeEntry, tokenA, tokenB, sideBeforeSwap) => {
	if (process.env.DEBUG) storeItInTempAsJSON(`txResultFromSDK_${tx?.txid}`, tx);

	// Reset consecutive error counter on success
	cache.consecutiveErrors = 0;

	// update counter
	cache.tradeCounter[sideBeforeSwap ? "buy" : "sell"].success++;

	if (cache.config.tradingStrategy === "pingpong") {
		// CRITICAL FIX: Save the OLD lastBalance BEFORE updating it for profit calculation
		const oldLastBalanceForProfit = sideBeforeSwap 
			? cache.lastBalance.tokenB 
			: cache.lastBalance.tokenA;

		// CRITICAL FIX: Proper balance updates matching original Jupiter v4 logic
		
		if (sideBeforeSwap) {
			// Was BUY side: tokenA → tokenB
			cache.lastBalance.tokenA = cache.currentBalance.tokenA;
			cache.currentBalance.tokenA = BigInt(0);
			cache.currentBalance.tokenB = BigInt(tx.outputAmount);
			// CRITICAL FIX: Also update lastBalance.tokenB for next iteration!
			cache.lastBalance.tokenB = BigInt(tx.outputAmount);
		} else {
			// Was SELL side: tokenB → tokenA
			cache.lastBalance.tokenB = cache.currentBalance.tokenB;
			cache.currentBalance.tokenB = BigInt(0);
			cache.currentBalance.tokenA = BigInt(tx.outputAmount);
			// CRITICAL FIX: Also update lastBalance.tokenA for next iteration!
			cache.lastBalance.tokenA = BigInt(tx.outputAmount);
		}

		// update profit
		if (sideBeforeSwap) {
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
			sideBeforeSwap ? tokenA.decimals : tokenB.decimals
		);
		tradeEntry.outAmount = toDecimal(
			tx.outputAmount,
			sideBeforeSwap ? tokenB.decimals : tokenA.decimals
		);

		// FIX: Use the SAVED old lastBalance value, not the updated one
		tradeEntry.profit = calculateProfit(
			oldLastBalanceForProfit,
			BigInt(tx.outputAmount)
		);
		tempHistory.push(tradeEntry);
		cache.tradeHistory = tempHistory;
	}
	
	if (cache.config.tradingStrategy === "arbitrage") {
		// FIX: Save the OLD lastBalance BEFORE updating it for profit calculation
		const oldLastBalanceA = cache.lastBalance.tokenA;

		// For arbitrage, amounts should already be fetched from Solscan in swap()
		cache.lastBalance.tokenA = cache.currentBalance.tokenA;
		cache.currentBalance.tokenA = BigInt(tx.outputAmount);

		cache.currentProfit.tokenA = calculateProfit(
			cache.initialBalance.tokenA,
			cache.currentBalance.tokenA
		);

		// update trade history
		let tempHistory = cache.tradeHistory;

		tradeEntry.inAmount = toDecimal(tx.inputAmount, tokenA.decimals);
		tradeEntry.outAmount = toDecimal(tx.outputAmount, tokenA.decimals);

		// FIX: Use the SAVED old lastBalance value, not the updated one
		tradeEntry.profit = calculateProfit(
			oldLastBalanceA,
			BigInt(tx.outputAmount)
		);
		tempHistory.push(tradeEntry);
		cache.tradeHistory = tempHistory;
	}
};
exports.successSwapHandler = successSwapHandler;
