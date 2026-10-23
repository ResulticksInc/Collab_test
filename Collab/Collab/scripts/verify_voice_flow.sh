#!/bin/bash

# 1. Setup environment and constants
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1X2twX2FyYXZpbnRoX3Jlc3VsdGlja3NtYWlsX2NvbSIsInVzZXJJZCI6InVfa3BfYXJhdmludGhfcmVzdWx0aWNrc21haWxfY29tIiwiaWF0IjoxNzgxMDc2NDA3LCJleHAiOjE3ODE2ODEyMDd9.8NT6bP-c_JF7rreeTkVFMMwyPlq22IBscvxeVg_uX20"
CONV_ID="00309ea6-9181-4282-92be-43b4bd46d868"
BACKEND_URL="http://localhost:4000"
LOG_FILE="socket_evidence.log"

echo "Starting Voice Message Verification Flow..."

# 2. Start Socket Listener in background
rm -f $LOG_FILE
node scripts/listen-socket.js $BACKEND_URL "$TOKEN" "$CONV_ID" > $LOG_FILE 2>&1 &
LISTENER_PID=$!
echo "Socket listener started (PID: $LISTENER_PID)"

# Give it a moment to connect
sleep 3

# 3. Run the simulation script to send the voice message
echo "Triggering voice message simulation..."
npx tsx scripts/simulate_voice_message.ts

# Wait for broadcast to hit listener
sleep 5

# 4. Kill listener
kill $LISTENER_PID
echo "Listener stopped."

# 5. Collect Evidence
echo -e "\n=== EVIDENCE: SOCKET PAYLOAD ==="
cat $LOG_FILE

echo -e "\n=== EVIDENCE: DATABASE ROW ==="
# We use a temporary node script to query the DB for the last message in that conv
npx tsx -e "
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();
(async () => {
  const conn = await mysql.createConnection(process.env.DATABASE_URL || '');
  const [rows] = await conn.execute('SELECT id, type, voice_json, parent_message_id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', ['$CONV_ID']);
  console.table(rows);
  await conn.end();
})().catch(console.error);
"

echo -e "\n=== EVIDENCE: API RESPONSE ==="
curl -H "Authorization: Bearer $TOKEN" "$BACKEND_URL/api/conversations/$CONV_ID/messages?limit=1" | tail -n 20