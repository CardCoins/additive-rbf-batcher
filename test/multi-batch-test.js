/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint max-len: "off" */

'use strict';

const Services = require('./util/services');
const assert = require('assert');

describe('Multi Batch', function () {
  this.timeout(10000);

  const services = new Services({
    network: 'regtest',
    username: 'multi-batch-test',
    password: 'password-test',
    wallet: 'app',
    port: 18443,
    maxFeeRate: 50, // Small value here to start new batches faster in test
    dataDir: Services.tmpdir()
  });

  const appAddrs = [];

  before(async () => {
    await services.init();
    await services.startBitcoin();

    // Get addresses for funding app
    for (let i = 0; i < 10; i++) {
      const addr = await services.app.getNewAddress();
      appAddrs.push(addr);
    }
  });

  after(async () => {
    await services.stopBitcoin();
  });

  describe('Single Batch', function () {
    const payoutCoin = 1;
    const iterations = 8;
    let tx;

    it('should generate coins and fund wallet', async () => {
      await services.miner.generate(110);

      const fundCoin = 1;
      const txid = await services.miner.sendMany({
        [appAddrs[0]]: fundCoin,
        [appAddrs[1]]: fundCoin,
        [appAddrs[2]]: fundCoin,
        [appAddrs[3]]: fundCoin,
        [appAddrs[4]]: fundCoin,
        [appAddrs[5]]: fundCoin,
        [appAddrs[6]]: fundCoin,
        [appAddrs[7]]: fundCoin,
        [appAddrs[8]]: fundCoin,
        [appAddrs[9]]: fundCoin
      });

      await services.app.waitForRPC('gettransaction', [txid]);

      services.unconf('app', 10 * fundCoin);
      await services.check('app');
      await services.miner.generate(1);

      // check app balance
      services.conf('app', 10 * fundCoin);
      await services.check('app');
    });

    for (let i = 0; i < iterations; i++) {
      it(`iteration ${i + 1}`, async () => {
        const addr1 = await services.alice.getNewAddress();
        const res1 = await services.sendOrder(addr1, payoutCoin);
        services.unconf('alice', payoutCoin);
        await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);

        tx = await services.app.getTransaction(res1.transaction_id);
        await services.check('alice');
      });
    }

    it('should have 1 big batch TX with multiple inputs', async () => {
      const mempool = await services.app.execute('getmempoolinfo', []);
      assert.strictEqual(mempool.size, 1);
      // 1 per payout plus 1 for fee
      assert.strictEqual(tx.decoded.vin.length, iterations + 1);

      // confirm and double-check Alice got all payouts
      await services.miner.generate(1);
      services.conf('alice', iterations * payoutCoin);
      await services.check('alice');

      // confirm sane wallet balance (fee is expressed as negative amount)
      const sent = (iterations * payoutCoin) - tx.fee;
      services.unconf('app', sent * -1);
      services.conf('app', sent * -1);
      await services.check('app');
    });
  });

  describe('Mutiple Batches', function () {
    const payoutCoin = 0.2;
    const iterations = 30;

    it('should fund wallet', async () => {
      const fundCoin = 1;
      const txid = await services.miner.sendMany({
        [appAddrs[0]]: fundCoin,
        [appAddrs[1]]: fundCoin,
        [appAddrs[2]]: fundCoin,
        [appAddrs[3]]: fundCoin,
        [appAddrs[4]]: fundCoin,
        [appAddrs[5]]: fundCoin,
        [appAddrs[6]]: fundCoin,
        [appAddrs[7]]: fundCoin,
        [appAddrs[8]]: fundCoin,
        [appAddrs[9]]: fundCoin
      });

      await services.miner.waitForRPC('gettransaction', [txid]);

      services.unconf('app', 10 * fundCoin);
      await services.check('app');
      await services.miner.generate(1);

      // check app balance
      services.conf('app', 10 * fundCoin);
      await services.check('app');
    });

    for (let i = 0; i < iterations; i++) {
      it(`iteration ${i + 1}`, async () => {
        const addr1 = await services.alice.getNewAddress();
        const res1 = await services.sendOrder(addr1, payoutCoin);
        services.unconf('alice', payoutCoin);
        await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);

        await services.app.getTransaction(res1.transaction_id);
        await services.check('alice');
      });
    }

    it('should have multiple batches', async () => {
      const mempool = await services.app.execute('getrawmempool', []);
      let totalFees = 0;
      const report = [];
      for (const txid of mempool) {
        const tx = await services.app.getTransaction(txid);
        totalFees += tx.fee;
        report.push(
          `inputs: ${tx.decoded.vin.length}, ` +
          `outputs: ${tx.decoded.vout.length}, ` +
          `fee: ${tx.fee}`
        );
      }
      console.log(
        `Payouts requested: ${iterations}. Batches in mempool: `,
        report
      );

      // confirm and double-check Alice got all payouts
      await services.miner.generate(1);
      services.conf('alice', iterations * payoutCoin);
      await services.check('alice');

      // confirm sane wallet balance (fee is expressed as negative amount)
      const sent = (iterations * payoutCoin) - totalFees;
      services.unconf('app', sent * -1);
      services.conf('app', sent * -1);
      await services.check('app');
    });
  });

  describe('Rule 6', function() {
    it('should not add to batch with spent output', async () => {
        const addrBob = await services.bob.getNewAddress();
        // Bob makes first request
        const res1 = await services.sendOrder(addrBob, 0.001);
        await services.bob.waitForRPC('gettransaction', [res1.transaction_id]);

        // Bob spends his unconfirmed output
        const tx1 = await services.bob.execute(
          'send',
          {
            outputs: [{'bcrt1q4kc7ax3ps66x680xq5pxaqnztjr9p57t7ryhaz': 0.0001}],
            options: {'include_unsafe': true}
          }
        );

        // Bob makes second request
        const res2 = await services.sendOrder(addrBob, 0.001);

        // We had to start another batch
        const mempool = await services.app.execute('getrawmempool', []);
        for (const txid of [res1.transaction_id, res2.transaction_id, tx1.txid]) {
          assert(mempool.includes(txid));
        }
    });
  });
});
