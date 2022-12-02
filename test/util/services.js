'use strict';

const assert = require('assert');
const {tmpdir} = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Replacer = require('../../lib/replacer');
const Client = require('../../lib/walletClient');
const Amount = require('../../build/amount');

class Services {
  constructor(options) {
    this.options = options;

    // this is what we're testing
    this.replacer = null;

    // child process
    this.bitcoind = null;

    // client with no wallet for generic node RPC calls
    this.client = new Client({...options, wallet: null});

    // clients with specified wallets for miner, app, and customers
    this.app =    new Client({...options, wallet: 'app'});
    this.miner =  new Client({...options, wallet: 'miner'});
    this.alice =  new Client({...options, wallet: 'alice'});
    this.bob =    new Client({...options, wallet: 'bob'});

    // incremented throughout the tests
    this.orderID = 0;

    // audit balance for each wallet
    this.expected = {
      app: {
        unconf: 0,
        conf: 0
      },
      alice: {
        unconf: 0,
        conf: 0
      },
      bob: {
        unconf: 0,
        conf: 0
      }
    };
  }

  async init() {
    if (!(await fs.existsSync(this.options.dataDir)))
      await fs.mkdirSync(this.options.dataDir);
    this.replacer = new Replacer(this.options);
  }

  async sendOrder(address, amount) {
    return this.replacer.addPayment(
      address,
      amount,
      this.orderID++
    );
  }

  async stopBitcoin() {
    if (!this.bitcoind || this.bitcoind.exitCode != null)
      return;

    const waiter = new Promise((resolve) => {
      this.bitcoind.once('exit', () => {
        resolve();
      });
    });

    await this.client.execute('stop', []);
    await waiter;

    this.bitcoind = null;
  }

  async startBitcoin(extraArgs) {
    if (this.bitcoind)
      throw new Error('bitcoind already running');

    const opts = this.options;
    const args = [
      `-datadir=${opts.dataDir}`,
      `-rpcuser=${opts.username}`,
      `-rpcpassword=${opts.password}`,
      `-rpcport=${opts.port}`,
      '-regtest',
      '-fallbackfee=0.00010000',
      '-persistmempool=0',
      // These will be ignored until created, but required for restarts
      '-wallet=app',
      '-wallet=miner',
      '-wallet=alice',
      '-wallet=bob'
    ];

    // optional
    // args.push('-debug=wallet');
    // args.push('-debug=rpc');

    if (extraArgs) {
      for (const arg of extraArgs)
      args.push(arg);
    }

    this.bitcoind = this.spawnWithOutput(
      'bitcoind',
      args,
      {stdio: 'pipe', detached: false}
    );

    await this.client.waitForRPC('getblockcount');

    try {
      await this.client.execute('createwallet', ['app']);
      await this.client.execute('createwallet', ['miner']);
      await this.client.execute('createwallet', ['alice']);
      await this.client.execute('createwallet', ['bob']);
    } catch (e) {
      // Ignore "database already exists" error
    }
  }

  spawnWithOutput(cmd, args, opts) {
    const proc = cp.spawn(cmd, args, opts);
    proc.stdout.on('data', (data) => {
      this.printStdout(data.toString());
    });
    proc.stderr.on('data', (data) => {
      this.printStdout(data.toString());
    });
    proc.on('error', (data) => {
      this.printStdout(data.toString());
    });
    return proc;
  }

  printStdout(str) {
    // Prints in blue
    console.log(`\x1b[${34}m%s\x1b[0m`, str);
  }

  // Update expected balances for audit
  unconf(wallet, amt) {
    this.expected[wallet].unconf += Amount.fromBTC(amt).toValue();
  }

  conf(wallet, amt) {
    this.expected[wallet].unconf -= Amount.fromBTC(amt).toValue();
    this.expected[wallet].conf += Amount.fromBTC(amt).toValue();
  }

  async check(wallet) {
    const actualConf = await this[wallet].getBalance();
    const actualUnconf = await this[wallet].getUnconfirmedBalance();
    assert.strictEqual(
      Amount.fromBTC(actualConf).toValue(),
      this.expected[wallet].conf
    );
    assert.strictEqual(
      Amount.fromBTC(actualUnconf).toValue(),
      this.expected[wallet].unconf
    );
  }

  static tmpdir() {
    return path.join(tmpdir(), 'cardcoins_test_' + String(Date.now()));
  }
}

module.exports = Services;
