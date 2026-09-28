const { PaymentService } = require('./services/paymentService');
const { PaymentWorker } = require('./services/paymentWorker');
const { BitcoinAdapter } = require('./blockchain/btc');
const { LitecoinAdapter } = require('./blockchain/ltc');
const { EthereumAdapter } = require('./blockchain/eth');
const { BitcoinCashAdapter } = require('./blockchain/bch');
const { MoneroAdapter } = require('./blockchain/xmr');

// Just a test to see if we can instantiate these
console.log("Imports successful");
