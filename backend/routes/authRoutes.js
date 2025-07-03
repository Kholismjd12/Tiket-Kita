const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { sendLoginData } = require('../producer/producerAuth');
require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const router = express.Router();

// === REGISTER ===
router.post('/register', (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Semua data wajib diisi' });
  }

  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) return res.status(500).json({ error: 'Hashing error' });

    let status = 'Terdaftar';
    if (role === 'admin') {
      db.query('SELECT COUNT(*) AS total FROM users WHERE role = "admin"', (err, results) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        if (results[0].total > 0) status = 'Pending';
        generateUserIdAndInsert();
      });
    } else {
      generateUserIdAndInsert();
    }

    function generateUserIdAndInsert() {
      db.query('SELECT MAX(user_id) AS maxId FROM users', (err, result) => {
        if (err) return res.status(500).json({ error: 'Gagal cek user_id' });

        const userId = (result[0].maxId || 0) + 1;

        db.query(
          'INSERT INTO users (user_id, name, email, password, role, status) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, name, email, hashedPassword, role, status],
          (err) => {
            if (err) return res.status(500).json({ error: 'Insert error' });

            sendLoginData({
              user_id: userId,
              name,
              email,
              password: hashedPassword,
              role,
              action: 'register',
              status // ✅ kirim status ke Kafka
            });

            if (status === 'Pending') {
              res.status(202).json({ message: 'Menunggu persetujuan admin.' });
            } else {
              res.status(201).json({ message: 'Registrasi berhasil. Silakan login.' });
            }
          }
        );
      });
    }
  });
});

// === LOGIN ===
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });

  db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (results.length === 0) return res.status(401).json({ error: 'Email tidak ditemukan' });

    const user = results[0];
    if (user.status === 'Pending') return res.status(403).json({ error: 'Belum disetujui admin' });
    if (user.status === 'Ditolak') return res.status(403).json({ error: 'Akun Anda ditolak' });

    bcrypt.compare(password, user.password, (err, match) => {
      if (err || !match) return res.status(401).json({ error: 'Password salah' });

      sendLoginData({
        user_id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
        action: 'login'
      });

      res.json({
        message: `Login berhasil sebagai ${user.role}`,
        user: {
          id: user.user_id,
          name: user.name,
          email: user.email,
          role: user.role
        }
      });
    });
  });
});

// === UPDATE AKUN ===
router.put('/update-account', (req, res) => {
  const { oldEmail, name, email, password } = req.body;
  if (!oldEmail) return res.status(400).json({ error: 'Email lama wajib dikirim' });

  const updates = [];
  const values = [];

  if (name) {
    updates.push('name = ?');
    values.push(name);
  }

  function applyUpdate() {
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Minimal satu data harus diubah' });
    }

    values.push(oldEmail);
    const sql = `UPDATE users SET ${updates.join(', ')} WHERE email = ?`;
    db.query(sql, values, (err) => {
      if (err) return res.status(500).json({ error: 'Update gagal' });

      sendLoginData({
        email: email || oldEmail,
        name: name || '',
        password: password || '',
        role: '',
        action: 'update'
      });

      res.json({ message: 'Data akun berhasil diperbarui' });
    });
  }

  if (password) {
    bcrypt.hash(password, 10, (err, hashed) => {
      if (err) return res.status(500).json({ error: 'Hashing error' });
      updates.push('password = ?');
      values.push(hashed);
      if (email && email !== oldEmail) {
        updates.push('email = ?');
        values.push(email);
      }
      applyUpdate();
    });
  } else {
    if (email && email !== oldEmail) {
      updates.push('email = ?');
      values.push(email);
    }
    applyUpdate();
  }
});

// === HAPUS AKUN ===
router.delete('/delete-account', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email wajib dikirim' });

  db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (results.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });

    const user = results[0];
    db.query('DELETE FROM users WHERE email = ?', [email], (err) => {
      if (err) return res.status(500).json({ error: 'Gagal hapus' });

      sendLoginData({
        user_id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
        action: 'delete'
      });

      res.json({ message: 'Akun berhasil dihapus' });
    });
  });
});

// === GET ADMIN PENDING / DITOLAK ===
router.get('/admin-pending', (req, res) => {
  db.query(
    `SELECT * FROM users WHERE role = "admin" AND (status = "Pending" OR status = "Ditolak")`,
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Gagal membaca data admin' });
      res.json(results);
    }
  );
});

// === APPROVE ADMIN ===
router.post('/admin-approve', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email wajib dikirim' });

  db.query('SELECT * FROM users WHERE email = ? AND role = "admin" AND status = "Pending"', [email], (err, results) => {
    if (err) return res.status(500).json({ error: 'Gagal cek data admin' });
    if (results.length === 0) return res.status(404).json({ error: 'Data admin tidak ditemukan' });

    const admin = results[0];

    db.query('UPDATE users SET status = "Terdaftar" WHERE email = ?', [email], (err) => {
      if (err) return res.status(500).json({ error: 'Gagal mengupdate status admin' });

      sendLoginData({
        user_id: admin.user_id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        action: 'approve'
      });

      resend.emails.send({
        from: 'onboarding@resend.dev',
        to: 'tiketkita69@gmail.com',
        subject: 'Pendaftaran Admin Disetujui ✅',
        html: `
          <div style="font-family: sans-serif; line-height: 1.5;">
            <h2>Halo ${admin.name},</h2>
            <p>Selamat! Permintaan akun admin Anda telah <strong>disetujui</strong>.</p>
            <p>Silakan login ke aplikasi untuk mulai menggunakan akun Anda.</p>
            <br><p>Terima kasih,</p><p><em>Tim TiketKita</em></p>
          </div>
        `,
      });

      res.json({ message: 'Admin disetujui & notifikasi dikirim' });
    });
  });
});

// === REJECT ADMIN ===
router.post('/admin-reject', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email wajib dikirim' });

  db.query('SELECT * FROM users WHERE email = ? AND role = "admin" AND status = "Pending"', [email], (err, results) => {
    if (err) return res.status(500).json({ error: 'Gagal cek data admin' });
    if (results.length === 0) return res.status(404).json({ error: 'Data admin tidak ditemukan' });

    const admin = results[0];

    db.query('UPDATE users SET status = "Ditolak" WHERE email = ?', [email], (err) => {
      if (err) return res.status(500).json({ error: 'Gagal mengupdate status admin' });

      sendLoginData({
        user_id: admin.user_id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        action: 'reject'
      });

      resend.emails.send({
        from: 'onboarding@resend.dev',
        to: 'tiketkita69@gmail.com',
        subject: 'Pendaftaran Admin Ditolak ❌',
        html: `
          <div style="font-family: sans-serif; line-height: 1.5;">
            <h2>Halo ${admin.name},</h2>
            <p>Kami mohon maaf, permintaan akun admin Anda <strong>ditolak</strong>.</p>
            <p>Silakan hubungi kami jika Anda merasa ini adalah kesalahan.</p>
            <br><p>Terima kasih,</p><p><em>Tim TiketKita</em></p>
          </div>
        `,
      });

      res.json({ message: 'Pendaftaran admin ditolak & email dikirim' });
    });
  });
});

// === HAPUS ADMIN SECARA MANUAL ===
router.delete('/admin-delete', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email wajib dikirim' });

  db.query('SELECT * FROM users WHERE email = ? AND role = "admin"', [email], (err, results) => {
    if (err) return res.status(500).json({ error: 'Gagal cek admin' });
    if (results.length === 0) return res.status(404).json({ error: 'Admin tidak ditemukan' });

    const admin = results[0];

    db.query('DELETE FROM users WHERE email = ?', [email], (err) => {
      if (err) return res.status(500).json({ error: 'Gagal menghapus admin' });

      sendLoginData({
        user_id: admin.user_id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        action: 'delete'
      });

      res.json({ message: 'Admin berhasil dihapus dari database' });
    });
  });
});

module.exports = router;