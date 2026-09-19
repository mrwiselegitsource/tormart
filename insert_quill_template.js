const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./neobyte.db');

const quillHtml = `
<h2 class="ql-align-center"><strong>WELCOME TO PLATINUM CARDS</strong></h2>
<p class="ql-align-center">🍁 🍂 🎃 🍂 <strong>FALL SALE!</strong> 🍂 🎃 ☂️ 🍁</p>
<p class="ql-align-center">💳 💳 <strong>Fall is here, and so are the savings!</strong> 💳 💳</p>
<p class="ql-align-center">💰 💰 💰 <strong>Shop smarter, spend easier!</strong> 💰 💰 💰</p>
<p><br></p>
<p>Buying a Prepaid Card or Cloned Card is quick, easy, and totally stress-free. No need to top up your account or fuss with payment methods!</p>
<p>All you have to do is order a Prepaid Card / Cloned Credit Card with a high enough balance for the kind of cashout you need, 'cause nobody wants to hit the ATM every day! Just head to the store, ATM, or Bitcoin ATM and cash out!</p>
<p>Use my card no worries, no stress! Buy elsewhere? Hit the ATM first to avoid awkward moments.</p>
<p>In addition to physical plastic cards, we also sell digital versions of the cards.</p>
<p>Grab your digital prepaid card now and enjoy exclusive deals - perfect for shopping online!</p>
<p><br></p>
<h3><strong>Why PLATINUM CARDS?</strong></h3>
<p>✨ Fast, Secure, Stress-Free!</p>
<p>⏱️ Order your card online in minutes</p>
<p>🌍 Use it anywhere Visa, MasterCard, or AMEX is accepted</p>
<p>🛍️ In-store, online, or at ATMs - spending has never been easier!</p>
<p><br></p>
<h3><strong>FAQ-Quick Answers</strong></h3>
<p>🌍 <strong>In which countries can I use cards?</strong></p>
<p>Visa, MasterCard, and AMEX are accepted internationally. You can use them to withdraw cash at ATMs worldwide, and you can also use them for online shopping anywhere.</p>
<p><br></p>
<p>📦 <strong>Do you ship worldwide?</strong></p>
<p>Absolutely! We deliver to most countries with discreet, secure packaging.</p>
<p><br></p>
<p>🔐 <strong>Is shipping safe?</strong></p>
<p>All cards are safe for delivery and are not prohibited items. We make sure to send the cards in safe packages such as: greeting cards, magazines and more. In addition, our cards look exactly like a regular credit card with a high quality of printing and embossing. Even if the parcel is opened there is nothing to incriminate you.</p>
<p><br></p>
<p>⏱️ <strong>How fast will I get my card?</strong></p>
<p>Orders are shipped within 24 hours of payment.</p>
<p>Digital cards are sent within 1 hour to the email address you provide. You can use any email address, including anonymous ones (onion, Proton, DNMX, etc.).</p>
<p><br></p>
<p>🔍 <strong>Will I get a tracking number?</strong></p>
<p>Yes! Parcel Locker and Express and Overnight deliveries include tracking info so you can follow your order.</p>
<p><br></p>
<p>🤔 <strong>What is the difference between a cloned card and a prepaid card?</strong></p>
<p>The Cloned card is a card whose details have been copied using a dedicated device called "ATM Skimmer" or by hacking into credit card databases on the Internet. The card is associated with a person's bank account.</p>
<p>Prepaid card is a card that can be used anywhere that accepts a Visa, MasterCard, or AMEX but the difference is that it is a card that is not associated with any bank account and does not have any identification information and therefore its use is completely anonymous.</p>
<p><br></p>
<p>🔢 <strong>Do the cards have a PIN?</strong></p>
<p>Yes! Every card comes with a 4-digit PIN code for secure transactions.</p>
<p><br></p>
<p>📱 <strong>Can I use a digital card at an ATM?</strong></p>
<p>Sure, they work just as well at ATMs, and you can withdraw cash using the card via NFC on your smartphone.</p>
<p><br></p>
<p>🎁 <strong>Special Fall Offer!</strong></p>
<p>📸 Attach a photo or video of your card in use and get a discount on your next order!</p>
<p>⏰ Hurry - limited-time sale! Don't miss out on stress-free shopping this spring!</p>
<p>✅ Platinum Cards - Safe, simple, and ready to spend! 💳 💸</p>
<p><br></p>
<h3><strong>Our office:</strong></h3>
<p>[PASTE OFFICE IMAGE HERE]</p>
<p><br></p>
<p>[PASTE TRUST ICONS IMAGE HERE]</p>
`;

db.run('UPDATE users SET vendor_description = ? WHERE is_vendor = 1', [quillHtml], function(err) {
  if (err) {
    console.error(err.message);
  } else {
    console.log(`Row(s) updated: ${this.changes}`);
  }
  db.close();
});
