// index.js – WebSocket + PostgreSQL (Railway)

const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
require('dotenv').config();
const createTables = require('./createTables');

const clients = new Map(); // account_id → { background, popup }
const checkinStatus = new Map();

function setClient(account_id, source, ws) {
  const entry = clients.get(account_id) || {};
  entry[source] = ws;
  clients.set(account_id, entry);
}

function removeClient(account_id, source) {
  const entry = clients.get(account_id) || {};
  delete entry[source];
  if (!entry.background && !entry.popup) {
    clients.delete(account_id);
  } else {
    clients.set(account_id, entry);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('✅ Database connected successfully.'))
  .catch(err => {
    console.error('❌ Failed to connect to the database:', err);
    process.exit(1);
  });

async function handleSudden(account_id, ws = null) {
  try {
    console.log(`🔍 handleSudden triggered for ${account_id}`);
    if (ws?.source === 'popup') return;

    if (ws && ws.readyState !== ws.OPEN) {
      await pool.query(
        `INSERT INTO incident_sessions (account_id, status, reason, created_at)
         VALUES ($1, 'SUDDEN', 'Client Disconnected', $2)`,
        [account_id, new Date()]
      );
      checkinStatus.set(account_id, false);
      console.log(`🚨 Logged SUDDEN for account_id ${account_id}`);

      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'force-checkin',
          status: 'checkin-required',
          message: 'Mất kết nối – vui lòng CHECK-IN lại để tiếp tục.'
        }));
      }
    }
  } catch (err) {
    console.error('❌ Error in handleSudden:', err);
  }
}

const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end('Server is alive');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, 'ws://placeholder');
  const source = urlObj.searchParams.get('source') || 'background';
  ws.source = source;

  console.log(`✅ New ${source} WebSocket connected.`);
  ws.account_id = null;
  ws.isAlive = true;
  ws.isCheckout = false;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const { type, account_id } = msg;

      if (!type) return ws.send(JSON.stringify({ success: false, error: 'Missing message type' }));

      if (account_id) {
        ws.account_id = account_id;
        setClient(account_id, ws.source, ws);
      }

      switch (type) {
        case 'login':
          const { username, password } = msg;
          const result = await pool.query(
            `SELECT account_id AS id, full_name AS name
             FROM accounts
             WHERE LOWER(username) = $1 AND password = $2`,
            [(username || '').toLowerCase().trim(), (password || '').trim()]
          );
          if (result.rows.length) {
            ws.send(JSON.stringify({ success: true, ...result.rows[0] }));
          } else {
            ws.send(JSON.stringify({ success: false, error: 'Sai tên đăng nhập hoặc mật khẩu' }));
          }
          break;

        case 'log-work':
          const { status, created_at } = msg;
          await pool.query(
            `INSERT INTO work_sessions (account_id, status, created_at)
             VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', created_at || new Date()]
          );
          if (status === 'checkin') checkinStatus.set(account_id, true);
          if (status === 'checkout') checkinStatus.set(account_id, false);
          ws.send(JSON.stringify({ success: true, type: status }));
          break;

        case 'log-break':
          const breakStatus = msg.status;
          await pool.query(
            `INSERT INTO break_sessions (account_id, status, created_at)
             VALUES ($1, $2, $3)`,
            [account_id, breakStatus, msg.created_at || new Date()]
          );
          checkinStatus.set(account_id, breakStatus === 'break_end');
          ws.send(JSON.stringify({ success: true, type: breakStatus }));
          break;

        case 'log-incident':
          await pool.query(
            `INSERT INTO incident_sessions (account_id, status, reason, created_at)
             VALUES ($1, $2, $3, $4)`,
            [account_id, msg.status, msg.reason || '', msg.created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;

        case 'log-distraction':
          await pool.query(
            `INSERT INTO distraction_sessions (account_id, status, note, created_at)
             VALUES ($1, $2, $3, $4)`,
            [account_id, msg.status, msg.note || '', msg.created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;

        case 'log-loginout':
          await pool.query(
            `INSERT INTO login_logout_sessions (account_id, status, created_at)
             VALUES ($1, $2, $3)`,
            [account_id, msg.status, msg.created_at || new Date()]
          );
          if (msg.status === 'logout' || msg.status === 'checkout') {
            checkinStatus.set(account_id, false);
            ws.isCheckout = true;
          }
          ws.send(JSON.stringify({ success: true, type: 'log-loginout', status: msg.status }));
          break;

        case 'log-screenshot':
          await pool.query(
            `INSERT INTO photo_sessions (account_id, hash, created_at)
             VALUES ($1, $2, $3)`,
            [account_id, msg.hash, msg.created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;

        case 'check-alive':
          ws.isAlive = true;
          ws.lastSeen = new Date();
          ws.send(JSON.stringify({ type: 'alive' }));
          break;

        default:
          ws.send(JSON.stringify({ success: false, error: 'Unknown message type' }));
      }
    } catch (err) {
      console.error('❌ Error parsing message:', err);
      ws.send(JSON.stringify({ success: false, error: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    console.log(`❌ Socket (${ws.source}) disconnected.`);

    let id = ws.account_id;

    if (!id) {
      for (const [accId, entry] of clients.entries()) {
        if (entry[ws.source] === ws) {
          id = accId;
          break;
        }
      }
    }

    if (!id) {
      console.warn("⚠️ Socket closed but account_id is undefined.");
      return;
    }

    const isCheckin = checkinStatus.get(id);
    console.log(`➡️ Close Event — source: ${ws.source} | id: ${id} | isCheckin: ${isCheckin} | isCheckout: ${ws.isCheckout}`);

    if (ws.source === 'background' && isCheckin && !ws.isCheckout) {
      handleSudden(id, ws);
      checkinStatus.set(id, false);
    }

    removeClient(id, ws.source);
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });
});

const PORT = process.env.PORT || 8999;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  createTables(pool);
});
