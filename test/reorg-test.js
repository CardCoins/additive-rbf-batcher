/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint max-len: "off" */

'use strict';

const Services = require('./util/services');
const assert = require('assert');

describe('Reorg', function () {
  this.timeout(10000);

  const services = new Services({
    network: 'regtest',
    username: 'reorg-test',
    password: 'password-test',
    wallet: 'app',
    port: 18443,
    fallbackMinFee: 1,
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
    await services.miner.generate(110);

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

    await services.app.waitForRPC('gettransaction', [txid]);

    services.unconf('app', 10 * 10);
    await services.check('app');
    await services.miner.generate(1);

    services.conf('app', 10 * 10);
    await services.check('app');
  });

  // Alice's first order
  let txA;
  let txAConfirmationBlock;
  // Bob's order batched with Alice's
  let txAB;
  // Chuck's order batched with Bob's duplicate payout
  let txBC;

  it('Alice requests a payout (txA)', async () => {
    // Send order
    const addr = await services.alice.getNewAddress();
    const res = await services.sendOrder(addr, 1.1);
    services.unconf('alice', 1.1);

    // Wait for broadcast and check
    txA = await services.alice.waitForRPC('getrawtransaction', [res.transaction_id, 2]);
    await services.check('alice');
  });

  it('Bob requests a payout, it is batched with Alice (txAB)', async () => {
    // Send order
    const addr = await services.bob.getNewAddress();
    const res = await services.sendOrder(addr, 2.2);
    services.unconf('bob', 2.2);

    // Wait for broadcast and check
    txAB = await services.bob.waitForRPC('getrawtransaction', [res.transaction_id, 2]);
    await services.check('bob');
  });

  it('Miner confirms txA (despite lower fee rate), evicting txAB', async () => {
    // txAB by itself in mempool
    assert.deepStrictEqual(
      await services.miner.execute('getrawmempool'),
      [txAB.txid]);

    // Reduce txAB effective fee rate to 0
    await services.miner.execute('prioritisetransaction', [txAB.txid, 0, -100000000]);

    // Re-insert txA which will now abnormally replace its replacement
    await services.miner.execute('sendrawtransaction', [txA.hex]);

    // txA by itself in mempool
    assert.deepStrictEqual(
      await services.miner.execute('getrawmempool'),
      [txA.txid]);

    // confirm txA
    txAConfirmationBlock = (await services.miner.generate(1))[0];
    await services.conf('alice', 1.1);

    // wait for wallet to acknowledge the eviction after block is processed
    for (;;) {
      const t = await services.bob.execute('gettransaction', [txAB.txid]);
      if (t.confirmations < 0)
        break;
    }
  });

  it('Chuck requests a payout, it is batched with Bob\'s abandoned order (txBC)', async () => {
    // Send order
    // Request a large amount so the wallet funds the payout with a fresh coin
    // and NOT the change of txA, which would inadvertently prevent the reorg
    // issue. The permanent fix is to require that txBC spends from txA.
    const addr = await services.chuck.getNewAddress();
    const res = await services.sendOrder(addr, 7);
    services.unconf('chuck', 7);

    // Wait for broadcast and check
    txBC = await services.chuck.waitForRPC('getrawtransaction', [res.transaction_id, 2]);
    await services.check('alice');
    await services.check('bob');
    await services.check('chuck');
  });

  it('A reorg evicts txA, confirms txAB and txBC in the same block', async () => {
    // create fork
    await services.miner.execute('invalidateblock', [txAConfirmationBlock]);

    // txA now joins txBC in mempool
    assert.deepStrictEqual(
      (await services.miner.execute('getrawmempool')).sort(),
      [txA.txid, txBC.txid].sort());

    // Re-insert txAB which will appropriately replace txA.
    // It will ALSO evict txBC, because it is a child of txA.
    // Note that this requires that txAB has enough RBF fees to replace both.
    await services.miner.execute('prioritisetransaction', [txAB.txid, 0, 150000000]);
    await services.miner.execute('sendrawtransaction', [txAB.hex]);

    // double payout is not in the mempool
    assert.deepStrictEqual(
      await services.miner.execute('getrawmempool'),
      [txAB.txid]);

    // Confirm
    await services.miner.generate(1);

    // Expected outcome (Alice's payout is already confirmed)
    services.conf('bob', 2.2);
    await services.check('alice');
    await services.check('bob');

    // Now Chuck has not been paid at all, because an unconfirmed
    // payment has been replaced in a block, Chuck will need
    // a brand new transaction now.
    assert.strictEqual(await services.chuck.getBalance(), 0);
    assert.strictEqual(await services.chuck.getUnconfirmedBalance(), 0);
  });

  it('Alice requests a payout, it is batched with Chuck\'s abandoned payout (txAC)', async () => {
    // Send order
    const addr = await services.alice.getNewAddress();
    const res = await services.sendOrder(addr, 0.001);
    services.unconf('alice', 0.001);

    // Wait for broadcast and check everyone
    await services.alice.waitForRPC('gettransaction', [res.transaction_id]);
    await services.check('alice');
    await services.check('bob');
    await services.check('chuck');

    // Confirm
    await services.miner.generate(1);
    services.conf('chuck', 7);
    services.conf('alice', 0.001);
    await services.check('alice');
    await services.check('bob');
    await services.check('chuck');
  });
});
