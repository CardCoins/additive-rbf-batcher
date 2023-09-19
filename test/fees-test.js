/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint max-len: "off" */

'use strict';

const Services = require('./util/services');

/**
 *  MockClient replaces selected Bitcoin Core RPCs
 *  with simulated mainnet responses for fee estimation
 */
class MockClient {
  constructor() {
                              // (BTC/kvB)
    this.minFee  = .00003000; // getmempoolinfo .mempoolminfee
    this.lowFee  = .00015000; // estimatesmartfee 100
    this.highFee = .00035000; // estimatesmartfee 1

    this.factor = 0; // Used to adjust fees over time
  }

  execute(method, params) {
    this.minFee  += (this.factor * .00000100);
    this.lowFee  += (this.factor * .00000300);
    this.highFee += (this.factor * .00000800);

    switch (method) {
      case 'getmempoolinfo': {
        return {mempoolminfee: this.minFee};
      }
      case 'estimatesmartfee': {
        switch (params[0]) {
          case 1:
            return {feerate: this.highFee};
          case 100:
            return {feerate: this.lowFee};
          default:
            throw new Error(`Unexpected request: ${method} ${params}`);
        }
      }
      default:
        throw new Error(`Unexpected request: ${method} ${params}`);
    }
  }
};

describe('Fee Estimator', function () {
  this.timeout(0);

  const services = new Services({
    network: 'regtest',
    username: 'fees-test',
    password: 'password-test',
    wallet: 'app',
    port: 18443,
    dataDir: Services.tmpdir()
  });

  const client = new MockClient();

  before(async () => {
    await services.init();
    services.replacer.fees.client = client;
    await services.startBitcoin();
  });

  after(async () => {
    await services.stopBitcoin();
  });

  it('should fund app', async () => {
    await services.miner.generate(110);
    await services.miner.execute(
      'sendtoaddress',
      [await services.app.getNewAddress(), 100]);
    await services.miner.generate(1);
  });

  it('should make 50 payouts with static fee estimates', async () => {
    for (let i = 0; i < 50; i ++) {
        const addr1 = await services.alice.getNewAddress();
        const res1 = await services.sendOrder(addr1, 0.1);
        services.unconf('alice', 0.1);
        await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);
    }
    await services.check('alice');
    await services.miner.generate(1);
    services.conf('alice', 0.1 * 50);
    await services.check('alice');
  });

  it('should make 50 payouts with rising fee estimates', async () => {
    client.factor = 2;
    for (let i = 0; i < 50; i ++) {
        const addr1 = await services.alice.getNewAddress();
        const res1 = await services.sendOrder(addr1, 0.1);
        services.unconf('alice', 0.1);
        await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);
    }
    await services.check('alice');
    await services.miner.generate(1);
    services.conf('alice', 0.1 * 50);
    await services.check('alice');
  });

  it('should make 50 payouts with declining fee estimates', async () => {
    client.factor = -2;
    for (let i = 0; i < 50; i ++) {
        const addr1 = await services.alice.getNewAddress();
        const res1 = await services.sendOrder(addr1, 0.1);
        services.unconf('alice', 0.1);
        await services.alice.waitForRPC('gettransaction', [res1.transaction_id]);
    }
    await services.check('alice');
    await services.miner.generate(1);
    services.conf('alice', 0.1 * 50);
    await services.check('alice');
  });
});
