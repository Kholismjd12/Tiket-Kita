const kafka = require('../kafka');
const db = require('../db');

const consumer = kafka.consumer({ groupId: 'payment-log-group' });

async function consumerPayment() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'payment-lifecycle', fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const data = JSON.parse(message.value.toString());
        let {
          action,
          organizer_id,
          event_id,
          admin_id,
          bukti_transfer,
          jumlah,
          status,
          timestamp
        } = data;

        // 🔁 Mapping status eksternal ke internal payment
        if (status === 'dibayar') status = 'pending';
        if (status === 'diterima') status = 'success';
        if (status === 'ditolak') status = 'gagal';

        const allowedStatus = ['pending', 'success', 'gagal'];

        // 🛠️ Fallback dari event_ticket jika data belum lengkap
        if ((!organizer_id || !status) && event_id) {
          const [eventRows] = await db.promise().query(
            'SELECT organizer_id, status FROM event_ticket WHERE event_id = ? LIMIT 1',
            [event_id]
          );
          if (eventRows.length) {
            organizer_id = organizer_id || eventRows[0].organizer_id;
            const originalStatus = eventRows[0].status;
            if (originalStatus === 'dibayar') status = 'pending';
            else if (originalStatus === 'diterima') status = 'success';
            else if (originalStatus === 'ditolak') status = 'gagal';
          } else {
            console.warn('⚠️ Event tidak ditemukan di DB:', data);
            return;
          }
        }

        // ❌ Validasi final
        if (!organizer_id || !event_id || !status || !allowedStatus.includes(status)) {
          console.warn('⚠️ Data tidak valid atau status bukan enum yang diizinkan:', data);
          return;
        }

        // ❓ Ambil jumlah jika kosong (untuk konfirmasi EO)
        if (!jumlah && action === 'konfirmasi') {
          const [rows] = await db.promise().query(
            'SELECT jumlah FROM organizer_payments WHERE event_id = ? ORDER BY tanggal DESC LIMIT 1',
            [event_id]
          );
          if (!rows.length) {
            console.warn('⚠️ Tidak ada data pembayaran sebelumnya untuk konfirmasi:', data);
            return;
          }
          jumlah = rows[0].jumlah;
        }
        timestamp = timestamp || new Date();

        // 🧠 Cek apakah sudah ada payment
        const [existing] = await db.promise().query(
        'SELECT 1 FROM organizer_payments WHERE event_id = ? LIMIT 1',
        [event_id]
        );

        if (existing.length === 0) {
          // ➕ INSERT jika belum ada
          await db.promise().query(
            `INSERT INTO organizer_payments 
              (organizer_id, event_id, admin_id, bukti_transfer, jumlah, status, tanggal)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              organizer_id,
              event_id,
              admin_id || null,
              bukti_transfer || null,
              jumlah,
              status,
              timestamp
            ]
          );
        } else {
          // 🔁 UPDATE jika sudah ada
          await db.promise().query(
            `UPDATE organizer_payments
             SET admin_id = COALESCE(?, admin_id),
                 bukti_transfer = COALESCE(?, bukti_transfer),
                 jumlah = COALESCE(?, jumlah),
                 status = ?,
                 tanggal = ?
             WHERE event_id = ?`,
            [
              admin_id || null,
              bukti_transfer || null,
              jumlah || null,
              status,
              timestamp,
              event_id
            ]
          );
        }

        // 📄 Ambil nama event dan instansi
        const [infoRows] = await db.promise().query(
        `SELECT nama_event, instansi
        FROM event_ticket
        WHERE event_id = ?
        LIMIT 1`,
        [event_id]
        );

        const nama_event = infoRows[0]?.nama_event || '(Tidak Diketahui)';
        const instansi = infoRows[0]?.instansi || '(Tidak Diketahui)';

        // 🧾 Format log berdasarkan aksi
        const isAdminKonfirmasi = (
        action === 'konfirmasi' &&
        typeof admin_id === 'number' && !isNaN(admin_id)
        );

        let logMessage = '';
        if (action === 'buat') {
        logMessage = `📤 PEMBAYARAN diajukan oleh Admin untuk Event ID ${event_id}, Event: "${nama_event}", EO: "${instansi}"`;
        } else if (action === 'bayar') {
        logMessage = `📥 PEMBAYARAN diajukan oleh EO: "${instansi}" untuk Event ID ${event_id}, Event: "${nama_event}"`;
        } else if (action === 'konfirmasi') {
        logMessage = `✅ PEMBAYARAN dikonfirmasi oleh Admin untuk Event ID ${event_id}, Event: "${nama_event}", EO: "${instansi}"`;
        }

        console.log(logMessage);

      } catch (err) {
        console.error('❌ Kafka payment error:', err.message);
      }
    }
  });
}

module.exports = consumerPayment;

if (require.main === module) {
  consumerPayment().catch(err => {
    console.error('❌ Gagal menjalankan Kafka Consumer Payment:', err.message);
  });
}