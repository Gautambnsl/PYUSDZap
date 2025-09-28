import { useEffect, useMemo, useState } from "react";
import { nearestUsableTick, TICK_SPACINGS } from "@uniswap/v3-sdk";
import "./App.css";

// Network targets (Arbitrum One)
const TARGET_CHAIN_ID = 42161;
const TARGET_CHAIN_HEX = "0xa4b1";
const TARGET_CHAIN_NAME = "Arbitrum One";
const TARGET_RPC_URL = "https://arb1.arbitrum.io/rpc";
const TARGET_BLOCK_EXPLORER = "https://arbiscan.io";

// Aggregator (0x) API base for Arbitrum
const ZEROX_API = "https://arbitrum.api.0x.org";

// PYUSD token address on Arbitrum One (provided)
const PYUSD_ADDRESS = "0x46850aD61C2B7d64d08c9C754F45254596696984";
// Note: Verify this pool exists and has liquidity on Arbitrum One
const ERC20_ABI = [
	"function balanceOf(address owner) view returns (uint256)",
	"function decimals() view returns (uint8)",
	"function approve(address spender, uint256 value) returns (bool)",
	"function allowance(address owner, address spender) view returns (uint256)",
];

// Stable tokens on Arbitrum
const USDC = {
	symbol: "USDC",
	address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
	decimals: 6,
};

// Uniswap constants provided by user
const UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Minimal Uniswap V3 Pool ABI
const UNISWAP_POOL_ABI = [
	"function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
	"function fee() view returns (uint24)",
	"function liquidity() view returns (uint128)",
	"function token0() view returns (address)",
	"function token1() view returns (address)",
];

// Position Manager ABI (mint, positions, collect, decreaseLiquidity, multicall)
const POSITION_MANAGER_ABI = [
	"function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
	"function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
	"function balanceOf(address owner) external view returns (uint256 balance)",
	"function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256 tokenId)",
	"function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)",
	"function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)",
	"function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
];

// Uniswap V3 Router ABI (exactInputSingle)
const UNISWAP_ROUTER_ABI = [
	"function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

// Uniswap V3 Factory ABI (getPool)
const UNISWAP_FACTORY_ABI = [
	"function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

// Multicall3 ABI (aggregate3)
const MULTICALL3_ABI = [
	{
		inputs: [
			{
				components: [
					{ name: "target", type: "address" },
					{ name: "allowFailure", type: "bool" },
					{ name: "callData", type: "bytes" },
				],
				name: "calls",
				type: "tuple[]",
			},
		],
		name: "aggregate3",
		outputs: [
			{
				components: [
					{ name: "success", type: "bool" },
					{ name: "returnData", type: "bytes" },
				],
				name: "returnData",
				type: "tuple[]",
			},
		],
		stateMutability: "payable",
		type: "function",
	},
];

type Strategy = {
	name: string;
	apy: string;
	desc: string;
	risk: "Low" | "Medium" | "High";
	tvl: string;
};

type Position = {
	id: string;
	tokenId?: number;
	strategyName: string;
	apy: string;
	risk: "Low" | "Medium" | "High";
	tvl: string;
	amountPYUSD: number;
	amountUSDC?: number;
	liquidity?: string;
	tickLower?: number;
	tickUpper?: number;
	token0?: string;
	token1?: string;
	fee?: number;
	openedAt: number;
};

function App() {
	const [account, setAccount] = useState<string | null>(null);
	const [balance, setBalance] = useState<string>("0");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [walletDetected, setWalletDetected] = useState<boolean>(false);
	const [showDeposit, setShowDeposit] = useState(false);
	const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(
		null
	);
	const [depositAmount, setDepositAmount] = useState<string>("");
	const amountNum = Number(depositAmount || "0");
	const [positions, setPositions] = useState<Position[]>([]);
	const [loadingPositions, setLoadingPositions] = useState(false);

	// Swap controls and quote state
	// We only support USDC for the Uniswap PYUSD/USDC pool
	const stableOut = USDC;
	const [quoteLoading, setQuoteLoading] = useState(false);
	const [quoteError, setQuoteError] = useState<string | null>(null);
	const [quoteOut, setQuoteOut] = useState<string>("");
	const [quoteGas, setQuoteGas] = useState<string>("");
	const [txLoading, setTxLoading] = useState(false);
	const [txError, setTxError] = useState<string | null>(null);
	const [testMode, setTestMode] = useState<boolean>(false);
	// Simple 50/50 split logic
	const swapAmount = testMode ? 0 : amountNum / 2; // Half of deposit amount goes to USDC

	// Simple mock estimates for review preview
	const review = useMemo(() => {
		const amt = isFinite(amountNum) ? Math.max(0, amountNum) : 0;
		const routingFeePct = 0.001; // 0.10%
		const slippagePct = 0.003; // 0.30%
		const fee = amt * routingFeePct;
		const minAfterSlippage = Math.max(0, (amt - fee) * (1 - slippagePct));
		return {
			routingFeePct: (routingFeePct * 100).toFixed(2) + "%",
			slippagePct: (slippagePct * 100).toFixed(2) + "%",
			fee: fee.toFixed(2),
			minAfterSlippage: minAfterSlippage.toFixed(2),
		};

		// Fetch a 0x quote for swapping auto-calculated PYUSD amount -> USDC
		useEffect(() => {
			const run = async () => {
				if (!showDeposit || !selectedStrategy || !depositAmount) return;
				const totalAmt = Number(depositAmount);
				if (!isFinite(totalAmt) || totalAmt <= 0) return;

				// Simple logic: Half of deposit converts to USDC
				const optimalSwapAmt = testMode ? 0 : totalAmt / 2;

				console.log("💡 Quote calculation:", {
					totalAmount: totalAmt,
					swapAmount: optimalSwapAmt,
					testMode,
				});

				const amt = optimalSwapAmt;
				if (!isFinite(amt) || amt <= 0) return;
				setQuoteError(null);
				setQuoteLoading(true);
				setQuoteOut("");
				setQuoteGas("");
				try {
					const { ethers } = await import("ethers");
					// Ensure we know PYUSD decimals
					const readProvider = new ethers.providers.JsonRpcProvider(
						TARGET_RPC_URL
					);
					const pyusd = new ethers.Contract(
						PYUSD_ADDRESS,
						ERC20_ABI,
						readProvider
					);
					const pyusdDec: number = await pyusd.decimals();
					const sellStr = amt.toFixed(pyusdDec);
					const sellUnits = ethers.utils
						.parseUnits(sellStr, pyusdDec)
						.toString();
					const params = new URLSearchParams({
						sellToken: PYUSD_ADDRESS,
						buyToken: stableOut.address,
						sellAmount: sellUnits,
					});
					const url = `${ZEROX_API}/swap/v1/quote?${params.toString()}`;
					const res = await fetch(url);
					if (!res.ok) {
						const t = await res.text();
						// Gracefully handle no-route (404) so user can adjust or proceed with no swap
						if (res.status === 404) {
							setQuoteError(
								"0x route not available, will use Uniswap fallback"
							);
							return;
						}
						throw new Error(`0x quote failed: ${res.status} ${t}`);
					}
					const data = await res.json();
					// data.buyAmount is string in dst token units
					const outHuman = ethers.utils.formatUnits(
						data.buyAmount,
						stableOut.decimals
					);
					setQuoteOut(`${Number(outHuman).toFixed(2)} ${stableOut.symbol}`);
					setQuoteGas(data.gas ? String(data.gas) : "—");
				} catch (e: any) {
					setQuoteError("0x unavailable, will use Uniswap fallback");
				} finally {
					setQuoteLoading(false);
				}
			};
			run();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [showDeposit, depositAmount, selectedStrategy]);
	}, [amountNum]);

	// Execute swap via 0x, then mint Uniswap v3 LP around current tick (+/-5%)
	async function handleConfirmDeposit() {
		try {
			setTxLoading(true);
			setTxError(null);
			const eth = getEthProvider();
			if (!eth) throw new Error("No wallet provider detected");
			await ensureTargetNetwork(eth);
			const { ethers } = await import("ethers");
			const provider = new ethers.providers.Web3Provider(eth);
			const signer = provider.getSigner();
			const from = await signer.getAddress();

			// amounts
			const readProvider = new ethers.providers.JsonRpcProvider(TARGET_RPC_URL);
			const pyusd = new ethers.Contract(PYUSD_ADDRESS, ERC20_ABI, readProvider);
			const pyusdDec: number = await pyusd.decimals();
			const totalAmt = Number(depositAmount);
			if (!isFinite(totalAmt) || totalAmt <= 0)
				throw new Error("Invalid amount");
			const swapAmt = testMode ? 0 : totalAmt * 0.5; // Convert half to USDC

			console.log("💡 Deposit flow:", {
				totalAmount: totalAmt,
				swapAmount: swapAmt,
				remainingPYUSD: totalAmt - swapAmt,
				testMode,
			});
			if (!isFinite(swapAmt)) throw new Error("Invalid swap amount");
			const totalUnits = ethers.utils.parseUnits(
				totalAmt.toFixed(pyusdDec),
				pyusdDec
			);
			const swapUnits = ethers.utils.parseUnits(
				swapAmt.toFixed(pyusdDec),
				pyusdDec
			);
			if (swapUnits.gt(totalUnits)) {
				throw new Error("Swap amount cannot exceed total deposit amount");
			}

			// For LP deposit we require USDC output to match provided pool; USDC.e not supported

			// Get pool address from factory for different fee tiers
			const factory = new ethers.Contract(
				UNISWAP_FACTORY,
				UNISWAP_FACTORY_ABI,
				provider
			);
			const feeTiers = [500, 3000, 10000]; // 0.05%, 0.3%, 1%
			let poolAddress = ethers.constants.AddressZero;
			let selectedFeeTier = 3000; // Default to 0.3%

			// Check if user already has USDC balance to skip swap
			const usdcContract = new ethers.Contract(
				USDC.address,
				ERC20_ABI,
				provider
			);
			const currentUsdcBalance = await usdcContract.balanceOf(from);

			console.log("Current token balances:", {
				pyusdBalance: totalUnits.toString(),
				usdcBalance: currentUsdcBalance.toString(),
				swapUnitsPlanned: swapUnits.toString(),
				testMode,
			});

			let buyAmount: string = "0";

			// TEST MODE: Skip all swap logic and use existing balances
			if (testMode) {
				console.log(
					"🧪 TEST MODE: Skipping all swaps, using existing balances"
				);
				buyAmount = Math.min(
					Number(currentUsdcBalance.toString()),
					Number(swapUnits.toString())
				).toString();
			}
			// Skip swap if user already has sufficient USDC
			else if (currentUsdcBalance.gte(swapUnits) && swapUnits.gt(0)) {
				console.log(
					"User already has sufficient USDC, skipping all swap logic"
				);
				buyAmount = swapUnits.toString(); // Use existing USDC balance
			} else if (swapUnits.gt(0)) {
				console.log("User needs to swap PYUSD for USDC");
				// Try 0x first, fallback to Uniswap if no route
				try {
					const params = new URLSearchParams({
						sellToken: PYUSD_ADDRESS,
						buyToken: stableOut.address,
						sellAmount: swapUnits.toString(),
						takerAddress: from,
						slippagePercentage: "0.005",
					});
					const swapUrl = `${ZEROX_API}/swap/v1/quote?${params.toString()}`;
					const res = await fetch(swapUrl);
					if (!res.ok) {
						throw new Error(`0x failed: ${res.status}`);
					}
					const swapData = await res.json();
					const txTo: string = swapData.to;
					const txData: string = swapData.data;
					const txValue: string = swapData.value || "0";
					const allowanceTarget: string = swapData.allowanceTarget;
					buyAmount = swapData.buyAmount; // in USDC decimals
					if (!txTo || !txData || !allowanceTarget || !buyAmount)
						throw new Error("Invalid 0x swap payload");

					// Ensure allowance to allowanceTarget
					const pyusdW = new ethers.Contract(PYUSD_ADDRESS, ERC20_ABI, signer);
					const currentAllow = await pyusdW.allowance(from, allowanceTarget);
					if (currentAllow.lt(swapUnits)) {
						console.log(
							`Approving 0x allowanceTarget: current=${currentAllow.toString()}, needed=${swapUnits.toString()}`
						);
						const appr = await pyusdW.approve(allowanceTarget, swapUnits);
						await appr.wait();
					} else {
						console.log(
							`0x allowanceTarget already approved: ${currentAllow.toString()} >= ${swapUnits.toString()}`
						);
					}
					// Execute 0x swap
					const sent = await signer.sendTransaction({
						to: txTo,
						data: txData,
						value: ethers.BigNumber.from(txValue),
					});
					await sent.wait();
				} catch (zeroXError) {
					// Fallback to Uniswap V3 Router - need to find pool first for fee tier
					console.log("0x failed, using Uniswap fallback:", zeroXError);

					// Find pool to get correct fee tier for swap
					for (const fee of feeTiers) {
						try {
							const addr = await factory.getPool(
								PYUSD_ADDRESS,
								USDC.address,
								fee
							);
							if (addr !== ethers.constants.AddressZero) {
								selectedFeeTier = fee;
								break;
							}
						} catch (e) {
							// Continue to next fee tier
						}
					}

					// Approve Uniswap router
					const pyusdW = new ethers.Contract(PYUSD_ADDRESS, ERC20_ABI, signer);
					const currentAllow = await pyusdW.allowance(from, UNISWAP_V3_ROUTER);
					if (currentAllow.lt(swapUnits)) {
						console.log(
							`Approving UNISWAP_V3_ROUTER fallback: current=${currentAllow.toString()}, needed=${swapUnits.toString()}`
						);
						const appr = await pyusdW.approve(UNISWAP_V3_ROUTER, swapUnits);
						await appr.wait();
					} else {
						console.log(
							`UNISWAP_V3_ROUTER fallback already approved: ${currentAllow.toString()} >= ${swapUnits.toString()}`
						);
					}

					// Execute Uniswap swap
					const router = new ethers.Contract(
						UNISWAP_V3_ROUTER,
						UNISWAP_ROUTER_ABI,
						signer
					);
					const deadline = Math.floor(Date.now() / 1000) + 1800;
					const swapParams = {
						tokenIn: PYUSD_ADDRESS,
						tokenOut: stableOut.address,
						fee: selectedFeeTier,
						recipient: from,
						deadline,
						amountIn: swapUnits,
						amountOutMinimum: 0, // Accept any amount of USDC out
						sqrtPriceLimitX96: 0,
					};
					const swapTx = await router.exactInputSingle(swapParams);
					await swapTx.wait();

					// Estimate buyAmount from events or use approximate 1:1 ratio
					buyAmount = swapUnits.toString(); // Approximate for PYUSD:USDC ~1:1
				}
			} else {
				console.log("No swap needed - swapUnits is 0");
			}

			// Try to find an existing pool with any fee tier
			for (const fee of feeTiers) {
				try {
					const addr = await factory.getPool(PYUSD_ADDRESS, USDC.address, fee);
					if (addr !== ethers.constants.AddressZero) {
						poolAddress = addr;
						selectedFeeTier = fee;
						console.log(
							`Found PYUSD/USDC pool at ${addr} with ${fee / 10000}% fee`
						);
						break;
					}
				} catch (e) {
					console.log(`No pool found for fee tier ${fee}:`, e);
				}
			}

			if (poolAddress === ethers.constants.AddressZero) {
				throw new Error(
					"No PYUSD/USDC Uniswap V3 pool found on Arbitrum One. The pool may not exist yet."
				);
			}

			// Read pool state with validation
			const pool = new ethers.Contract(poolAddress, UNISWAP_POOL_ABI, provider);
			let slot0, fee, token0Addr, token1Addr;
			try {
				[slot0, fee, token0Addr, token1Addr] = await Promise.all([
					pool.slot0(),
					pool.fee(),
					pool.token0(),
					pool.token1(),
				]);
			} catch (poolError: any) {
				throw new Error(
					`Pool contract error for address ${poolAddress}. Error: ${
						poolError?.message || poolError
					}`
				);
			}
			const currentTick: number = Number(slot0.tick);
			const feeTier: number = Number(fee);

			// Validate pool data
			if (!slot0 || !fee || !token0Addr || !token1Addr) {
				throw new Error(
					"Invalid pool data received. Pool may not be properly initialized."
				);
			}

			// Compute +/-5% range using Uniswap v3 SDK helpers
			const spacing: number =
				(TICK_SPACINGS as any)[feeTier] ??
				(feeTier === 500 ? 10 : feeTier === 3000 ? 60 : 200);
			const delta = Math.floor(Math.log(1.05) / Math.log(1.0001));

			// Ensure ticks are within valid range and properly spaced
			const rawLower = currentTick - delta;
			const rawUpper = currentTick + delta;
			const lower: number = nearestUsableTick(rawLower, spacing);
			const upper: number = nearestUsableTick(rawUpper, spacing);

			// Validate tick range
			if (lower >= upper) {
				throw new Error(
					`Invalid tick range: lower=${lower}, upper=${upper}, current=${currentTick}`
				);
			}

			console.log(
				`Tick range: ${lower} to ${upper} (current: ${currentTick}, spacing: ${spacing})`
			);

			// Determine token ordering and desired amounts
			const token0 = token0Addr.toLowerCase();
			const token1 = token1Addr.toLowerCase();
			const pyusdAddr = PYUSD_ADDRESS.toLowerCase();
			const usdcAddr = USDC.address.toLowerCase();

			// Validate this is actually a PYUSD/USDC pool
			const hasCorrectTokens =
				(token0 === pyusdAddr && token1 === usdcAddr) ||
				(token0 === usdcAddr && token1 === pyusdAddr);
			if (!hasCorrectTokens) {
				throw new Error(
					`Pool ${poolAddress} does not contain PYUSD and USDC. Found tokens: ${token0Addr}, ${token1Addr}`
				);
			}

			// Remaining PYUSD after swap goes into LP along with received USDC
			const amountPyusd = totalUnits.sub(swapUnits);
			const amountUsdc = ethers.BigNumber.from(buyAmount);

			console.log("Before LP creation:", {
				totalUnits: totalUnits.toString(),
				swapUnits: swapUnits.toString(),
				amountPyusd: amountPyusd.toString(),
				amountUsdc: amountUsdc.toString(),
				buyAmount,
			});

			// Calculate final amounts for LP creation
			let finalAmountPyusd = amountPyusd;
			let finalAmountUsdc = amountUsdc;

			// TEST MODE: Use existing balances directly
			if (testMode) {
				console.log("🧪 TEST MODE: Using existing balances for LP");
				// Use a reasonable split of existing balances
				const pyusdToUse = totalUnits.div(2); // Use half of deposit amount as PYUSD
				const usdcToUse = currentUsdcBalance.gt(0)
					? ethers.BigNumber.from(
							Math.min(
								Number(currentUsdcBalance.toString()),
								Number(totalUnits.div(2).toString())
							).toString()
					  )
					: ethers.BigNumber.from("0");

				finalAmountPyusd = pyusdToUse;
				finalAmountUsdc = usdcToUse;

				console.log("🧪 TEST MODE amounts:", {
					finalAmountPyusd: finalAmountPyusd.toString(),
					finalAmountUsdc: finalAmountUsdc.toString(),
					currentUsdcBalance: currentUsdcBalance.toString(),
				});
			}
			// If we used existing USDC balance instead of swapping
			else if (
				currentUsdcBalance.gte(swapUnits) &&
				swapUnits.gt(0) &&
				amountUsdc.eq(0)
			) {
				console.log("Using existing USDC balance for LP");
				finalAmountPyusd = totalUnits; // Use full PYUSD amount since no swap occurred
				finalAmountUsdc = swapUnits; // Use the planned swap amount from existing USDC

				console.log("Adjusted amounts for existing balance scenario:", {
					finalAmountPyusd: finalAmountPyusd.toString(),
					finalAmountUsdc: finalAmountUsdc.toString(),
				});
			}
			// If no swap occurred or swap failed, we need to do a minimal swap to get both tokens
			else if (amountUsdc.eq(0) && amountPyusd.gt(0)) {
				// Force a small swap to get some USDC for LP creation
				const minSwapAmount = totalUnits.div(10); // Use 10% for swap
				console.log(
					"Forcing minimal swap of",
					minSwapAmount.toString(),
					"PYUSD to get USDC"
				);

				try {
					// Try Uniswap direct swap for minimal amount
					const router = new ethers.Contract(
						UNISWAP_V3_ROUTER,
						UNISWAP_ROUTER_ABI,
						signer
					);
					const deadline = Math.floor(Date.now() / 1000) + 1800;

					// Approve router if needed (only for forced swap)
					const pyusdW = new ethers.Contract(PYUSD_ADDRESS, ERC20_ABI, signer);
					const currentAllow = await pyusdW.allowance(from, UNISWAP_V3_ROUTER);
					if (currentAllow.lt(minSwapAmount)) {
						console.log(
							`Approving UNISWAP_V3_ROUTER for forced swap: current=${currentAllow.toString()}, needed=${minSwapAmount.toString()}`
						);
						const appr = await pyusdW.approve(UNISWAP_V3_ROUTER, minSwapAmount);
						await appr.wait();
					} else {
						console.log(
							`UNISWAP_V3_ROUTER already approved for forced swap: ${currentAllow.toString()} >= ${minSwapAmount.toString()}`
						);
					}

					const swapParams = {
						tokenIn: PYUSD_ADDRESS,
						tokenOut: stableOut.address,
						fee: selectedFeeTier,
						recipient: from,
						deadline,
						amountIn: minSwapAmount,
						amountOutMinimum: 0,
						sqrtPriceLimitX96: 0,
					};

					const swapTx = await router.exactInputSingle(swapParams);
					await swapTx.wait();

					// Update amounts after forced swap
					finalAmountPyusd = totalUnits.sub(minSwapAmount);
					finalAmountUsdc = minSwapAmount; // Approximate 1:1 for PYUSD:USDC

					console.log("After forced swap:", {
						finalAmountPyusd: finalAmountPyusd.toString(),
						finalAmountUsdc: finalAmountUsdc.toString(),
					});
				} catch (forceSwapError) {
					console.error("Forced swap failed:", forceSwapError);
					throw new Error(
						"Unable to create balanced LP position. Both PYUSD and USDC are required."
					);
				}
			}

			// Calculate token amounts based on pool token ordering
			const amount0Desired =
				token0 === pyusdAddr ? finalAmountPyusd : finalAmountUsdc;
			const amount1Desired =
				token1 === pyusdAddr ? finalAmountPyusd : finalAmountUsdc;

			// Ensure we have meaningful amounts for LP
			if (amount0Desired.eq(0) && amount1Desired.eq(0)) {
				throw new Error(
					"Cannot create LP position with zero amounts for both tokens"
				);
			}

			// Log amounts for debugging
			console.log("LP amounts:", {
				token0: token0Addr,
				token1: token1Addr,
				amount0Desired: amount0Desired.toString(),
				amount1Desired: amount1Desired.toString(),
				finalAmountPyusd: finalAmountPyusd.toString(),
				finalAmountUsdc: finalAmountUsdc.toString(),
			});

			// Batch approve both tokens to Position Manager using Multicall3
			const token0C = new ethers.Contract(token0Addr, ERC20_ABI, signer);
			const token1C = new ethers.Contract(token1Addr, ERC20_ABI, signer);
			const [allow0, allow1] = await Promise.all([
				token0C.allowance(from, UNISWAP_POSITION_MANAGER),
				token1C.allowance(from, UNISWAP_POSITION_MANAGER),
			]);

			console.log("Position Manager allowances:", {
				token0: token0Addr,
				token1: token1Addr,
				allow0: allow0.toString(),
				allow1: allow1.toString(),
				needed0: amount0Desired.toString(),
				needed1: amount1Desired.toString(),
			});

			// Smart approval logic - use multicall only when needed
			const needsToken0Approval = allow0.lt(amount0Desired);
			const needsToken1Approval = allow1.lt(amount1Desired);
			const totalApprovalsNeeded =
				(needsToken0Approval ? 1 : 0) + (needsToken1Approval ? 1 : 0);

			if (totalApprovalsNeeded === 0) {
				console.log("No approvals needed - all tokens already approved");
			} else if (totalApprovalsNeeded === 1) {
				// Single approval - use direct contract call
				if (needsToken0Approval) {
					console.log(
						`Direct approval for token0 (${token0Addr}): current=${allow0.toString()}, needed=${amount0Desired.toString()}`
					);
					const approveTx = await token0C.approve(
						UNISWAP_POSITION_MANAGER,
						amount0Desired
					);
					await approveTx.wait();
					console.log("Token0 approval completed");
				} else if (needsToken1Approval) {
					console.log(
						`Direct approval for token1 (${token1Addr}): current=${allow1.toString()}, needed=${amount1Desired.toString()}`
					);
					const approveTx = await token1C.approve(
						UNISWAP_POSITION_MANAGER,
						amount1Desired
					);
					await approveTx.wait();
					console.log("Token1 approval completed");
				}
			} else {
				// Multiple approvals - use multicall for efficiency
				console.log("Multiple approvals needed - using multicall");
				const { ethers: ethersLib } = await import("ethers");
				const erc20Interface = new ethersLib.utils.Interface(ERC20_ABI);
				const approveCalls = [];

				if (needsToken0Approval) {
					console.log(`Adding token0 approval to multicall: ${token0Addr}`);
					const approveCalldata = erc20Interface.encodeFunctionData("approve", [
						UNISWAP_POSITION_MANAGER,
						amount0Desired,
					]);
					approveCalls.push({
						target: token0Addr,
						allowFailure: false,
						callData: approveCalldata,
					});
				}

				if (needsToken1Approval) {
					console.log(`Adding token1 approval to multicall: ${token1Addr}`);
					const approveCalldata = erc20Interface.encodeFunctionData("approve", [
						UNISWAP_POSITION_MANAGER,
						amount1Desired,
					]);
					approveCalls.push({
						target: token1Addr,
						allowFailure: false,
						callData: approveCalldata,
					});
				}

				const multicall = new ethersLib.Contract(
					MULTICALL3,
					MULTICALL3_ABI,
					signer
				);
				const multicallTx = await multicall.aggregate3(approveCalls);
				await multicallTx.wait();
				console.log("Multicall approvals completed");
			}

			// Mint position with validation
			const pm = new ethers.Contract(
				UNISWAP_POSITION_MANAGER,
				POSITION_MANAGER_ABI,
				signer
			);
			const deadline = Math.floor(Date.now() / 1000) + 1800;

			// Validate mint parameters
			if (amount0Desired.lte(0) || amount1Desired.lte(0)) {
				throw new Error(
					`Invalid amounts for minting: amount0=${amount0Desired.toString()}, amount1=${amount1Desired.toString()}. Need both PYUSD and USDC for LP.`
				);
			}

			const paramsMint = {
				token0: token0Addr,
				token1: token1Addr,
				fee: feeTier,
				tickLower: lower,
				tickUpper: upper,
				amount0Desired,
				amount1Desired,
				amount0Min: 0,
				amount1Min: 0,
				recipient: from,
				deadline,
			};

			console.log("Mint parameters:", paramsMint);

			// Check actual token balances before minting
			const [actualPyusdBalance, actualUsdcBalance] = await Promise.all([
				token0C.balanceOf(from),
				token1C.balanceOf(from),
			]);

			console.log("Pre-mint balance check:", {
				actualPyusdBalance: actualPyusdBalance.toString(),
				actualUsdcBalance: actualUsdcBalance.toString(),
				amount0Desired: amount0Desired.toString(),
				amount1Desired: amount1Desired.toString(),
				token0IsEnough: actualPyusdBalance.gte(amount0Desired),
				token1IsEnough: actualUsdcBalance.gte(amount1Desired),
			});

			// Try to estimate gas first to catch errors early
			try {
				const gasEstimate = await pm.estimateGas.mint(paramsMint);
				console.log("Gas estimate successful:", gasEstimate.toString());
			} catch (gasError: any) {
				console.error("Gas estimation failed:", gasError);
				throw new Error(
					`Transaction would fail: ${
						gasError?.reason || gasError?.message || gasError
					}. Check if you have sufficient token balances and allowances.`
				);
			}

			let mintTx;
			try {
				console.log("Attempting to mint position...");
				mintTx = await pm.mint(paramsMint);
				console.log("Mint transaction sent:", mintTx.hash);
				const receipt = await mintTx.wait();
				console.log("Mint transaction confirmed:", receipt.transactionHash);

				// Try to extract tokenId from logs
				const mintEvent = receipt.logs.find((log: any) => {
					try {
						const parsed = pm.interface.parseLog(log);
						return (
							parsed.name === "IncreaseLiquidity" || parsed.name === "Transfer"
						);
					} catch {
						return false;
					}
				});

				if (mintEvent) {
					const parsed = pm.interface.parseLog(mintEvent);
					console.log("Position created successfully:", parsed);
				}
			} catch (mintError: any) {
				console.error("Mint transaction failed:", mintError);

				// Check if transaction was actually mined but failed
				if (mintError.receipt) {
					console.log(
						"Transaction was mined but failed. Receipt:",
						mintError.receipt
					);
					throw new Error(
						`Position creation failed: ${
							mintError.reason || mintError.message
						}. Transaction hash: ${mintError.receipt.transactionHash}`
					);
				} else {
					throw new Error(
						`Position creation failed: ${
							mintError.reason || mintError.message || mintError
						}`
					);
				}
			}

			// Update UI: add position and close
			if (selectedStrategy && mintTx) {
				setPositions((prev) => [
					{
						id: mintTx.hash || Math.random().toString(36).slice(2),
						strategyName: selectedStrategy.name,
						apy: selectedStrategy.apy,
						risk: selectedStrategy.risk,
						tvl: selectedStrategy.tvl,
						amountPYUSD: totalAmt,
						openedAt: Date.now(),
					},
					...prev,
				]);

				console.log("✅ Position created successfully!");
				console.log("Transaction hash:", mintTx.hash);
				console.log("Pool address:", poolAddress);
				console.log("Tick range:", lower, "to", upper);
			}

			setShowDeposit(false);
			setDepositAmount("");
			// No need to clear swap amount as it's calculated automatically
			// refresh balance and positions
			fetchBalance();
			fetchPositions();
		} catch (e: any) {
			setTxError(e?.message || "Failed to process transaction");
		} finally {
			setTxLoading(false);
		}
	}

	const strategies: Strategy[] = useMemo(
		() => [
			{
				name: "PYUSD/USDC Liquidity Pool",
				apy: "5.7%",
				desc: "Provide liquidity to PYUSD/USDC pairs on Uniswap V3 with concentrated ranges.",
				risk: "Low",
				tvl: "$437.8K",
			},
			{
				name: "PYUSD Yield Farming",
				apy: "8.4%",
				desc: "Automated yield farming across multiple PYUSD pools with dynamic rebalancing and compound rewards.",
				risk: "Medium",
				tvl: "$1.2M",
			},
			{
				name: "Cross-Chain PYUSD Bridge",
				apy: "12.1%",
				desc: "Bridge PYUSD across multiple chains while earning yield from transaction fees and arbitrage opportunities.",
				risk: "High",
				tvl: "$890K",
			},
		],
		[]
	);

	useEffect(() => {
		if (account) {
			fetchBalance();
			fetchPositions();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [account]);

	// Fetch real Uniswap V3 positions
	async function fetchPositions() {
		if (!account) return;

		setLoadingPositions(true);
		try {
			const { ethers } = await import("ethers");
			const provider = new ethers.providers.JsonRpcProvider(TARGET_RPC_URL);
			const positionManager = new ethers.Contract(
				UNISWAP_POSITION_MANAGER,
				POSITION_MANAGER_ABI,
				provider
			);

			// Get number of positions owned by user
			const balance = await positionManager.balanceOf(account);
			console.log(`User has ${balance.toString()} NFT positions`);

			const fetchedPositions: Position[] = [];

			// Fetch each position
			for (let i = 0; i < balance.toNumber(); i++) {
				try {
					const tokenId = await positionManager.tokenOfOwnerByIndex(account, i);
					const position = await positionManager.positions(tokenId);

					// Only include PYUSD/USDC positions
					const token0 = position.token0.toLowerCase();
					const token1 = position.token1.toLowerCase();
					const pyusdAddr = PYUSD_ADDRESS.toLowerCase();
					const usdcAddr = USDC.address.toLowerCase();

					const isPyusdUsdcPool =
						(token0 === pyusdAddr && token1 === usdcAddr) ||
						(token0 === usdcAddr && token1 === pyusdAddr);

					if (isPyusdUsdcPool && position.liquidity.gt(0)) {
						console.log(
							`Found PYUSD/USDC position: tokenId=${tokenId.toString()}`,
							position
						);

						fetchedPositions.push({
							id: tokenId.toString(),
							tokenId: tokenId.toNumber(),
							strategyName: "PYUSD/USDC Liquidity Pool",
							apy: "5.7%",
							risk: "Low",
							tvl: "$8.4M",
							amountPYUSD: 0, // Would need more complex calculation
							amountUSDC: 0,
							liquidity: position.liquidity.toString(),
							tickLower: position.tickLower,
							tickUpper: position.tickUpper,
							token0: position.token0,
							token1: position.token1,
							fee: position.fee,
							openedAt: Date.now(), // Approximate
						});
					}
				} catch (e) {
					console.error(`Error fetching position ${i}:`, e);
				}
			}

			setPositions(fetchedPositions);
			console.log(`Loaded ${fetchedPositions.length} PYUSD/USDC positions`);
		} catch (e) {
			console.error("Error fetching positions:", e);
		} finally {
			setLoadingPositions(false);
		}
	}

	// Withdraw from position - Single transaction + auto-swap USDC back to PYUSD
	async function handleWithdraw(position: Position) {
		if (!position.tokenId) {
			setTxError("Invalid position - no token ID found");
			return;
		}

		try {
			setTxLoading(true);
			setTxError(null);

			console.log(
				`🔄 Withdrawing position #${position.tokenId} in single transaction...`
			);

			const eth = getEthProvider();
			if (!eth) throw new Error("No wallet provider detected");
			await ensureTargetNetwork(eth);

			const { ethers } = await import("ethers");
			const provider = new ethers.providers.Web3Provider(eth);
			const signer = provider.getSigner();

			const positionManager = new ethers.Contract(
				UNISWAP_POSITION_MANAGER,
				POSITION_MANAGER_ABI,
				signer
			);
			const deadline = Math.floor(Date.now() / 1000) + 1800;

			console.log("📊 Position details:", {
				tokenId: position.tokenId,
				liquidity: position.liquidity,
				tickRange: `${position.tickLower} to ${position.tickUpper}`,
				fee: position.fee,
			});

			// Create multicall data - same as Uniswap interface does
			const positionInterface = new ethers.utils.Interface(
				POSITION_MANAGER_ABI
			);

			// 1. Decrease liquidity to 0
			const decreaseLiquidityData = positionInterface.encodeFunctionData(
				"decreaseLiquidity",
				[
					{
						tokenId: position.tokenId,
						liquidity: position.liquidity, // Remove 100% of liquidity
						amount0Min: 0, // Accept any amount
						amount1Min: 0, // Accept any amount
						deadline,
					},
				]
			);

			// 2. Collect all tokens (fees + principal)
			const collectData = positionInterface.encodeFunctionData("collect", [
				{
					tokenId: position.tokenId,
					recipient: account,
					amount0Max: "340282366920938463463374607431768211455", // MaxUint128
					amount1Max: "340282366920938463463374607431768211455", // MaxUint128
				},
			]);

			// Execute both operations in single transaction via multicall
			console.log("🚀 Executing single transaction withdrawal...");
			const multicallTx = await positionManager.multicall([
				decreaseLiquidityData,
				collectData,
			]);
			const receipt = await multicallTx.wait();

			console.log("✅ Position withdrawn successfully in single transaction!");
			console.log("💰 Transaction hash:", receipt.transactionHash);

			// Step 2: Swap any USDC back to PYUSD
			console.log("🔄 Checking USDC balance to swap back to PYUSD...");
			const usdcContract = new ethers.Contract(
				USDC.address,
				ERC20_ABI,
				provider
			);
			const usdcBalance = await usdcContract.balanceOf(account);

			if (usdcBalance.gt(0)) {
				console.log(
					`💱 Swapping ${ethers.utils.formatUnits(
						usdcBalance,
						6
					)} USDC back to PYUSD...`
				);

				try {
					// Try 0x first for USDC → PYUSD swap
					const params = new URLSearchParams({
						sellToken: USDC.address,
						buyToken: PYUSD_ADDRESS,
						sellAmount: usdcBalance.toString(),
						takerAddress: account || "",
						slippagePercentage: "0.01", // 1% slippage
					});
					const swapUrl = `${ZEROX_API}/swap/v1/quote?${params.toString()}`;
					const res = await fetch(swapUrl);

					if (res.ok) {
						const swapData = await res.json();
						const txTo = swapData.to;
						const txData = swapData.data;
						const txValue = swapData.value || "0";
						const allowanceTarget = swapData.allowanceTarget;

						// Approve USDC to allowanceTarget if needed
						const currentAllow = await usdcContract.allowance(
							account,
							allowanceTarget
						);
						if (currentAllow.lt(usdcBalance)) {
							console.log("Approving USDC for swap...");
							const approveTx = await usdcContract
								.connect(signer)
								.approve(allowanceTarget, usdcBalance);
							await approveTx.wait();
						}

						// Execute swap
						const swapTx = await signer.sendTransaction({
							to: txTo,
							data: txData,
							value: ethers.BigNumber.from(txValue),
						});
						await swapTx.wait();

						console.log("✅ USDC swapped back to PYUSD successfully!");
					} else {
						console.log("⚠️ 0x swap failed, trying Uniswap fallback...");

						// Fallback to Uniswap for USDC → PYUSD
						const router = new ethers.Contract(
							UNISWAP_V3_ROUTER,
							UNISWAP_ROUTER_ABI,
							signer
						);

						// Approve Uniswap router if needed
						const routerAllow = await usdcContract.allowance(
							account,
							UNISWAP_V3_ROUTER
						);
						if (routerAllow.lt(usdcBalance)) {
							console.log("Approving USDC for Uniswap swap...");
							const approveTx = await usdcContract
								.connect(signer)
								.approve(UNISWAP_V3_ROUTER, usdcBalance);
							await approveTx.wait();
						}

						const swapParams = {
							tokenIn: USDC.address,
							tokenOut: PYUSD_ADDRESS,
							fee: 3000, // 0.3% fee tier
							recipient: account,
							deadline: Math.floor(Date.now() / 1000) + 1800,
							amountIn: usdcBalance,
							amountOutMinimum: 0,
							sqrtPriceLimitX96: 0,
						};

						const swapTx = await router.exactInputSingle(swapParams);
						await swapTx.wait();

						console.log("✅ USDC swapped back to PYUSD via Uniswap!");
					}
				} catch (swapError) {
					console.error("⚠️ Failed to swap USDC back to PYUSD:", swapError);
					console.log(
						"USDC remains in wallet - you can swap manually if needed"
					);
				}
			} else {
				console.log("No USDC to swap back");
			}

			console.log("🎉 Withdrawal complete! All funds converted back to PYUSD");

			// Refresh positions and balance
			console.log("🔄 Refreshing positions and balance...");
			await Promise.all([fetchPositions(), fetchBalance()]);
		} catch (e: any) {
			console.error("❌ Withdraw failed:", e);
			const errorMsg = e?.reason || e?.message || "Failed to withdraw position";
			setTxError(`Withdrawal failed: ${errorMsg}`);
		} finally {
			setTxLoading(false);
		}
	}

	// On mount, detect provider and prefetch existing accounts
	useEffect(() => {
		const eth = (window as any).ethereum;
		if (!eth) {
			setWalletDetected(false);
			return;
		}
		setWalletDetected(true);
		// Try to read already connected accounts
		if (typeof eth.request === "function") {
			eth
				.request({ method: "eth_accounts" })
				.then((accs: string[]) => {
					if (accs && accs[0]) setAccount(accs[0]);
				})
				.catch(() => {});
		}

		// Listen to wallet events
		const handleAccountsChanged = (accs: string[]) => {
			setAccount(accs && accs[0] ? accs[0] : null);
		};
		const handleChainChanged = () => {
			// Refresh balance on chain changes
			if (account) fetchBalance();
		};
		eth.on?.("accountsChanged", handleAccountsChanged);
		eth.on?.("chainChanged", handleChainChanged);

		return () => {
			eth.removeListener?.("accountsChanged", handleAccountsChanged);
			eth.removeListener?.("chainChanged", handleChainChanged);
		};
	}, []);

	async function connectWallet() {
		setError(null);
		try {
			const eth = getEthProvider();
			if (!eth) {
				alert("Please install MetaMask");
				return;
			}
			// Prefer direct request to wallet to avoid provider quirks
			let accounts: string[] | undefined;
			if (typeof eth.request === "function") {
				accounts = await eth.request({ method: "eth_requestAccounts" });
			} else {
				const { ethers } = await import("ethers");
				const provider = new ethers.providers.Web3Provider(eth);
				accounts = await provider.send("eth_requestAccounts", []);
			}
			if (!accounts || accounts.length === 0) {
				setError("No accounts returned from wallet");
				return;
			}
			setAccount(accounts[0]);

			// Try switching to Arbitrum One after connect for a consistent UX
			await ensureTargetNetwork(eth);
		} catch (e: any) {
			// Handle common user rejection code
			if (e?.code === 4001) {
				setError("Connection request was rejected in the wallet");
			} else {
				setError(e?.message ?? "Failed to connect wallet");
			}
		}
	}

	// Prefer MetaMask provider if multiple are present
	function getEthProvider(): any {
		const eth = (window as any).ethereum;
		if (eth && Array.isArray(eth.providers)) {
			const metamask = eth.providers.find((p: any) => p.isMetaMask);
			return metamask || eth.providers[0];
		}
		return eth;
	}

	async function fetchBalance() {
		if (!account) return;
		setLoading(true);
		setError(null);
		try {
			const eth = getEthProvider();
			if (!eth) {
				setError("No wallet provider detected");
				return;
			}
			const { ethers } = await import("ethers");
			// Ensure wallet is on Arbitrum, but read via RPC even if not switched
			await ensureTargetNetwork(eth);

			// Use RPC provider to guarantee reads from Arbitrum One
			const readProvider = new ethers.providers.JsonRpcProvider(TARGET_RPC_URL);
			const contract = new ethers.Contract(
				PYUSD_ADDRESS,
				ERC20_ABI,
				readProvider
			);
			const bal = await contract.balanceOf(account);
			const dec = await contract.decimals();
			setBalance(ethers.utils.formatUnits(bal, dec));
		} catch (e: any) {
			console.error(e);
			setError(
				e?.code === "MODULE_NOT_FOUND"
					? 'Dependency missing: please install "ethers"'
					: e?.reason ||
							e?.message ||
							`Failed to fetch PYUSD balance on ${TARGET_CHAIN_NAME}`
			);
		} finally {
			setLoading(false);
		}
	}

	// Ensure wallet is on target chain, try switch and add if needed
	async function ensureTargetNetwork(eth: any) {
		try {
			const { ethers } = await import("ethers");
			const provider = new ethers.providers.Web3Provider(eth);
			const network = await provider.getNetwork();
			if (network.chainId === TARGET_CHAIN_ID) return true;
			// Try switch
			if (typeof eth.request === "function") {
				try {
					await eth.request({
						method: "wallet_switchEthereumChain",
						params: [{ chainId: TARGET_CHAIN_HEX }],
					});
					return true;
				} catch (switchErr: any) {
					// Unrecognized chain -> try to add
					if (switchErr?.code === 4902) {
						try {
							await eth.request({
								method: "wallet_addEthereumChain",
								params: [
									{
										chainId: TARGET_CHAIN_HEX,
										chainName: TARGET_CHAIN_NAME,
										rpcUrls: [TARGET_RPC_URL],
										nativeCurrency: {
											name: "Ether",
											symbol: "ETH",
											decimals: 18,
										},
										blockExplorerUrls: [TARGET_BLOCK_EXPLORER],
									},
								],
							});
							return true;
						} catch (addErr) {
							// fall through
						}
					}
				}
			}
		} catch (_) {
			// ignore
		}
		return false;
	}

	return (
		<div className="page">
			{/* Header */}
			<header className="header">
				<div className="brand">
					<div className="brand-mark" aria-hidden>
						Ƥ
					</div>
					<div className="brand-text">
						<span className="brand-name">PayYield</span>
						<span className="brand-sub">DeFi Yield Strategies for PayPal USD (PYUSD)</span>
					</div>
				</div>

				{!account ? (
					walletDetected ? (
						<button className="btn btn-primary" onClick={connectWallet}>
							Connect Wallet
						</button>
					) : (
						<a
							className="btn btn-primary"
							href="https://metamask.io/download/"
							target="_blank"
							rel="noreferrer"
						>
							Install MetaMask
						</a>
					)
				) : (
					<div className="account">
						<div className="account-dot" />
						<span className="account-text">
							{account.slice(0, 6)}...{account.slice(-4)}
						</span>
					</div>
				)}
			</header>

			{/* Main content */}
			<main className="content">
				{/* Hero */}
				<section className="hero">
					<div className="hero-kicker">
						PayYield • DeFi Yield Strategies • Powered by PayPal USD
					</div>
					<h1 className="hero-title">
						Maximize Your <span className="grad">PYUSD</span> Returns
					</h1>
					<p className="hero-sub">
						Discover institutional-grade DeFi strategies designed to optimize
						your PayPal USD holdings with transparent, secure, and automated
						yield generation.
					</p>
					{!account && (
						<div className="hero-actions">
							<button className="btn btn-primary" onClick={connectWallet}>
								Connect Wallet to Get Started
							</button>
						</div>
					)}
				</section>

				{/* Stats */}
				<section className="stats">
					<div className="stat">
						<div className="stat-value">$102.3</div>
						<div className="stat-label">Total Value Locked</div>
					</div>
					<div className="stat">
						<div className="stat-value">4</div>
						<div className="stat-label">Active Users</div>
					</div>
					<div className="stat">
						<div className="stat-value">8.6%</div>
						<div className="stat-label">Avg APY</div>
					</div>
					<div className="stat">
						<div className="stat-value">3</div>
						<div className="stat-label">Strategies Available</div>
					</div>
				</section>

				{/* Wallet summary card */}
				{account && (
					<section className="card wallet">
						<div className="wallet-top">
							<h2 className="card-title">PYUSD Balance</h2>
							{loading ? (
								<div className="spinner" aria-label="Loading" />
							) : null}
						</div>
						{error ? (
							<div className="alert alert-error">{error}</div>
						) : (
							<p className="wallet-balance">
								<span className="balance-number">{balance}</span>
								<span className="balance-unit">PYUSD</span>
							</p>
						)}
						<div className="wallet-actions">
							<button
								className="btn btn-secondary"
								onClick={fetchBalance}
								disabled={loading}
							>
								Refresh Balance
							</button>
						</div>
					</section>
				)}

				{/* Single-Token Zaps (Deposit/Withdraw) */}
				<section>
					<div className="section-head">
						<h3 className="section-title">Single‑Token Zaps for PYUSD</h3>
						<p className="section-sub">
							Deposit and withdraw using only PYUSD. We handle the routing into
							and out of LP positions under the hood.
						</p>
					</div>
					<div className="zap-grid">
						<div className="card zap-card">
							<h4 className="zap-title">Deposit Zap (PYUSD ➜ LP)</h4>
							<p className="zap-desc">
								Supply only PYUSD. We automatically route through trusted DEXes
								on <strong>{TARGET_CHAIN_NAME}</strong> to create the balanced
								LP position for the selected strategy.
							</p>
							<ul className="zap-list">
								<li>
									<span className="dot" /> Single‑asset input: PYUSD only
								</li>
								<li>
									<span className="dot" /> Auto‑split, swap, and add liquidity
								</li>
								<li>
									<span className="dot" /> Transparent routing and estimated
									slippage
								</li>
							</ul>
							<div className="zap-cta">
								<button className="btn btn-primary btn-block">
									Deposit PYUSD via Zap
								</button>
							</div>
							<p className="zap-note">
								Note: You’ll review route, fees, and min‑received before
								confirming in your wallet.
							</p>
						</div>

						<div className="card zap-card">
							<h4 className="zap-title">Withdraw Zap (LP ➜ PYUSD)</h4>
							<p className="zap-desc">
								Exit back to only PYUSD. We remove liquidity and swap residual
								tokens to PYUSD to keep your balances simple.
							</p>
							<ul className="zap-list">
								<li>
									<span className="dot" /> Single‑asset output: PYUSD only
								</li>
								<li>
									<span className="dot" /> Auto‑remove liquidity and swap to
									PYUSD
								</li>
								<li>
									<span className="dot" /> Clear preview of output and fees
								</li>
							</ul>
							<div className="zap-cta">
								<button className="btn btn-secondary btn-block">
									Withdraw to PYUSD via Zap
								</button>
							</div>
							<p className="zap-note">
								Tip: Ideal for simplifying portfolio accounting and PYUSD‑only
								treasuries.
							</p>
						</div>
					</div>
				</section>

				{/* Featured Strategies */}
				<section>
					<div className="section-head">
						<h3 className="section-title">Featured Strategies</h3>
						<p className="section-sub">
							Choose from our carefully curated strategies, each designed for
							different risk profiles and yield objectives.
						</p>
					</div>
					<div className="grid">
						{strategies.map((s, i) => (
							<div className="card strategy" key={i}>
								<div className="strategy-top">
									<span className="badge">{s.apy} APY</span>
								</div>
								<h4 className="strategy-title">{s.name}</h4>
								<p className="strategy-desc">{s.desc}</p>
								<div className="kv">
									<div className="kv-row">
										<span className="kv-key">Risk Level</span>
										<span className={`kv-val risk-${s.risk.toLowerCase()}`}>
											{s.risk}
										</span>
									</div>
									<div className="kv-row">
										<span className="kv-key">TVL</span>
										<span className="kv-val">{s.tvl}</span>
									</div>
								</div>
								{s.risk === "Low" ? (
									<button
										className="btn btn-primary btn-block"
										onClick={() => {
											setSelectedStrategy(s);
											setShowDeposit(true);
										}}
									>
										Deposit PYUSD
									</button>
								) : (
									<button className="btn btn-secondary btn-block" disabled>
										<span style={{ opacity: 0.7 }}>🚧 Enabling Soon</span>
									</button>
								)}
							</div>
						))}
					</div>
				</section>

				{/* Your Positions */}
				<section>
					<div className="section-head">
						<h3 className="section-title">
							Your Positions {loadingPositions && <span className="spinner" />}
						</h3>
						<p className="section-sub">
							Track your active deposits and manage exits back to PYUSD.
						</p>
					</div>
					{positions.length === 0 ? (
						<div className="card">
							<p className="feature-desc">
								{loadingPositions
									? "Loading positions..."
									: "No active positions yet. Start by choosing a strategy above and depositing PYUSD via the Zap."}
							</p>
						</div>
					) : (
						<div className="grid">
							{positions.map((p) => (
								<div className="card" key={p.id}>
									<h4 className="strategy-title">{p.strategyName}</h4>
									<div className="kv">
										<div className="kv-row">
											<span className="kv-key">Token ID</span>
											<span className="kv-val">#{p.tokenId}</span>
										</div>
										<div className="kv-row">
											<span className="kv-key">Liquidity</span>
											<span className="kv-val">
												{p.liquidity
													? Number(p.liquidity).toLocaleString()
													: "—"}
											</span>
										</div>
										<div className="kv-row">
											<span className="kv-key">Fee Tier</span>
											<span className="kv-val">
												{p.fee ? (p.fee / 10000).toFixed(2) + "%" : "—"}
											</span>
										</div>
										<div className="kv-row">
											<span className="kv-key">Tick Range</span>
											<span className="kv-val">
												{p.tickLower && p.tickUpper
													? `${p.tickLower} to ${p.tickUpper}`
													: "—"}
											</span>
										</div>
									</div>
									<div className="wallet-actions">
										<button
											className="btn btn-secondary"
											onClick={() => handleWithdraw(p)}
											disabled={txLoading}
										>
											{txLoading ? "Processing..." : "Withdraw to PYUSD"}
										</button>
									</div>
								</div>
							))}
						</div>
					)}
				</section>

				{/* Why Choose */}
				<section>
					<div className="section-head">
						<h3 className="section-title">Why Choose PayYield?</h3>
					</div>
					<div className="grid why">
						<div className="card feature">
							<h4 className="feature-title">Bank-Grade Security</h4>
							<p className="feature-desc">
								Multi-signature wallets and audited smart contracts protect your
								funds with institutional-level security.
							</p>
						</div>
						<div className="card feature">
							<h4 className="feature-title">Automated Optimization</h4>
							<p className="feature-desc">
								Our algorithms continuously rebalance your positions to maximize
								yields while minimizing risks.
							</p>
						</div>
						<div className="card feature">
							<h4 className="feature-title">Transparent Returns</h4>
							<p className="feature-desc">
								Real-time tracking of your investments with detailed analytics
								and performance reporting.
							</p>
						</div>
					</div>
					<div className="tagline">
						Powered by PayPal USD • Secured by Smart Contracts
					</div>
					<p className="disclaimer">
						Always DYOR. Past performance does not guarantee future results.
					</p>
				</section>
			</main>

			{/* Deposit Modal */}
			{showDeposit && selectedStrategy && (
				<div className="modal-overlay" onClick={() => setShowDeposit(false)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<div className="modal-head">
							<h3 className="modal-title">Deposit PYUSD</h3>
							<button
								className="modal-close"
								onClick={() => setShowDeposit(false)}
								aria-label="Close"
							>
								×
							</button>
						</div>
						<div className="modal-body">
							<div className="modal-summary">
								<div className="modal-row">
									<span className="k">Strategy</span>
									<span className="v">{selectedStrategy.name}</span>
								</div>
								<div className="modal-row">
									<span className="k">Network</span>
									<span className="v">{TARGET_CHAIN_NAME}</span>
								</div>
								<div className="modal-row">
									<span className="k">Your PYUSD</span>
									<span className="v">{balance}</span>
								</div>
							</div>
							<label className="field">
								<span className="field-label">Amount (PYUSD)</span>
								<input
									type="number"
									min="0"
									step="0.01"
									placeholder="0.00"
									value={depositAmount}
									onChange={(e) => setDepositAmount(e.target.value)}
									className="input"
								/>
								<div className="field-hint">
									Single‑token zap. We’ll route and add liquidity behind the
									scenes.
								</div>
							</label>

							{/* Routing and Quote */}
							<div className="card route">
								<div className="route-head">
									<span className="route-title">Routing</span>
									<span className="pill">via 0x</span>
								</div>
								<div className="seg">
									<span className="pill">USDC only</span>
								</div>
								<div className="quote-row">
									<span className="k">Mode</span>
									<span className="v">
										<label
											style={{
												display: "flex",
												alignItems: "center",
												gap: "8px",
												cursor: "pointer",
											}}
										>
											<input
												type="checkbox"
												checked={testMode}
												onChange={(e) => setTestMode(e.target.checked)}
												style={{ margin: 0 }}
											/>
											🧪 Test Mode (Skip Swaps)
										</label>
									</span>
								</div>
								{!testMode && (
									<div className="quote-row">
										<span className="k">Auto Swap</span>
										<span className="v">
											{swapAmount.toFixed(2)} PYUSD → USDC
										</span>
									</div>
								)}
								{quoteLoading ? (
									<div className="quote-row">
										<span className="k">Quote</span>
										<span className="v">
											<span className="spinner" /> Fetching…
										</span>
									</div>
								) : quoteError ? (
									<div className="quote-row">
										<span className="k">Route</span>
										<span className="v warning">{quoteError}</span>
									</div>
								) : (
									<>
										<div className="quote-row">
											<span className="k">0x Quote</span>
											<span className="v">{quoteOut || "—"}</span>
										</div>
										<div className="quote-row">
											<span className="k">Estimated Gas</span>
											<span className="v">{quoteGas || "—"}</span>
										</div>
									</>
								)}
								<div className="quote-row small">
									<span className="k">Uniswap Pool</span>
									<span className="v mono">Auto-detected from factory</span>
								</div>
								<div className="quote-row small">
									<span className="k">Position Manager</span>
									<span className="v mono">{UNISWAP_POSITION_MANAGER}</span>
								</div>
								<div className="quote-row small">
									<span className="k">Factory</span>
									<span className="v mono">{UNISWAP_FACTORY}</span>
								</div>
								<p className="review-note">
									Auto-calculates optimal swap (≈50% for 1:1 USD ratio). Uses 0x
									with Uniswap fallback.
								</p>
							</div>
						</div>
						<div className="modal-actions">
							<button
								className="btn btn-secondary"
								onClick={() => setShowDeposit(false)}
							>
								Cancel
							</button>
							{!account ? (
								<button className="btn btn-primary" onClick={connectWallet}>
									Connect Wallet
								</button>
							) : (
								<button
									className="btn btn-primary"
									disabled={
										!depositAmount || Number(depositAmount) <= 0 || txLoading
									}
									onClick={() => {
										handleConfirmDeposit().catch(() => {});
									}}
								>
									{txLoading ? "Processing…" : "Confirm Deposit"}
								</button>
							)}
						</div>
						{txError && (
							<div
								className="alert alert-error"
								role="alert"
								style={{ margin: "0 18px 12px" }}
							>
								{txError}
							</div>
						)}
						{depositAmount && Number(depositAmount) > 0 && (
							<div className="review card">
								<h4 className="review-title">Review Route</h4>
								<div className="review-grid">
									<div className="review-row">
										<span className="k">Strategy APY</span>
										<span className="v">{selectedStrategy.apy}</span>
									</div>
									<div className="review-row">
										<span className="k">Risk</span>
										<span
											className={`v risk-${selectedStrategy.risk.toLowerCase()}`}
										>
											{selectedStrategy.risk}
										</span>
									</div>
									<div className="review-row">
										<span className="k">TVL</span>
										<span className="v">{selectedStrategy.tvl}</span>
									</div>
									<div className="review-row">
										<span className="k">Input</span>
										<span className="v">
											{Number(depositAmount).toFixed(2)} PYUSD
										</span>
									</div>
									<div className="review-row">
										<span className="k">Estimated Routing Fee</span>
										<span className="v">
											{review.fee} PYUSD ({review.routingFeePct})
										</span>
									</div>
									<div className="review-row">
										<span className="k">Estimated Slippage</span>
										<span className="v">{review.slippagePct}</span>
									</div>
									<div className="review-row">
										<span className="k">Min Received Into Position</span>
										<span className="v">
											{review.minAfterSlippage} PYUSD-equivalent
										</span>
									</div>
									<div className="review-row">
										<span className="k">Route</span>
										<span className="v">
											PYUSD → split/swap → add liquidity on {TARGET_CHAIN_NAME}
										</span>
									</div>
								</div>
								<p className="review-note">
									This is a preview for readability. Final route, fees, and
									minimums will be shown in your wallet before confirmation.
								</p>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Footer */}
			<footer className="footer">
				<span>PayYield — Built with ❤️ for the PayPal USD ecosystem</span>
			</footer>
		</div>
	);
}

export default App;
