import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

async function getContext() {
  try {
    dotenv.config();
    const connection = await mysql.createConnection(process.env.DATABASE_URL || '');
    const [users] = await connection.execute('SELECT id, email, name FROM users LIMIT 2');
    console.log('Users:');
    console.table(users);
    const [convs] = await connection.execute('SELECT * FROM conversations LIMIT 1');
    console.log('Conversations:');
    console.table(convs);
    await connection.end();
  } catch (error) {
    console.error('Error getting context:', error);
    process.exit(1);
  }
}

getContext();