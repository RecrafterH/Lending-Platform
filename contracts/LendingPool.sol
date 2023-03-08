// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "@chainlink/contracts/src/v0.8/AutomationCompatible.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/interfaces/IERC20.sol";
import "hardhat/console.sol";

contract LendingPool is Ownable, AutomationCompatibleInterface {
    address internal wethAddress;
    IERC20 internal WETH;

    // Automation variables
    uint public interval = 30 days;
    uint public timestamp;

    struct Deposit {
        uint amount;
        uint unlockDate;
    }

    struct Lended {
        uint amount;
        uint interestDate;
    }

    mapping(address => uint) public userLendingId;
    //holder => id => amount
    mapping(address => mapping(uint => uint)) public collateral;
    mapping(address => mapping(uint => Lended)) public lended;
    mapping(address => mapping(uint => address)) public borrowedAsset;
    // depositer => tokenAddress => Deposit
    mapping(address => mapping(address => Deposit)) public depositedAssets;
    // tokenAddress => amount
    mapping(address => uint) public interestRewards;
    // tokenAddress => totalAssetDeposits
    mapping(address => uint) public totalAssetDeposits;
    // DepositerAddress => tokenAddress => latestClaimTimestamp
    mapping(address => mapping(address => uint)) public latestClaim;
    // tokenAddress => array of all lender of this token
    mapping(address => address[]) public tokenLender;
    // tokenAddress => bool
    mapping(address => bool) public tokenAllowed;

    // token address => priceFeed address
    mapping(address => address) public prices;

    address[] public lendingToken;

    constructor(
        address[] memory priceFeedAddresses,
        address[] memory tokenAddresses,
        address _wethAddress
    ) {
        wethAddress = _wethAddress;
        WETH = IERC20(wethAddress);
        require(priceFeedAddresses.length == tokenAddresses.length);
        for (uint i = 0; i < priceFeedAddresses.length; i++) {
            prices[tokenAddresses[i]] = priceFeedAddresses[i];
        }
        timestamp = block.timestamp;
        lendingToken = tokenAddresses;
    }

    function setPriceList(
        address priceFeedAddress,
        address tokenAddress
    ) internal {
        prices[tokenAddress] = priceFeedAddress;
        if (checkTokenAddress(tokenAddress) == true) {
            lendingToken.push(tokenAddress);
        }
    }

    function setPriceFeed(
        address tokenAddress,
        address aggregatorAddress
    ) public onlyOwner {
        prices[tokenAddress] = aggregatorAddress;
    }

    function borrow(address tokenAddress, uint amount) public {
        int256 tokenPrice = getLatestPrice(prices[tokenAddress]);
        int256 wethPrice = getLatestPrice(prices[wethAddress]);
        IERC20 token = IERC20(tokenAddress);
        require(
            token.balanceOf(address(this)) >= amount,
            "This pool doesn't have enough token"
        );

        uint collateralAmount = (uint(tokenPrice) * amount * 2) /
            uint(wethPrice);
        require(
            WETH.balanceOf(msg.sender) >= collateralAmount,
            "You don't own enough weth token"
        );
        tokenLender[tokenAddress].push(msg.sender);
        bool success = WETH.transferFrom(
            msg.sender,
            address(this),
            collateralAmount
        );
        require(success, "TransferFrom failed");
        success = token.transfer(msg.sender, amount);
        require(success, "Transfer failed");
        uint id = userLendingId[msg.sender];
        lended[msg.sender][id].amount += uint(amount);
        lended[msg.sender][id].interestDate = block.timestamp;
        collateral[msg.sender][id] += collateralAmount;
        borrowedAsset[msg.sender][id] = tokenAddress;
        userLendingId[msg.sender] += 1;
    }

    function withdraw(
        address tokenAddress,
        uint id,
        uint _lendedAmount
    ) public {
        require(
            liquidation(msg.sender, id) == false,
            "You already got liquidated"
        );
        IERC20 token = IERC20(tokenAddress);
        /*         require(lended[msg.sender] >= amount / 2, "Not enough token lended");
        require(
            collateral[msg.sender] >= amount,
            "Not enough token as collateral"
        ); */
        chargeInterests(tokenAddress, msg.sender);
        uint lendedAmount = lended[msg.sender][id].amount;
        require(
            lendedAmount >= _lendedAmount,
            "You don't have that much token lended"
        );
        uint percentage = (100 * _lendedAmount) / lendedAmount;

        token.approve(address(this), lendedAmount);
        bool success = token.transferFrom(
            msg.sender,
            address(this),
            _lendedAmount
        );
        require(success, "TransferFrom failed");
        uint amount = (collateral[msg.sender][id] * percentage) / 100;
        require(collateral[msg.sender][id] >= amount, "Not enough collateral");
        success = WETH.transfer(msg.sender, amount);
        require(success, "Transfer failed");
        lended[msg.sender][id].amount -= _lendedAmount;
        collateral[msg.sender][id] -= amount;
    }

    function depositing(address tokenAddress, uint amount, uint time) public {
        require(time >= (60 * 60 * 24 * 30), "Minimum lockup time is 30 days");
        IERC20 token = IERC20(tokenAddress);
        bool success = token.transferFrom(msg.sender, address(this), amount);
        require(success, "Transferfrom failed");
        uint unlockDate = block.timestamp + time;
        depositedAssets[msg.sender][tokenAddress] = Deposit(amount, unlockDate);
        totalAssetDeposits[tokenAddress] += amount;
        latestClaim[msg.sender][tokenAddress] = block.timestamp;
    }

    function withdrawDeposits(address tokenAddress, uint amount) public {
        require(
            block.timestamp >=
                depositedAssets[msg.sender][tokenAddress].unlockDate,
            "Your token can't be unlocked yet"
        );
        IERC20 token = IERC20(tokenAddress);
        depositedAssets[msg.sender][tokenAddress].amount -= amount;
        bool success = token.transfer(msg.sender, amount);
        require(success, "Transfer failed");
    }

    function checkUpkeep(
        bytes memory /* checkData */
    )
        public
        view
        override
        returns (bool upkeepNeeded, bytes memory /* performData */)
    {
        upkeepNeeded = (block.timestamp - timestamp) > interval;
        return (upkeepNeeded, "0x0"); // can we comment this out?
    }

    function performUpkeep(bytes calldata /* performData */) external override {
        //We highly recommend revalidating the upkeep in the performUpkeep function
        (bool success, ) = checkUpkeep("");
        require(success, "Its not yet time");
        for (uint i = 0; i < lendingToken.length; i++) {
            address tokenAddress = lendingToken[i];
            address[] storage lenderArray = tokenLender[tokenAddress];
            for (uint j = 0; j < lenderArray.length; j++) {
                address lenderAddress = lenderArray[j];
                chargeInterests(tokenAddress, lenderAddress);
            }
        }

        // We don't use the performData in this example. The performData is generated by the Automation Node's call to your checkUpkeep function
    }

    function checkTokenAddress(
        address tokenAddress
    ) public view returns (bool) {
        for (uint i = 0; i < lendingToken.length; i++) {
            if (tokenAddress == lendingToken[i]) {
                return false;
            }
        }
        return true;
    }

    function chargeInterests(
        address tokenAddress,
        address lenderAddress
    ) public {
        uint id = userLendingId[lenderAddress];
        for (uint i = 0; i < id; i++) {
            uint time = block.timestamp - lended[lenderAddress][i].interestDate;
            uint amount = lended[lenderAddress][i].amount;
            uint apy = 25;
            uint interests = (apy * time * amount) / (365 * 24 * 60 * 60) / 100;
            int256 tokenPrice = getLatestPrice(prices[tokenAddress]);
            int256 wethPrice = getLatestPrice(prices[wethAddress]);
            uint collateralAmount = (uint(tokenPrice) * interests * 2) /
                uint(wethPrice);
            collateral[lenderAddress][i] -= collateralAmount;
            lended[lenderAddress][i].interestDate = block.timestamp;
        }
    }

    ////////////////////////
    /// Getter Functions ///
    ////////////////////////

    function getLatestPrice(
        address priceFeedAddress
    ) public view returns (int) {
        AggregatorV3Interface priceFeed = AggregatorV3Interface(
            priceFeedAddress
        );
        (, int price, , , ) = priceFeed.latestRoundData();
        return price;
    }

    function liquidation(address lender, uint id) public returns (bool) {
        address tokenAddress = borrowedAsset[lender][id];
        uint wethPrice = uint(getLatestPrice(prices[wethAddress]));
        uint wethTotal = wethPrice * (collateral[lender][id]);
        uint tokenPrice = uint(getLatestPrice(prices[tokenAddress]));
        uint tokenTotal = tokenPrice * (lended[lender][id].amount);

        if (wethTotal <= tokenTotal) {
            lended[msg.sender][id].amount = 0;
            collateral[msg.sender][id] = 0;

            return true;
        }

        return false;
    }

    function claimRewards(address tokenAddress) public {
        IERC20 token = IERC20(tokenAddress);
        uint apy = (100 * interestRewards[tokenAddress]) /
            totalAssetDeposits[tokenAddress];
        uint timeStaked = block.timestamp -
            latestClaim[msg.sender][tokenAddress];
        uint amount = depositedAssets[msg.sender][tokenAddress].amount;
        latestClaim[msg.sender][tokenAddress] = block.timestamp;
        uint rewards = (apy * timeStaked * amount) / (365 * 24 * 60 * 60) / 100;
        bool success = token.transfer(msg.sender, rewards);
        require(success);
    }

    function getBorrowedToken(uint id) public view returns (uint) {
        return lended[msg.sender][id].amount;
    }

    function getColleteralAmount(uint id) public view returns (uint) {
        return collateral[msg.sender][id];
    }

    function getApy(address tokenAddress) public view returns (uint) {
        uint apy = (100 * interestRewards[tokenAddress]) /
            totalAssetDeposits[tokenAddress];
        return apy;
    }

    function depositRewards(address tokenAddress, uint amount) public {
        IERC20 token = IERC20(tokenAddress);
        bool success = token.transferFrom(msg.sender, address(this), amount);
        require(success, "TransferFrom failed");
        interestRewards[tokenAddress] += amount;
    }

    function getTokenLender(
        address tokenAddress
    ) public view returns (address[] memory) {
        address[] memory lenders = tokenLender[tokenAddress];
        return lenders;
    }

    function getDepositedAssets(
        address tokenAddress
    ) public view returns (uint) {
        return depositedAssets[msg.sender][tokenAddress].amount;
    }
}
