const axios = require('axios');
const FormData = require('form-data');

async function test() {
    // 1. Register a new user
    const username = 'testuser_' + Date.now();
    console.log("Registering", username);
    const resReg = await axios.post('http://localhost:3000/register', new URLSearchParams({
        username: username,
        password: 'password123',
        role: 'buyer'
    }), { validateStatus: () => true, maxRedirects: 0 });
    
    // Cookie parsing
    const cookies = resReg.headers['set-cookie'];
    if (!cookies) return console.log("No cookies from register:", resReg.data);
    const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
    
    // 2. Fetch /messages to get CSRF token
    const resMsgPage = await axios.get('http://localhost:3000/messages', {
        headers: { Cookie: cookieHeader }
    });
    const match = resMsgPage.data.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!match) return console.log("CSRF token not found in page");
    const csrfToken = match[1];
    
    // 3. Post to /api/messages/send
    const form = new FormData();
    form.append('receiver_id', '1');
    form.append('body', 'Hello from script');
    
    console.log("Sending message POST...");
    const resSend = await axios.post('http://localhost:3000/api/messages/send', form, {
        headers: {
            Cookie: cookieHeader,
            'X-CSRF-Token': csrfToken,
            ...form.getHeaders()
        },
        validateStatus: () => true
    });
    
    console.log("Response status:", resSend.status);
    console.log("Response data:", resSend.data);
}
test().catch(console.error);
