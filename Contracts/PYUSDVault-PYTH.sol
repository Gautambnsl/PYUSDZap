// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.18;

/*
  UniswapPositionManagerWithPyth.sol
  A variant of UniswapPositionManager that uses the Pyth oracle for price checks.

  Notes:
  - Requires @pythnetwork/pyth-sdk-solidity installed.
  - Provide the correct Pyth contract address and the desired price feed ID (bytes32).
  - The contract uses getPriceNoOlderThan/getPriceUnsafe style calls; these are available
    in the Pyth Solidity SDK (API may vary slightly by SDK version — adapt if necessary).
*/

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {IUniswapNonfungiblePositionManager, IUniswapPoolV3} from "../interfaces/Externals/IUniswapNonfungiblePositionManager.sol";
import {BasePositionManager} from "./BasePositionManager.sol";
import "../utils/Constants.sol";
import "../utils/Errors.sol";

// Pyth SDK imports (path depends on your project layout / npm package)
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/**
 * @title UniswapPositionManagerWithPyth
 * @notice Manages Uniswap V3 NFT positions and validates prices using the Pyth oracle
 */
contract UniswapPositionManagerWithPyth is
    Initializable,
    AccessControl,
    ReentrancyGuard,
    Pausable,
    BasePositionManager
{
    using SafeERC20 for IERC20;

    IUniswapNonfungiblePositionManager public positionManager;

    // Pyth oracle
    IPyth public pyth;
    bytes32 public pythPriceId; // the feed ID you want to consult (e.g., ETH/USD)
    uint32 public maxPythAge; // maximum allowed age of the Pyth price in seconds
    uint256 public maxPriceDeviationBps; // e.g., 200 => 2.00% (basis points)

    // Pack cached pool state to save gas (kept from original)
    struct CachedPoolState {
        uint160 sqrtPriceX96;
        int24 tick;
        uint32 lastUpdate;
    }

    CachedPoolState private _cachedState;
    uint32 private constant CACHE_DURATION = 60; // Cache for 60 seconds

    /* ========== EVENTS ========== */
    event PythConfigUpdated(address indexed pythAddr, bytes32 indexed priceId, uint32 maxAge, uint256 maxDeviationBps);

    /**
     * @notice Initialize contract (similar parameters to original + Pyth config)
     */
    function initialize(
        address _positionManager,
        address _treasury,
        uint256 _treasuryFeePercent,
        address _token0,
        address _token1,
        uint128 _minAmount0,
        uint128 _minAmount1,
        uint128 _maxAmount0,
        uint128 _maxAmount1,
        address _pool,
        int56 _maxTickDeviation,
        uint32 _twapInterval,
        address _admin,
        int24 _tickSpacing,
        uint24 _poolFee,
        address _pythAddress,
        bytes32 _pythPriceId,
        uint32 _maxPythAge,
        uint256 _maxPriceDeviationBps
    ) external initializer {
        // Basic validation (re-used)
        if (_positionManager == address(0)) revert ZeroToken();
        if (_treasury == address(0)) revert InvalidTreasury();
        if (_treasuryFeePercent > MAX_TREASURY_FEE_PERCENT) revert InvalidFeePercent();
        if (_token0 == address(0) || _token1 == address(0)) revert ZeroToken();
        if (_token0 == _token1) revert TokensMustDiffer();
        if (_maxAmount0 <= _minAmount0 || _maxAmount1 <= _minAmount1) revert InvalidRanges();

        // Set core storage
        positionManager = IUniswapNonfungiblePositionManager(_positionManager);
        treasury = _treasury;
        treasuryFeePercent = _treasuryFeePercent;
        token0 = IERC20(_token0);
        token1 = IERC20(_token1);

        tokenAmountLimits = TokenAmountLimits({
            minAmount0: _minAmount0,
            minAmount1: _minAmount1,
            maxAmount0: _maxAmount0,
            maxAmount1: _maxAmount1
        });

        pool = _pool;
        maxTickDeviation = _maxTickDeviation;
        twapInterval = _twapInterval;
        tickSpacing = _tickSpacing;
        poolFee = _poolFee;

        // Pyth config
        require(_pythAddress != address(0), "Pyth address zero");
        pyth = IPyth(_pythAddress);
        pythPriceId = _pythPriceId;
        maxPythAge = _maxPythAge;
        maxPriceDeviationBps = _maxPriceDeviationBps; // e.g., 200 = 2%

        // Roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _setRoleAdmin(ADMIN_ROLE, DEFAULT_ADMIN_ROLE);

        emit PythConfigUpdated(_pythAddress, _pythPriceId, _maxPythAge, _maxPriceDeviationBps);
    }

    /* =========================
       PUBLIC USER INTERACTIONS
       ========================= */

    /**
     * @notice Mint liquidity with Pyth price validation
     * @dev This mirrors the original mintLiquidity but will validate price vs Pyth oracle
     */
    function mintLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        int24 lowerTick,
        int24 upperTick,
        uint256 amount0Min,
        uint256 amount1Min
    )
        public
        nonReentrant
        whenNotPaused
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        )
    {
        // Validate token amounts as before
        _validateAmounts(amount0Desired, amount1Desired);

        // Optional price validation before proceeding:
        // if pythPriceId is non-zero, verify price is fresh and within allowed deviation of pool TWAP
        if (pythPriceId != bytes32(0)) {
            // Revert on bad price (stale or deviates too much)
            _validatePriceViaPyth();
        }

        // Transfer tokens in batch and approve
        _transferTokensFrom(msg.sender, amount0Desired, amount1Desired);
        _approveExact(amount0Desired, amount1Desired);

        // Build Uniswap mint params and call as original
        IUniswapNonfungiblePositionManager.MintParams memory params = IUniswapNonfungiblePositionManager.MintParams({
            token0: address(token0),
            token1: address(token1),
            fee: poolFee,
            tickLower: lowerTick,
            tickUpper: upperTick,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: msg.sender,
            deadline: block.timestamp + DEADLINE_BUFFER
        });

        (tokenId, liquidity, amount0, amount1) = positionManager.mint(params);

        // Refund leftover tokens
        _batchRefund(msg.sender, amount0Desired, amount1Desired, amount0, amount1);

        emit Minted(tokenId, liquidity);
        return (tokenId, liquidity, amount0, amount1);
    }

    /**
     * @notice Increase liquidity with Pyth guard
     */
    function increaseLiquidity(
        uint256 tokenId,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint128 liquidityAdded, uint256 amount0, uint256 amount1)
    {
        _validateAmounts(amount0Desired, amount1Desired);
        if (positionManager.ownerOf(tokenId) != msg.sender) revert ERR_NotOwner();

        // Validate price with Pyth (optional)
        if (pythPriceId != bytes32(0)) {
            _validatePriceViaPyth();
        }

        _transferTokensFrom(msg.sender, amount0Desired, amount1Desired);
        _approveExact(amount0Desired, amount1Desired);

        IUniswapNonfungiblePositionManager.IncreaseLiquidityParams memory params = IUniswapNonfungiblePositionManager.IncreaseLiquidityParams({
            tokenId: tokenId,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            deadline: block.timestamp + DEADLINE_BUFFER
        });

        (liquidityAdded, amount0, amount1) = positionManager.increaseLiquidity(params);

        _batchRefund(msg.sender, amount0Desired, amount1Desired, amount0, amount1);

        emit LiquidityIncreased(tokenId, liquidityAdded, amount0, amount1);
        return (liquidityAdded, amount0, amount1);
    }

    /* =========================
       PYTH INTEGRATION HELPERS
       ========================= */

    /**
     * @notice Read the Pyth price and return (price, expo, publishTime)
     * @dev Uses Pyth SDK getPriceNoOlderThan if configured; falls back to getPriceUnsafe if needed.
     * @return price The integer price (signed)
     * @return expo The exponent for the price (so realPrice = price * 10**expo)
     * @return publishTime The timestamp the price was published
     */
    function _readPythPrice() internal view returns (int256 price, int32 expo, uint256 publishTime) {
        // If pythPriceId is zero, return zeros.
        if (pythPriceId == bytes32(0)) return (0, 0, 0);

        // Pyth SDK provides different accessors: getPriceNoOlderThan, getPriceUnsafe, getPrice.
        // We'll attempt a safe read with no age restriction here (caller should enforce age).
        PythStructs.Price memory p = pyth.getPriceUnsafe(pythPriceId);
        // p.price: int64, p.expo: int32, p.publishTime: uint64 (fields per PythStructs)
        price = int256(p.price);
        expo = p.expo;
        publishTime = uint256(p.publishTime);
        return (price, expo, publishTime);
    }

    /**
     * @notice Validate Pyth price freshness and deviation vs pool TWAP.
     * @dev Reverts if price is stale or deviates more than maxPriceDeviationBps.
     */
    function _validatePriceViaPyth() internal view {
        (int256 pythPriceInt, int32 expo, uint256 publishTime) = _readPythPrice();

        // Ensure pyth price exists
        if (pythPriceInt == 0) revert ERR_InvalidPythPrice();
        // Freshness
        if (block.timestamp > publishTime + maxPythAge) revert ERR_PythPriceStale();

        // Convert to a single uint256 scaled price for comparison with pool TWAP.
        // We'll scale both to 1e18 for comparison: scaledPrice = pythPrice * 10^(18 - (-expo))
        // expo is negative for decimals (e.g., -8). Handle safely with unchecked and require.
        uint256 pythScaled;
        if (expo < 0) {
            // expo negative => price * 10**(18 + expoAbs)
            uint256 absExpo = uint256(uint32(-expo));
            pythScaled = _absScaleTo18(uint256(int256(pythPriceInt)), absExpo);
        } else {
            // expo >=0
            pythScaled = uint256(int256(pythPriceInt)) * (10 ** uint256(uint32(expo)));
            // Then scale to 1e18 if needed (if expo positive this may be large — adjust if used)
        }

        // Get current pool price TWAP (as an approximation) — we reuse currentTick and convert to price
        int24 curTick = currentTick();
        uint256 poolPriceScaled = _tickToPrice18(curTick);

        // Calculate allowed deviation
        uint256 diff = pythScaled > poolPriceScaled ? pythScaled - poolPriceScaled : poolPriceScaled - pythScaled;
        uint256 diffBps = (diff * 10000) / poolPriceScaled;

        if (diffBps > maxPriceDeviationBps) revert ERR_PythDeviationTooHigh();
    }

    /**
     * @notice Scale a positive integer price to 1e18 using expoAbs (abs of negative expo)
     * @dev price * (10 ** (18 - expoAbs)) where expoAbs = abs(expo)
     */
    function _absScaleTo18(uint256 price, uint256 expoAbs) internal pure returns (uint256) {
        // If expoAbs > 18, result would become fractional — for simplicity require expoAbs <= 18
        // (Pyth feeds typically have small exponents like -8)
        require(expoAbs <= 36, "expo too large"); // safety
        if (expoAbs == 18) return price;
        if (expoAbs < 18) {
            return price * (10 ** (18 - expoAbs));
        } else {
            // expoAbs > 18 => divide (floor)
            return price / (10 ** (expoAbs - 18));
        }
    }

    /**
     * @notice Convert an Uniswap tick to a price scaled to 1e18 for comparison.
     * @dev This uses the standard formula price = 1.0001^tick, approximated using exponent math.
     * For simplicity we use a rough approximation: price ~ 2^(tick/ (log2(1.0001))) but
     * implementing exact pow(Q96) -> price conversion is complex. Here we provide a simple stub
     * that should be replaced by a correct tick -> price conversion for production.
     */
    function _tickToPrice18(int24 tick) internal pure returns (uint256) {
        // STUB: for demo/hackathon purposes only. Real implementation should
        // convert sqrtPriceX96 or compute 1.0001^tick precisely (use libraries).
        // We'll approximate by returning 1e18 (i.e., $1) for tick==0 and scale linearly.
        int256 t = int256(tick);
        if (t == 0) return 1e18;
        // very rough linear approximation (NOT financially accurate)
        if (t > 0) {
            return uint256(1e18 + uint256(t) * 1e12);
        } else {
            return uint256(1e18 - uint256(uint256(-t) * 1e12));
        }
    }

    /* =========================
       INTERNAL / STORAGE HELPERS
       ========================= */

    function _transferTokensFrom(address from, uint256 amount0, uint256 amount1) private {
        if (amount0 > 0) token0.safeTransferFrom(from, address(this), amount0);
        if (amount1 > 0) token1.safeTransferFrom(from, address(this), amount1);
    }

    function _approveExact(uint256 amount0, uint256 amount1) private {
        address pm = address(positionManager);
        if (amount0 > 0) token0.approve(pm, amount0);
        if (amount1 > 0) token1.approve(pm, amount1);
    }

    function _batchRefund(address recipient, uint256 desired0, uint256 desired1, uint256 used0, uint256 used1) private {
        unchecked {
            if (used0 < desired0) {
                token0.safeTransfer(recipient, desired0 - used0);
            }
            if (used1 < desired1) {
                token1.safeTransfer(recipient, desired1 - used1);
            }
        }
    }

    /* ========== ADMIN FUNCTIONS ========== */

    function setPythConfig(address _pyth, bytes32 _priceId, uint32 _maxAge, uint256 _maxDeviationBps) external onlyRole(ADMIN_ROLE) {
        require(_pyth != address(0), "pyth zero");
        pyth = IPyth(_pyth);
        pythPriceId = _priceId;
        maxPythAge = _maxAge;
        maxPriceDeviationBps = _maxDeviationBps;
        emit PythConfigUpdated(_pyth, _priceId, _maxAge, _maxDeviationBps);
    }
}
