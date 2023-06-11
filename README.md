# Cardcoins Additive RBF Batcher


## Explanations

[Bitcoin OpTech Field Report: Using RBF and Additive Batching](https://bitcoinops.org/en/cardcoins-rbf-batching/)

[RBF Batching at CardCoins: Diving into the Mempool’s Dark Reorg Forest](https://blog.cardcoins.co/rbf-batching-at-cardcoins-diving-into-the-mempool-s-dark-reorg-forest)


## Installation

```
git clone https://github.com/CardCoins/additive-rbf-batcher
cd additive-rbf-batcher
npm install --omit=dev
```

## Usage

The batcher expects a running local instance of Bitcoin Core. RPC details for
the node and wallet are passed in as options. For more details see `replacer.js`

Example code with options:

```js
// Require
const Replacer = require('additive-rbf-batcher');

// Configure
const options = {
  network: 'regtest',
  username: 'rpcuser',
  password: 'rpcpassword',
  wallet: 'hot',
  port: 18443,
  confTarget: 3,
  estimateMode: 'CONSERVATIVE',
  maxFeeRate: 0.00050000,
  maxFeeConfTarget: 3,
  dataDir: '~/.batcher',
  logger: logger // your application logging module with info() and error() functions
};
const replacer = new Replacer(options);

// Send a payment
(async () => {
  await replacer.addPayment(
    'bcrt1q4kc7ax3ps66x680xq5pxaqnztjr9p57t7ryhaz', // customer address
    0.00050000, // payout amount
    'abc-123'   // unique payout ID
  );
})();
```

## Dependencies

This package was designed to have minimal dependencies. It relies on simple,
security-hardened modules from [bcoin](https://github.com/bcoin-org/bcoin)
which by design do not have any external dependencies themselves.

The entire bcoin library plus its native add-on modules are overkill for this
package so only the modules that are needed are included
(in the [/build](/build) directory). To re-build these modules yourself,
see the [Contributing](#contributing) section below.

## Contributing

Developers can install the package **without** `--omit=dev` to install the full
bcoin library and the test runner. To rebuild the selected bcoin modules, execute:

```
npm run build
```

## Testing

The tests spawn a Bitcoin Core instance with a temporary data directory. It has
a `sendOrder()` function that mimics that call sent by your application
to the RBF batcher.

Once installed (in developer mode), the test suite can be run with the command:

```
npm run test
```

Individual test files can be run (for example):

```
npm run test-file test/simple-send-test.js
```

By default, Bitcoin Core logs are output (in blue) along with the replacer
logger output. Bitcoin Core log output can be minimized by prepending any test
command with the environment variable `QUIET=1`:

```
QUIET=1 npm run test
```

