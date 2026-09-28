class BaseWalletProvider {
  constructor(currency, network) {
    this.currency = currency;
    this.network = network;
  }

  async getBalance() {
    throw new Error('Not implemented');
  }

  async estimateFee(destination, amountSmallestUnit) {
    throw new Error('Not implemented');
  }

  async signAndBroadcast(destination, amountSmallestUnit) {
    throw new Error('Not implemented');
  }

  async validateAddress(address) {
    throw new Error('Not implemented');
  }

  async getHealth() {
    throw new Error('Not implemented');
  }
}

module.exports = BaseWalletProvider;
