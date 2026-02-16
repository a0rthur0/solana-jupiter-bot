const fs = require("fs");
const chalk = require("chalk");
const ora = require("ora-classic");
const bs58 = require("bs58");
const { createJupiterApiClient } = require("@jup-ag/api");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const { logExit } = require("./exit");
const { loadConfigFile } = require("../utils");
const { intro, listenHotkeys } = require("./ui");
const cache = require("./cache");

/**
 * Get actual wallet balance for a token
 */
const getTokenBalance = async (connection, wallet, tokenAddress) => {
	try {
		// Check if it's SOL
		if (tokenAddress === "So11111111111111111111111111111111111111112") {
			const balance = await connection.getBalance(wallet.publicKey);
			return BigInt(balance);
		}
		
		// Check SPL token balance
		const tokenPubkey = new PublicKey(tokenAddress);
		const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
			wallet.publicKey,
			{ mint: tokenPubkey }
		);

		if (tokenAccounts.value.length === 0) {
			return BigInt(0);
		}

		const tokenAmount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
		return BigInt(tokenAmount.amount);
	} catch (error) {
		console.error(`Error getting balance for ${tokenAddress}:`, error.message);
		return BigInt(0);
	}
};

/**
 * Auto-detect which token user has and set correct trading side
 */
const autoDetectBalanceAndSide = async (connection, wallet, tokenA, tokenB) => {
	console.log(chalk.cyan('\n🔍 Auto-detecting wallet balances...'));
	
	const balanceA = await getTokenBalance(connection, wallet, tokenA.address);
	const balanceB = await getTokenBalance(connection, wallet, tokenB.address);
	
	const balanceADecimal = Number(balanceA) / Math.pow(10, tokenA.decimals);
	const balanceBDecimal = Number(balanceB) / Math.pow(10, tokenB.decimals);
	
	console.log(chalk.cyan(`  ${tokenA.symbol}: ${balanceADecimal.toFixed(6)}`));
	console.log(chalk.cyan(`  ${tokenB.symbol}: ${balanceBDecimal.toFixed(6)}`));
	
	// Determine which side to start on based on balances
	let startSide;
	let startBalance;
	
	if (balanceA > BigInt(0) && balanceB === BigInt(0)) {
		// Have tokenA, need to swap to tokenB
		startSide = true; // BUY side (tokenA → tokenB)
		startBalance = balanceA;
		console.log(chalk.green(`\n✅ Detected: You have ${tokenA.symbol}`));
		console.log(chalk.green(`   Starting on BUY side: ${tokenA.symbol} → ${tokenB.symbol}`));
	} else if (balanceB > BigInt(0) && balanceA === BigInt(0)) {
		// Have tokenB, need to swap to tokenA
		startSide = false; // SELL side (tokenB → tokenA)
		startBalance = balanceB;
		console.log(chalk.green(`\n✅ Detected: You have ${tokenB.symbol}`));
		console.log(chalk.green(`   Starting on SELL side: ${tokenB.symbol} → ${tokenA.symbol}`));
	} else if (balanceA > BigInt(0) && balanceB > BigInt(0)) {
		// Have both - choose the one with more value
		// CRITICAL FIX: Compare decimal values, not raw lamports!
		if (balanceADecimal > balanceBDecimal) {
			startSide = true;
			startBalance = balanceA;
			console.log(chalk.yellow(`\n⚠️  You have both tokens!`));
			console.log(chalk.green(`   Starting with larger balance: ${tokenA.symbol} → ${tokenB.symbol}`));
		} else {
			startSide = false;
			startBalance = balanceB;
			console.log(chalk.yellow(`\n⚠️  You have both tokens!`));
			console.log(chalk.green(`   Starting with larger balance: ${tokenB.symbol} → ${tokenA.symbol}`));
		}
	} else {
		// Have neither - use config default
		startSide = true;
		startBalance = BigInt(0);
		console.log(chalk.red(`\n⚠️  Warning: No balance detected for either token!`));
		console.log(chalk.yellow(`   Using config defaults...`));
	}
	
	return { startSide, balanceA, balanceB };
};

const setup = async () => {
	let spinner, tokens, tokenA, tokenB, wallet;
	try {
		// listen for hotkeys
		listenHotkeys();
		await intro();

		// load config file and store it in cache
		cache.config = loadConfigFile({ showSpinner: true });

		spinner = ora({
			text: "Loading tokens...",
			discardStdin: false,
			color: "magenta",
		}).start();

		// read tokens.json file
		try {
			tokens = JSON.parse(fs.readFileSync("./temp/tokens.json"));
			// find tokens full Object
			tokenA = tokens.find((t) => t.address === cache.config.tokenA.address);

			if (cache.config.tradingStrategy !== "arbitrage")
				tokenB = tokens.find((t) => t.address === cache.config.tokenB.address);
		} catch (error) {
			spinner.text = chalk.black.bgRedBright(
				`\n	Loading tokens failed!\n	Please try to run the Wizard first using ${chalk.bold(
					"`npm start`"
				)}\n`
			);
			throw error;
		}

		// check wallet private key
		try {
			spinner.text = "Checking wallet...";
			if (
				!process.env.SOLANA_WALLET_PRIVATE_KEY ||
				(process.env.SOLANA_WALLET_PUBLIC_KEY &&
					process.env.SOLANA_WALLET_PUBLIC_KEY?.length !== 88)
			) {
				throw new Error("Wallet check failed!");
			} else {
				wallet = Keypair.fromSecretKey(
					bs58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY)
				);
			}
		} catch (error) {
			spinner.text = chalk.black.bgRedBright(
				`\n	Wallet check failed! \n	Please make sure that ${chalk.bold(
					"SOLANA_WALLET_PRIVATE_KEY "
				)}\n	inside ${chalk.bold(".env")} file is correct \n`
			);
			throw error;
		}

		spinner.text = "Setting up connection ...";
		
		// JUPITER V6: Enhanced connection settings
		const connection = new Connection(cache.config.rpc[0], {
			commitment: 'confirmed',
			confirmTransactionInitialTimeout: 60000,
		});

		spinner.succeed("Connection established!");

		// AUTO-DETECT: Check wallet balances and determine starting side
		spinner = ora({
			text: "Detecting wallet balances...",
			discardStdin: false,
			color: "cyan",
		}).start();

		const { startSide, balanceA, balanceB } = await autoDetectBalanceAndSide(
			connection,
			wallet,
			tokenA,
			tokenB
		);

		spinner.succeed("Balance detection complete!");

		// Set the starting side in cache
		cache.sideBuy = startSide;

		spinner = ora({
			text: "Loading Jupiter v6 API (public endpoint)...",
			discardStdin: false,
			color: "magenta",
		}).start();

		// JUPITER V6: Create API client with CORRECT PUBLIC ENDPOINT
		const jupiterQuoteApi = createJupiterApiClient({
			basePath: 'https://public.jupiterapi.com',
		});

		// Store wallet and connection in cache for later use
		cache.wallet = wallet;
		cache.connection = connection;
		
		// Store actual balances in cache
		cache.actualWalletBalance = {
			tokenA: balanceA,
			tokenB: balanceB,
		};

		cache.isSetupDone = true;
		spinner.succeed("Setup done! Jupiter v6 API ready!");

		return { jupiterQuoteApi, tokenA, tokenB, wallet, connection };
	} catch (error) {
		if (spinner)
			spinner.fail(
				chalk.bold.redBright(`Setting up failed!\n 	${spinner.text}`)
			);
		logExit(1, error);
		process.exitCode = 1;
	}
};

const getInitialOutAmountWithSlippage = async (
	jupiterQuoteApi,
	inputToken,
	outputToken,
	amountToTrade
) => {
	let spinner;
	try {
		spinner = ora({
			text: "Computing initial route with Jupiter v6...",
			discardStdin: false,
			color: "magenta",
		}).start();

		// JUPITER V6: New quote API
		const quote = await jupiterQuoteApi.quoteGet({
			inputMint: inputToken.address,
			outputMint: outputToken.address,
			amount: amountToTrade.toString(),
			slippageBps: 0,
			onlyDirectRoutes: false,
			asLegacyTransaction: false,
		});

		if (quote && quote.outAmount) {
			spinner.succeed("Initial route computed with v6!");
			return BigInt(quote.outAmount);
		} else {
			spinner.fail("No routes found. Something is wrong!");
			return BigInt(0);
		}
	} catch (error) {
		if (spinner)
			spinner.fail(chalk.bold.redBright("Computing routes failed!\n"));
		console.error("Error details:", error.message);
		logExit(1, error);
		process.exitCode = 1;
	}
};

module.exports = {
	setup,
	getInitialOutAmountWithSlippage,
	getTokenBalance,
};
