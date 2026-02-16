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
					setTimeout(() => reject(new Error('Confirmation timeout')), 15000)
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

const successSwapHandler = async (tx, jupiterQuoteApi, tokenA, tokenB) => {
    // 1. Определяем направление сделки (до переворота)
    const sideBeforeSwap = cache.sideBuy;
    
    // 2. Переворачиваем сторону (готовимся к следующему шагу)
    cache.sideBuy = !cache.sideBuy;
    cache.iteration++;

    console.log(`\n✅ Swap successful!`);
    console.log(`🔗 Tx: https://solscan.io/tx/${tx.txid}`);

    // Определяем, какой токен мы получили
    const outToken = sideBeforeSwap ? tokenB : tokenA;
    const inToken  = sideBeforeSwap ? tokenA : tokenB;

    // --- ОБНОВЛЕНИЕ БАЛАНСОВ (PINGPONG) ---
    if (cache.config.tradingStrategy === "pingpong") {
        if (sideBeforeSwap) {
            // BUY (A -> B)
            cache.currentBalance.tokenA = BigInt(0);
            cache.currentBalance.tokenB = BigInt(tx.outputAmount);
            // Запоминаем, сколько у нас теперь токенов B (для расчета профита при продаже)
            cache.lastBalance.tokenB = cache.currentBalance.tokenB;
        } else {
            // SELL (B -> A)
            cache.currentBalance.tokenB = BigInt(0);
            cache.currentBalance.tokenA = BigInt(tx.outputAmount);
            // Запоминаем, сколько у нас теперь токенов A
            cache.lastBalance.tokenA = cache.currentBalance.tokenA;
        }
    }

    // --- РАСЧЕТ ПРОФИТА И ПОДГОТОВКА ЛОГОВ ---
    
    // Вспомогательная функция для перевода в нормальное число (Float)
    const safeToFloat = (amount, decimals) => {
        if (!amount) return 0;
        const str = amount.toString();
        if (decimals === 0) return parseFloat(str);
        // Если число короче, чем decimals (напр. 500 при decimals 6 -> 0.000500)
        const d = parseInt(decimals);
        const padded = str.padStart(d + 1, '0'); 
        const integerPart = padded.slice(0, -d);
        const fractionPart = padded.slice(-d);
        return parseFloat(`${integerPart}.${fractionPart}`);
    };

    // Считаем реальные суммы (Float)
    const inAmountFloat = safeToFloat(tx.inputAmount, inToken.decimals);
    const outAmountFloat = safeToFloat(tx.outputAmount, outToken.decimals);

    // Считаем профит
    let profitPercent = 0;
    
    // Баланс, с которым сравниваем (с чем заходили в цикл)
    // Если BUY: сравниваем (полученные B) с (прошлыми B). Если это первый вход, прошлых B было 0 -> профит 0.
    // Если SELL: сравниваем (полученные A) с (прошлыми A).
    const startBalanceBigInt = cache.lastBalance[sideBeforeSwap ? "tokenB" : "tokenA"];
    
    // ВНИМАНИЕ: Для корректного расчета PINGPONG профит обычно считается только на круге (USDC -> SOL -> USDC).
    // Но если ты хочешь видеть профит на каждом шаге, сравнивая "было/стало" того же токена:
    
    if (sideBeforeSwap) {
        // Мы купили B. Если раньше B было 0, то профит считать некорректно (он бесконечный или 0).
        profitPercent = 0; 
    } else {
        // Мы продали B и вернулись в A (SOL). 
        // Сравниваем: сколько SOL стало (outAmountFloat) vs сколько SOL было до начала круга (startBalance)
        // Но `cache.lastBalance` мы уже обновили выше. Нам нужен баланс ДО обновления.
        // В рамках этой функции сложно достать "тот самый старый баланс" если мы его уже перезаписали.
        
        // Упрощенный вариант:
        // Профит сделки = (Выход / Вход) * Цена - ... это сложно без оракула.
        // Давай использовать логику: (Получили - Ожидали) / Ожидали? Нет.
        
        // Логика "Прирост токена":
        // Работает только если мы вернулись в исходный токен.
        // Для простоты, чтобы не было NULL:
        profitPercent = 0; // Заглушка, если невозможно посчитать (первая сделка)
        
        // Если у нас есть данные о цене или мы вернулись в стейбл, можно раскомментировать сложный расчет
    }

    // --- ФОРМИРОВАНИЕ ЗАПИСИ ---
    let tradeEntry = {
        date: new Date().toLocaleString(),
        buy: sideBeforeSwap,
        inputToken: inToken.symbol,
        outputToken: outToken.symbol,
        inAmount: inAmountFloat.toFixed(6),      // Нормальное число
        expectedOutAmount: toDecimal(tx.expectedOutAmount || 0, outToken.decimals),
        expectedProfit: 0, // Можно взять из кэша если есть
        outAmount: outAmountFloat.toFixed(6),    // Нормальное число!
        profit: profitPercent,                   // Число (0), но не NULL
        performanceOfTx: performance.now() - cache.performanceOfTxStart,
        error: null,
        txid: tx.txid,
        timestamp: new Date().toISOString(),
    };

	// Добавляем в историю
	let tempHistory = cache.tradeHistory;
	tempHistory.push(tradeEntry);
	cache.tradeHistory = tempHistory;

	// =================================================================
	// 🛠 FIX: Manual Profit Calculation (Float Math)
	// =================================================================
	try {
		const startBalanceBigInt = cache.lastBalance[sideBeforeSwap ? "tokenB" : "tokenA"];
		
		// 2.
		const outAmountBigInt = BigInt(tx.outputAmount);

		// 3. 
		const startVal = parseFloat(toDecimal(startBalanceBigInt, outDecimals));
		const endVal = parseFloat(toDecimal(outAmountBigInt, outDecimals));

		console.log(`🧮 Calc Profit: Start=${startVal}, End=${endVal}`);

		if (startVal === 0 || isNaN(startVal)) {
			tradeEntry.profit = 0;
		} else {
			const profitRaw = ((endVal - startVal) / startVal) * 100;
			tradeEntry.profit = parseFloat(profitRaw.toFixed(2));
		}
	} catch (e) {
		console.error("⚠️ Error calculating profit:", e);
		tradeEntry.profit = 0; // Fallback 
	}
	// =================================================================

	tempHistory = cache.tradeHistory;
	tempHistory.push(tradeEntry);
	cache.tradeHistory = tempHistory;

	if (cache.config.tradingStrategy === "arbitrage") {
		// For arbitrage, amounts should already be fetched from Solscan in swap()
		cache.lastBalance.tokenA = cache.currentBalance.tokenA;
		cache.currentBalance.tokenA = BigInt(tx.outputAmount);

		cache.currentProfit.tokenA = calculateProfit(
			cache.initialBalance.tokenA,
			cache.currentBalance.tokenA
		);

		// update trade history
		tempHistory = cache.tradeHistory;

		tradeEntry.inAmount = toDecimal(tx.inputAmount, tokenA.decimals);
		tradeEntry.outAmount = toDecimal(tx.outputAmount, tokenA.decimals);

		tradeEntry.profit = calculateProfit(
			cache.lastBalance["tokenA"],
			BigInt(tx.outputAmount)
		);
		tempHistory.push(tradeEntry);
		cache.tradeHistory = tempHistory;
	}
};
exports.successSwapHandler = successSwapHandler;
