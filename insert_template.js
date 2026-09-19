const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./neobyte.db');

const htmlTemplate = `
<div style="text-align: center;">
  <h2><strong>WELCOME TO PLATINUM CARDS</strong></h2>
  <p>🍁 🍂 🎃 🍂 <strong>FALL SALE!</strong> 🍂 🎃 ☂️ 🍁</p>
  <p>💳 💳 <strong>Fall is here, and so are the savings!</strong> 💳 💳</p>
  <p>💰 💰 💰 <strong>Shop smarter, spend easier!</strong> 💰 💰 💰</p>
</div>
<br>
<p>Buying a Prepaid Card or Cloned Card is quick, easy, and totally stress-free. No need to top up your account or fuss with payment methods!</p>
<p>All you have to do is order a Prepaid Card / Cloned Credit Card with a high enough balance for the kind of cashout you need, 'cause nobody wants to hit the ATM every day! Just head to the store, ATM, or Bitcoin ATM and cash out!</p>
<p>Use my card no worries, no stress! Buy elsewhere? Hit the ATM first to avoid awkward moments.</p>
<p>In addition to physical plastic cards, we also sell digital versions of the cards.<br>
Grab your digital prepaid card now and enjoy exclusive deals - perfect for shopping online!</p>
<br>
<h3><strong>Why PLATINUM CARDS?</strong></h3>
<p>✨ Fast, Secure, Stress-Free!</p>
<p>⏱️ Order your card online in minutes</p>
<p>🌍 Use it anywhere Visa, MasterCard, or AMEX is accepted</p>
<p>🛍️ In-store, online, or at ATMs - spending has never been easier!</p>
<br>
<h3><strong>FAQ-Quick Answers</strong></h3>
<p>🌍 <strong>In which countries can I use cards?</strong><br>
Visa, MasterCard, and AMEX are accepted internationally. You can use them to withdraw cash at ATMs worldwide, and you can also use them for online shopping anywhere.</p>

<p>📦 <strong>Do you ship worldwide?</strong><br>
Absolutely! We deliver to most countries with discreet, secure packaging.</p>

<p>🔐 <strong>Is shipping safe?</strong><br>
All cards are safe for delivery and are not prohibited items. We make sure to send the cards in safe packages such as: greeting cards, magazines and more. In addition, our cards look exactly like a regular credit card with a high quality of printing and embossing. Even if the parcel is opened there is nothing to incriminate you.</p>

<p>⏱️ <strong>How fast will I get my card?</strong><br>
Orders are shipped within 24 hours of payment.<br>
Digital cards are sent within 1 hour to the email address you provide. You can use any email address, including anonymous ones (onion, Proton, DNMX, etc.).</p>

<p>🔍 <strong>Will I get a tracking number?</strong><br>
Yes! Parcel Locker and Express and Overnight deliveries include tracking info so you can follow your order.</p>

<p>🤔 <strong>What is the difference between a cloned card and a prepaid card?</strong><br>
The Cloned card is a card whose details have been copied using a dedicated device called "ATM Skimmer" or by hacking into credit card databases on the Internet. The card is associated with a person's bank account.<br>
Prepaid card is a card that can be used anywhere that accepts a Visa, MasterCard, or AMEX but the difference is that it is a card that is not associated with any bank account and does not have any identification information and therefore its use is completely anonymous.</p>

<p>🔢 <strong>Do the cards have a PIN?</strong><br>
Yes! Every card comes with a 4-digit PIN code for secure transactions.</p>

<p>📱 <strong>Can I use a digital card at an ATM?</strong><br>
Sure, they work just as well at ATMs, and you can withdraw cash using the card via NFC on your smartphone.</p>
<br>
<p>🎁 <strong>Special Fall Offer!</strong></p>
<p>📸 Attach a photo or video of your card in use and get a discount on your next order!</p>
<p>⏰ Hurry - limited-time sale! Don't miss out on stress-free shopping this spring!</p>
<p>✅ Platinum Cards - Safe, simple, and ready to spend! 💳 💸</p>
<br>
<h3><strong>Our office:</strong></h3>
<p><img src="/images/office_image_placeholder.jpg" alt="Our Office" style="max-width: 100%; height: auto;"></p>
<br>
<p><img src="/images/trust_icons_placeholder.jpg" alt="Trust Icons" style="max-width: 100%; height: auto;"></p>
`;

db.run('UPDATE users SET vendor_description = ? WHERE is_vendor = 1', [htmlTemplate], function(err) {
  if (err) {
    console.error(err.message);
  } else {
    console.log(`Row(s) updated: ${this.changes}`);
  }
  db.close();
});
