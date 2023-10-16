'use strict';

const assert = require('assert');
const Amount = require('../build/amount');

class FeeEstimator {
  constructor(client, logger, options) {
    this.client = client;
    this.logger = logger;
    this.options = options;

    // Fallback fee: minimum fee used if all services fail (i.e. regtest)
    this.fallbackMinFee = 10;     // sat/vB

    // Passed to rpc estimatesmartfee for both min and max
    this.estimateMode = 'CONSERVATIVE';

    // Minimum fee: used as fee rate for initial TX that starts batch
    this.minFeeConfTarget = 100;

    // Maximum fee: abort batch if RBF combined fee rate exceeds this amount
    this.maxFeeConfTarget = 1;    // first check: testmempoolaccept max_fee
    this.maxFeeMultiplier = 4;    //              multiplied by this constant
    this.maxFeeRate = 500;        // second check: hard-coded sat/vB value

    if (options)
      this.parseOptions(options);

    assert(this.fallbackMinFee < this.maxFeeRate);
    assert(this.minFeeConfTarget > this.maxFeeConfTarget);
  }

  parseOptions(options) {
    if (options.fallbackMinFee != null) {
      assert((options.fallbackMinFee >>> 0) === options.fallbackMinFee);
      assert(options.fallbackMinFee > 0);
      this.fallbackMinFee = options.fallbackMinFee;
    }

    if (options.minFeeConfTarget != null) {
      assert((options.minFeeConfTarget >>> 0) === options.minFeeConfTarget);
      assert(options.minFeeConfTarget > 0);
      this.minFeeConfTarget = options.minFeeConfTarget;
    }

    if (options.minFeeEstimateMode != null) {
      assert(typeof options.minFeeEstimateMode === 'string');
      this.minFeeEstimateMode = options.minFeeEstimateMode;
    }

    if (options.maxFeeConfTarget != null) {
      assert((options.maxFeeConfTarget >>> 0) === options.maxFeeConfTarget);
      assert(options.maxFeeConfTarget > 0);
      this.maxFeeConfTarget = options.maxFeeConfTarget;
    }

    if (options.maxFeeMultiplier != null) {
      assert((options.maxFeeMultiplier >>> 0) === options.maxFeeMultiplier);
      assert(options.maxFeeMultiplier > 0);
      this.maxFeeMultiplier = options.maxFeeMultiplier;
    }

    if (options.maxFeeRate != null) {
      assert((options.maxFeeRate >>> 0) === options.maxFeeRate);
      assert(options.maxFeeRate > 0);
      this.maxFeeRate = options.maxFeeRate;
    }
  }

  async getMinFee() {
    let minFee;
    try {
      const {mempoolminfee} = await this.client.execute('getmempoolinfo', []);
      minFee = this.getSatsPerVbyte(mempoolminfee);
      this.logger.info(`Mempool min fee: ${minFee} s/vB`);
    } catch (e) {
      this.logger.info(`rpc getmempoolinfo failed: ${e.message}`);
    }

    try {
      minFee = await this.getClientMinFee();
      this.logger.info(`Client min fee estimate: ${minFee} s/vB`);
    } catch (e) {
      this.logger.info(`getClientMinFee() failed: ${e.message}`);
    }

    if (minFee)
      return minFee;

    this.logger.info(`Using fallback min fee: ${this.fallbackMinFee} s/vB`);
    return this.fallbackMinFee;
  }

  async getMaxFee() {
    try {
      const expensiveFee = await this.getClientMaxFee();
      return expensiveFee * this.maxFeeMultiplier;
    } catch (e) {
      this.logger.info(`getClientMaxFee() failed: ${e.message}`);
    }

    this.logger.info(`Using fallback max fee: ${this.maxFeeRate} s/vB`);
    return this.maxFeeRate;
  }

  async getClientMinFee() {
    // BTC/kvB
    const res = await this.client.execute('estimatesmartfee', [
      this.minFeeConfTarget,
      this.estimateMode
    ]);

    if (res.errors)
      throw new Error(res.errors.join(' '));

    return this.getSatsPerVbyte(res.feerate);
  }

  async getClientMaxFee() {
    // BTC/kvB
    const res = await this.client.execute('estimatesmartfee', [
      this.maxFeeConfTarget,
      this.estimateMode
    ]);

    if (res.errors)
      throw new Error(res.errors.join(' '));

    return this.getSatsPerVbyte(res.feerate);
  }

  getSatsPerVbyte(btcPerKiloVbyte) {
    /**
     *    BTC/kB * 1e8 = s/kB
     *    s/kB   / 1e3 = s/B
     */

    return Amount.fromBTC(btcPerKiloVbyte / 1e3).toValue();
  }

  getBTCPerKiloVbyte(satsPerVbyte) {
    /**
     *    s/B   / 1e8 = BTC/B
     *    BTC/B * 1e3 = BTC/kB
     */

    return Amount.fromSatoshis(satsPerVbyte * 1e3).toBTC(true);
  }
}

module.exports = FeeEstimator;
