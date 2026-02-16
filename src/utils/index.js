const chalk = require("chalk");

const fs = require("fs");

const ora = require("ora-classic");

const { logExit } = require("../bot/exit");

const createTempDir = () => !fs.existsSync("./temp") && fs.mkdirSync("./temp");

const storeItInTempAsJSON = (filename, data) =>
  fs.writeFileSync(`./temp/${filename}.json`, JSON.stringify(data, null, 2));

const createConfigFile = (config) => {
  const configSpinner = ora({
    text: "Creating config...",
    discardStdin: false,
  }).start();

  const configValues = {
    network: config.network.value,
    rpc: config.rpc.value,
    tradingStrategy: config.strategy.value,
    tokenA: config.tokens.value.tokenA,
    tokenB: config.tokens.value.tokenB,
    slippage: config.slippage.value,
    minPercProfit: config.profit.value,
    minInterval: parseInt(config.advanced.value.minInterval),
    tradeSize: {
      value: parseFloat(config["trading size"].value.value),
      strategy: config["trading size"].value.strategy,
    },
    ui: {
      defaultColor: "cyan",
    },
    storeFailedTxInHistory: true,
  };

  fs.writeFileSync("./config.json", JSON.stringify(configValues, null, 2), {});

  configSpinner.succeed("Config created!");
};

const verifyConfig = (config) => {
  let result = true;
  const badConfig = [];

  Object.entries(config).forEach(([key, value]) => {
    const isSet = value.isSet;
    const isSectionSet =
      isSet instanceof Object
        ? Object.values(isSet).every((value) => value === true)
        : isSet;

    if (!isSectionSet) {
      result = false;
      badConfig.push(key);
    }
  });

  return { result, badConfig };
};

/**
 * It loads the config file and returns the config object
 * @returns The config object
 */
const loadConfigFile = ({ showSpinner = false }) => {
  let config = {};
  let spinner;

  if (showSpinner) {
    spinner = ora({
      text: "Loading config...",
      discardStdin: false,
    }).start();
  }

  if (fs.existsSync("./config.json")) {
    config = JSON.parse(fs.readFileSync("./config.json"));
    spinner?.succeed("Config loaded!");
    return config;
  }

  spinner?.fail(chalk.redBright("Loading config failed!\n"));
  throw new Error("\nNo config.json file found!\n");
};

/**
 * FIX: Calculate profit for BigInt values
 * Converts BigInt to Number for calculation, returns percentage as Number
 */
const calculateProfit = (oldVal, newVal) => {
  // Ensure both values are BigInt
  const oldValBigInt = typeof oldVal === 'bigint' ? oldVal : BigInt(oldVal);
  const newValBigInt = typeof newVal === 'bigint' ? newVal : BigInt(newVal);

  // Convert to Number for percentage calculation
  // Using Number() is safe here because we're calculating a percentage (small number)
  const oldValNum = Number(oldValBigInt);
  const newValNum = Number(newValBigInt);

  // Calculate percentage profit
  return ((newValNum - oldValNum) / oldValNum) * 100;
};

/**
 * FIX: Convert token amount to decimal representation
 * Handles BigInt, string, and number inputs
 */
const toDecimal = (number, decimals) => {
  // Handle undefined or null
  if (number === undefined || number === null) return "0";

  // Convert to string first to handle all types uniformly
  let numStr;
  if (typeof number === 'bigint') {
    numStr = number.toString();
  } else if (typeof number === 'string') {
    numStr = number;
  } else {
    numStr = String(number);
  }

  // Convert string to Number for division
  const numValue = Number(numStr);

  // Perform calculation and format
  return (numValue / (10 ** decimals)).toFixed(decimals);
};

/**
 * FIX: Convert decimal to token amount (with decimals)
 * Returns BigInt for consistency with cache values
 */
const toNumber = (number, decimals) => {
  // Calculate the value
  const result = number * (10 ** decimals);

  // Return as BigInt for consistency
  return BigInt(Math.floor(result));
};

/**
 * It calculates the number of iterations per minute and updates the cache.
 */
const updateIterationsPerMin = (cache) => {
  const iterationTimer =
    (performance.now() - cache.iterationPerMinute.start) / 1000;

  if (iterationTimer >= 60) {
    cache.iterationPerMinute.value = Number(
      cache.iterationPerMinute.counter.toFixed()
    );
    cache.iterationPerMinute.start = performance.now();
    cache.iterationPerMinute.counter = 0;
  } else cache.iterationPerMinute.counter++;
};

const checkRoutesResponse = (routes) => {
  if (Object.hasOwn(routes, "routesInfos")) {
    if (routes.routesInfos.length === 0) {
      logExit(1, {
        message: "No routes found or something is wrong with RPC / Jupiter! ",
      });
      process.exit(1);
    }
  } else {
    logExit(1, {
      message: "Something is wrong with RPC / Jupiter! ",
    });
    process.exit(1);
  }
};

const checkForEnvFile = () => {
  if (!fs.existsSync("./.env")) {
    logExit(1, {
      message: "No .env file found! ",
    });
    process.exit(1);
  }
};

module.exports = {
  createTempDir,
  storeItInTempAsJSON,
  createConfigFile,
  loadConfigFile,
  verifyConfig,
  calculateProfit,
  toDecimal,
  toNumber,
  updateIterationsPerMin,
  checkRoutesResponse,
  checkForEnvFile,
};
