const fs = require("fs");
const chalk = require("chalk");
const ora = require("ora-classic");
const bs58 = require("bs58");
const { Jupiter } = require("@jup-ag/core");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const { logExit } = require("./exit");
const { loadConfigFile } = require("../utils");
const { intro, listenHotkeys } = require("./ui");
const cache = require("./cache");

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
					"`yarn start`"
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
		
		// OPTIMIZATION 1: Add connection commitment level for faster confirmations
		const connection = new Connection(cache.config.rpc[0], {
			commitment: 'confirmed',  // Faster than 'finalized', safer than 'processed'
			confirmTransactionInitialTimeout: 60000, // 60s timeout
		});

		spinner.text = "Loading Jupiter SDK...";

		// OPTIMIZATION 2: Add AMM exclusions for faster routing
		const jupiter = await Jupiter.load({
			connection,
			cluster: cache.config.network,
			user: wallet,
			restrictIntermediateTokens: true,
			wrapUnwrapSOL: cache.wrapUnwrapSOL,
			// PERFORMANCE BOOST: Exclude slow/low-liquidity AMMs
			// Adjust based on your trading pair - test which ones to keep!
			ammsToExclude: {
				'Aldrin': false,
				'Crema': false,
				'Cropper': true,        // LOW LIQUIDITY
				'Cykura': true,         // LOW LIQUIDITY
				'DeltaFi': false,
				'GooseFX': true,        // LOW LIQUIDITY
				'Invariant': false,
				'Lifinity': false,
				'Lifinity V2': false,
				'Marinade': false,
				'Mercurial': false,
				'Meteora': false,
				'Raydium': false,       // KEEP - FAST
				'Raydium CLMM': false,  // KEEP - FAST
				'Saber': false,
				'Serum': true,          // SLOW (old orderbook)
				'Orca': false,          // KEEP - FAST
				'Step': false,
				'Penguin': false,
				'Saros': false,
				'Stepn': true,          // LOW LIQUIDITY
				'Orca (Whirlpools)': false, // KEEP - VERY FAST
				'Sencha': false,
				'Saber (Decimals)': false,
				'Dradex': true,         // LOW LIQUIDITY
				'Balansol': true,       // LOW LIQUIDITY
				'Openbook': false,
				'Marco Polo': false,
				'Oasis': false,
				'BonkSwap': false,
				'Phoenix': false,
				'Symmetry': true,       // LOW LIQUIDITY
				'Unknown': true         // ALWAYS EXCLUDE
			}
		});

		cache.isSetupDone = true;
		spinner.succeed("Setup done!");

		return { jupiter, tokenA, tokenB };
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
	jupiter,
	inputToken,
	outputToken,
	amountToTrade
) => {
	let spinner;
	try {
		spinner = ora({
			text: "Computing routes...",
			discardStdin: false,
			color: "magenta",
		}).start();

		// OPTIMIZATION 3: Fix typo (forceFeech -> forceFetch) and add route optimization
		const routes = await jupiter.computeRoutes({
			inputMint: new PublicKey(inputToken.address),
			outputMint: new PublicKey(outputToken.address),
			inputAmount: amountToTrade,
			slippage: 0,
			forceFetch: true,  // FIXED: was "forceFeech"
			// OPTIMIZATION 4: Add performance settings
			onlyDirectRoutes: false,  // Set to true for faster routing (test first!)
			filterTopNResult: 3,      // Only get top 3 routes (faster)
		});

		if (routes?.routesInfos?.length > 0) spinner.succeed("Routes computed!");
		else spinner.fail("No routes found. Something is wrong!");

		return routes.routesInfos[0].outAmountWithSlippage;
	} catch (error) {
		if (spinner)
			spinner.fail(chalk.bold.redBright("Computing routes failed!\n"));
		logExit(1, error);
		process.exitCode = 1;
	}
};

module.exports = {
	setup,
	getInitialOutAmountWithSlippage,
};
