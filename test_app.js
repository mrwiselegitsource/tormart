const http = require('http');
const querystring = require('querystring');

function request(path, method = 'GET', data = null, cookie = '') {
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

        if (data) {
            req.write(querystring.stringify(data));
        }
        req.end();
    });
}

async function runTests() {
    try {
        console.log("Testing Registration...");
        const regRes = await request('/register', 'POST', { username: 'testvendor1', email: 'testvendor1@x.com', password: 'password123', captcha: 'dummy' });
        console.log("Registration Status:", regRes.statusCode);
        
        let cookie = '';
        if (regRes.headers['set-cookie']) {
            cookie = regRes.headers['set-cookie'][0].split(';')[0];
        }

        console.log("Testing Login...");
        const loginRes = await request('/login', 'POST', { username: 'testvendor1', password: 'password123' });
        console.log("Login Status:", loginRes.statusCode);
        if (loginRes.headers['set-cookie']) {
            cookie = loginRes.headers['set-cookie'][0].split(';')[0];
        }

        console.log("Testing Forum Access (Non-VIP)...");
        const forumRes = await request('/forum', 'GET', null, cookie);
        console.log("Forum HTML contains VIP gate?:", forumRes.body.includes('Exclusive Access Restricted'));
        
        console.log("Creating Vendor as Admin...");
        const adminRes = await request('/login', 'POST', { username: 'admin', password: 'password123' });
        let adminCookie = adminRes.headers['set-cookie'][0].split(';')[0];
        
        const createVendorRes = await request('/admin/vendors/create', 'POST', { username: 'testvendor2', password: 'password123', vendor_name: 'Vendor 2', vendor_description: 'Test' }, adminCookie);
        console.log("Create Vendor Status:", createVendorRes.statusCode);
        
        console.log("Login as new Vendor...");
        const vendorLoginRes = await request('/login', 'POST', { username: 'testvendor2', password: 'password123' });
        let vendorCookie = vendorLoginRes.headers['set-cookie'][0].split(';')[0];
        
        console.log("Testing Vendor Dashboard Access...");
        const vendorDashRes = await request('/vendor', 'GET', null, vendorCookie);
        console.log("Vendor Dashboard Access:", vendorDashRes.statusCode);
        
        console.log("Testing Forum Access for Vendor...");
        const vendorForumRes = await request('/forum', 'GET', null, vendorCookie);
        console.log("Forum HTML contains VIP gate?:", vendorForumRes.body.includes('Exclusive Access Restricted'));

    } catch (e) {
        console.error("Test failed:", e);
    }
}
runTests();
