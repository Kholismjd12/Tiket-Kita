const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { sendEventLifecycle } = require('../producer/producerEvent');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { v4: uuidv4 } = require('uuid');
const payment_id = uuidv4();


// 🔧 Multer config untuk gambar event & bukti transfer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'frontend/public/uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// 🔧 Generate payment_id seperti 'payment-1', 'payment-2', dst
function generateCustomPaymentId(callback) {
  db.query(
    `SELECT payment_id FROM organizer_payments WHERE payment_id LIKE 'payment-%'`,
    (err, result) => {
      if (err) return callback(err);

      const existingIds = result
        .map(row => parseInt(row.payment_id.replace('payment-', '')))
        .filter(Number.isInteger);

      const nextNumber = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
      const paymentId = `payment-${nextNumber}`;
      callback(null, paymentId);
    }
  );
}

/* ======================= */
/* ===== EVENT ROUTES ==== */
/* ======================= */

// Tambah event EO
router.post('/eo/tambah-event', upload.single('gambar_event'), (req, res) => {
  const {
    organizer_id, nama_event, instansi, tanggal,
    lokasi, deskripsi, harga, jumlah_tersedia
  } = req.body;

  if (!organizer_id || !nama_event || !instansi || !tanggal || !lokasi || !deskripsi || !harga || !jumlah_tersedia) {
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  }

  // Step 1: Cari MAX(event_id)
  db.query('SELECT MAX(event_id) AS maxEventId FROM event_ticket', (errMax, resultMax) => {
    if (errMax) return res.status(500).json({ error: 'Gagal ambil max event_id' });

    const event_id = (resultMax[0].maxEventId || 0) + 1;

      const gambar_event = req.file ? req.file.filename : null;
      const hargaValid = isNaN(Number(harga)) ? 0 : Number(harga);
      const stokValid = isNaN(Number(jumlah_tersedia)) ? 0 : Number(jumlah_tersedia);

      db.query(
        `INSERT INTO event_ticket (
          event_id, organizer_id, admin_id, nama_event, instansi, tanggal,
          lokasi, deskripsi, gambar_event, harga, jumlah_tersedia, status
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [event_id, organizer_id, nama_event, instansi, tanggal, lokasi, deskripsi, gambar_event, hargaValid, stokValid],
        (err) => {
          if (err) return res.status(500).json({ error: 'Gagal menyimpan event ke database' });

          sendEventLifecycle({
            event_id,
            organizer_id,
            nama_event,
            instansi,
            tanggal,
            lokasi,
            deskripsi,
            gambar_event,
            harga: hargaValid,
            jumlah_tersedia: stokValid,
            status: 'pending'
          });

          res.status(200).json({ message: '✅ Event berhasil diajukan dan dikirim ke Kafka', event_id });
        }
      );
    });
  });

// Event list EO
router.get('/eo/event-pending', (req, res) => {
  db.query('SELECT * FROM event_ticket WHERE status IN ("pending", "menunggu_dibayar", "dibayar", "diterima", "ditolak")', (err, results) => {
    if (err) return res.status(500).json({ error: 'Gagal mengambil event' });
    res.status(200).json(results);
  });
});

// Event + Rekening
router.get('/event-ticket', (req, res) => {
  const sql = `
    SELECT et.*, op.nomor_rekening
    FROM event_ticket et
    LEFT JOIN organizer_payments op ON et.event_id = op.event_id
    AND op.status IN ('pending', 'dibayar', 'menunggu_dibayar')
    ORDER BY et.tanggal ASC
  `;

  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'Gagal mengambil event dari database' });
    res.status(200).json(results);
  });
});

/* ======================= */
/* ===== PAYMENT ROUTES == */
/* ======================= */

// Admin ajukan pembayaran
router.put('/admin/event-status/:id', (req, res) => {
  const event_id = req.params.id;
  const { status, nominal, nomor_rekening, alasan, admin_id } = req.body;

  if (!status || !admin_id) {
    return res.status(400).json({ error: 'Status dan Admin ID wajib dikirim' });
  }

  // Jika status 'menunggu_dibayar', maka nominal dan rekening wajib
  if (status === 'menunggu_dibayar') {
  db.query('SELECT organizer_id, nama_event, instansi FROM event_ticket WHERE event_id = ?', [event_id], (err0, result0) => {
    if (err0 || result0.length === 0) return res.status(500).json({ error: 'Gagal ambil data event' });

    const { organizer_id, nama_event, instansi } = result0[0];

    // Cek apakah sudah ada pembayaran untuk event ini
    generateCustomPaymentId((errGen, payment_id) => {
    if (errGen) return res.status(500).json({ error: 'Gagal generate payment_id' });

    // Lanjutkan ke proses insert pembayaran
    db.query(`SELECT * FROM organizer_payments WHERE event_id = ?`, [event_id], (err2, result2) => {
      if (err2) return res.status(500).json({ error: 'Gagal cek data pembayaran' });

      if (result2.length === 0) {
        // INSERT baru
        db.query(`
          INSERT INTO organizer_payments (
            payment_id, organizer_id, event_id, admin_id, bukti_transfer,
            jumlah, status, tanggal, nomor_rekening
          ) VALUES (?, ?, ?, ?, NULL, ?, 'pending', NOW(), ?)`,
          [payment_id, organizer_id, event_id, admin_id, nominal, nomor_rekening],
          (err3) => {
            if (err3) return res.status(500).json({ error: 'Gagal insert pembayaran' });

            sendEventLifecycle({
              event_id,
              organizer_id,
              nama_event,
              instansi,
              status,
              admin_id,
              jumlah: nominal,
              nomor_rekening,
              payment_id
            });

            return res.status(200).json({ message: 'Pembayaran diajukan (insert baru)' });
          }
        );
      } else {
        // UPDATE jika sudah ada
        db.query(`
          UPDATE organizer_payments SET jumlah = ?, nomor_rekening = ?, status = 'pending',
          tanggal = NOW(), admin_id = ? WHERE event_id = ?`,
          [nominal, nomor_rekening, admin_id, event_id],
          (err4) => {
            if (err4) return res.status(500).json({ error: 'Gagal update pembayaran' });

            sendEventLifecycle({
              event_id,
              organizer_id,
              nama_event,
              instansi,
              status,
              admin_id,
              jumlah: nominal
            });

            return res.status(200).json({ message: 'Pembayaran diajukan (update)' });
          }
        );
      }
    });
  });
});
    } else if (status === 'ditolak') {
    // 1. Simpan alasan penolakan ke DB
    db.query(`UPDATE event_ticket SET alasan_penolakan = ?, status = 'ditolak', admin_id = ? WHERE event_id = ?`,
      [alasan, admin_id, event_id], (err3) => {
        if (err3) {
          return res.status(500).json({ error: 'Gagal simpan alasan penolakan' });
        }

        // 2. Ambil data EO
        db.query(`SELECT et.nama_event, et.instansi, eo.email, eo.name
          FROM event_ticket et
          JOIN users eo ON et.organizer_id = eo.user_id
          WHERE et.event_id = ?`, [event_id], async (err4, result4) => {
          if (err4 || result4.length === 0) {
            console.warn('❗ Gagal ambil data EO untuk email');
          } else {
            const { nama_event, instansi, email, name } = result4[0];

            // 3. Kirim email ke EO
            try {
              await resend.emails.send({
                from: 'onboarding@resend.dev',
                to: 'tiketkita69@gmail.com',
                subject: 'Pengajuan Event Anda Ditolak ❌',
                html: `
                  <div style="font-family: sans-serif; line-height: 1.5;">
                    <h2>Halo ${name},</h2>
                    <p>Event <strong>${nama_event}</strong> dari <strong>${instansi}</strong> telah <span style="color:red;"><strong>ditolak</strong></span> oleh admin TiketKita.</p>
                    <p><strong>Alasan Penolakan:</strong> ${alasan}</p>
                    <p>Silakan revisi dan ajukan kembali jika diperlukan.</p>
                    <br>
                    <p>Terima kasih,</p>
                    <p><em>Tim TiketKita</em></p>
                  </div>
                `
              });
            } catch (emailErr) {
              console.error('❌ Gagal kirim email penolakan:', emailErr);
            }
          }

          // 4. Kirim ke Kafka
          sendEventLifecycle({
            event_id,
            status: 'ditolak',
            admin_id,
            alasan_penolakan: alasan
          });

          // 5. Response ke frontend
          return res.status(200).json({ message: 'Event ditolak, email terkirim & Kafka updated' });
        });
      });
    }else if (status === 'diterima') {
  db.query(
    `UPDATE event_ticket SET status = 'diterima', admin_id = ? WHERE event_id = ?`,
    [admin_id, event_id],
    (err1) => {
      if (err1) return res.status(500).json({ error: 'Gagal update status event' });

      db.query(
        `UPDATE organizer_payments SET status = 'success', tanggal = NOW() WHERE event_id = ?`,
        [event_id],
        (err2) => {
          if (err2) return res.status(500).json({ error: 'Gagal update status pembayaran' });

          // Kirim ke Kafka
          sendEventLifecycle({
            event_id: Number(event_id),
            admin_id,
            status: 'diterima'
          });

          // Respon ke frontend
          return res.status(200).json({ message: '✅ Event dikonfirmasi dan pembayaran success' });
        }
      );
    }
  );
}
});

// EO upload bukti transfer
router.put('/eo/upload-bukti/:eventId', upload.single('bukti_transfer'), (req, res) => {
  const { eventId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'File bukti transfer wajib diunggah' });

  const bukti_transfer = req.file.filename;

  // Cek apakah sudah ada pembayaran untuk event ini
  db.query(`SELECT * FROM organizer_payments WHERE event_id = ?`, [eventId], (err0, result0) => {
    if (err0) return res.status(500).json({ error: 'Gagal cek data pembayaran' });

    if (result0.length === 0) {
      // INSERT baru jika belum ada
      db.query(`SELECT organizer_id, admin_id FROM event_ticket WHERE event_id = ?`, [eventId], (err1, result1) => {
        if (err1 || result1.length === 0) return res.status(500).json({ error: 'Gagal ambil data event' });

        const { organizer_id, admin_id } = result1[0];

        db.query(`
          INSERT INTO organizer_payments (
            payment_id, organizer_id, event_id, admin_id,
            bukti_transfer, jumlah, status, tanggal, nomor_rekening
          ) VALUES (NULL, ?, ?, ?, ?, 0, 'pending', NOW(), ?)
        `, [organizer_id, eventId, admin_id, bukti_transfer], (err2) => {
          if (err2) return res.status(500).json({ error: 'Gagal insert pembayaran' });

          sendEventLifecycle({
            event_id: Number(eventId),
            organizer_id,
            admin_id,
            jumlah: 0,
            bukti_transfer,
            nomor_rekening,
            status: 'dibayar'
          });

          return res.status(200).json({ message: '✅ Bukti transfer berhasil (insert & Kafka)' });
        });
      });

    } else {
      // UPDATE jika sudah ada
      db.query(`UPDATE organizer_payments SET bukti_transfer = ?, status = 'pending', tanggal = NOW() WHERE event_id = ?`,
        [bukti_transfer, eventId], (err3) => {
          if (err3) return res.status(500).json({ error: 'Gagal simpan bukti transfer' });

          const { organizer_id, admin_id, jumlah, nomor_rekening } = result0[0];

          sendEventLifecycle({
            event_id: Number(eventId),
            organizer_id,
            admin_id,
            jumlah,
            bukti_transfer,
            nomor_rekening,
            status: 'dibayar'
          });

          return res.status(200).json({ message: '✅ Bukti transfer berhasil (update & Kafka)' });
        });
    }
  });
});

// EO bayar isi nominal manual
router.put('/eo/event-bayar/:id', (req, res) => {
  const event_id = req.params.id;
  const { nominal } = req.body;

  if (!nominal || isNaN(nominal)) return res.status(400).json({ error: 'Nominal pembayaran tidak valid' });

  db.query(`SELECT organizer_id, admin_id FROM event_ticket WHERE event_id = ?`, [event_id], (err, result) => {
    if (err || result.length === 0) return res.status(500).json({ error: 'Gagal ambil data event' });

    const { organizer_id, admin_id } = result[0];

    db.query(`UPDATE organizer_payments SET jumlah = ?, tanggal = NOW() WHERE event_id = ?`, [nominal, event_id], (err) => {
      if (err) return res.status(500).json({ error: 'Gagal update pembayaran EO' });

      db.query(`UPDATE event_ticket SET status = 'dibayar' WHERE event_id = ?`, [event_id], (err2) => {
        if (err2) return res.status(500).json({ error: 'Gagal update status event' });

        sendEventLifecycle({
          event_id: Number(event_id),
          organizer_id,
          admin_id,
          jumlah: nominal,
          status: 'dibayar'
        });

        res.status(200).json({ message: 'Pembayaran berhasil dan status diperbarui' });
      });
    });
  });
});

// Info pembayaran EO
router.get('/eo/payment-info/:eventId', (req, res) => {
  const { eventId } = req.params;

  db.query(`SELECT jumlah, nomor_rekening FROM organizer_payments WHERE event_id = ? AND status IN ('pending', 'menunggu_dibayar') ORDER BY tanggal DESC LIMIT 1`,
    [eventId], (err, results) => {
      if (err) return res.status(500).json({ error: 'Gagal mengambil data nominal' });
      if (results.length === 0) return res.status(404).json({ error: 'Nominal tidak ditemukan' });

      res.status(200).json(results[0]);
    });
});

// Ambil bukti transfer
router.get('/eo/bukti-transfer/:eventId', (req, res) => {
  const { eventId } = req.params;

  db.query(`SELECT bukti_transfer FROM organizer_payments WHERE event_id = ? AND bukti_transfer IS NOT NULL ORDER BY tanggal DESC LIMIT 1`,
    [eventId], (err, results) => {
      if (err) return res.status(500).json({ error: 'Gagal ambil bukti transfer' });
      if (results.length === 0) return res.status(404).json({ error: 'Bukti transfer tidak ditemukan' });

      res.status(200).json({ bukti_transfer: results[0].bukti_transfer });
    });
});

// Hapus event dan data terkait
router.delete('/delete-event/:eventId', (req, res) => {
  const { eventId } = req.params;

  // Ambil organizer_id dulu sebelum dihapus
  db.query('SELECT organizer_id FROM event_ticket WHERE event_id = ?', [eventId], (err0, result0) => {
    if (err0 || result0.length === 0) {
      return res.status(404).json({ error: 'Event tidak ditemukan' });
    }

    const organizer_id = result0[0].organizer_id;

    db.query('DELETE FROM orders WHERE event_id = ?', [eventId], (err1) => {
      if (err1) return res.status(500).json({ error: 'Gagal hapus orders' });

      db.query('DELETE FROM tickets WHERE event_id = ?', [eventId], (err2) => {
        if (err2) return res.status(500).json({ error: 'Gagal hapus tickets' });

        db.query('DELETE FROM organizer_payments WHERE event_id = ?', [eventId], (err3) => {
          if (err3) return res.status(500).json({ error: 'Gagal hapus pembayaran' });

          db.query('DELETE FROM event_ticket WHERE event_id = ?', [eventId], (err4) => {
            if (err4) return res.status(500).json({ error: 'Gagal hapus event' });

            sendEventLifecycle({
            event_id: Number(eventId),
            organizer_id,
            status: 'dihapus'
          });

            res.status(200).json({ message: '✅ Event dan semua data terkait berhasil dihapus' });
          });
        });
      });
    });
  });
});

module.exports = router;