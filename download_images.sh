#!/bin/bash

# Ensure directory exists
mkdir -p public/images

echo "Downloading top banner 1 (Cybersecurity/Privacy)..."
curl -L "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?q=80&w=1000&auto=format&fit=crop" -o public/images/top-banner-1.jpg

echo "Downloading top banner 2 (Coding/Software)..."
curl -L "https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=1000&auto=format&fit=crop" -o public/images/top-banner-2.jpg

echo "Downloading bottom banner 1 (Security Vault)..."
curl -L "https://images.unsplash.com/photo-1614064641938-3bbee52942c7?q=80&w=1000&auto=format&fit=crop" -o public/images/bottom-banner-1.jpg

echo "Downloading bottom banner 2 (Tech/Server)..."
curl -L "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?q=80&w=1000&auto=format&fit=crop" -o public/images/bottom-banner-2.jpg

echo "Downloading default vendor banner..."
curl -L "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?q=80&w=1000&auto=format&fit=crop" -o public/images/default-vendor-banner.jpg

echo "Downloading default vendor logo (Abstract minimal)..."
curl -L "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=200&auto=format&fit=crop" -o public/images/default-vendor-logo.png

echo "Downloading product images..."
curl -L "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?q=80&w=400&auto=format&fit=crop" -o public/images/carding-product.jpg
curl -L "https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=400&auto=format&fit=crop" -o public/images/ai-asset.jpg
curl -L "https://images.unsplash.com/photo-1558655146-d49348d9bfe3?q=80&w=400&auto=format&fit=crop" -o public/images/design-kit.jpg
curl -L "https://images.unsplash.com/photo-1511379938547-c1f69419868d?q=80&w=400&auto=format&fit=crop" -o public/images/audio-bundle.jpg

echo "Done!"
