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

class Replacer {
  constructor(options) {
    this.options = options;

    /*
     * Default options
     */

    // Bitcoin Core node
    this.network = 'regtest';
    this.port = 18443;
    this.username = 'rpcuser';
    this.password = 'rpcpassword';
    this.wallet = 'wallet.dat';

    // Minimum fee: initial TX before RBF bumping and increment value to bump
    this.confTarget = 100;
    this.estimateMode = 'CONSERVATIVE';
    // Maximum fee: abort if batch fee exceeds this amount and send as single
    this.maxFeeRate = 0.00050000; // hard-coded limit
    this.maxFeeConfTarget = 3;    // limit based on rpc estimatesmartfee

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

    if (options.confTarget != null) {
      assert((options.confTarget >>> 0) === options.confTarget);
      this.confTarget = options.confTarget;
    }

    if (options.estimateMode != null) {
      assert(typeof options.estimateMode === 'string');
      this.estimateMode = options.estimateMode;
    }

    if (options.maxFeeRate != null) {
      assert(typeof options.maxFeeRate === 'number');
      assert(options.maxFeeRate < 1);
      assert(options.maxFeeRate > 0);
      this.maxFeeRate = options.maxFeeRate;
    }

    if (options.maxFeeConfTarget != null) {
      assert((options.maxFeeConfTarget >>> 0) === options.maxFeeConfTarget);
      this.maxFeeConfTarget = options.maxFeeConfTarget;
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

    if (!replaceable.length) {
      if (!abandoned.length) {
        // Mempool is empty and nothing is pending
        return this.sendOne(address, amount, orderID);
      } else {
        // Mempool is empty but some payout needs to start over (abandoned?)
        return this.sendMany(address, amount, orderID, abandoned);
      }
    } else {
      // Mempool is not empty, batch and replace-by-fee
      return this.sendRBF(address, amount, orderID, abandoned, replaceable);
    }
  }

  async sendOne(address, amount, orderID) {
    const orderIDs = [];
    let txid = null;
    let total = 0;

    try {
      txid = await this.client.execute('sendtoaddress', [
        address,
        amount,
        null,   // comment
        null,   // comment_to
        false,  // subtractfeefromamount
        true,   // replaceable
        this.confTarget,
        this.estimateMode
      ]);
      orderIDs.push(orderID);
      total += amount;

      this.logger.info(`Replacer sent tx: ${txid}`);

      this.addNewPayout({
        txids: [txid],
        orderID,
        address,
        amount,
        block: null,
        confirmations: 0
      });
    } catch (error) {
      this.logger.error('Replacer error:');
      this.logger.error(error);
      this.logger.error(JSON.stringify(error));
      throw error;
    }

    return {
      transaction_id: txid,
      order_ids: orderIDs,
      total
    };
  }

  async sendMany(address, amount, orderID, abandoned) {
    const orderIDs = [];
    let txid = null;
    let total = 0;

    const outpoints = []; // to be converted into inputs
    const outputs = [];

    // Add output for the new payment
    outputs.push({
      address,
      value: Amount.fromBTC(amount).toValue()
    });
    orderIDs.push(orderID);
    total += amount;

    // Combine with outputs from abandoned payments
    for (const payout of abandoned) {
      outputs.push({
        address: payout.address,
        value: Amount.fromBTC(payout.amount).toValue()
      });
      orderIDs.push(payout.orderID);
      total += payout.amount;

      if (payout.requiredCoin) {
        // TODO: avoid adding same input more than once
        // I do not think bcoin MTX handles this for us
        outpoints.push({
          hash: Buffer.from(payout.requiredCoin.txid, 'hex').reverse(),
          index: payout.requiredCoin.n
        });
      }
    }

    try {
      const mtx = new MTX({outputs});
      for (const outpoint of outpoints)
        mtx.addOutpoint(outpoint);
      const hex = mtx.toRaw().toString('hex');

      const fundedTX = await this.client.execute('fundrawtransaction', [
        hex,
        {
          replaceable: true,
          conf_target: this.confTarget,
          estimate_mode: this.estimateMode
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

      this.logger.info(`Replacer sent tx: ${txid}`);

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
    } catch (error) {
      this.logger.error('Replacer error:');
      this.logger.error(error);
      this.logger.error(JSON.stringify(error));
      throw error;
    }

    return {
      transaction_id: txid,
      order_ids: orderIDs,
      total
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
    outputs.push({
      address,
      value: Amount.fromBTC(amount).toValue()
    });
    orderIDs.push(orderID);
    total += amount;

    // Combine with outputs from abandoned & replaceable payments
    for (const payout of abandoned.concat(replaceable)) {
      outputs.push({
        address: payout.address,
        value: Amount.fromBTC(payout.amount).toValue()
      });
      orderIDs.push(payout.orderID);
      total += payout.amount;
    }

    try {
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

        this.logger.info(
          `Found ${txMap.size} replaceable TXs in mempool. ` +
          `Attempting to add orderID ${orderID} ` +
          `to batch with ${smallestBatch.length} existing payouts.`
        );

        // Recurse!
        return this.sendRBF(address, amount, orderID, abandoned, smallestBatch);
      }

      const inputs = [];
      for (const [, input] of inputMap)
        inputs.push(input);

      const mtx = new MTX({inputs, outputs});
      const hex = mtx.toRaw().toString('hex');

      // Let Bitcoin Core calculate the fee for this tx
      // as if it were not a replacement
      const fundedTX = await this.client.execute('fundrawtransaction', [
        hex,
        {
          replaceable: true,
          conf_target: this.confTargetRBF,
          estimate_mode: this.estimateModeRBF
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
      const {feerate: saneFee} = await this.client.execute('estimatesmartfee', [
        this.maxFeeConfTarget,
        this.estimateMode
      ]);

      // On regtest, estimatesmartfee may not work at all
      if (saneFee) {
        const test1 = await this.client.execute('testmempoolaccept', [
          [signedTX.hex],
          saneFee
        ]);

        if (!test1[0].allowed) {
          this.logger.info(
            'RBF batch TX failed check against estimated fee rate of ' +
            `${saneFee}, details: ` +
            test1[0]['reject-reason'] + ' ' +
            'Sending as a single payout instead'
          );
          return this.sendOne(address, amount, orderID);
        }
      } else {
        this.logger.info('estimatesmartfee failed, skipping test.');
      }

      // Make sure we don't pay an absurd fee based on option set in index.js
      const test2 = await this.client.execute('testmempoolaccept', [
        [signedTX.hex],
        this.maxFeeRate
      ]);

      if (!test2[0].allowed) {
        this.logger.info(
          'RBF batch TX failed check against maxFeeRate option of ' +
          `${this.maxFeeRate}, details: ` +
          test2[0]['reject-reason'] + ' ' +
          'Sending as single payout instead'
        );
        return this.sendOne(address, amount, orderID);
      } else {
        this.logger.info('RBF batch TX passed maxFeeRate check');
      }

      txid = await this.client.execute('sendrawtransaction', [signedTX.hex]);

      this.logger.info(`Replacer sent tx: ${txid}`);

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
    } catch (error) {
      this.logger.error('Replacer error:');
      this.logger.error(error);
      this.logger.error(JSON.stringify(error));
      throw error;
    }

    return {
      transaction_id: txid,
      order_ids: orderIDs,
      total
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

      // Clear old state
      // delete payout.requiredCoin;

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

        // Conflicting TX has been confirmed
        if (tx.confirmations < 0) {
          // When we replace a payout that was abandoned because its conflicting
          // TX was confirmed, we need to identify that confirmed conflict and
          // spend its change output when we retry the abandoned payout.
          // This prevents us paying the same request twice even after a reorg.
          //   <!> This feature is still experimental so we will <!>
          //   <!> assert our assumptions and let errors abort.  <!>
          for (const conflictingTXID of tx.walletconflicts) {
            let conflict = cache.get(conflictingTXID);
            if (!conflict) {
              conflict = await this.client.execute('gettransaction', [
                conflictingTXID,
                true, // include_watchonly
                true  // verbose: return object will have 'decoded' object
              ]);
            }
            assert(conflict);
            cache.set(conflictingTXID, conflict);

            // If conflicting TX has been confirmed, we MUST spend its change.
            if (conflict.confirmations > 0) {
              // Find the change output by removing all "send" outputs
              for (const detail of conflict.details.reverse()) {
                assert(detail.category === 'send');
                conflict.decoded.vout.splice(detail.vout, 1);
              }
              assert(conflict.decoded.vout.length === 1);
              payout.requiredCoin = {
                txid: conflictingTXID,
                ...conflict.decoded.vout[0]
              };
            }
          }

          // We consider this payout abandoned, ignore this txid and continue
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
        if (payout.confirmations > 0) {
          // Don't need this anymore
          delete payout.requiredCoin;

          continue PAYOUTS;
        }

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
