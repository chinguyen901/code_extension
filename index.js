const http = require('http');
const { Pool } = require('pg');
const { parse } = require('url');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const parseBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
  });

const server = http.createServer(async (req, res) => {
  const parsedUrl = parse(req.url, true);
  const path = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method === 'POST' && path === '/login') {
      const { email, password } = await parseBody(req);
      const lowerEmail = (email || '').toLowerCase().trim();
      const trimmedPassword = (password || '').trim();

      const result = await pool.query(
        'SELECT id, name FROM employee WHERE LOWER(email) = $1 AND password = $2',
        [lowerEmail, trimmedPassword]
      );
      console.log(`✅ result.rows.length:${result.rows.length}`);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        return res.end(JSON.stringify({ success: true, ...user }));
      } else {
        return res.end(JSON.stringify({ success: false, error: 'Email hoặc mật khẩu không đúng' }));
      }
    }

    else if (req.method === 'POST' && path === '/logEvent') {
      const data = await parseBody(req);
      await pool.query(
        `INSERT INTO events (id, session_id, event_type, event_status, source, timestamp, type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          data.id || "unknown",
          data.session_id || "no-session",
          data.event_type || "unknown",
          data.event_status || "unknown",
          data.source || "unknown",
          data.timestamp || new Date().toISOString(),
          data.type || ""
        ]
      );
      return res.end(JSON.stringify({ success: true }));
    }

    else if (req.method === 'POST' && path === '/logSession') {
      const data = await parseBody(req);
      await pool.query(
        `INSERT INTO session (session_id, email, start_time, end_time, session_status, device_info)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          data.session_id || "unknown",
          data.email || "unknown",
          data.start_time || new Date().toISOString(),
          data.end_time || "",
          data.session_status || "active",
          data.device_info || ""
        ]
      );
      return res.end(JSON.stringify({ success: true }));
    }

    else if (req.method === 'POST' && path === '/logSession_out') {
      const data = await parseBody(req);
      await pool.query(
        `INSERT INTO session (session_id, email, start_time, end_time, session_status, device_info)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          data.session_id || "unknown",
          data.email || "unknown",
          data.start_time || "",
          data.end_time || new Date().toISOString(),
          data.session_status || "ended",
          data.device_info || ""
        ]
      );
      return res.end(JSON.stringify({ success: true }));
    }

    else if (req.method === 'POST' && path === '/logScreenshot') {
      const data = await parseBody(req);
      await pool.query(
        `INSERT INTO log (id, name, hash, session_id, timestamp)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          data.id || "",
          data.name || "",
          data.hash || "",
          data.session_id || "",
          data.timestamp || new Date().toISOString()
        ]
      );
      return res.end(JSON.stringify({ success: true }));
    }

    else {
      res.statusCode = 404;
      return res.end(JSON.stringify({ success: false, error: "Not Found" }));
    }
  } catch (err) {
    console.error("❌ Server Error:", err);
    res.statusCode = 500;
    return res.end(JSON.stringify({ success: false, error: err.message }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});