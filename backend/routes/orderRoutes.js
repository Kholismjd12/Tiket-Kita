const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendOrderLifecycle } = require('../producer/producerOrder');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// ============================
// POST /api/orders
// ============================
router.post('/orders', (req, res) => {
  let { user_id, role, event_id, ticket_id, jumlah, harga } = req.body;
  const status = 'pending';
  const bukti_transfer = null;
  const tanggal_pesan = new Date();

  if (role !== 'user') {
    return res.status(403).json({ message: 'Hanya user yang dapat memesan tiket' });
  }

  const getMaxIdSql = 'SELECT MAX(order_id) AS maxId FROM orders';
  db.query(getMaxIdSql, (err, rows) => {
    if (err) {
      console.error('❌ Gagal ambil max order_id:', err);
      return res.status(500).json({ message: 'Gagal proses ID order' });
    }

    const orderId = (rows[0].maxId || 0) + 1;

    const insertSql = `
      INSERT INTO orders (order_id, user_id, event_id, ticket_id, jumlah, harga, tanggal_pesan, status, bukti_transfer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(insertSql, [orderId, user_id, event_id, ticket_id, jumlah, harga, tanggal_pesan, status, bukti_transfer], (err) => {
      if (err) {
        console.error('❌ Gagal membuat order:', err);
        return res.status(500).json({ message: 'Gagal membuat order', error: err });
      }

      sendOrderLifecycle({
        action: 'buat',
        order_id: orderId,
        user_id,
        event_id,
        ticket_id,
        jumlah,
        harga,
        status,
        bukti_transfer,
        timestamp: tanggal_pesan.toISOString()
      });

      res.json({ message: 'Pesanan berhasil dibuat', order_id: orderId });
    });
  });
});

// ============================
// PUT /api/user/upload-bukti/:orderId
// ============================
router.put('/user/upload-bukti/:orderId', (req, res) => {
  const orderId = req.params.orderId;
  const { bukti_transfer } = req.body;

  const sql = `UPDATE orders SET bukti_transfer = ? WHERE order_id = ?`;

  db.query(sql, [bukti_transfer, orderId], (err, result) => {
    if (err) {
      console.error('❌ Gagal upload bukti:', err);
      return res.status(500).json({ message: 'Gagal upload bukti pembayaran' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Order tidak ditemukan' });
    }

    const getUserSql = 'SELECT user_id FROM orders WHERE order_id = ?';
    db.query(getUserSql, [orderId], (userErr, rows) => {
      if (userErr || rows.length === 0) {
        console.error('❌ Gagal ambil user_id:', userErr?.message);
        return res.status(500).json({ message: 'Gagal ambil data order' });
      }

      const user_id = rows[0].user_id;

      sendOrderLifecycle({
        action: 'upload-bukti',
        order_id: orderId,
        user_id,
        bukti_transfer,
        status: 'pending',
        timestamp: new Date().toISOString()
      });

      res.json({ message: 'Bukti pembayaran berhasil diunggah. Menunggu konfirmasi admin.' });
    });
  });
});

// ============================
// PUT /api/admin/konfirmasi-order/:orderId
// ============================
router.put('/admin/konfirmasi-order/:orderId', (req, res) => {
  const orderId = req.params.orderId;

  const orderSql = `
    SELECT o.*, u.email, u.name AS nama_user, e.nama_event
    FROM orders o
    JOIN users u ON o.user_id = u.user_id
    JOIN event_ticket e ON o.event_id = e.event_id
    WHERE o.order_id = ?
  `;

  db.query(orderSql, [orderId], (err, results) => {
    if (err || results.length === 0) {
      return res.status(500).json({ message: 'Gagal ambil data order' });
    }

    const order = results[0];

    const updateSql = `UPDATE orders SET status = 'dibayar' WHERE order_id = ?`;
    db.query(updateSql, [orderId], (errUpdate) => {
      if (errUpdate) return res.status(500).json({ message: 'Gagal update status' });

      const getMaxTicketSql = `SELECT MAX(ticket_id) AS maxId FROM tickets`;
      db.query(getMaxTicketSql, (errMax, rowsMax) => {
        if (errMax) {
          console.error('❌ Gagal ambil max ticket_id:', errMax);
          return res.status(500).json({ message: 'Gagal proses ID tiket' });
        }

        let nextTicketId = (rowsMax[0].maxId || 0) + 1;
        const tickets = [];
        const values = [];

        for (let i = 0; i < order.jumlah; i++) {
          const nomorTiket = `TK-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}-${i}`;
          const ticket = {
            ticket_id: nextTicketId,
            order_id: orderId,
            event_id: order.event_id,
            nomor_tiket: nomorTiket,
            status: 'aktif'
          };
          tickets.push(ticket);
          values.push([ticket.ticket_id, ticket.order_id, ticket.event_id, ticket.nomor_tiket, ticket.status]);
          nextTicketId++;
        }

        const insertTicketSql = `
          INSERT INTO tickets (ticket_id, order_id, event_id, nomor_tiket, status)
          VALUES ?
        `;

        db.query(insertTicketSql, [values], (errInsert) => {
          if (errInsert) {
            console.error('❌ Gagal insert tiket:', errInsert);
            return res.status(500).json({ message: 'Gagal membuat tiket' });
          }

          const daftarTiket = tickets.map(t => `<li>${t.nomor_tiket}</li>`).join('');
          resend.emails.send({
            from: 'onboarding@resend.dev',
            to: order.email,
            subject: `🎟️ Tiket untuk ${order.nama_event}`,
            html: `
              <div style="font-family: sans-serif;">
                <h3>Halo ${order.nama_user},</h3>
                <p>Terima kasih telah melakukan pembayaran untuk event <strong>${order.nama_event}</strong>.</p>
                <p>Berikut adalah nomor tiketmu:</p>
                <ul>${daftarTiket}</ul>
                <p>Tunjukkan nomor ini saat masuk ke acara.</p>
                <br>
                <p><em>Salam,</em><br>Tim TiketKita</p>
              </div>
            `
          });

          sendOrderLifecycle({
          action: 'konfirmasi',
          order_id: orderId,
          user_id: order.user_id,
          status: 'dibayar',
          timestamp: new Date().toISOString(),
          tickets: values.map(v => ({
            ticket_id: v[0],
            order_id: v[1],
            event_id: v[2],
            nomor_tiket: v[3],
            status: v[4]
          }))
        });

          res.json({ message: 'Pesanan dikonfirmasi dan tiket dibuat' });
        });
      });
    });
  });
});

// ============================
// GET /api/admin/unpaid-orders
// ============================
router.get('/admin/unpaid-orders', (req, res) => {
  const sql = `
    SELECT o.order_id, o.user_id, o.event_id, o.jumlah, o.harga, o.status, o.bukti_transfer,
           u.name AS nama_user, e.nama_event
    FROM orders o
    JOIN users u ON o.user_id = u.user_id
    JOIN event_ticket e ON o.event_id = e.event_id
    WHERE o.status = 'pending'
    ORDER BY o.tanggal_pesan DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error('❌ Gagal ambil pesanan pending:', err);
      return res.status(500).json({ message: 'Gagal ambil pesanan' });
    }

    res.json(results);
  });
});

// ============================
// GET /api/events/:id
// ============================
router.get('/events/:id', (req, res) => {
  const eventId = req.params.id;

  const sql = 'SELECT * FROM event_ticket WHERE event_id = ?';
  db.query(sql, [eventId], (err, results) => {
    if (err) {
      console.error('❌ Gagal ambil detail event:', err);
      return res.status(500).json({ message: 'Gagal ambil detail event' });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: 'Event tidak ditemukan' });
    }

    res.json(results[0]);
  });
});

// ============================
// GET /api/events?status=diterima
// ============================
router.get('/events', (req, res) => {
  const status = req.query.status || 'diterima';

  const sql = 'SELECT * FROM event_ticket WHERE status = ? ORDER BY tanggal ASC';
  db.query(sql, [status], (err, results) => {
    if (err) {
      console.error('❌ Gagal ambil event:', err);
      return res.status(500).json({ message: 'Gagal ambil event' });
    }

    res.json(results);
  });
});

// ============================
// GET /api/user/tickets/:userId
// ============================
router.get('/user/tickets/:userId', (req, res) => {
  const userId = req.params.userId;

  const sql = `
    SELECT t.nomor_tiket, e.nama_event, e.tanggal
    FROM tickets t
    JOIN orders o ON t.order_id = o.order_id
    JOIN event_ticket e ON t.event_id = e.event_id
    WHERE o.user_id = ? AND o.status = 'dibayar'
    ORDER BY e.tanggal ASC
  `;

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error('❌ Gagal ambil tiket user:', err);
      return res.status(500).json({ message: 'Gagal ambil tiket user' });
    }

    res.json(results);
  });
});

// ============================
// GET /api/user-orders/:userId
// ============================
router.get('/user-orders/:userId', (req, res) => {
  const userId = req.params.userId;

  const sql = `
    SELECT o.*, e.nama_event, e.lokasi, e.tanggal, e.deskripsi
    FROM orders o
    JOIN event_ticket e ON o.event_id = e.event_id
    WHERE o.user_id = ?
    ORDER BY o.tanggal_pesan DESC
  `;

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error('❌ Gagal ambil pesanan user:', err);
      return res.status(500).json({ message: 'Gagal ambil data pesanan' });
    }

    res.json(results);
  });
});

module.exports = router;