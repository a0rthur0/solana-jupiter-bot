"use strict";
const React = require("react");
const { Box, Text } = require("ink");
const WizardContext = require("../WizardContext");
const { useContext, useState, useEffect, useRef } = require("react");
const { default: SelectInput } = require("ink-select-input");
const chalk = require("chalk");
const { default: axios } = require("axios");
const { default: TextInput } = require("ink-text-input");
const fs = require("fs");

// JUPITER V6 FIX: Multiple token list sources with fallbacks
const TOKEN_LIST_URLS = [
	"https://token.jup.ag/all",
	"https://cache.jup.ag/tokens",
	"https://tokens.jup.ag/tokens?tags=verified",
];

// Backup: Hardcoded essential tokens if all APIs fail
const ESSENTIAL_TOKENS = [
	{
		address: "So11111111111111111111111111111111111111112",
		symbol: "SOL",
		name: "Wrapped SOL",
		decimals: 9,
		logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png"
	},
	{
		address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		symbol: "USDC",
		name: "USD Coin",
		decimals: 6,
		logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png"
	},
	{
		address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
		symbol: "USDT",
		name: "USDT",
		decimals: 6,
		logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg"
	},
	{
		address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
		symbol: "ETH",
		name: "Ether (Portal)",
		decimals: 8,
		logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs/logo.png"
	},
	{
		address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
		symbol: "mSOL",
		name: "Marinade staked SOL",
		decimals: 9,
		logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So/logo.png"
	},
	{
		address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
		symbol: "BONK",
		name: "Bonk",
		decimals: 5,
		logoURI: "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I"
	},
	{
		address: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
		symbol: "POPCAT",
		name: "Popcat",
		decimals: 9,
		logoURI: "https://bafkreidlwyr7yq6w3s5toq2b2ss5appleqjvogs3ojl2vtjwkbhfmv2tjy.ipfs.nftstorage.link"
	},
	{
		address: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
		symbol: "jupSOL",
		name: "Jupiter Staked SOL",
		decimals: 9,
		logoURI: "https://static.jup.ag/jup-sol/icon.png"
	}
];

async function fetchTokensWithFallback() {
	// Try each URL in sequence
	for (const url of TOKEN_LIST_URLS) {
		try {
			console.log(`Trying to fetch tokens from: ${url}`);
			const response = await axios.get(url, {
				timeout: 10000, // 10 second timeout
				headers: {
					'User-Agent': 'Mozilla/5.0'
				}
			});
			
			if (response.data && Array.isArray(response.data)) {
				console.log(`✓ Successfully fetched ${response.data.length} tokens`);
				return response.data;
			}
		} catch (error) {
			console.log(`✗ Failed to fetch from ${url}: ${error.message}`);
			continue; // Try next URL
		}
	}
	
	// If all URLs fail, use essential tokens
	console.log("⚠️  All token APIs failed. Using essential tokens only.");
	return ESSENTIAL_TOKENS;
}

function Tokens() {
	let isMountedRef = useRef(false);
	const {
		config: {
			strategy: { value: strategy },
			network: { value: network },
			tokens: { value: tokensValue, isSet: tokensIsSet },
		},
		configSetValue,
	} = useContext(WizardContext);
	const [tokens, setTokens] = useState([]);
	const [autocompleteTokens, setAutocompleteTokens] = useState([]);
	const [tempTokensValue, setTempTokensValue] = useState(tokensValue);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	
	const handleSubmit = (tokenId, selectedToken) => {
		// go to the next step only if all tokens are set
		let goToNextStep = true;

		if (strategy === "arbitrage") {
			if (tokenId === "tokenA") {
				setTempTokensValue({ tokenA: selectedToken, tokenB: selectedToken });
				configSetValue("tokens", { tokenA: selectedToken, tokenB: selectedToken });
				goToNextStep = true;
			}
		} else {
			if (tokenId === "tokenA") {
				setTempTokensValue({ ...tempTokensValue, tokenA: selectedToken });
				goToNextStep = false;
			}
			if (tokenId === "tokenB") {
				const newTokensValue = { ...tempTokensValue, tokenB: selectedToken };
				setTempTokensValue(newTokensValue);
				configSetValue("tokens", newTokensValue);
				goToNextStep = true;
			}
		}

		return goToNextStep;
	};

	useEffect(() => {
		isMountedRef.current = true;
		setLoading(true);
		
		(async () => {
			try {
				const tokenData = await fetchTokensWithFallback();
				
				if (isMountedRef.current) {
					setTokens(tokenData);
					setLoading(false);
					
					// Save tokens to temp folder
					if (!fs.existsSync("./temp")) fs.mkdirSync("./temp");
					fs.writeFileSync("./temp/tokens.json", JSON.stringify(tokenData));
				}
			} catch (error) {
				console.error("Error fetching tokens:", error.message);
				if (isMountedRef.current) {
					setError(error.message);
					setLoading(false);
					// Use essential tokens as fallback
					setTokens(ESSENTIAL_TOKENS);
				}
			}
		})();
		
		return () => {
			isMountedRef.current = false;
		};
	}, [network]);

	const [tokenA, setTokenA] = useState(
		tempTokensValue.tokenA ? tempTokensValue.tokenA : null
	);
	const [tokenB, setTokenB] = useState(
		tempTokensValue.tokenB ? tempTokensValue.tokenB : null
	);

	const [autocompleteValue, setAutocompleteValue] = useState("");
	const [focusedTokenId, setFocusedTokenId] = useState("tokenA");

	useEffect(() => {
		if (autocompleteValue.length > 0) {
			const filteredTokens = tokens.filter(
				(token) =>
					token.symbol.toLowerCase().includes(autocompleteValue.toLowerCase()) ||
					token.name.toLowerCase().includes(autocompleteValue.toLowerCase())
			);
			setAutocompleteTokens(filteredTokens);
		} else {
			setAutocompleteTokens([]);
		}
	}, [autocompleteValue, tokens]);

	return (
		<Box flexDirection="column">
			<Box marginBottom={1}>
				<Text>
					{chalk.bold("Tokens")} - Select tokens for your trading strategy
				</Text>
			</Box>

			{loading && (
				<Box marginTop={1}>
					<Text color="yellow">⏳ Loading tokens from Jupiter API...</Text>
				</Box>
			)}

			{error && (
				<Box marginTop={1} marginBottom={1}>
					<Text color="yellow">
						⚠️  Using essential tokens only (network issue)
					</Text>
				</Box>
			)}

			{!loading && tokens.length > 0 && (
				<>
					{/* Token A Selection */}
					<Box flexDirection="column" marginBottom={1}>
						<Text>{strategy === "arbitrage" ? "Token:" : "Token A (Input):"}</Text>
						{!tokenA ? (
							<Box flexDirection="column">
								<TextInput
									value={autocompleteValue}
									onChange={setAutocompleteValue}
									placeholder="Type to search (e.g., SOL, USDC)..."
									onSubmit={() => {}}
									focus={focusedTokenId === "tokenA"}
								/>
								{autocompleteTokens.length > 0 && (
									<Box marginTop={1}>
										<SelectInput
											items={autocompleteTokens.slice(0, 10).map((token) => ({
												label: `${token.symbol} - ${token.name}`,
												value: token,
											}))}
											onSelect={(item) => {
												setTokenA(item.value);
												setAutocompleteValue("");
												const goToNext = handleSubmit("tokenA", item.value);
												if (!goToNext && strategy !== "arbitrage") {
													setFocusedTokenId("tokenB");
												}
											}}
										/>
									</Box>
								)}
								{autocompleteValue.length > 0 && autocompleteTokens.length === 0 && (
									<Box marginTop={1}>
										<Text color="red">No tokens found. Try: SOL, USDC, BONK</Text>
									</Box>
								)}
							</Box>
						) : (
							<Box>
								<Text color="green">
									✓ {tokenA.symbol} - {tokenA.name}
								</Text>
							</Box>
						)}
					</Box>

					{/* Token B Selection (only for pingpong) */}
					{strategy !== "arbitrage" && (
						<Box flexDirection="column">
							<Text>Token B (Output):</Text>
							{!tokenB ? (
								<Box flexDirection="column">
									<TextInput
										value={autocompleteValue}
										onChange={setAutocompleteValue}
										placeholder="Type to search (e.g., USDC)..."
										onSubmit={() => {}}
										focus={focusedTokenId === "tokenB"}
									/>
									{autocompleteTokens.length > 0 && (
										<Box marginTop={1}>
											<SelectInput
												items={autocompleteTokens.slice(0, 10).map((token) => ({
													label: `${token.symbol} - ${token.name}`,
													value: token,
												}))}
												onSelect={(item) => {
													setTokenB(item.value);
													setAutocompleteValue("");
													handleSubmit("tokenB", item.value);
												}}
											/>
										</Box>
									)}
									{autocompleteValue.length > 0 && autocompleteTokens.length === 0 && (
										<Box marginTop={1}>
											<Text color="red">No tokens found. Try: USDC, USDT, SOL</Text>
										</Box>
									)}
								</Box>
							) : (
								<Box>
									<Text color="green">
										✓ {tokenB.symbol} - {tokenB.name}
									</Text>
								</Box>
							)}
						</Box>
					)}
				</>
			)}
		</Box>
	);
}

module.exports = Tokens;
