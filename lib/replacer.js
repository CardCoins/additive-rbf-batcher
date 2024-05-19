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
      this.logger.error(`Replacer error: ${error}`);
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

    return {txid, orderIDs, total: amount};
  }

  async sendMany(address, amount, orderID, abandoned) {
    const orderIDs = [];
    let txid = null;
    let total = 0;

    const requiredCoins = [];
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

      if (payout.requiredCoin) {
        requiredCoins.push(payout.requiredCoin);
      }
    }

    const mtx = new MTX({outputs});

    // Add required inputs to ensure reorg protection.
    for (const requiredCoin of requiredCoins) {
      const hash = Buffer.from(requiredCoin.txid, 'hex').reverse();
      const index = requiredCoin.index;
      // Only add each required input once!
      if (!mtx.view.hasEntry({hash, index})) {
        mtx.addOutpoint({hash, index});
      }
    }

    const hex = mtx.toRaw().toString('hex');

    const fee_rate = await this.fees.getMinFee();

    const fundedTX = await this.client.execute('fundrawtransaction', [
      hex,
      {
        replaceable: true,
        fee_rate    // sat/vB
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
    // Go through all replaceable payouts and sort by pending TX
    const txMap = new Map();
    for (const payout of replaceable) {
      const tx = payout.tx;
      if (!txMap.has(tx.txid)) {
        txMap.set(tx.txid, [payout]);
      } else {
        txMap.set(tx.txid, txMap.get(tx.txid).concat([payout]));
      }
    }

    // Pick a pending TX to replace.
    let originalTX = null;
    let originalBatch = [];
    let originalFeeRate = Infinity;
    this.logger.info('Pending txs:');
    txMap.forEach((value, key) => {
      // 'value' is an array of payouts in this tx
      // We can get tx details from any of them
      const tx = value[0].tx;
      this.logger.info(`  ${key}: ` +
                       `${value.length} payouts, ` +
                       `${this.fees.getSatsPerVbyte(tx.rate)} s/vB, ` +
                       `${tx.children.length} descendants`);

      // We curently do not support replacing TXs with descendants
      if (tx.children.length > 0) {
        txMap.delete(key);
        return; // continue forEach
      }

      // Choose the TX with the lowest fee rate
      if (tx.rate < originalFeeRate) {
        originalTX = tx;
        originalBatch = value;
        originalFeeRate = tx.rate;
      }
    });

    // Nothing is replaceable, after all
    if (!originalTX) {
      this.logger.info(
        'Can not replace any pending TXs, redirecting to sendMany()');
      return this.sendMany(address, amount, orderID, abandoned);
    }

    this.logger.info(`Attempting to add orderID ${orderID} ` +
                     `to ${originalTX.txid} with RBF`);

    // Initialize new transaction
    const orderIDs = [];
    let total = 0;

    const requiredCoins = [];
    const inputs = [];
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
    const batch = abandoned.concat(originalBatch);
    for (const payout of batch) {
      const value = Amount.fromBTC(payout.amount).toValue();
      outputs.push({
        address: payout.address,
        value
      });
      orderIDs.push(payout.orderID);
      total += value;

      if (payout.requiredCoin) {
        requiredCoins.push(payout.requiredCoin);
      }
    }

    // Copy all inputs from original TX
    const originalMTX = MTX.fromRaw(originalTX.hex, 'hex');
    for (const input of originalMTX.inputs)
      inputs.push(input);

    // Compile!
    const mtx = new MTX({inputs, outputs});

    // Add required inputs to ensure reorg protection.
    for (const requiredCoin of requiredCoins) {
      const hash = Buffer.from(requiredCoin.txid, 'hex').reverse();
      const index = requiredCoin.index;
      // Only add each required input once!
      if (!mtx.view.hasEntry({hash, index})) {
        mtx.addOutpoint({hash, index});
      }
    }

    const hex = mtx.toRaw().toString('hex');

    // Let Bitcoin Core calculate the fee for this tx
    // as if it were not a replacement
    const fee_rate = await this.fees.getMinFee();
    let fundedTX;
    try {
      fundedTX = await this.client.execute('fundrawtransaction', [
        hex,
        {
          replaceable: true,
          minconf: 1, // do not add unconfirmed coins if more inputs are needed
          fee_rate    // sat/vB
          // feeRate  // BTC/kvB
        }
      ]);
    } catch (e) {
      this.logger.info(
        `fundrawtransaction failed to fund RBF batch: ${e.message}`);
        this.logger.info('Sending as a single payout instead');
        return this.sendOne(address, amount, orderID);
    }

    // Pay the fees of all replaced TXs
    // by subtracting that amount from change.
    // To do this using only bitcoind we need to
    // deconstruct the TX we already have,
    // tweak it, and then re-construct it.
    const finalHex = await this.subtractRBFFees(
      fundedTX,
      Amount.fromBTC(-originalTX.fee).toValue(),
      originalFeeRate); // BTC/kvB

    // Sign
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
      // Expected on regtest
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

    // Passed all sanity checks, send it!
    const txid = await this.client.execute(
      'sendrawtransaction',
      [signedTX.hex]);

    this.logger.info(`Replacer sent tx with sendRBF(): ${txid}`);

    // Does not write to disk, yet
    this.updateTXIDs(batch, txid);
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

  // fees in satoshis
  // originalFeeRate in BTC/kvB
  async subtractRBFFees(fundedTX, fees, originalFeeRate) {
    const mtx = MTX.fromRaw(fundedTX.hex, 'hex');

    // Ensure the TX we are creating has a change output
    assert(fundedTX.changepos >= 0);

    // Subtract extra fees from the change output
    // (denominated in satoshis)
    mtx.outputs[fundedTX.changepos].value -= fees;

    // Abide rule #6
    // If the new fee rate is still lower than the original,
    // recalculate the fee using the old rate and add the difference.
    // We shouldn't need to reconsider rules 3 and 4 again since
    // we have already included them and we are only increasing the fee now.

    // sats
    const totalFees = Amount.fromBTC(fundedTX.fee).toValue() + fees;

    // BTC/kvB
    const newFeeRate =
      this.fees.getBTCPerKiloVbyte(totalFees / mtx.getVirtualSize());

    if (newFeeRate < originalFeeRate) {
      this.logger.info('Compensating for rule 6: ' +
                       `increasing fee rate from ${newFeeRate} BTC/kvB ` +
                       `to > ${originalFeeRate} BTC/kvB`);

      // BTC
      const targetFee = (originalFeeRate + 1e-8)
                        * (mtx.getVirtualSize() / 1000);

      // sats
      const diff = Amount.fromBTC(targetFee).toValue() - totalFees;
      mtx.outputs[fundedTX.changepos].value -= diff;
    }

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
            tx.children = [];
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

          if (tx.confirmations === 0) {
            try {
              // Has anyone (including ourselves) spent any of these outputs?
              tx.children = await this.client.execute(
                'getmempooldescendants',
                [txid]);
            } catch (e) {
                this.logger.info(
                  `Could not getmempooldescendants for ${txid}: ${e}`);
            }
          }

          cache.set(txid, tx);
        }

        // TX details are an array of objects for each type "send" / "receive"
        // Ignore abandoned txid and continue
        for (const det of tx.details) {
          if (det.abandoned) {
            continue TXIDS;
          }
        }

        // Conflicting TX has been confirmed
        if (tx.confirmations < 0) {
          // When we replace a payout that was abandoned because its conflicting
          // TX was confirmed, we need to identify that confirmed conflict and
          // spend its change output when we retry the abandoned payout.
          // This prevents us paying the same request twice even after a reorg.
          for (const conflictingTXID of tx.walletconflicts) {
            // We might already have retrieved the conflict for another payout
            let conflict = cache.get(conflictingTXID);
            // Otherwise get it now from RPC
            if (!conflict) {
              conflict = await this.client.execute('gettransaction', [
                conflictingTXID,
                true, // include_watchonly
                true  // verbose: return object will have 'decoded' object
              ]);
            }
            // If we still can't find the conflict, abort --  and open an
            // issue in Bitcoin Core! How could we have a `walletconflict`
            // we can not retrieve?
            assert(
              conflict,
              `Could not retrieve walletconflict ${conflictingTXID} for ` +
              `${txid}`);
            // Store the conflict in the cache in case it comes up again
            // for another payout
            cache.set(conflictingTXID, conflict);

            // There might be more than one walletconflict, but we are only
            // concerned with a conflict that has been confirmed.
            // If conflicting TX has been confirmed, we MUST spend its change
            // when we re-send the abandoned payout. Otherwise a chain reorg
            // could end up confirming both the original and the re-send.
            if (conflict.confirmations > 0) {
              // It would be nice if Bitcoin Core made it easier to
              // determine the change output of a transaction from our wallet...
              for (let i = 0; i < conflict.decoded.vout.length; i++) {
                const vout = conflict.decoded.vout[i];
                const addr = vout.scriptPubKey.address;
                const info = await this.client.execute(
                  'getaddressinfo',
                  [addr]);
                if (info.ischange) {
                  // Okay we found it, we MUST spend this coin in this payout.
                  this.logger.info(
                    `Found confirmed conflict for ${txid}. ` +
                    `Re-sending abandoned payout orderID ${payout.orderID} ` +
                    `must spend outpoint ${conflictingTXID}:${i}`);
                  payout.requiredCoin = {
                    txid: conflictingTXID,
                    index: i
                  };
                  break;
                }
              }
              // If we couldn't determine the change output of the confirmed
              // conflict, we should abort because we can't garuntee reorg
              // protection. Optionally, we can just log this error and hope
              // for the best (no reorg).
              assert(
                payout.requiredCoin,
                'Could not determine change output for walletconflict ' +
                `${conflictingTXID} needed for payout orderID ` +
                `${payout.orderID} originally sent in ${txid}`);
            }
          }

          // If a conflicting transaction was confirmed we consider
          // this payout abandoned
          continue TXIDS;
        }

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
