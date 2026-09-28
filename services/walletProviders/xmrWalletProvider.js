const axios = require('axios');
const BaseWalletProvider = require('./baseProvider');

class XmrWalletProvider extends BaseWalletProvider {
  constructor(rpcUrl, rpcUser, rpcPass, network = 'mainnet') {
    super('XMR', network);
    this.rpcUrl = rpcUrl; // e.g. http://127.0.0.1:18082/json_rpc
    this.rpcUser = rpcUser;
    this.rpcPass = rpcPass;
  }

  async _rpcCall(method, params = {}) {
    try {
      const auth = this.rpcUser && this.rpcPass ? { username: this.rpcUser, password: this.rpcPass } : undefined;
      const config = {
        headers: { 'Content-Type': 'application/json' }
      };
      if (auth) {
        config.auth = auth;
      }
      
      const response = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: '2.0',
          id: '0',
          method: method,
          params: params
        },
        config
      );
      
      if (response.data.error) {
        throw new Error(response.data.error.message);
      }
      return response.data.result;
    } catch (error) {
      if (error.response && error.response.data && error.response.data.error) {
        throw new Error(`RPC Error: ${error.response.data.error.message}`);
      }
      throw new Error(`RPC Error: ${error.message}`);
    }
  }

  async getBalance() {
    try {
      const result = await this._rpcCall('get_balance');
      return {
        total: result.balance.toString(),
        spendable: result.unlocked_balance.toString(),
        pending: (result.balance - result.unlocked_balance).toString()
      };
    } catch (error) {
      throw error;
    }
  }

  async estimateFee(destination, amountSmallestUnit) {
    // Monero dynamic fee calculation is handled by the wallet during transfer,
    // so we return an estimate based on typical Monero tx fees.
    return {
      fee: '2000000000', // 0.002 XMR typical estimate
      feeRate: '0'
    };
  }

  async signAndBroadcast(destination, amountSmallestUnit) {
    try {
      const result = await this._rpcCall('transfer', {
        destinations: [{
          amount: Number(amountSmallestUnit),
          address: destination
        }],
        do_not_relay: false
      });
      
      return {
        txid: result.tx_hash,
        fee: result.fee.toString()
      };
    } catch (error) {
      throw error;
    }
  }

  async validateAddress(address) {
    try {
      const result = await this._rpcCall('validate_address', { address: address });
      return {
        valid: result.valid,
        network: this.network,
        type: result.valid ? 'monero' : 'unknown',
        error: result.valid ? null : 'Invalid address'
      };
    } catch (error) {
      return { valid: false, network: this.network, type: 'unknown', error: error.message };
    }
  }

  async getHealth() {
    try {
      const result = await this._rpcCall('get_height');
      return {
        status: 'HEALTHY',
        blockHeight: result.height,
        syncProgress: 1.0,
        error: null
      };
    } catch (error) {
      return { status: 'ERROR', blockHeight: null, syncProgress: null, error: error.message };
    }
  }
}

module.exports = XmrWalletProvider;
