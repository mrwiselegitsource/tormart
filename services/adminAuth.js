const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ADMIN_ROLES = {
  VIEWER: 1,
  TREASURY_OPERATOR: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4
};

const AUDIT_ACTIONS = {
  ADMIN_LOGIN: 'ADMIN_LOGIN',
  ADMIN_LOGIN_FAILED: 'ADMIN_LOGIN_FAILED',
  ADMIN_LOGOUT: 'ADMIN_LOGOUT',
  WITHDRAWAL_CREATED: 'WITHDRAWAL_CREATED',
  WITHDRAWAL_APPROVED: 'WITHDRAWAL_APPROVED',
  WITHDRAWAL_REJECTED: 'WITHDRAWAL_REJECTED',
  WITHDRAWAL_SIGNING_STARTED: 'WITHDRAWAL_SIGNING_STARTED',
  WITHDRAWAL_SIGNED: 'WITHDRAWAL_SIGNED',
  WITHDRAWAL_BROADCAST: 'WITHDRAWAL_BROADCAST',
  WITHDRAWAL_FAILED: 'WITHDRAWAL_FAILED',
  TREASURY_PAUSED: 'TREASURY_PAUSED',
  TREASURY_RESUMED: 'TREASURY_RESUMED',
  WALLET_STATUS_CHANGED: 'WALLET_STATUS_CHANGED',
  ADDRESS_ALLOCATED: 'ADDRESS_ALLOCATED',
  SECURITY_SETTING_CHANGED: 'SECURITY_SETTING_CHANGED',
  STEP_UP_AUTH_SUCCESS: 'STEP_UP_AUTH_SUCCESS',
  STEP_UP_AUTH_FAILED: 'STEP_UP_AUTH_FAILED'
};

class LoginRateLimiter {
  constructor(maxAttempts = 5, lockoutDurationMs = 15 * 60 * 1000) {
    this.attempts = new Map();
    this.maxAttempts = maxAttempts;
    this.lockoutDurationMs = lockoutDurationMs;
    
    // Cleanup interval
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }
  
  check(ip) {
    const record = this.attempts.get(ip);
    const now = Date.now();
    
    if (record && record.lockedUntil && now < record.lockedUntil) {
      const retryAfter = Math.ceil((record.lockedUntil - now) / 1000);
      return { allowed: false, remaining: 0, lockedUntil: record.lockedUntil, retryAfter };
    }
    
    if (record && record.lockedUntil && now >= record.lockedUntil) {
      this.attempts.delete(ip);
      return { allowed: true, remaining: this.maxAttempts };
    }
    
    const count = record ? record.count : 0;
    return { allowed: true, remaining: this.maxAttempts - count };
  }
  
  recordFailure(ip) {
    const now = Date.now();
    let record = this.attempts.get(ip);
    
    if (!record || (record.lockedUntil && now >= record.lockedUntil)) {
      record = { count: 1, lockedUntil: null };
    } else {
      record.count += 1;
    }
    
    if (record.count >= this.maxAttempts) {
      record.lockedUntil = now + this.lockoutDurationMs;
    }
    
    this.attempts.set(ip, record);
    return this.check(ip);
  }
  
  recordSuccess(ip) {
    this.attempts.delete(ip);
  }
  
  cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.attempts.entries()) {
      if (record.lockedUntil && now >= record.lockedUntil) {
        this.attempts.delete(ip);
      }
    }
  }
}

class AuditLogger {
  static sanitizeMetadata(metadata) {
    if (!metadata) return null;
    let sanitized;
    try {
      sanitized = JSON.parse(JSON.stringify(metadata));
    } catch (e) {
      return null;
    }
    
    const sensitiveKeys = ['password', 'privatekey', 'seed', 'secret', 'token', 'key'];
    
    const sanitizeObj = (obj) => {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (typeof obj[key] === 'object' && obj[key] !== null) {
            sanitizeObj(obj[key]);
          } else if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
            obj[key] = '[REDACTED]';
          }
        }
      }
    };
    
    sanitizeObj(sanitized);
    return JSON.stringify(sanitized);
  }

  static async logAudit(db, { adminId, action, resourceType = null, resourceId = null, ipAddress = null, userAgent = null, result = 'SUCCESS', failureReason = null, metadata = null }) {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now();
      const safeMetadata = AuditLogger.sanitizeMetadata(metadata);
      
      const sql = `
        INSERT INTO admin_audit_log 
        (admin_id, action, resource_type, resource_id, ip_address, user_agent, result, failure_reason, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      db.run(sql, [adminId, action, resourceType, resourceId, ipAddress, userAgent, result, failureReason, safeMetadata, timestamp], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  static async log(...args) {
    return this.logAudit(...args);
  }
}

class StepUpAuth {
  static createStepUpChallenge(session) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 5 * 60 * 1000; // 5 minutes
    
    session.stepUp = {
      token,
      expiresAt: expiry
    };
    
    return token;
  }
  
  static verifyStepUp(session) {
    if (!session || !session.stepUp) {
      return false;
    }
    
    if (Date.now() > session.stepUp.expiresAt) {
      delete session.stepUp;
      return false;
    }
    
    return true;
  }
  
  static async validateStepUpPassword(db, userId, password) {
    return new Promise((resolve, reject) => {
      db.get("SELECT password FROM users WHERE id = ? AND role = 'admin'", [userId], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(false);
        
        bcrypt.compare(password, row.password, (err, isMatch) => {
          if (err) return reject(err);
          resolve(isMatch);
        });
      });
    });
  }
}

class RoleManager {
  static hasMinRole(userRoleName, requiredRoleName) {
    const userRoleValue = ADMIN_ROLES[userRoleName] || 0;
    const requiredRoleValue = ADMIN_ROLES[requiredRoleName] || 0;
    
    return userRoleValue >= requiredRoleValue;
  }
  
  static requireAdminRole(minRoleName) {
    return (req, res, next) => {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      
      const adminRole = req.session.user.admin_role || 'VIEWER';
      
      if (!RoleManager.hasMinRole(adminRole, minRoleName)) {
        return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
      }
      
      next();
    };
  }
}

module.exports = {
  LoginRateLimiter,
  AuditLogger,
  StepUpAuth,
  RoleManager,
  ADMIN_ROLES,
  AUDIT_ACTIONS
};
