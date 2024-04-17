/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint max-len: "off" */

'use strict';

const Services = require('./util/services');

describe('Retry', function () {
  this.timeout(10000);

  const services = new Services({
    network: 'regtest',
    username: 'simple-test',
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

  let lastBatchTxid;

  it('should generate only TWO coins in wallet', async () => {
    await services.miner.generate(110);

    const appAddrs = [];
    for (let i = 0; i < 10; i++) {
      const addr = await services.app.getNewAddress();
      appAddrs.push(addr);
    }
    const txid = await services.miner.sendMany({
      [appAddrs[0]]: 1,
      [appAddrs[1]]: 1
    });

    await services.app.waitForRPC('gettransaction', [txid]);
    await services.miner.generate(1);
  });

  for (let i = 0; i < 10; i++) {
    it(`Alice requests ten payouts: ${i + 1}`, async () => {
      // Send order
      const addr = await services.alice.getNewAddress();
      const res = await services.sendOrder(addr, 0.1);
      lastBatchTxid = res.transaction_id;
      await services.alice.waitForRPC('gettransaction', [lastBatchTxid]);
    });
  }

  it('Alice spends her last unconfirmed payout', async () => {
    // At this point there are 2 batches in the mempool.
    // One is "full" and the other is not. Alice spends
    // from the latter batch, giving it a descendant and
    // therefore making it un-RBF-able. Even though the
    // wallet has funds, we won't be able to add more
    // payments to either batch.

    // Get all 0-conf UTXOs
    const coins = await services.alice.execute('listunspent', [0]);
    // Pick one from last batch
    let input;
    for (const coin of coins) {
      if (coin.txid === lastBatchTxid) {
        input = {txid: coin.txid, vout: coin.vout};
        break;
      }
    }
    const addr = await services.alice.getNewAddress();
    const create = await services.alice.execute(
      'createrawtransaction',
      [[input], {[addr]: 0.0999}]);
    const sign = await services.alice.execute(
      'signrawtransactionwithwallet',
      [create]);
    const send = await services.alice.execute(
      'sendrawtransaction',
      [sign.hex]);
    await services.alice.waitForRPC('gettransaction', [send]);
  });

  for (let i = 0; i < 5; i++) {
    it(`Alice requests five more payouts: ${i + 1}`, async () => {
      // Send order
      const addr = await services.alice.getNewAddress();
      const res = await services.sendOrder(addr, 0.1);
      await services.alice.waitForRPC('gettransaction', [res.transaction_id]);
    });
  }
});
