const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('neobyte.db');
const http = require('http');
const querystring = require('querystring');
const crypto = require('crypto');

async function request(path, method = 'GET', data = null, cookie = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: '127.0.0.1',
            port: 3000,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookie
            }
        };

        const req = http.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });

        req.on('error', reject);
        if (data) req.write(querystring.stringify(data));
        req.end();
    });
}

db.serialize(async () => {
    // 1. Get a CSRF token and CAPTCHA bypass? 
    // We can just update the DB manually for testing the login to get a cookie.
    
    // Instead of doing HTTP, let's just inspect the database.
    db.all("SELECT * FROM referral_links", [], (err, rows) => {
        console.log("Referral Links:", rows);
    });

    db.all("SELECT id, username, referred_by FROM users WHERE referred_by IS NOT NULL", [], (err, rows) => {
        console.log("Users with referred_by:", rows);
    });
});
