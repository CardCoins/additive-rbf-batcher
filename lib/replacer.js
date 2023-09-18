/* eslint camelcase: "off" */

'use strict';

// For bcrypto hash functions, not used
process.env.NODE_BACKEND = 'js';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const MTX = require('../build/mtx');
const Amount = require('../build/amount');
const Client = require('./walletClient');
const Logger = require('./logger');
const FeeEstimator = require('./fees');

class Replacer {
  constructor(options) {
    this.options = options;

    // Bitcoin Core node
    this.network = 'regtest';
    this.port = 18443;
    this.username = 'rpcuser';
    this.password = 'rpcpassword';
    this.wallet = 'wallet.dat';

    // Replacer application
    this.dataDir = path.join(__dirname, '..', 'data');
    this.logger = new Logger();

    if (options)
      this.parseOptions(options);

    // Bitcoin Core RPC client
    this.client = new Client({
      port: this.port,
      username: this.username,
      password: this.password,
      wallet: this.wallet
    });

    // Combined Fee Estimator
    this.fees = new FeeEstimator(this.client, this.logger, options);

    // Application state
    this.payouts = [];
    this.payoutsFile = path.join(this.dataDir, `${this.network}_outputs.json`);
    try {
      this.payouts = JSON.parse(fs.readFileSync(this.payoutsFile));
      this.logger.info(
        `Loaded outputs.json file: found ${this.payouts.length} orders`
      );
    } catch (e) {
      if (e.code === 'ENOENT')
        this.logger.info('No outputs.json file found, starting empty');
      else
        throw e;
    }
  }

  parseOptions(options) {
    if (options.network != null) {
      assert(typeof options.network === 'string');
      this.network = options.network;
    }

    if (options.port != null) {
      assert((options.port >>> 0) === options.port);
      this.port = options.port;
    }

    if (options.username != null) {
      assert(typeof options.username === 'string');
      this.username = options.username;
    }

    if (options.password != null) {
      assert(typeof options.password === 'string');
      this.password = options.password;
    }

    if (options.wallet != null) {
      assert(typeof options.wallet === 'string');
      this.wallet = options.wallet;
    }

    if (options.dataDir != null) {
      assert(typeof options.dataDir === 'string');
      this.dataDir = options.dataDir;
    }

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      assert(typeof options.logger.info === 'function');
      assert(typeof options.logger.error === 'function');
      this.logger = options.logger;
    }
  }

  async addPayment(address, amount, orderID) {
    const {abandoned, replaceable} = await this.updatePayouts();

    this.logger.info(`Add payment order ID: ${orderID}`);
    this.logger.info(`Current pending payouts: ${abandoned.length} abandoned,` +
                     ` ${replaceable.length} replaceable`);

    let result = {txid: null, orderIDs: [], total: 0};
    try {
      if (!replaceable.length) {
        if (!abandoned.length) {
          // Mempool is empty and nothing is pending
          result = await this.sendOne(address, amount, orderID);
        } else {
          // Mempool is empty but some payout needs to start over (abandoned?)
          result = await this.sendMany(address, amount, orderID, abandoned);
        }
      } else {
        // Mempool is not empty, batch and replace-by-fee
        result = await this.sendRBF(address,
                                    amount,
                                    orderID,
                                    abandoned,
                                    replaceable);
      }
    } catch (error) {
      this.logger.error('Replacer error:');
      this.logger.error(error);
      this.logger.error(JSON.stringify(error));
      throw error;
    }
    return this.report(result);
  }

  async sendOne(address, amount, orderID) {
    const orderIDs = [];
    let txid = null;

    const fee_rate = await this.fees.getMinFee();

    txid = await this.client.execute('sendtoaddress', [
      address,
      amount,
      null,   // comment
      null,   // comment_to
      false,  // subtractfeefromamount
      true,   // replaceable
      null,   // conf_target
      null,   // estimate_mode
      null,   // avoid_reuse
      fee_rate// sat/vB
    ]);

    orderIDs.push(orderID);

    this.logger.info(`Replacer sent tx with sendOne(): ${txid}`);

    this.addNewPayout({
      txids: [txid],
      orderID,
      address,
      amount,
      block: null,
      confirmations: 0
    });

    return {txid, orderIDs, amount};
  }

  async sendMany(address, amount, orderID, abandoned) {
    const orderIDs = [];
    let txid = null;
    let total = 0;

    const outputs = [];

    // Add output for the new payment
    const value = Amount.fromBTC(amount).toValue();
    outputs.push({
      address,
      value
    });
    orderIDs.push(orderID);
    total += value;

    // Combine with outputs from abandoned payments
    for (const payout of abandoned) {
      const value = Amount.fromBTC(payout.amount).toValue();
      outputs.push({
        address: payout.address,
        value
      });
      orderIDs.push(payout.orderID);
      total += value;
    }

    const mtx = new MTX({outputs});
    const hex = mtx.toRaw().toString('hex');

    const fee_rate = await this.fees.getMinFee();

    const fundedTX = await this.client.execute('fundrawtransaction', [
      hex,
      {
        replaceable: true,
        fee_rate,   // sat/vB
        // feeRate  // BTC/kvB
      }
    ]);

    const signedTX = await this.client.execute(
      'signrawtransactionwithwallet',
      [fundedTX.hex]
    );

    // If the wallet for some reason can not completely sign the transaction
    // bitcoind will return a JSON object listing any verification errors
    if (!signedTX.complete) {
      throw new Error(`Replacer sign TX error: ${JSON.stringify(signedTX)}`);
    }

    txid = await this.client.execute('sendrawtransaction', [signedTX.hex]);

    this.logger.info(`Replacer sent tx with sendMany(): ${txid}`);

    // Does not write to disk, yet
    this.updateTXIDs(abandoned, txid);
    // Writes all to disk
    this.addNewPayout({
      txids: [txid],
      orderID,
      address,
      amount,
      block: null,
      confirmations: 0
    });

    return {
      txid,
      orderIDs,
      total: Amount.fromSatoshis(total).toBTC()
    };
  }

  async sendRBF(address, amount, orderID, abandoned, replaceable) {
    const orderIDs = [];
    let txid = null;
    let total = 0;
    let fees = 0; // denominated in satoshis

    const txMap = new Map();
    const inputMap = new Map();
    const outputs = [];

    // Add output for the new payment
    const value = Amount.fromBTC(amount).toValue();
    outputs.push({
      address,
      value
    });
    orderIDs.push(orderID);
    total += value;

    // Combine with outputs from abandoned & replaceable payments
    for (const payout of abandoned.concat(replaceable)) {
      const value = Amount.fromBTC(payout.amount).toValue();
      outputs.push({
        address: payout.address,
        value
      });
      orderIDs.push(payout.orderID);
      total += value;
    }

    // Iterate through replaceable txs
    for (const payout of replaceable) {
      const tx = payout.tx;

      // Accumulate fees, all replaced TXs need to be paid for.
      // Only add fees from each unique replaceable TX once!
      if (!txMap.has(tx.txid)) {
        const feeInSatoshis = Amount.fromBTC(tx.fee).toValue();
        fees += (feeInSatoshis * -1);
        txMap.set(tx.txid, [payout]);
      } else {
        // Keep track of which transactions fulfill which payouts
        txMap.set(tx.txid, txMap.get(tx.txid).concat([payout]));
      }

      // Collect all inputs from all replaceable TXs.
      // Technically only one input needs to conflict
      // to replace a transaction but we want our replacements
      // to update their predecessors as little as possible,
      // so we keep as much as we can the same.
      const mtx = MTX.fromRaw(tx.hex, 'hex');
      for (const input of mtx.inputs) {
        const outpoint = input.prevout.toKey().toString('hex');
        if (!inputMap.has(outpoint)) {
          inputMap.set(outpoint, input);
        }
      }
    }

    // If there are more than one unconfirmed TXs in the mempool,
    // We find the TX with the least amount of payouts
    // and re-start the batcher using ONLY those payouts.
    // This will either result in the new payout being added to
    // that batch leaving other batches alone OR, it will
    // fail one of the fee checks, get sent from sendOne()
    // and effectively start a new batch with one payout.
    // We can add the entire array of abandoned payouts to this
    // recursive call as well, since they are not in the mempool at all.
    if (txMap.size > 1) {
      // Start with a maximum-size array, guaranteed one of
      // the payout sets is smaller than that!
      let smallestBatch = Array(0xffffffff);
      txMap.forEach((payouts) => {
        if (payouts.length <= smallestBatch.length)
          smallestBatch = payouts;
      });

      // Sanity check
      assert(smallestBatch.length < 0xffffffff);

      txMap.forEach((value, key) => {
        this.logger.info(`Pending tx: ${key} with ${value.length} payouts`);
      });

      // Recurse!
      return this.sendRBF(address, amount, orderID, abandoned, smallestBatch);
    }

    // Should only be one tx in map now
    let oldTXFeeRate = 0;
    txMap.forEach((value, key) => {
      // Grab the fee rate from any of the replaceable payouts
      // (they are all from the same transaction at this point)
      oldTXFeeRate = this.fees.getSatsPerVbyte(value[0].tx.rate);
      this.logger.info(
        `Attempting to add orderID ${orderID} ` +
        `to tx ${key} with ${value.length} existing payouts ` +
        `and fee rate of ${oldTXFeeRate} s/vB`
      );
    });

    const inputs = [];
    for (const [, input] of inputMap)
      inputs.push(input);

    const mtx = new MTX({inputs, outputs});
    const hex = mtx.toRaw().toString('hex');

    // Let Bitcoin Core calculate the fee for this tx
    // as if it were not a replacement
    const fee_rate = await this.fees.getMinFee();
    const fundedTX = await this.client.execute('fundrawtransaction', [
      hex,
      {
        replaceable: true,
        fee_rate,   // sat/vB
        // feeRate  // BTC/kvB
      }
    ]);

    // Pay the fees of all replaced TXs
    // by subtracting that amount from change.
    // To do this using only bitcoind we need to
    // deconstruct the TX we already have,
    // tweak it, and then re-construct it.
    const finalHex = await this.subtractRBFFees(fundedTX, fees);

    const signedTX = await this.client.execute(
      'signrawtransactionwithwallet',
      [finalHex]
    );

    // If the wallet for some reason can not completely sign the transaction
    // bitcoind will return a JSON object listing any verification errors
    if (!signedTX.complete) {
      throw new Error(`Replacer sign TX error: ${JSON.stringify(signedTX)}`);
    }

    // Make sure we don't pay an absurd fee based on fullnode estimate
    const saneFee = await this.fees.getMaxFee();

    // On regtest, estimatesmartfee may not work at all
    if (saneFee) {
      const test1 = await this.client.execute('testmempoolaccept', [
        [signedTX.hex],
        this.fees.getBTCPerKiloVbyte(saneFee) // BTC/kvB
      ]);

      if (!test1[0].allowed) {
        this.logger.info(
          'RBF batch TX failed testmempoolaccept with estimated ' +
          `max fee rate of ${saneFee} s/vB, reason: ` +
          test1[0]['reject-reason']
        );
        this.logger.info('Sending as a single payout instead');
        return this.sendOne(address, amount, orderID);
      } else {
      this.logger.info(
        'RBF batch TX passed testmempoolaccept with estimated ' +
        `max fee rate of ${saneFee} s/vB`);
      }
    } else {
      this.logger.info('estimatesmartfee failed, skipping test.');
    }

    // Make sure we don't pay an absurd fee based on option set in index.js
    const test2 = await this.client.execute('testmempoolaccept', [
      [signedTX.hex],
      this.fees.getBTCPerKiloVbyte(this.fees.maxFeeRate) // BTC/kvB
    ]);

    if (!test2[0].allowed) {
      this.logger.info(
          'RBF batch TX failed testmempoolaccept with hard-coded ' +
          `max fee rate of ${this.fees.maxFeeRate} s/vB, reason: ` +
          test2[0]['reject-reason']
      );
      this.logger.info('Sending as single payout instead');
      return this.sendOne(address, amount, orderID);
    } else {
      this.logger.info(
        'RBF batch TX passed testmempoolaccept with hard-coded ' +
        `max fee rate of ${this.fees.maxFeeRate} s/vB`);
    }

    txid = await this.client.execute('sendrawtransaction', [signedTX.hex]);

    this.logger.info(`Replacer sent tx with sendRBF(): ${txid}`);

    // Does not write to disk, yet
    this.updateTXIDs(abandoned.concat(replaceable), txid);
    // Writes all to disk
    this.addNewPayout({
      txids: [txid],
      orderID,
      address,
      amount,
      block: null,
      confirmations: 0
    });

    return {
      txid,
      orderIDs,
      total: Amount.fromSatoshis(total).toBTC()
    };
  }

  async subtractRBFFees(fundedTX, fees) {
    const mtx = MTX.fromRaw(fundedTX.hex, 'hex');

    // Ensure the TX we are creating has a change output
    assert(fundedTX.changepos >= 0);

    // Subtract extra fees from the change output
    // (denominated in satoshis)
    mtx.outputs[fundedTX.changepos].value -= fees;

    return mtx.toRaw().toString('hex');
  }

  updateTXIDs(updated, txid) {
    for (const {orderID} of updated) {
      for (const payout of this.payouts) {
        if (orderID === payout.orderID)
          payout.txids.push(txid);
      }
    }
  }

  addNewPayout(payout) {
    this.payouts.push(payout);
    this.writePayouts();
  }

  writePayouts() {
    fs.writeFileSync(
      this.payoutsFile,
      JSON.stringify(this.payouts, null, 2)
    );
  }

  async report(result) {
    const {txid, orderIDs, total} = result;
    let _fee = 0;
    let _vsize = 0;
    let rate = 0;
    try {
      const {fee, decoded} = await this.client.execute(
        'gettransaction',
        [
          txid,
          true, // watch only
          true  // verbose
        ]
      );
      const {vsize} = decoded;
      _fee = -fee;
      _vsize = vsize;
      rate = parseInt(Amount.fromBTC(-fee).toSatoshis() / _vsize);
    } catch (e) {
      this.logger.error(
        `gettransaction failed to get TX we just sent: ${e.message}`);
    }
    const ret = {
      transaction_id: txid,
      order_ids: orderIDs,
      total: Number(total),
      fee: _fee,
      vsize: _vsize,
      rate
    };
    this.logger.info(JSON.stringify(ret));
    return ret;
  }

  async updatePayouts() {
    // Sanity check: can possibly be removed in production
    this.checkIntegrity();

    // Cache the rpc calls
    const cache = new Map();

    // payouts with an unconfirmed tx in mempool
    const replaceable = [];
    // payouts with no tx in the mempool (possibly abandoned)
    const abandoned = [];

    PAYOUTS: for (let p = 0; p < this.payouts.length; p++) {
      const payout = this.payouts[p];

      TXIDS: for (let t = payout.txids.length - 1; t >= 0; t--) {
        const txid = payout.txids[t];

        // Get TX details from wallet, check cache first
        let tx = cache.get(txid);
        if (!tx) {
          try {
            tx = await this.client.execute('gettransaction', [
              txid,
              true, // include_watchonly
              true  // verbose: return object will have 'decoded' object
            ]);
            // compute fee rate in BTC/kB and attach to object
            // we can use this later on for smarter batching-of-batches
            const feeInSatoshis = Amount.fromBTC(tx.fee * -1000).toValue();
            const rateInSatPerKb = parseInt(feeInSatoshis / tx.decoded.vsize);
            tx.rate = Amount.encode(rateInSatPerKb, 8, true);
            cache.set(txid, tx);
          } catch (e) {
            if (e.code === -5) {
              // "Invalid or non-wallet transaction id"
              // Remove txid and continue
              payout.txids.pop();
              continue TXIDS;
            } else {
              throw e;
            }
          }
        }

        // TX details are an array of objects for each type "send" / "receive"
        // Ignore abandoned txid and continue
        for (const det of tx.details) {
          if (det.abandoned) {
            continue TXIDS;
          }
        }

        // If a conflicting transaction was confirmed we consider it abandoned
        // Ignore the txid and continue
        if (tx.confirmations < 0)
          continue TXIDS;

        // Remove confirmed payouts
        if (tx.confirmations >= 6) {
          this.payouts.splice(p, 1);
          p--;
          continue PAYOUTS;
        }

        // Update
        payout.confirmations = tx.confirmations;
        payout.block = tx.blockhash || null;

        // Confirmed tx
        if (payout.confirmations > 0)
          continue PAYOUTS;

        // Unconfirmed, therefore replaceable.
        // Send back all the tx details
        const payoutWithDetails = Object.assign({tx}, payout);
        replaceable.push(payoutWithDetails);
        continue PAYOUTS;
      }

      // Possibly abandoned, we need to start over
      abandoned.push(payout);
    }

    // Update file on disk
    this.writePayouts();

    return {
      abandoned,
      replaceable
    };
  }

  checkIntegrity() {
    try {
      const file = JSON.parse(fs.readFileSync(this.payoutsFile));
      assert.deepStrictEqual(
        this.payouts,
        file,
        'Payouts file / state memory mismatch'
      );
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw e;
      else
        assert.deepStrictEqual(this.payouts, [], 'Expected empty state memory');
    }
  }
}

module.exports = Replacer;
