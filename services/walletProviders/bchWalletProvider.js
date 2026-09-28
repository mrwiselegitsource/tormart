const axios = require('axios');
const BaseWalletProvider = require('./baseProvider');

class BchWalletProvider extends BaseWalletProvider {
  constructor(rpcUrl, rpcUser, rpcPass, network = 'mainnet') {
    super('BCH', network);
    this.rpcUrl = rpcUrl;
    this.rpcUser = rpcUser;
    this.rpcPass = rpcPass;
  }

  async _rpcCall(method, params = []) {
    try {
      const response = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: '1.0',
          id: 'bchWalletProvider',
          method: method,
          params: params
        },
        {
          auth: {
            username: this.rpcUser,
            password: this.rpcPass
          }
        }
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

  _bchToSats(bch) {
    return BigInt(Math.round(Number(bch) * 100000000)).toString();
  }

  _satsToBch(sats) {
    return (Number(sats) / 100000000).toFixed(8);
  }

  async getBalance() {
    try {
      const balances = await this._rpcCall('getbalances');
      return {
        total: this._bchToSats(balances.mine.trusted + balances.mine.untrusted_pending),
        spendable: this._bchToSats(balances.mine.trusted),
        pending: this._bchToSats(balances.mine.untrusted_pending)
      };
    } catch (e) {
      // Fallback
      const balance = await this._rpcCall('getbalance');
      return {
        total: this._bchToSats(balance),
        spendable: this._bchToSats(balance),
        pending: '0'
      };
    }
  }

  async estimateFee(destination, amountSmallestUnit) {
    let feeRateBchKb = 0.0001; // fallback
    try {
      const feeInfo = await this._rpcCall('estimatesmartfee', [6]); // target 6 blocks
      if (feeInfo.feerate) {
        feeRateBchKb = feeInfo.feerate;
      }
    } catch (e) {
      // Keep fallback
    }
    
    let feeRateSatsKb = this._bchToSats(feeRateBchKb);
    
    // Typical tx size 250 bytes (0.25 kb)
    const feeSats = Math.floor(Number(feeRateSatsKb) * 0.25).toString();
    return {
      fee: feeSats,
      feeRate: Math.floor(Number(feeRateSatsKb) / 1000).toString() // sats/byte
    };
  }

  async signAndBroadcast(destination, amountSmallestUnit) {
    let unlocked = false;
    const passphrase = process.env.BCH_WALLET_PASSPHRASE;
    
    try {
      if (passphrase) {
        await this._rpcCall('walletpassphrase', [passphrase, 60]);
        unlocked = true;
      }
      
      const bchAmount = Number(this._satsToBch(amountSmallestUnit));
      const txid = await this._rpcCall('sendtoaddress', [destination, bchAmount, "", "", false, true]);
      
      if (unlocked) {
        await this._rpcCall('walletlock');
      }
      
      return { txid, fee: '0' }; // Exact fee determined by wallet
    } catch (error) {
      if (unlocked) {
        try { await this._rpcCall('walletlock'); } catch(e) {}
      }
      throw error;
    }
  }

  async validateAddress(address) {
    try {
      const result = await this._rpcCall('validateaddress', [address]);
      return {
        valid: result.isvalid,
        network: this.network,
        type: result.isvalid ? 'bitcoincash' : 'unknown',
        error: result.isvalid ? null : 'Invalid address'
      };
    } catch (error) {
      return { valid: false, network: this.network, type: 'unknown', error: error.message };
    }
  }

  async getHealth() {
    try {
      const info = await this._rpcCall('getblockchaininfo');
      return {
        status: info.initialblockdownload ? 'SYNCING' : 'HEALTHY',
        blockHeight: info.blocks,
        syncProgress: info.verificationprogress,
        error: null
      };
    } catch (error) {
      return { status: 'ERROR', blockHeight: null, syncProgress: null, error: error.message };
    }
  }
}

module.exports = BchWalletProvider;
