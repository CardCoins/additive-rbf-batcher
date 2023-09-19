/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint max-len: "off" */

'use strict';

// For bcrypto hash functions, not used
process.env.NODE_BACKEND = 'js';

const MTX = require('../build/mtx');
const Services = require('./util/services');
const assert = require('assert');

describe('Mempool Evict', function () {
  this.timeout(0xffffff);

  const services = new Services({
    network: 'regtest',
    username: 'mempool-evict-test',
    password: 'password-test',
    wallet: 'app',
    port: 18443,
    dataDir: Services.tmpdir()
  });

  let orderRes;

  before(async () => {
    await services.init();
    await services.startBitcoin(['-maxmempool=5', '-maxtxfee=1', '-debug=mempool']);
  });

  after(async () => {
    await services.stopBitcoin();
  });

  it('should generate coins and fund wallet', async () => {
    await services.miner.generate(120);

    await services.miner.execute(
      'sendtoaddress',
      [await services.app.getNewAddress(), 10]);

    // Set up miner with numerous UTXO
    const minerAddr = await services.miner.getNewAddress();
    const minerMTX = new MTX();
    for (let i = 0; i < 500; i++)
      minerMTX.addOutput(minerAddr, 1e8);
    const funded = await services.miner.execute(
      'fundrawtransaction',
      [minerMTX.toRaw().toString('hex')]);
    const signed = await services.miner.execute(
      'signrawtransactionwithwallet',
      [funded.hex]);
    await services.miner.execute(
      'sendrawtransaction',
      [signed.hex]);
    await services.miner.generate(1);
  });

  it('Alice requests one payout', async () => {
    const addr = await services.alice.getNewAddress();
    orderRes = await services.sendOrder(addr, 0.5);
    services.unconf('alice', 0.5);
  });

  it('Fill mempool with big high-fee TXs', async () => {
    // Flood mempool with 1-of-3 bare multisig outputs
    const outputs = [];
    for (let i = 0; i < 100; i++) {
      outputs.push({
        value: 1e5,
        script: '51' +
                '21022fb0abef9efd53e45faeb89fc0e7f71e36d60796b96d6958c7ae2ad308c2d0c1' +
                '2102ffe833e16e13a688f62e89a4dfd013d8ee9b3814c3d212a2970f0e2875adc381' +
                '21033333333333333333333333333333333333333333333333333333333333333333' +
                '53ae'});
    }
    const floodMTX = MTX.fromJSON({
      version: 2,
      locktime: 0,
      inputs: [],
      outputs});
    let lastTxid;
    try {
      for (;;) {
        const funded = await services.miner.execute(
          'fundrawtransaction',
          [floodMTX.toRaw().toString('hex'), {'fee_rate':1000}]);
        const signed = await services.miner.execute(
          'signrawtransactionwithwallet',
          [funded.hex]);
        lastTxid = await services.miner.execute(
          'sendrawtransaction',
          [signed.hex]);
      }
    } catch (e) {
      assert(e.message === 'mempool full');
    }

    const txids = await services.miner.execute('getrawmempool', []);
    // Alice's order was evicted!
    assert(txids.indexOf(orderRes.transaction_id) === -1);
    // Sanity check
    assert(txids.indexOf(lastTxid) !== -1);
  });

  it('Bob requests one payout', async () => {
    const addr = await services.bob.getNewAddress();
    orderRes = await services.sendOrder(addr, 0.7);

    // Alice's evicted order is batched in with Bob's new order
    const newBatch = await services.bob.waitForRPC(
      'gettransaction',
      [orderRes.transaction_id, true, true]);

    assert.strictEqual(newBatch.decoded.vout.length, 3);

    services.unconf('bob', 0.7);
    await services.check('alice'); // She doesn't even know her first tx vanished
    await services.check('bob');

    // confirm and double-check
    await services.miner.generate(1);
    services.conf('alice', 0.5);
    services.conf('bob', 0.7);
    await services.check('alice');
    await services.check('bob');
  });
});
