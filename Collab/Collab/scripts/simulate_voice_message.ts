import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import fs from 'fs';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1X2twX2FyYXZpbnRoX3Jlc3VsdGlja3NtYWlsX2NvbSIsInVzZXJJZCI6InVfa3BfYXJhdmludGhfcmVzdWx0aWNrc21haWxfY29tIiwiaWF0IjoxNzgxMDc2NDA3LCJleHAiOjE3ODE2ODEyMDd9.8NT6bP-c_JF7rreeTkVFMMwyPlq22IBscvxeVg_uX20';
const USER_ID = 'u_kp_aravinth_resulticksmail_com';
const CONVERSATION_ID = '00309ea6-9181-4282-92be-43b4bd46d868';
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:4000';

async function uploadFile(fileStream: any) {
  const form = new FormData();
  form.append('file', fileStream);
  
  const response = await axios.post(`${API_BASE_URL}/api/files/upload`, form, {
    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${TOKEN}` },
  });
  return response.data;
}

async function sendVoiceMessage(fileMeta: any) {
  const socket = io(SOCKET_URL, { 
    auth: { token: TOKEN },
    transports: ['websocket']
  });

  return new Promise((resolve, reject) => {
    socket.on('connect', async () => {
      console.log('Socket connected. Sending voice message...');
      const payload = {
        conversationId: CONVERSATION_ID,
        type: 'voice',
        voice: {
          fileId: fileMeta.id,
          duration: 10,
          waveform: null,
          mimeType: 'audio/webm',
        },
      };
      socket.emit('MESSAGE_SEND', payload);
      
      setTimeout(() => {
        socket.disconnect();
        resolve(true);
      }, 2000);
    });

    socket.on('connect_error', (err) => reject(`Socket connection error: ${err}`));
    socket.on('disconnect', () => resolve(true));
  });
}

async function run() {
  try {
    console.log('Starting simulation...');
    const fileStream = fs.createReadStream('dummy_voice.webm');
    const uploadedMeta = await uploadFile(fileStream);
    console.log('JSON Payload (Upload):', JSON.stringify(uploadedMeta, null, 2));
    
    await sendVoiceMessage(uploadedMeta);
    console.log('Socket Payload sent successfully.');
  } catch (error) {
    console.error('Simulation failed:', error);
    process.exit(1);
  }
}

run();