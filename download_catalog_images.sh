#!/bin/bash

# Ensure directory exists
mkdir -p public/images

echo "Downloading Category Images..."
# 1. Carding (Credit cards)
curl -L "https://images.unsplash.com/photo-1563013544-824ae1b704d3?q=80&w=400&h=400&fit=crop" -o public/images/cat-carding.jpg
# 2. PayPal (Phone with money app)
curl -L "https://images.unsplash.com/photo-1616077168712-fc6c788db4af?q=80&w=400&h=400&fit=crop" -o public/images/cat-paypal.jpg
# 3. Gift Cards (Shopping boxes/cards)
curl -L "https://images.unsplash.com/photo-1549465220-1a8b9238cd48?q=80&w=400&h=400&fit=crop" -o public/images/cat-giftcards.jpg
# 4. Crypto currency (Bitcoin)
curl -L "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?q=80&w=400&h=400&fit=crop" -o public/images/cat-crypto.jpg
# 5. Fake Money (Stacks of cash)
curl -L "https://images.unsplash.com/photo-1580519542036-ed47f73fac61?q=80&w=400&h=400&fit=crop" -o public/images/cat-money.jpg
# 6. Accounts (Social media logos on screen)
curl -L "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=400&h=400&fit=crop" -o public/images/cat-accounts.jpg
# 7. Documents (Passports/ID)
curl -L "https://images.unsplash.com/photo-1594957640248-cb5804300305?q=80&w=400&h=400&fit=crop" -o public/images/cat-documents.jpg
# 8. Electronics (Phones/gadgets)
curl -L "https://images.unsplash.com/photo-1525547719571-a2d4ac8945e2?q=80&w=400&h=400&fit=crop" -o public/images/cat-electronics.jpg
# 9. 18+ (Neon sign / nightlife)
curl -L "https://images.unsplash.com/photo-1563298723-dcfebaa392e3?q=80&w=400&h=400&fit=crop" -o public/images/cat-18plus.jpg
# 10. Casino (Roulette/chips)
curl -L "https://images.unsplash.com/photo-1517457211116-c73ed51e0413?q=80&w=400&h=400&fit=crop" -o public/images/cat-casino.jpg

echo "Downloading Hero Background..."
curl -L "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?q=80&w=1920&h=600&fit=crop" -o public/images/hero-bg.jpg

echo "Done!"
