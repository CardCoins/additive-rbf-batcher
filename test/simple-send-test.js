/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint max-len: "off" */

'use strict';

const Services = require('./util/services');
const assert = require('assert');
const fs = require('fs');

describe('Simple Sends', function () {
  this.timeout(10000);

  const services = new Services({
    network: 'regtest',
    username: 'simple-test',
    password: 'password-test',
    wallet: 'app',
    port: 18443,
    confTarget: 3,
    estimateMode: 'CONSERVATIVE',
    maxFeeRate: 0.00050000,
    maxFeeConfTarget: 3,
    dataDir: Services.tmpdir()
  });

  before(async () => {
    await services.init();
    await services.startBitcoin();
  });

  after(async () => {
    await services.stopBitcoin();
  });

  it('should generate coins and fund walet', async () => {
    await services.miner.generate(200);

    const appAddrs = [];
    for (let i = 0; i < 10; i++) {
      const addr = await services.app.getNewAddress();
      appAddrs.push(addr);
    }
    const txid = await services.miner.sendMany({
      [appAddrs[0]]: 10,
      [appAddrs[1]]: 10,
      [appAddrs[2]]: 10,
      [appAddrs[3]]: 10,
      [appAddrs[4]]: 10,
      [appAddrs[5]]: 10,
      [appAddrs[6]]: 10,
      [appAddrs[7]]: 10,
      [appAddrs[8]]: 10,
      [appAddrs[9]]: 10
    });

    await services.miner.waitForRPC('gettransaction', [txid]);

    services.unconf('app', 10 * 10);
    await services.check('app');
    await services.miner.generate(1);

    services.conf('app', 10 * 10);
    await services.check('app');
  });

  it('Alice requests a payout, it\'s sent and confirmed', async () => {
    // Send order
    const addr = await services.alice.getNewAddress();
    const res = await services.sendOrder(addr, 1.01010101);
    services.unconf('alice', 1.01010101);

    // Wait for broadcast and check
    await services.alice.waitForRPC('gettransaction', [res.transaction_id]);
    await services.check('alice');

    // confirm and double-check
    await services.miner.generate(1);
    services.conf('alice', 1.01010101);
    await services.check('alice');
  });

  it('Bob requests a payout, it\'s sent and confirmed', async () => {
    // Send order
    const addr = await services.bob.getNewAddress();
    const res = await services.sendOrder(addr, 2.02020202);
    services.unconf('bob', 2.02020202);

    // Wait for broadcast and check
    await services.bob.waitForRPC('gettransaction', [res.transaction_id]);
    await services.check('bob');

    // confirm and double-check
    await services.miner.generate(1);
    services.conf('bob', 2.02020202);
    await services.check('bob');
  });

  it('Alice requests a payout but it is abandoned (dropped from mempool)', async () => {
    // Send first order
    const aliceAddr = await services.alice.getNewAddress();
    const res1 = await services.sendOrder(aliceAddr, 3.03030303);
    services.unconf('alice', 3.03030303);

    // Wait for broadcast and check
    await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);
    await services.check('alice');

    // Abandon Alice's TX by restarting the node with high minRelay fee
    // shut down
    await services.stopBitcoin();
    // restart with such high minRelay that mempool is cleared
    await services.startBitcoin(['-minrelaytxfee=0.1']);
    // abandon tx from sender AND recipient (because it's all the same test node)
    await services.alice.abandonTransaction(res1.transaction_id);
    await services.app.abandonTransaction(res1.transaction_id);
    // shut down again
    await services.stopBitcoin();
    // restart with default settings
    await services.startBitcoin();

    // Bob orders
    const bobAddr = await services.bob.getNewAddress();
    const res2 = await services.sendOrder(bobAddr, 4.04040404);
    services.unconf('bob', 4.04040404);

    // Wait for broadcast and check
    await services.bob.waitForRPC('gettransaction', [res2.transaction_id]);
    await services.check('bob');
    await services.check('alice');

    // confirm and double-check
    await services.miner.generate(1);
    services.conf('alice', 3.03030303);
    services.conf('bob', 4.04040404);
    await services.check('alice');
    await services.check('bob');
  });

  it('Alice requests 4 payouts all to different addresses', async () => {
    // Alice makes several orders to different addresses
    await new Promise(r => setTimeout(r, 1000));
    const addr1 = await services.alice.getNewAddress();
    const res1 = await services.sendOrder(addr1, 0.01010101);
    services.unconf('alice', 0.01010101);

    await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);
    await services.check('alice');

    const addr2 = await services.alice.getNewAddress();
    const res2 = await services.sendOrder(addr2, 0.01010101);
    services.unconf('alice', 0.01010101);

    await services.alice.waitForRPC('gettransaction', [res2.transaction_id]);
    await services.check('alice');

    const addr3 = await services.alice.getNewAddress();
    const res3 = await services.sendOrder(addr3, 0.01010101);
    services.unconf('alice', 0.01010101);

    await services.alice.waitForRPC('gettransaction', [res3.transaction_id]);
    await services.check('alice');

    const addr4 = await services.alice.getNewAddress();
    const res4 = await services.sendOrder(addr4, 0.01010101);
    services.unconf('alice', 0.01010101);

    await services.alice.waitForRPC('gettransaction', [res4.transaction_id]);
    await services.check('alice');

    // Ensure this transaction has 5 distinct outputs (Alice's batch + change)
    const tx = await services.alice.getTransaction(res4.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 5);

    // confirm and double-check
    await services.miner.generate(1);
    services.conf('alice', 4 * 0.01010101);
    await services.check('alice');
  });

  it('Alice requests 4 payouts all to the SAME addresses', async () => {
    const addr = await services.alice.getNewAddress();
    const res1 = await services.sendOrder(addr, 0.02020202);
    services.unconf('alice', 0.02020202);

    await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);
    await services.check('alice');

    const res2 = await services.sendOrder(addr, 0.02020202);
    services.unconf('alice', 0.02020202);

    await services.alice.waitForRPC('gettransaction', [res2.transaction_id]);
    await services.check('alice');

    const res3 = await services.sendOrder(addr, 0.02020202);
    services.unconf('alice', 0.02020202);

    await services.alice.waitForRPC('gettransaction', [res3.transaction_id]);
    await services.check('alice');

    const res4 = await services.sendOrder(addr, 0.02020202);
    services.unconf('alice', 0.02020202);

    await services.alice.waitForRPC('gettransaction', [res4.transaction_id]);
    await services.check('alice');

    // Ensure this transaction has 5 distinct outputs (Alice's batch + change)
    const tx = await services.alice.getTransaction(res4.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 5);

    // confirm and double-check
    await services.miner.generate(1);
    services.conf('alice', 4 * 0.02020202);
    await services.check('alice');
  });

  it('6 blocks go by before Alice requests another payout', async () => {
    // Generate a few more blocks to ensure that the outputs file gets cleared
    await services.miner.generate(6);

    // Send new order
    const addr = await services.alice.getNewAddress();
    const res = await services.sendOrder(addr, 0.83838384);
    services.unconf('alice', 0.83838384);

    await services.alice.waitForRPC('gettransaction', [res.transaction_id]);
    await services.check('alice');

    // confirm and double-check
    await services.miner.generate(1);
    services.conf('alice', 0.83838384);

    // regtest_outputs.json file should only have this one new order
    const outputs = JSON.parse(fs.readFileSync(services.replacer.payoutsFile));
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0].txids[0], res.transaction_id);
  });

  it('Bob requests a payout, but before it is confirmed the system reboots', async () => {
    // Bob places first order
    const addr1 = await services.bob.getNewAddress();
    const res1 = await services.sendOrder(addr1, 0.90909090);
    services.unconf('bob', 0.90909090);

    await services.bob.waitForRPC('gettransaction', [res1.transaction_id]);
    await services.check('bob');

    // oh no! server failure!
    await services.stopBitcoin();

    // Clear state in memory and restart,
    // we should load the regtest_outputs.json file
    await services.init();
    await services.startBitcoin();

    // Bob places second order, should RBF batch with first
    const addr2 = await services.bob.getNewAddress();
    const res2 = await services.sendOrder(addr2, 0.03030304);
    services.unconf('bob', 0.03030304);

    await services.bob.waitForRPC('gettransaction', [res2.transaction_id]);
    await services.check('bob');

    // confirm and double-check
    await services.miner.generate(1);
    services.conf('bob', 0.90909090 + 0.03030304);
    await services.check('bob');
  });

  it('Alice and Bob request payouts but the replaced transaction gets confirmed first', async () => {
    // Alice places first order
    const aliceAddr1 = await services.alice.getNewAddress();
    const res1 = await services.sendOrder(aliceAddr1, 0.12345678);
    services.unconf('alice', 0.12345678);

    await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);
    await services.check('alice');
    await services.check('bob');

    // Bob places second order, should RBF batch with first
    const bobAddr1 = await services.bob.getNewAddress();
    const res2 = await services.sendOrder(bobAddr1, 0.87654321);
    services.unconf('bob', 0.87654321);

    await services.bob.waitForRPC('gettransaction', [res2.transaction_id]);
    await services.check('alice');
    await services.check('bob');

    // Get Alice's first transaction
    const tx1 = await services.alice.getTransaction(res1.transaction_id);

    // Completely clear mempool by restarting the node with high minRelay fee
    // shut down
    await services.stopBitcoin();
    // restart with such high minRelay that mempool is cleared
    await services.startBitcoin(['-minrelaytxfee=0.1']);

    // abandon tx from sender AND all recipients (because it's all the same test node)
    // this prevents the wallets from re-sending TXs on boot and ruining the test
    await services.alice.abandonTransaction(res1.transaction_id);
    await services.app.abandonTransaction(res1.transaction_id);

    await services.alice.abandonTransaction(res2.transaction_id);
    await services.bob.abandonTransaction(res2.transaction_id);
    await services.app.abandonTransaction(res2.transaction_id);

    // shut down again
    await services.stopBitcoin();
    // restart with default settings
    await services.startBitcoin();

    // Re-broadcast the original (replaced) tansaction
    await services.alice.sendRawTransaction(tx1.hex);

    // confirm (should confirm Alice's first transaction only)
    await services.miner.generate(1);
    services.conf('alice', 0.12345678);
    await services.check('alice');

    // Alice places a third order, should batch with Bob's abandoned payout
    const aliceAddr2 = await services.alice.getNewAddress();
    const res3 = await services.sendOrder(aliceAddr2, 0.11111111);
    services.unconf('alice', 0.11111111);

    await services.alice.waitForRPC('gettransaction', [res3.transaction_id]);
    await services.check('alice');
    await services.check('bob');

    // confirm (all orders should be cleared now)
    await services.miner.generate(1);
    services.conf('alice', 0.11111111);
    services.conf('bob', 0.87654321);
    await services.check('alice');
    await services.check('bob');
  });

  it('absurd fee limit after 6 RBFs', async () => {
    // Alice makes several orders to different addresses
    const addr1 = await services.alice.getNewAddress();
    const res1 = await services.sendOrder(addr1, 0.01010101);
    services.unconf('alice', 0.01010101);
    await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);

    // check each payout and make sure orders 1-6
    // are batched into one TX (plus change output)
    let tx = await services.alice.getTransaction(res1.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 2);

    await services.check('alice');

    const addr2 = await services.alice.getNewAddress();
    const res2 = await services.sendOrder(addr2, 0.01010101);
    services.unconf('alice', 0.01010101);
    await services.alice.waitForRPC('gettransaction', [res2.transaction_id]);

    tx = await services.alice.getTransaction(res2.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 3);
    await services.check('alice');

    const addr3 = await services.alice.getNewAddress();
    const res3 = await services.sendOrder(addr3, 0.01010101);
    services.unconf('alice', 0.01010101);
    await services.alice.waitForRPC('gettransaction', [res3.transaction_id]);

    tx = await services.alice.getTransaction(res3.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 4);
    await services.check('alice');

    const addr4 = await services.alice.getNewAddress();
    const res4 = await services.sendOrder(addr4, 0.01010101);
    services.unconf('alice', 0.01010101);
    await services.alice.waitForRPC('gettransaction', [res4.transaction_id]);

    tx = await services.alice.getTransaction(res4.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 5);
    await services.check('alice');

    const addr5 = await services.alice.getNewAddress();
    const res5 = await services.sendOrder(addr5, 0.01010101);
    services.unconf('alice', 0.01010101);
    await services.alice.waitForRPC('gettransaction', [res5.transaction_id]);

    tx = await services.alice.getTransaction(res5.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 6);
    await services.check('alice');

    const addr6 = await services.alice.getNewAddress();
    const res6 = await services.sendOrder(addr6, 0.01010101);
    services.unconf('alice', 0.01010101);
    await services.alice.waitForRPC('gettransaction', [res6.transaction_id]);

    tx = await services.alice.getTransaction(res6.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 7);
    await services.check('alice');

    const addr7 = await services.alice.getNewAddress();
    const res7 = await services.sendOrder(addr7, 0.01010101);
    services.unconf('alice', 0.01010101);
    await services.alice.waitForRPC('gettransaction', [res7.transaction_id]);

    // should be sent as sendOne()
    tx = await services.alice.getTransaction(res7.transaction_id);
    assert.strictEqual(tx.decoded.vout.length, 2);
    await services.check('alice');

    const addr8 = await services.alice.getNewAddress();
    const res8 = await services.sendOrder(addr8, 0.01010101);
    services.unconf('alice', 0.01010101);
    await services.alice.waitForRPC('gettransaction', [res8.transaction_id]);

    // should be batched with previous one-off
    tx = await services.alice.getTransaction(res8.transaction_id);
    // two payouts + change
    assert.strictEqual(tx.decoded.vout.length, 3);
    await services.check('alice');

    // One big batch TX, one small batch
    const mempool = await services.client.execute('getmempoolinfo', []);
    assert.strictEqual(mempool.size, 2);

    // confirm and double-check Alice still got all 8 payouts
    await services.miner.generate(1);
    services.conf('alice', 8 * 0.01010101);
    await services.check('alice');
  });
});
