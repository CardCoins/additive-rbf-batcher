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
the node and wallet are passed in as options.
For more details see [Configuration](#configuration)

Example code with some options set:

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
  dataDir: '~/.batcher'
};
const replacer = new Replacer(options);

// Send a payment
(async () => {
  await replacer.addPayment(
    'bcrt1q4kc7ax3ps66x680xq5pxaqnztjr9p57t7ryhaz', // customer address (string)
    0.00050000, // payout amount (float)
    'abc-123'   // unique payout ID (string)
  );
})();
```

## Configuration

All options are set as key-value pairs in an object passed as the only
argument to `new Replacer(options)`

| name | default | type | meaning |
|-|-|-|-|
| `network` | `"regtest"` | string | Bitcoin network, only used to name database |
| `port` | `18443` | number | RPC port to connect to Bitcoin Core |
| `username` | `"rpcuser"` | string | RPC username for Bitcoin Core |
| `password` | `"rpcpassword"` | string | RPC password for Bitcoin Core |
| `wallet` | `"wallet.dat"` | string | Name of Bitcoin Core wallet to use |
| `dataDir` | `./data` | string | Filesystem path to save application state |
| `logger` | *stdout* | object | Logger module with `info()` and `error()` functions |
| `fallbackMinFee` | `10` | number | Minimum fee rate in s/vB to use if all other fee estimation attempts fail |
| `estimateMode` | `"CONSERVATIVE"` | string | Fee estimation algorithm used by Bitcoin Core |
| `minFeeConfTarget` | `100` | number | Confimation block target used for minimum fee estimation |
| `maxFeeConfTarget` | `1` | number | Confirmation block target used to estimate max fee rate limit for RBF batches |
| `maxFeeMultiplier` | `4` | number | `estimatesmartfee` with `maxFeeConfTarget` result multiplier to compute rate limit for RBF batches |
| `maxFeeRate` | `500` | number | Maximum fee rate in s/vB to use as "absurd" hard limit for RBF batches |

### Explanation of fee options

The batcher will start by sending the first payout request as a single transaction,
using the fee rate provided by `rpc estimatesmartfee` with `minFeeConfTarget`, using
`fallbackMinFee` in case of error (i.e. on regtest). If this payout is still
unconfirmed when the next payout request is made, the first transaction will be
RBF'ed by a new transaction making both payouts. The new fee rate will be initialized
using the same parameters as before, but ALSO pay the entire total fee from the first
transaction as required by
[BIP125 rule #3](https://github.com/bitcoin/bips/blob/master/bip-0125.mediawiki#implementation-details).

This batching process will continue for every new payout request until the fee rate
of an RBF batch exceeds EITHER the fee rate provided by `rpc estimatesmartfee` with
`maxConfTarget` (multiplied by `maxFeeMultiplier`) OR the hard-coded "absurd" fee
limit set by `maxFeeRate`. In this case, the RBF batch is discarded and the new payout
request is sent as a single transaction paying only its own fee, thereby also starting
the next batch for future payouts.

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
