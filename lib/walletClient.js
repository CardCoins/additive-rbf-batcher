'use strict';

const {Client} = require('bcurl');

class walletClient extends Client {
  constructor(options) {
    super(options);
    this.endpoint = '/';
    if (options.wallet)
      this.endpoint = `wallet/${options.wallet}`;
  }

  async execute(method, params) {
    return super.execute(this.endpoint, method, params);
  }

  async waitForRPC(method, params = [], value) {
    let interval;
    let count = 20; // 5 seconds
    return new Promise(async (resolve, reject) => {
      interval = setInterval(async () => {
        if (!count--) {
          clearInterval(interval);
          reject(Error('timeout waiting for RPC'));
        }

        try {
          const answer = await this.execute(method, params);
          if (answer === value || value == null) {
            clearInterval(interval);
            resolve(answer);
          }
        } catch (e) {
          // Ignore RPC errors for now,
          // they are expected until bitcoind is ready
        }
      }, 250);
    });
  }

  async getNewAddress(args = []) {
    return this.execute('getnewaddress', args);
  }

  async generate(n) {
    const start = await super.execute('/', 'getblockcount', []);
    const addr = await this.getNewAddress();
    super.execute('/', 'generatetoaddress', [n, addr]);
    await this.waitForRPC('getblockcount', [], start + n);
  }

  async abandonTransaction(txid) {
    return this.execute('abandontransaction', [txid]);
  }

  async getTransaction(txid) {
    return this.execute(
      'gettransaction',
      [
        txid,
        true, // include watch-only
        true  // verbose
      ]
    );
  }

  async getBalance() {
    return this.execute('getbalance', []);
  }

  async getUnconfirmedBalance() {
    return this.execute('getunconfirmedbalance', []);
  }

  async sendRawTransaction(hex) {
    return this.execute('sendrawtransaction', [hex]);
  }

  async sendMany(obj) {
    return this.execute('sendmany', ['', obj]);
  }
}

module.exports = walletClient;
