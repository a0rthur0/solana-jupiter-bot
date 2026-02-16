console.clear();

require("dotenv").config();
const { clearInterval } = require("timers");
const { PublicKey } = require("@solana/web3.js");

const {
	calculateProfit,
	toDecimal,
	toNumber,
	updateIterationsPerMin,
	checkRoutesResponse,
} = require("../utils");
const { handleExit, logExit } = require("./exit");
const cache = require("./cache");
const { setup, getInitialOutAmountWithSlippage } = require("./setup");
const { printToConsole } = require("./ui/");
const { swap, failedSwapHandler, successSwapHandler } = require("./swap");

// Optional: Try to load safety checks (won't crash if file missing)
let performSafetyChecks, logTransaction;
try {
	const safety = require("./safety");
	performSafetyChecks = safety.performSafetyChecks;
	logTransaction = safety.logTransaction;
} catch (e) {
	console.log("⚠️  Safety module not found, running without safety checks");
	performSafetyChecks = null;
	logTransaction = null;
}

const pingpongStrategy = async (jupiterQuoteApi, tokenA, tokenB) => {
	cache.iteration++;
	const date = new Date();
	const i = cache.iteration;
	cache.queue[i] = -1;

	try {
		// calculate & update iterations per minute
		updateIterationsPerMin(cache);

		// Calculate amount that will be used for trade
		const amountToTrade =
			cache.config.tradeSize.strategy === "cumulative"
				? cache.currentBalance[cache.sideBuy ? "tokenA" : "tokenB"]
				: cache.initialBalance[cache.sideBuy ? "tokenA" : "tokenB"];

		// Use the LAST BALANCE of the OUTPUT token for profit comparison
		// This matches the original Jupiter v4 logic
		const baseAmount = cache.lastBalance[cache.sideBuy ? "tokenB" : "tokenA"];

		// default slippage in BPS (basis points)
		const slippage =
			typeof cache.config.slippage === "number" ? cache.config.slippage : 50;

		// set input / output token
		const inputToken = cache.sideBuy ? tokenA : tokenB;
		const outputToken = cache.sideBuy ? tokenB : tokenA;

		// JUPITER V6: Get quote using new API
		const performanceOfRouteCompStart = performance.now();
		
		const quote = await jupiterQuoteApi.quoteGet({
			inputMint: inputToken.address,
			outputMint: outputToken.address,
			amount: amountToTrade.toString(),
			slippageBps: slippage,
			onlyDirectRoutes: false,
			asLegacyTransaction: false,
			maxAccounts: 64,
		});

		// JUPITER V6: Check if quote exists
		if (!quote || !quote.outAmount) {
			throw new Error("No routes found from Jupiter v6");
		}

		// update status as OK
		cache.queue[i] = 0;

		const performanceOfRouteComp =
			performance.now() - performanceOfRouteCompStart;

		// JUPITER V6: quote is the route (no routesInfos array)
		const route = quote;

		// Count available routes
		cache.availableRoutes[cache.sideBuy ? "buy" : "sell"] = 
			quote.routePlan?.length || 1;

		// Calculate profitability - compare output token amounts
		// This matches original Jupiter v4 logic exactly
		const routeOutAmount = BigInt(route.outAmount);
		const baseAmountBigInt = typeof baseAmount === 'bigint' 
			? baseAmount 
			: BigInt(baseAmount);
		
		// Direct comparison of output amounts (same token)
		const simulatedProfit = calculateProfit(baseAmountBigInt, routeOutAmount);

		// store max profit spotted
		if (
			simulatedProfit > cache.maxProfitSpotted[cache.sideBuy ? "buy" : "sell"]
		) {
			cache.maxProfitSpotted[cache.sideBuy ? "buy" : "sell"] = simulatedProfit;
		}

		// Convert route to display format (compatible with old UI)
		const routeForDisplay = {
			inAmount: route.inAmount,
			outAmount: route.outAmount,
			priceImpactPct: route.priceImpactPct,
			marketInfos: route.routePlan || [],
		};

		printToConsole({
			date,
			i,
			performanceOfRouteComp,
			inputToken,
			outputToken,
			tokenA,
			tokenB,
			route: routeForDisplay,
			simulatedProfit,
		});

		// check profitability and execute tx
		let tx, performanceOfTx;
		if (
			!cache.swappingRightNow &&
			(cache.hotkeys.e ||
				cache.hotkeys.r ||
				simulatedProfit >= cache.config.minPercProfit)
		) {
			// OPTIONAL: Run safety checks if module available
			if (performSafetyChecks) {
				const safetyResult = await performSafetyChecks({
					connection: cache.connection,
					wallet: cache.wallet,
					cache,
					config: cache.config,
					route,
					inputToken,
					amountToTrade
				});

				if (!safetyResult.passed) {
					if (!safetyResult.silent) {
						console.log("⚠️  Safety checks failed, skipping trade");
					}
					return; // Skip this trade
				}
			}

			// hotkeys
			if (cache.hotkeys.e) {
				console.log("[E] PRESSED - EXECUTION FORCED BY USER!");
				cache.hotkeys.e = false;
			}
			if (cache.hotkeys.r) {
				console.log("[R] PRESSED - REVERT BACK SWAP!");
			}

			if (cache.tradingEnabled || cache.hotkeys.e || cache.hotkeys.r) {
				cache.swappingRightNow = true;
				// store trade to the history
				let tradeEntry = {
					date: date.toLocaleString(),
					buy: cache.sideBuy,
					inputToken: inputToken.symbol,
					outputToken: outputToken.symbol,
					inAmount: toDecimal(route.inAmount, inputToken.decimals),
					expectedOutAmount: toDecimal(route.outAmount, outputToken.decimals),
					expectedProfit: simulatedProfit,
				};

				// start refreshing status
				const printTxStatus = setInterval(() => {
					if (cache.swappingRightNow) {
						printToConsole({
							date,
							i,
							performanceOfRouteComp,
							inputToken,
							outputToken,
							tokenA,
							tokenB,
							route: routeForDisplay,
							simulatedProfit,
						});
					}
				}, 500);

				[tx, performanceOfTx] = await swap(jupiterQuoteApi, route, cache.hotkeys.r);

				// stop refreshing status
				clearInterval(printTxStatus);

				// FIX: Check if transaction has txid (means it was sent, even if confirmation failed)
				const txWasSent = tx.txid && tx.txid.length > 0;
				const hasOutputAmount = tx.outputAmount && tx.outputAmount > 0;

				// CRITICAL FIX: If tx was sent but has error (timeout), treat as success if has output
				const isActualSuccess = !tx.error || (txWasSent && hasOutputAmount);

				// Calculate profit - compare current balance to output (same as original)
				tradeEntry = {
				...tradeEntry,
				outAmount: tx.outputAmount || 0,
				profit: null,  // will be calculated in successSwapHandler
				performanceOfTx,
				error: tx.error?.message || null,
				txid: tx.txid || null,
				};

				// OPTIONAL: Log transaction if module available
				if (logTransaction) {
					logTransaction(tradeEntry);
				}

				// CRITICAL FIX: Handle timeouts that actually succeeded
				if (isActualSuccess) {
					console.log('✅ Transaction succeeded (confirmed or has valid output)');
					
					if (cache.hotkeys.r) {
						console.log("[R] - REVERT BACK SWAP - SUCCESS!");
						cache.tradingEnabled = false;
						console.log("TRADING DISABLED!");
						cache.hotkeys.r = false;
					}
					
					// CRITICAL: Store side BEFORE switching
					const sideBeforeSwap = cache.sideBuy;
					
					// Update balances FIRST (using current side)
					successSwapHandler(tx, tradeEntry, tokenA, tokenB, sideBeforeSwap);
					cache.lastTradeTimestamp = Date.now();
					
					// Switch side for next trade AFTER updating balances
					cache.sideBuy = !cache.sideBuy;
					console.log(`🔄 Switched to ${cache.sideBuy ? 'BUY (tokenA→tokenB)' : 'SELL (tokenB→tokenA)'} side`);
					
				} else {
					console.log('❌ Transaction failed');
					failedSwapHandler(tradeEntry);
					// DON'T switch side on failure
				}
			}
		}

		if (tx) {
			cache.swappingRightNow = false;
		}

		printToConsole({
			date,
			i,
			performanceOfRouteComp,
			inputToken,
			outputToken,
			tokenA,
			tokenB,
			route: routeForDisplay,
			simulatedProfit,
		});
	} catch (error) {
		cache.queue[i] = 1;
		console.log("Error in pingpong strategy:", error.message);
	} finally {
		delete cache.queue[i];
	}
};

const arbitrageStrategy = async (jupiterQuoteApi, tokenA) => {
	cache.iteration++;
	const date = new Date();
	const i = cache.iteration;
	cache.queue[i] = -1;
	
	try {
		// calculate & update iterations per minute
		updateIterationsPerMin(cache);

		// Calculate amount that will be used for trade
		const amountToTrade =
			cache.config.tradeSize.strategy === "cumulative"
				? cache.currentBalance["tokenA"]
				: cache.initialBalance["tokenA"];
		const baseAmount = cache.lastBalance["tokenA"];

		// default slippage in BPS
		const slippage =
			typeof cache.config.slippage === "number" ? cache.config.slippage : 50;
			
		// set input / output token (same for arbitrage)
		const inputToken = tokenA;
		const outputToken = tokenA;

		// JUPITER V6: Get quote for arbitrage
		const performanceOfRouteCompStart = performance.now();
		
		const quote = await jupiterQuoteApi.quoteGet({
			inputMint: inputToken.address,
			outputMint: outputToken.address,
			amount: amountToTrade.toString(),
			slippageBps: slippage,
			onlyDirectRoutes: false,
			asLegacyTransaction: false,
			maxAccounts: 64,
		});

		// Check if quote exists
		if (!quote || !quote.outAmount) {
			throw new Error("No arbitrage routes found from Jupiter v6");
		}

		// update status as OK
		cache.queue[i] = 0;

		const performanceOfRouteComp =
			performance.now() - performanceOfRouteCompStart;

		// JUPITER V6: quote is the route
		const route = quote;

		cache.availableRoutes["buy"] = quote.routePlan?.length || 1;

		// FIX: Proper BigInt handling
		const routeOutAmount = BigInt(route.outAmount);
		const baseAmountBigInt = typeof baseAmount === 'bigint'
			? baseAmount
			: BigInt(baseAmount);

		let simulatedProfit = calculateProfit(baseAmountBigInt, routeOutAmount);

		// store max profit spotted
		if (simulatedProfit > cache.maxProfitSpotted["buy"]) {
			cache.maxProfitSpotted["buy"] = simulatedProfit;
		}

		// Convert route to display format
		const routeForDisplay = {
			inAmount: route.inAmount,
			outAmount: route.outAmount,
			priceImpactPct: route.priceImpactPct,
			marketInfos: route.routePlan || [],
		};

		printToConsole({
			date,
			i,
			performanceOfRouteComp,
			inputToken,
			outputToken,
			tokenA,
			tokenB: tokenA,
			route: routeForDisplay,
			simulatedProfit,
		});

		// check profitability and execute tx
		let tx, performanceOfTx;
		if (
			!cache.swappingRightNow &&
			(cache.hotkeys.e ||
				cache.hotkeys.r ||
				simulatedProfit >= cache.config.minPercProfit)
		) {
			// OPTIONAL: Run safety checks if module available
			if (performSafetyChecks) {
				const safetyResult = await performSafetyChecks({
					connection: cache.connection,
					wallet: cache.wallet,
					cache,
					config: cache.config,
					route,
					inputToken,
					amountToTrade
				});

				if (!safetyResult.passed) {
					if (!safetyResult.silent) {
						console.log("⚠️  Safety checks failed, skipping trade");
					}
					return;
				}
			}

			// hotkeys
			if (cache.hotkeys.e) {
				console.log("[E] PRESSED - EXECUTION FORCED BY USER!");
				cache.hotkeys.e = false;
			}
			if (cache.hotkeys.r) {
				console.log("[R] PRESSED - REVERT BACK SWAP!");
			}

			if (cache.tradingEnabled || cache.hotkeys.r) {
				cache.swappingRightNow = true;
				// store trade to the history
				let tradeEntry = {
					date: date.toLocaleString(),
					buy: cache.sideBuy,
					inputToken: inputToken.symbol,
					outputToken: outputToken.symbol,
					inAmount: toDecimal(route.inAmount, inputToken.decimals),
					expectedOutAmount: toDecimal(route.outAmount, outputToken.decimals),
					expectedProfit: simulatedProfit,
				};

				// start refreshing status
				const printTxStatus = setInterval(() => {
					if (cache.swappingRightNow) {
						printToConsole({
							date,
							i,
							performanceOfRouteComp,
							inputToken,
							outputToken,
							tokenA,
							tokenB: tokenA,
							route: routeForDisplay,
							simulatedProfit,
						});
					}
				}, 500);

				[tx, performanceOfTx] = await swap(jupiterQuoteApi, route, cache.hotkeys.r);

				// stop refreshing status
				clearInterval(printTxStatus);

				// CRITICAL FIX: Same timeout handling for arbitrage
				const txWasSent = tx.txid && tx.txid.length > 0;
				const hasOutputAmount = tx.outputAmount && tx.outputAmount > 0;
				const isActualSuccess = !tx.error || (txWasSent && hasOutputAmount);

				// FIX: Proper BigInt handling
				const txOutputAmount = BigInt(tx.outputAmount || 0);
				const initialBalanceAmount = cache.initialBalance["tokenA"];
				const initialBalanceBigInt = typeof initialBalanceAmount === 'bigint'
					? initialBalanceAmount
					: BigInt(initialBalanceAmount || 0);

				const profit = calculateProfit(initialBalanceBigInt, txOutputAmount);

				tradeEntry = {
					...tradeEntry,
					outAmount: tx.outputAmount || 0,
					profit,
					performanceOfTx,
					error: tx.error?.message || null,
					txid: tx.txid || null,
				};

				// OPTIONAL: Log transaction
				if (logTransaction) {
					logTransaction(tradeEntry);
				}

				// Handle success/failure
				if (isActualSuccess) {
					console.log('✅ Transaction succeeded');
					
					if (cache.hotkeys.r) {
						console.log("[R] - REVERT BACK SWAP - SUCCESS!");
						cache.tradingEnabled = false;
						console.log("TRADING DISABLED!");
						cache.hotkeys.r = false;
					}
					
					// For arbitrage, side doesn't change
					successSwapHandler(tx, tradeEntry, tokenA, tokenA, cache.sideBuy);
					cache.lastTradeTimestamp = Date.now();
					
				} else {
					console.log('❌ Transaction failed');
					failedSwapHandler(tradeEntry);
				}
			}
		}

		if (tx) {
			cache.swappingRightNow = false;
		}

		printToConsole({
			date,
			i,
			performanceOfRouteComp,
			inputToken,
			outputToken,
			tokenA,
			tokenB: tokenA,
			route: routeForDisplay,
			simulatedProfit,
		});
	} catch (error) {
		cache.queue[i] = 1;
		console.log("Error in arbitrage strategy:", error.message);
	} finally {
		delete cache.queue[i];
	}
};

const watcher = async (jupiterQuoteApi, tokenA, tokenB) => {
	if (
		!cache.swappingRightNow &&
		Object.keys(cache.queue).length < cache.queueThrottle
	) {
		if (cache.config.tradingStrategy === "pingpong") {
			await pingpongStrategy(jupiterQuoteApi, tokenA, tokenB);
		}
		if (cache.config.tradingStrategy === "arbitrage") {
			await arbitrageStrategy(jupiterQuoteApi, tokenA, tokenB);
		}
	}
};

const run = async () => {
	try {
		// AUTO-DETECT: Setup will detect wallet balance and set correct side
		const { jupiterQuoteApi, tokenA, tokenB } = await setup();

		console.log(`\n💡 Starting on ${cache.sideBuy ? 'BUY' : 'SELL'} side (auto-detected)\n`);

		if (cache.config.tradingStrategy === "pingpong") {
			// Use config trade size, but respect auto-detected side
			const tradeSize = toNumber(
				cache.config.tradeSize.value,
				cache.sideBuy ? tokenA.decimals : tokenB.decimals
			);

			if (cache.sideBuy) {
				// Starting on BUY side (have tokenA, will get tokenB)
				cache.initialBalance.tokenA = tradeSize;
				cache.currentBalance.tokenA = tradeSize;
				cache.lastBalance.tokenA = tradeSize;

				// Get expected tokenB amount for profit calculation baseline
				cache.initialBalance.tokenB = await getInitialOutAmountWithSlippage(
					jupiterQuoteApi,
					tokenA,
					tokenB,
					cache.initialBalance.tokenA
				);
				
				// CRITICAL FIX: Set lastBalance to initialBalance (expected first output)
				cache.lastBalance.tokenB = cache.initialBalance.tokenB;
				cache.currentBalance.tokenB = BigInt(0);
			} else {
				// Starting on SELL side (have tokenB, will get tokenA)
				cache.initialBalance.tokenB = tradeSize;
				cache.currentBalance.tokenB = tradeSize;
				cache.lastBalance.tokenB = tradeSize;

				// Get expected tokenA amount for profit calculation baseline
				cache.initialBalance.tokenA = await getInitialOutAmountWithSlippage(
					jupiterQuoteApi,
					tokenB,
					tokenA,
					cache.initialBalance.tokenB
				);
				
				// CRITICAL FIX: Set lastBalance to initialBalance (expected first output)
				cache.lastBalance.tokenA = cache.initialBalance.tokenA;
				cache.currentBalance.tokenA = BigInt(0);
			}
		} else if (cache.config.tradingStrategy === "arbitrage") {
			// set initial & current & last balance for tokenA
			cache.initialBalance.tokenA = toNumber(
				cache.config.tradeSize.value,
				tokenA.decimals
			);
			cache.currentBalance.tokenA = cache.initialBalance.tokenA;
			cache.lastBalance.tokenA = cache.initialBalance.tokenA;
		}

		global.botInterval = setInterval(
			() => watcher(jupiterQuoteApi, tokenA, tokenB),
			cache.config.minInterval
		);
	} catch (error) {
		logExit(error);
		process.exitCode = 1;
	}
};

run();

// handle exit
process.on("exit", handleExit);
