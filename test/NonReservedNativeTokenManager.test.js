/* eslint no-unused-vars: 0 */
const assert = require('assert');
const { promisify } = require('util');

const NonReservedNativeTokenManager = artifacts.require('./NonReservedNativeTokenManager');
require('chai').use(require('chai-as-promised')).should();

const revertError = 'VM Exception while processing transaction: revert';
const toWei = i => web3.utils.toWei(String(i));
const web3SendAsync = promisify(web3.currentProvider.send);
const zeroAddr = `0x${'0'.repeat(40)}`;

async function addDaysOnEVM(days) {
  const seconds = days * 3600 * 24;
  await web3SendAsync({
    jsonrpc: '2.0', method: 'evm_increaseTime', params: [seconds], id: 0,
  });
  await web3SendAsync({
    jsonrpc: '2.0', method: 'evm_mine', params: [], id: 0,
  });
}

async function addMinutesOnEVM(minutes) {
  const seconds = minutes * 60;
  await web3SendAsync({
    jsonrpc: '2.0', method: 'evm_increaseTime', params: [seconds], id: 0,
  });
  await web3SendAsync({
    jsonrpc: '2.0', method: 'evm_mine', params: [], id: 0,
  });
}

contract('NonReservedNativeTokenManager', async (accounts) => {
  let manager;
  let supervisor;

  beforeEach(async () => {
    supervisor = accounts[0];
    manager = await NonReservedNativeTokenManager.new(supervisor);
  });

  it('should deploy correctly', async () => {
    assert.notEqual(manager.address, zeroAddr);
  });

  it('should handle new token bid successfully', async () => {
    await manager.setAuctionParams(5, 5, 7 * 3600 * 24, { from: accounts[5] })
      .should.be.rejectedWith(revertError);
    await manager.setAuctionParams(5, 5, 299, { from: accounts[0] })
      .should.be.rejectedWith(revertError);
    await manager.setAuctionParams(5, 5, 7 * 3600 * 24, { from: accounts[0] });
    await manager.resumeAuction({ from: accounts[0] });

    // ----------------------- ROUND 0 -----------------------
    // One bidder place a bid.
    await manager.bidNewToken(19004000, toWei(5), 0, { from: accounts[1], value: toWei(5) });
    await addDaysOnEVM(6);
    await manager.endAuction().should.be.rejectedWith(revertError);
    await addDaysOnEVM(2);

    // Though end time comes, endAuction() hasn't been triggered.
    // So winner info of this auction hasn't been updated yet.
    let nativeToken = await manager.nativeTokens(19004000);
    assert.equal(nativeToken.owner, zeroAddr);

    // ----------------------- ROUND 1 -----------------------
    // Bidder 2 places a bid, should succeed.
    await manager.bidNewToken(19004002, toWei(20), 1, { from: accounts[2], value: toWei(20) });
    // The bid above triggers the end of last round of auction and
    // a new round of auction starts.
    nativeToken = await manager.nativeTokens(19004000);
    assert.equal(nativeToken.owner, accounts[1]);
    // Bidder 1 places a bid for token 19004000 again, should fail.
    await manager.bidNewToken(19004000, toWei(22), 1, { from: accounts[1], value: toWei(22) })
      .should.be.rejectedWith(revertError);
    // Bidder 1 outbids with different token id.
    await manager.bidNewToken(19004001, toWei(21), 1, { from: accounts[1], value: toWei(21) });

    // Bidder 2 places another bid with lower price, should fail.
    await manager.bidNewToken(19004002, toWei(20), 1, { from: accounts[2], value: toWei(20) })
      .should.be.rejectedWith(revertError);
    // Bidder 2 place another bid with not enough increment, should fail.
    await manager.bidNewToken(19004002, toWei(22), 1, { from: accounts[2], value: toWei(22) })
      .should.be.rejectedWith(revertError);
    // Bidder 2 places a bid for round 0, should fail (Round 0 has ended).
    await manager.bidNewToken(19004002, toWei(23), 0, { from: accounts[2], value: toWei(23) })
      .should.be.rejectedWith(revertError);
    // Bidder 2 places a bid for round 2, should fail (Round 2 hasn't started).
    await manager.bidNewToken(19004002, toWei(23), 2, { from: accounts[2], value: toWei(23) })
      .should.be.rejectedWith(revertError);
    // Bidder 1 tries to withdraw the deposit, should fail.
    await manager.withdraw({ from: accounts[1] }).should.be.rejectedWith(revertError);

    const {
      0: tokenId,
      1: highestBid,
      2: highestBidder,
      3: round,
      4: endTime,
    } = await manager.getAuctionState();
    assert.equal(tokenId, 19004001);
    assert.equal(highestBid, toWei(21));
    assert.equal(highestBidder, accounts[1]);
    assert.equal(round, 1);
    assert(Date.now() < 1000 * endTime.toNumber());

    // Bidder 2 place yet another valid bid with 5 more QKC as deposit, should succeed.
    await manager.bidNewToken(19004002, toWei(25), 1, { from: accounts[2], value: toWei(5) });
    // Bidder 1 tries to withdraw the deposit, should succeed.
    await manager.withdraw({ from: accounts[1] });
    // Try calling endAuction, should fail.
    await manager.endAuction().should.be.rejectedWith(revertError);

    await addDaysOnEVM(7);
    // The auction ends, Bidder 2 wins.
    const balBefore = Number(await web3.eth.getBalance(zeroAddr));
    await manager.endAuction();
    // Check burned QKC for round 1.
    const balNow = Number(await web3.eth.getBalance(zeroAddr));
    assert(balNow >= balBefore + Number(toWei(25)));
    nativeToken = await manager.nativeTokens(19004002);
    assert.equal(nativeToken.owner, accounts[2]);
    // Bidder 2 tries to withdraw the deposit, should fail because the balance is 0.
    await manager.withdraw({ from: accounts[2] }).should.be.rejectedWith(revertError);

    // Anyone can query existed native token info
    const {
      0: createdTime,
      1: owner,
    } = await manager.getNativeTokenInfo(19004002, { from: accounts[8] });
    assert.notEqual(createdTime.toNumber(), 0);
    assert.equal(owner, accounts[2]);

    const {
      0: createdTime1,
      1: owner1,
    } = await manager.getNativeTokenInfo(1900000, { from: accounts[8] });
    assert.equal(createdTime1.toNumber(), 0);
    assert.equal(owner1, zeroAddr);

    // ----------------------- ROUND 2 -----------------------
    // Test for time extension when last-minute bid happens.
    await manager.bidNewToken(19004003, toWei(5), 2, { from: accounts[3], value: toWei(5) });
    await addMinutesOnEVM(10080 - 3); // 60 * 24 * 7 - 3
    await manager.bidNewToken(19004004, toWei(8), 2, { from: accounts[4], value: toWei(8) });
    await addMinutesOnEVM(4);
    await manager.endAuction().should.be.rejectedWith(revertError);
    await addMinutesOnEVM(1);
    await manager.endAuction();
    nativeToken = await manager.nativeTokens(19004003);
    assert.equal(nativeToken.owner, 0);
    nativeToken = await manager.nativeTokens(19004004);
    assert.equal(nativeToken.owner, accounts[4]);
  });

  it('should handle acceleration successfully', async () => {
    await manager.setAuctionParams(5, 5, 7 * 3600 * 24, { from: accounts[0] });
    await manager.resumeAuction({ from: accounts[0] });

    // ----------------------- ROUND 0 -----------------------
    // First time accelerate should fail
    await manager.accelerate(19004000, toWei(5), 0, { from: accounts[0], value: toWei(5) })
      .should.be.rejectedWith(revertError);

    // One bidder place a bid.
    await manager.bidNewToken(19004000, toWei(5), 0, { from: accounts[1], value: toWei(5) });
    await manager.accelerate(19004000, toWei(9), 0, { from: accounts[1], value: toWei(9) })
      .should.be.rejectedWith(revertError);
    await manager.accelerate(19004000, toWei(10), 0, { from: accounts[1], value: toWei(10) })
      .should.be.rejectedWith(revertError);
    await manager.changeAccelerator(accounts[1], { from: accounts[1] })
      .should.be.rejectedWith(revertError);
    await manager.changeAccelerator(accounts[1], { from: accounts[0] });
    await manager.accelerate(19004000, toWei(10), 0, { from: accounts[1], value: toWei(10) });

    await addDaysOnEVM(4);
    await manager.endAuction();

    // ----------------------- ROUND 1 -----------------------
    // First time accelerate should fail
    await manager.accelerate(19004001, toWei(10), 1, { from: accounts[1], value: toWei(10) })
      .should.be.rejectedWith(revertError);

    // Accelerate twice.
    await manager.bidNewToken(19004001, toWei(5), 1, { from: accounts[0], value: toWei(5) });
    await manager.accelerate(19004001, toWei(10), 1, { from: accounts[0], value: toWei(10) })
      .should.be.rejectedWith(revertError);
    await manager.changeAccelerator(zeroAddr, { from: accounts[0] });
    await manager.accelerate(19004001, toWei(10), 1, { from: accounts[0], value: toWei(10) });
    await manager.accelerate(19004001, toWei(19), 1, { from: accounts[1], value: toWei(19) })
      .should.be.rejectedWith(revertError);
    await manager.accelerate(19004001, toWei(20), 1, { from: accounts[1], value: toWei(20) });

    await addDaysOnEVM(1);
    await manager.endAuction().should.be.rejectedWith(revertError);

    await addDaysOnEVM(1);
    await manager.endAuction();

    // ----------------------- ROUND 2 -----------------------
    // Test for time extension when last-minute bid happens.
    await manager.bidNewToken(19004002, toWei(5), 2, { from: accounts[3], value: toWei(5) });
    await addMinutesOnEVM(10080 - 7); // 60 * 24 * 7 - 7
    // Remain 7 mins, accelerate will decrease it to 5 mins instead of 3.5 mins.
    await manager.accelerate(19004002, toWei(10), 2, { from: accounts[4], value: toWei(10) });
    await addMinutesOnEVM(2);
    await manager.endAuction().should.be.rejectedWith(revertError);
    await addMinutesOnEVM(2);
    await manager.endAuction().should.be.rejectedWith(revertError);
    await addMinutesOnEVM(1);
    await manager.endAuction();
  });

  it('should handle pausing auction correctly', async () => {
    // No bid is allowed unless the supervisor has set it up.
    await manager.bidNewToken(19005001, toWei(5), 0, { from: accounts[1], value: toWei(5) })
      .should.be.rejectedWith(revertError);
    await manager.setAuctionParams(5, 5, 7 * 3600 * 24, { from: accounts[0] });
    await manager.resumeAuction({ from: accounts[0] });

    // One bidder place a bid.
    await manager.bidNewToken(19005001, toWei(5), 0, { from: accounts[1], value: toWei(5) });
    await addDaysOnEVM(3);
    // No one except the supervisor has access to pausing the auction.
    await manager.pauseAuction({ from: accounts[5] }).should.be.rejectedWith(revertError);
    await manager.pauseAuction({ from: accounts[0] });
    // Bid cannot be placed when the auction is paused.
    await manager.bidNewToken(19005002, toWei(6), 0, { from: accounts[2], value: toWei(6) })
      .should.be.rejectedWith(revertError);
    // No one except the supervisor has access to resuming the auction.
    await manager.resumeAuction({ from: accounts[5] }).should.be.rejectedWith(revertError);
    await manager.resumeAuction({ from: accounts[0] });
    await manager.bidNewToken(19005002, toWei(6), 0, { from: accounts[2], value: toWei(6) });
    await addDaysOnEVM(5);

    // Round 0 ends.
    await manager.bidNewToken(19005003, toWei(10), 1, { from: accounts[3], value: toWei(10) });
    let nativeToken = await manager.nativeTokens(19005002);
    assert.equal(nativeToken.owner, accounts[2]);

    const {
      2: highestBidder,
      3: round,
    } = await manager.getAuctionState();
    assert.equal(round, 1);
    assert.equal(highestBidder, accounts[3]);

    await manager.pauseAuction({ from: accounts[0] });
    await addDaysOnEVM(7);
    assert(await manager.isPaused());
    await addMinutesOnEVM(10);

    // After Round 1 ends, the auction is resumed.
    await manager.resumeAuction({ from: accounts[0] });
    assert(!(await manager.isPaused()));
    const {
      1: highestBid1,
      2: highestBidder1,
      3: round1,
    } = await manager.getAuctionState();
    assert.equal(round1, 2);
    assert.equal(highestBid1, toWei(0));
    assert.equal(highestBidder1, zeroAddr);

    // A new bid is placed, round 2 starts.
    await manager.bidNewToken(19005003, toWei(5), 2, { from: accounts[4], value: toWei(5) });
    await addDaysOnEVM(8);
    await manager.endAuction();
    nativeToken = await manager.nativeTokens(19005003);
    assert.equal(nativeToken.owner, accounts[4]);

    // Pause at idle time.
    await manager.pauseAuction({ from: accounts[0] });
    await manager.bidNewToken(19005004, toWei(5), 3, { from: accounts[5], value: toWei(5) })
      .should.be.rejectedWith(revertError);
    await manager.resumeAuction({ from: accounts[0] });
    await manager.bidNewToken(19005004, toWei(5), 3, { from: accounts[5], value: toWei(5) });
  });

  it('should support whitelisting reserved token IDs', async () => {
    await manager.setAuctionParams(5, 5, 7 * 3600 * 24, { from: accounts[0] });
    await manager.resumeAuction({ from: accounts[0] });

    const reservedTokenId = 1;
    // Reject since it's reserved.
    await manager.bidNewToken(reservedTokenId, toWei(5), 0, { from: accounts[1], value: toWei(5) })
      .should.be.rejectedWith(revertError);
    // Whitelist.
    await manager.whitelistTokenId(reservedTokenId, true, { from: accounts[0] });
    // Now this token should pass the check.
    await manager.bidNewToken(reservedTokenId, toWei(5), 0, { from: accounts[1], value: toWei(5) });
    // Un-whitelist.
    await manager.whitelistTokenId(reservedTokenId, false, { from: accounts[0] });
    await manager.bidNewToken(reservedTokenId, toWei(6), 0, { from: accounts[1], value: toWei(10) })
      .should.be.rejectedWith(revertError);
  });

  it('should reject bid with price less than minimum required', async () => {
    await manager.setAuctionParams(100, 5, 7 * 3600 * 24, { from: accounts[0] });
    await manager.resumeAuction({ from: accounts[0] });
    await web3.eth.sendTransaction({ from: accounts[6], to: accounts[1], value: toWei(99) });

    // Note 99 ether in uint64 would overflow. This test is to guard against that.
    await manager.bidNewToken(19004089, toWei(99), 0, { from: accounts[1], value: toWei(99) })
      .should.be.rejectedWith(revertError);
  });
});
