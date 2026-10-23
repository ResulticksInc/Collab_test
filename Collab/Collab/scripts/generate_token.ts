import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const secret = process.env.AUTH_JWT_SECRET;
if (!secret) {
  console.error('AUTH_JWT_SECRET not found in .env');
  process.exit(1);
}

const userId = 'u_kp_aravinth_resulticksmail_com';
const payload = {
  sub: userId,
  userId: userId,
};

const token = jwt.sign(payload, secret, { expiresIn: '7d' });
console.log(`TOKEN=${token}`);