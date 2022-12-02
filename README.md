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

Once installed (in developer mode), the test suite can be run with the command:

```
npm run test
```

Individual test files can be run (for example):

```
npm run test-file test/simple-send-test.js
```

The test spawns a Bitcoin Core instance with a temporary data directory. It has
a `sendOrder()` function that mimics that call sent by your application
to the RBF batcher.

The test suite runs (at least) the following scenarios:
- Alice requests a payout, it's sent and confirmed
- Bob requests a payout, it's sent and confirmed
- Alice requests a payout but it is abandoned (dropped from mempool)
  - Then Bob requests a payout, and it is batched with Alice's payout
- Alice requests 4 payouts all to different addresses
  - Each request RBF-batches together the previous payouts
  - All 4 payouts end up in one single batch transaction and confirmed
- Alice requests 4 payouts all to the SAME addresses
  - Each request RBF-batches together the previous payouts
  - All 4 payouts end up in one single batch transaction and confirmed
  - The transaction is checked to ensure that it had distinct outputs for each order
- 6 Blocks go by before Alice requests another payout
  - This ensures that the outputs.json array is cleared of payouts with >6 confirmations
- Bob requests a payout, but before it is confirmed the system reboots
  - This ensures that the Replacer reads the current outputs.json file on boot
  - Bob requests a second payout and it is RBF-batched together with the first
- Alice and Bob request payouts but the replaced transaction gets confirmed first
  - The RBF transaction is treated like it abandoned
  - When the next payout is requested, the abandoned payout is batched-in
- Request so many payouts that multiple batches are created into the mempool
