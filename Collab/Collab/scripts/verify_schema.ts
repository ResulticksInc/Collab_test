import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

async function verify() {
  try {
    dotenv.config();
    const connection = await mysql.createConnection(process.env.DATABASE_URL || '');
    const [rows] = await connection.execute('DESCRIBE messages');
    console.log('Columns in messages table:');
    console.table(rows);
    await connection.end();
  } catch (error) {
    console.error('Error verifying schema:', error);
    process.exit(1);
  }
}

verify();