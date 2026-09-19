const http = require('http');
const querystring = require('querystring');

const postData = querystring.stringify({
  'username': 'admin',
  'password': 'password'
});

const req1 = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postData)
  }
}, async (res1) => {
  const cookie = res1.headers['set-cookie'][0].split(';')[0];
  console.log("Logged in, cookie:", cookie);
  
  const form = new FormData();
  form.append('receiver_id', '1');
  form.append('body', 'Test message from script');
  form.append('_csrf', 'doesntmatter');

  const response = await fetch('http://localhost:3000/api/messages/send', {
    method: 'POST',
    headers: {
      'Cookie': cookie
    },
    body: form
  });
  const text = await response.text();
  console.log("Response:", response.status, text);
});
req1.write(postData);
req1.end();
