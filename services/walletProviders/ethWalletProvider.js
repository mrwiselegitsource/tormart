const { ethers } = require('ethers');
const BaseWalletProvider = require('./baseProvider');

class EthWalletProvider extends BaseWalletProvider {
  constructor(rpcUrl, network = 'mainnet') {
    super('ETH', network);
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    
    const privateKey = process.env.ETH_SIGNING_KEY;
    if (privateKey) {
      this.wallet = new ethers.Wallet(privateKey, this.provider);
    }
  }

  async getBalance() {
    if (!this.wallet) throw new Error('Wallet not initialized (missing ETH_SIGNING_KEY)');
    try {
      const balance = await this.provider.getBalance(this.wallet.address);
      return {
        total: balance.toString(),
        spendable: balance.toString(),
        pending: '0'
      };
    } catch (error) {
      throw new Error(`RPC Error: ${error.message}`);
    }
  }

  async estimateFee(destination, amountSmallestUnit) {
    if (!this.wallet) throw new Error('Wallet not initialized (missing ETH_SIGNING_KEY)');
    try {
      const tx = {
        to: destination,
        value: BigInt(amountSmallestUnit)
      };
      
      const gasLimit = await this.provider.estimateGas({
        ...tx,
        from: this.wallet.address
      });
      
      const feeData = await this.provider.getFeeData();
      
      // Calculate fee for EIP-1559 or legacy
      const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || 0n;
      const fee = gasLimit * maxFeePerGas;
      
      return {
        fee: fee.toString(),
        feeRate: maxFeePerGas.toString()
      };
    } catch (error) {
      throw new Error(`RPC Error: ${error.message}`);
    }
  }

  async signAndBroadcast(destination, amountSmallestUnit) {
    if (!this.wallet) throw new Error('Wallet not initialized (missing ETH_SIGNING_KEY)');
    try {
      const tx = {
        to: destination,
        value: BigInt(amountSmallestUnit)
      };
      
      const txResponse = await this.wallet.sendTransaction(tx);
      return {
        txid: txResponse.hash,
        fee: '0' // Final fee known after mining
      };
    } catch (error) {
      throw new Error(`RPC Error: ${error.message}`);
    }
  }

  async validateAddress(address) {
    try {
      const isValid = ethers.isAddress(address);
      return {
        valid: isValid,
        network: this.network,
        type: isValid ? 'ethereum' : 'unknown',
        error: isValid ? null : 'Invalid Ethereum address'
      };
    } catch (error) {
      return { valid: false, network: this.network, type: 'unknown', error: error.message };
    }
  }

  async getHealth() {
    try {
      // Just check if we can get the network and block number
      await this.provider.getNetwork();
      const blockHeight = await this.provider.getBlockNumber();
      return {
        status: 'HEALTHY',
        blockHeight: blockHeight,
        syncProgress: 1.0,
        error: null
      };
    } catch (error) {
      return { status: 'ERROR', blockHeight: null, syncProgress: null, error: error.message };
    }
  }
}

module.exports = EthWalletProvider;
