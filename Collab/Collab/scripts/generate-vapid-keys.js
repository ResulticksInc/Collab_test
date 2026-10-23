#!/usr/bin/env node
// Generate VAPID keys for Web Push notifications.
// Usage: node scripts/generate-vapid-keys.js
// Output: Add these to your .env file.
const webpush = require("web-push");
const keys = webpush.generateVAPIDKeys();
console.log("# Web Push VAPID keys — add to .env\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:admin@your-domain.com`);
