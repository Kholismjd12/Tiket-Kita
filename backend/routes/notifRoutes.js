const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendNotification } = require('../producer/producerNotif');

// ✅ KIRIM NOTIFIKASI (Kafka only) — dengan ID manual (MAX + 1)
router.post('/admin/send-notification', (req, res) => {
  const { email, title, message } = req.body;
  if (!email || !title || !message) return res.status(400).json({ error: 'Data tidak lengkap' });

  // Validasi admin
  db.query('SELECT user_id, name, role FROM users WHERE email = ? AND role = "admin"', [email], (err, result) => {
    if (err) return res.status(500).json({ error: 'Gagal mencari admin' });
    if (!result.length) return res.status(403).json({ error: 'Hanya admin yang dapat mengirim notifikasi' });

    const admin = result[0];

    // Ambil MAX(notification_id) untuk ID baru
    db.query('SELECT MAX(notification_id) AS maxId FROM notifications', async (err2, rows) => {
      if (err2) return res.status(500).json({ error: 'Gagal mengambil ID notifikasi' });

      const nextId = (rows[0].maxId || 0) + 1;

      // Kirim Kafka payload lengkap dengan id manual
      await sendNotification({
        id: nextId,
        userEmail: email,
        userId: admin.user_id,
        userName: admin.name,
        userRole: admin.role,
        title,
        message,
        action: 'create'
      });

      res.json({ message: `Notifikasi berhasil dikirim ke Kafka (akan diproses dengan ID ${nextId})` });
    });
  });
});

// ✅ EDIT NOTIFIKASI
router.put('/admin/edit-notification/:id', (req, res) => {
  const { title, message, email } = req.body;
  const id = req.params.id;
  if (!title || !message || !email) return res.status(400).json({ error: 'Data wajib diisi' });

  db.query('SELECT user_id, name, role FROM users WHERE email = ? AND role = "admin"', [email], (err, result) => {
    if (err) return res.status(500).json({ error: 'Gagal mencari admin' });
    if (!result.length) return res.status(403).json({ error: 'Hanya admin yang dapat mengedit notifikasi' });

    const admin = result[0];

    // 🔍 Ambil oldMessage dulu dari DB berdasarkan id
    db.query('SELECT message FROM notifications WHERE notification_id = ?', [id], async (err2, notifRows) => {
      if (err2) return res.status(500).json({ error: 'Gagal mengambil data notifikasi lama' });
      if (!notifRows.length) return res.status(404).json({ error: 'Notifikasi tidak ditemukan' });

      const oldMessage = notifRows[0].message;

      // ✅ Kirim ke Kafka lengkap dengan oldMessage
      await sendNotification({
        userEmail: email,
        userId: admin.user_id,
        userName: admin.name,
        userRole: admin.role,
        id,
        title,
        message,
        oldMessage,
        action: 'update'
      });

      res.json({ message: 'Notifikasi update dikirim ke Kafka (akan diproses)' });
    });
  });
});

// ✅ HAPUS NOTIFIKASI
router.delete('/admin/delete-notification/:id', (req, res) => {
  const { userEmail, userId, userName, userRole } = req.body;
  const id = req.params.id;

  if (!userEmail || userRole !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang dapat menghapus notifikasi' });
  }

  // 🔍 Ambil data notifikasi dulu
  db.query('SELECT title, message FROM notifications WHERE notification_id = ?', [id], (err1, rows) => {
    if (err1) return res.status(500).json({ error: 'Gagal mengambil data notifikasi' });
    if (!rows.length) return res.status(404).json({ error: 'Notifikasi tidak ditemukan' });

    const { title, message } = rows[0];

    // 🗑️ Lanjutkan proses delete
    db.query('DELETE FROM notifications WHERE notification_id = ?', [id], async (err2) => {
      if (err2) return res.status(500).json({ error: 'Gagal menghapus notifikasi' });

      // ✅ Kirim Kafka log lengkap
      await sendNotification({
        userEmail,
        userId,
        userName,
        userRole,
        id,
        action: 'delete',
        title,
        message
      });

      res.json({ message: 'Notifikasi berhasil dihapus' });
    });
  });
});

// ✅ AMBIL NOTIFIKASI KHUSUS ADMIN
router.get('/admin/list-notifications', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email diperlukan' });

  db.query('SELECT user_id, role FROM users WHERE email = ?', [email], (err, users) => {
    if (err) return res.status(500).json({ error: 'Gagal mencari pengguna' });
    if (!users.length) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });

    const { user_id, role } = users[0];
    if (role !== 'admin') return res.status(403).json({ error: 'Akses ditolak: hanya admin' });

    db.query(
      'SELECT notification_id, title, message, created_at FROM notifications WHERE admin_id = ? ORDER BY created_at DESC',
      [user_id],
      (err2, result) => {
        if (err2) return res.status(500).json({ error: 'Gagal mengambil notifikasi' });
        res.json(result);
      }
    );
  });
});

// ✅ AMBIL NOTIFIKASI UNTUK USER (semua role)
router.get('/user/notifications', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email tidak ditemukan' });

  db.query('SELECT user_id FROM users WHERE email = ?', [email], (err, userRows) => {
    if (err) return res.status(500).json({ error: 'Gagal mencari user' });
    if (!userRows.length) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });

    db.query('SELECT title, message, created_at FROM notifications ORDER BY created_at DESC LIMIT 10', (err2, notifs) => {
      if (err2) return res.status(500).json({ error: 'Gagal ambil notifikasi' });
      res.json(notifs);
    });
  });
});

// ✅ AMBIL NOTIFIKASI PUBLIK
router.get('/public/notifications', (req, res) => {
  db.query(
    'SELECT title, message, created_at FROM notifications ORDER BY created_at DESC',
    (err, result) => {
      if (err) return res.status(500).json({ error: 'Gagal mengambil notifikasi' });
      res.json(result);
    }
  );
});

module.exports = router;