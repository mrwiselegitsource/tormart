const axios = require('axios');
const BaseWalletProvider = require('./baseProvider');

class LtcWalletProvider extends BaseWalletProvider {
  constructor(rpcUrl, rpcUser, rpcPass, network = 'mainnet') {
    super('LTC', network);
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
          id: 'ltcWalletProvider',
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

  _ltcToLits(ltc) {
    return BigInt(Math.round(Number(ltc) * 100000000)).toString();
  }

  _litsToLtc(lits) {
    return (Number(lits) / 100000000).toFixed(8);
  }

  async getBalance() {
    try {
      const balances = await this._rpcCall('getbalances');
      return {
        total: this._ltcToLits(balances.mine.trusted + balances.mine.untrusted_pending),
        spendable: this._ltcToLits(balances.mine.trusted),
        pending: this._ltcToLits(balances.mine.untrusted_pending)
      };
    } catch (e) {
      // Fallback
      const balance = await this._rpcCall('getbalance');
      return {
        total: this._ltcToLits(balance),
        spendable: this._ltcToLits(balance),
        pending: '0'
      };
    }
  }

  async estimateFee(destination, amountSmallestUnit) {
    let feeRateLtcKb = 0.0001; // fallback
    try {
      const feeInfo = await this._rpcCall('estimatesmartfee', [6]); // target 6 blocks
      if (feeInfo.feerate) {
        feeRateLtcKb = feeInfo.feerate;
      }
    } catch (e) {
      // Keep fallback
    }
    
    let feeRateLitsKb = this._ltcToLits(feeRateLtcKb);
    
    // Typical tx size 250 bytes (0.25 kb)
    const feeLits = Math.floor(Number(feeRateLitsKb) * 0.25).toString();
    return {
      fee: feeLits,
      feeRate: Math.floor(Number(feeRateLitsKb) / 1000).toString() // lits/byte
    };
  }

  async signAndBroadcast(destination, amountSmallestUnit) {
    let unlocked = false;
    const passphrase = process.env.LTC_WALLET_PASSPHRASE;
    
    try {
      if (passphrase) {
        await this._rpcCall('walletpassphrase', [passphrase, 60]);
        unlocked = true;
      }
      
      const ltcAmount = Number(this._litsToLtc(amountSmallestUnit));
      const txid = await this._rpcCall('sendtoaddress', [destination, ltcAmount, "", "", false, true]);
      
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
        type: result.isvalid ? 'litecoin' : 'unknown',
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

module.exports = LtcWalletProvider;
