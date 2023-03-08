const { expect } = require("chai");
const { parseEther, formatEther } = require("ethers/lib/utils");
const { ethers, network } = require("hardhat");

describe("Unit test LendingPool", () => {
  let ReToken, reToken, LendingPool, lendingPool;
  beforeEach(async () => {
    /*     const daiPrice = "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9";
    const wethPrice = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"; */

    /*     const daiAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
    const wethAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; */

    const DaiV3Aggretator = await ethers.getContractFactory("MockV3Aggregator");
    const daiV3Aggretator = await DaiV3Aggretator.deploy(18, 1);
    await daiV3Aggretator.deployed();

    const EthV3Aggretator = await ethers.getContractFactory("MockV3Aggregator");
    const ethV3Aggregator = await EthV3Aggretator.deploy(18, 1600);
    await ethV3Aggregator.deployed();

    const [owner, user1] = await ethers.getSigners();
    WethToken = await ethers.getContractFactory("WETHToken");
    wethToken = await WethToken.deploy();
    await wethToken.deployed();

    DaiToken = await ethers.getContractFactory("Dai");
    daiToken = await DaiToken.deploy();
    await wethToken.deployed();

    const priceFeedAddresses = [
      ethV3Aggregator.address,
      daiV3Aggretator.address,
    ];
    const tokenAddresses = [wethToken.address, daiToken.address];

    LendingPool = await ethers.getContractFactory("LendingPool");
    lendingPool = await LendingPool.deploy(
      priceFeedAddresses,
      tokenAddresses,
      wethToken.address
    );
    await lendingPool.deployed();

    await wethToken.transfer(user1.address, parseEther("10"));
    await daiToken.transfer(lendingPool.address, parseEther("5000"));
  });
  describe("Borrow", () => {
    it("Reverts if the pool doesn't have enough token to borrow", async () => {
      const [owner, user1] = await ethers.getSigners();
      await expect(
        lendingPool.connect(user1).borrow(daiToken.address, parseEther("6000"))
      ).to.be.revertedWith("This pool doesn't have enough token");
    });

    it("Reverts if the user doesn't have enought weth", async () => {
      const [owner, user1] = await ethers.getSigners();
      let balance = await daiToken.balanceOf(owner.address);
      await daiToken.transfer(lendingPool.address, parseEther("100000"));
      await wethToken.approve(lendingPool.address, parseEther("100000"));
      await expect(
        lendingPool.connect(user1).borrow(daiToken.address, parseEther("50000"))
      ).to.be.revertedWith("You don't own enough weth token");
    });
    it("lets people borrow money", async () => {
      const [owner, user1] = await ethers.getSigners();

      await wethToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("4"));
      await lendingPool
        .connect(user1)
        .borrow(daiToken.address, parseEther("3200"));
      let balance = await daiToken.balanceOf(user1.address);
      balance = formatEther(balance.toString());
      await expect(balance).to.equal("3200.0");
      let lenders = await lendingPool.getTokenLender(daiToken.address);
    });
  });
  describe("Withdraw", () => {
    it("let people withdraw their weth", async () => {
      const [owner, user1] = await ethers.getSigners();

      await wethToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("4"));
      await lendingPool
        .connect(user1)
        .borrow(daiToken.address, parseEther("3200"));
      await wethToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("1"));
      await lendingPool
        .connect(user1)
        .borrow(daiToken.address, parseEther("800"));
      await daiToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("3200"));
      await lendingPool
        .connect(user1)
        .withdraw(daiToken.address, 0, parseEther("3200"));
      let balance = await lendingPool.getBorrowedToken(0);
      balance = formatEther(balance.toString());
      await expect(balance).to.equal("0.0");
    });
    it("let people withdraw a part of their weth", async () => {
      const [owner, user1] = await ethers.getSigners();

      await wethToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("4"));
      await lendingPool
        .connect(user1)
        .borrow(daiToken.address, parseEther("3200"));
      await daiToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("3200"));
      await lendingPool
        .connect(user1)
        .withdraw(daiToken.address, 0, parseEther("800"));
      let wbalance = await wethToken.balanceOf(user1.address);
      wbalance = formatEther(wbalance.toString());
      console.log(wbalance);
      let balance = await lendingPool.connect(user1).getBorrowedToken(0);
      balance = formatEther(balance.toString());
      await expect(balance).to.equal("2400.0");
    });
    it("Charges the interests if the user tries to withdraw", async () => {
      const [owner, user1] = await ethers.getSigners();
      const interval = 60 * 60 * 24 * 365;
      await wethToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("4"));
      await lendingPool
        .connect(user1)
        .borrow(daiToken.address, parseEther("3200"));
      await network.provider.send("evm_increaseTime", [interval + 1]);
      await network.provider.request({ method: "evm_mine", params: [] });
      await daiToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("3200"));
      await lendingPool
        .connect(user1)
        .withdraw(daiToken.address, 0, parseEther("3200"));
      let balance = await wethToken.balanceOf(user1.address);
      balance = formatEther(balance.toString());
      console.log(balance);
    });
  });
  describe("Liquadition", () => {
    it("liquidates if your borrowed asset wents down", async () => {
      const [owner, user1] = await ethers.getSigners();

      await wethToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("4"));
      await lendingPool
        .connect(user1)
        .borrow(daiToken.address, parseEther("3200"));
      const Dai2V3Aggretator = await ethers.getContractFactory(
        "MockV3Aggregator"
      );
      const dai2V3Aggregator = await Dai2V3Aggretator.deploy(18, 800);
      await dai2V3Aggregator.deployed();

      await lendingPool.setPriceFeed(
        wethToken.address,
        dai2V3Aggregator.address
      );

      await daiToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("3200"));
      await expect(
        lendingPool
          .connect(user1)
          .withdraw(daiToken.address, 0, parseEther("3200"))
      ).to.be.revertedWith("You already got liquidated");
    });
  });
  describe("Deposit", () => {
    it("Will let someone deposit some token", async () => {
      const interval = 60 * 60 * 24 * 100;
      await daiToken.approve(lendingPool.address, parseEther("2000"));
      await lendingPool.depositing(
        daiToken.address,
        parseEther("2000"),
        interval
      );
      let balance = await lendingPool.getDepositedAssets(daiToken.address);
      balance = formatEther(balance.toString());
      await expect(balance).to.equal("2000.0");
    });
    it("Will let someone withdraw his deposited amount after the locktime passed", async () => {
      const interval = 60 * 60 * 24 * 100;
      await daiToken.approve(lendingPool.address, parseEther("2000"));
      await lendingPool.depositing(
        daiToken.address,
        parseEther("2000"),
        interval
      );
      let balance = await lendingPool.getDepositedAssets(daiToken.address);
      balance = formatEther(balance.toString());
      await expect(balance).to.equal("2000.0");
      await network.provider.send("evm_increaseTime", [interval + 1]);
      await network.provider.request({ method: "evm_mine", params: [] });
      await lendingPool.withdrawDeposits(daiToken.address, parseEther("2000"));
      balance = await lendingPool.getDepositedAssets(daiToken.address);
      balance = formatEther(balance.toString());
      await expect(balance).to.equal("0.0");
    });
    it("Will revert if someone tries to withdraw his token before the unlocktime is done", async () => {
      const interval = 60 * 60 * 24 * 100;
      await daiToken.approve(lendingPool.address, parseEther("2000"));
      await lendingPool.depositing(
        daiToken.address,
        parseEther("2000"),
        interval
      );
      await expect(
        lendingPool.withdrawDeposits(daiToken.address, parseEther("2000"))
      ).to.be.revertedWith("Your token can't be unlocked yet");
    });
    it("Lets you withdraw only a small part", async () => {
      const interval = 60 * 60 * 24 * 100;
      await daiToken.approve(lendingPool.address, parseEther("2000"));
      await lendingPool.depositing(
        daiToken.address,
        parseEther("2000"),
        interval
      );
      let balance = await lendingPool.getDepositedAssets(daiToken.address);
      balance = formatEther(balance.toString());
      await expect(balance).to.equal("2000.0");
      await network.provider.send("evm_increaseTime", [interval + 1]);
      await network.provider.request({ method: "evm_mine", params: [] });
      await lendingPool.withdrawDeposits(daiToken.address, parseEther("200"));
      balance = await lendingPool.getDepositedAssets(daiToken.address);
      balance = formatEther(balance.toString());
      await expect(balance).to.equal("1800.0");
    });
  });
  describe("Claim Rewards", () => {
    it("Will let the user claim rewards", async () => {
      const interval = 60 * 60 * 24 * 100;
      const [owner, user1] = await ethers.getSigners();
      await daiToken.transfer(user1.address, parseEther("5000"));
      await daiToken.approve(lendingPool.address, parseEther("1020000"));
      await lendingPool.depositRewards(daiToken.address, parseEther("2000"));
      await lendingPool.depositing(
        daiToken.address,
        parseEther("100000"),
        60 * 60 * 24 * 365
      );

      await daiToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("5000"));
      await lendingPool
        .connect(user1)
        .depositing(daiToken.address, parseEther("5000"), 60 * 60 * 24 * 100);
      await network.provider.send("evm_increaseTime", [interval + 1]);
      await network.provider.request({ method: "evm_mine", params: [] });
      await lendingPool.connect(user1).claimRewards(daiToken.address);
      let balance = await daiToken.balanceOf(user1.address);

      balance = formatEther(balance.toString());
      console.log(balance);
    });
  });
  describe("interests", () => {
    it("Will take the interests from the borrower", async () => {
      const [owner, user1] = await ethers.getSigners();
      const interval = 60 * 60 * 24 * 30;

      await wethToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("4"));
      await lendingPool
        .connect(user1)
        .borrow(daiToken.address, parseEther("3200"));
      await network.provider.send("evm_increaseTime", [interval + 1]);
      await network.provider.request({ method: "evm_mine", params: [] });
      await lendingPool.performUpkeep("0x");
      let balance = await lendingPool.connect(user1).getColleteralAmount(0);
      balance = formatEther(balance.toString());
      console.log(balance);
    });
    it("Reverts if the time of 30 hasn't past yet", async () => {
      const [owner, user1] = await ethers.getSigners();
      const interval = 60 * 60 * 24 * 30;

      await wethToken
        .connect(user1)
        .approve(lendingPool.address, parseEther("4"));
      await lendingPool
        .connect(user1)
        .borrow(daiToken.address, parseEther("3200"));
      await expect(lendingPool.performUpkeep("0x")).to.be.revertedWith(
        "Its not yet time"
      );
    });
  });
});
