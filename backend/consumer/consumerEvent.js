const kafka = require('../kafka');
const db = require('../db');
const util = require('util');

const consumer = kafka.consumer({ groupId: 'event-lifecycle-group' });
const query = util.promisify(db.query).bind(db);

async function generateCustomPaymentId() {
  const result = await query('SELECT COUNT(*) AS count FROM organizer_payments');
  const nextId = result[0].count + 1;
  return `payment-${nextId}`;
}

function consumerEvent() {
  consumer.connect()
    .then(() => {
      console.log('✅ Kafka consumer event terhubung');
      return consumer.subscribe({ topic: 'event-lifecycle', fromBeginning: false });
    })
    .then(() => {
      return consumer.run({
        eachMessage: async ({ message }) => {
          try {
            const data = JSON.parse(message.value.toString());

            const {
              event_id,
              organizer_id,
              admin_id,
              status,
              nama_event,
              instansi,
              tanggal,
              lokasi,
              deskripsi,
              gambar_event,
              harga,
              jumlah_tersedia,
              jumlah,
              bukti_transfer,
              nomor_rekening
            } = data;

            if (!event_id || !status) {
              console.warn('⚠️ Data tidak lengkap:', data);
              return;
            }

            const existingEvent = await query('SELECT * FROM event_ticket WHERE event_id = ?', [event_id]);

            // === STATUS: pending ===
            if (status === 'pending') {
              console.log(`[Kafka Debug] Cek pending: event_id=${event_id}, organizer_id=${organizer_id}`);

              if (!organizer_id) {
                console.warn('❗ organizer_id kosong, lewati proses insert event');
                return;
              }

              if (existingEvent.length === 0) {
                await query(`
                  INSERT INTO event_ticket (
                    event_id, organizer_id, admin_id, nama_event, instansi, tanggal,
                    lokasi, deskripsi, gambar_event, harga, jumlah_tersedia, status
                  ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                `, [
                  event_id, organizer_id, nama_event, instansi, tanggal,
                  lokasi, deskripsi, gambar_event, harga, jumlah_tersedia
                ]);

                console.log(`📥 [Kafka] EO (${instansi}) Ajukan Event - ${nama_event} (ID: ${event_id})`);
              } else {
                console.log(`📥 [Kafka] EO (${instansi}) Ajukan Event - ${nama_event} (ID: ${event_id})`);
              }
            }

            // === STATUS: menunggu_dibayar ===
            if (status === 'menunggu_dibayar') {
              await query(`UPDATE event_ticket SET status = 'menunggu_dibayar', admin_id = ? WHERE event_id = ?`, [admin_id || null, event_id]);

              const existingPayment = await query('SELECT * FROM organizer_payments WHERE event_id = ?', [event_id]);
              const jumlahValid = !isNaN(jumlah) ? Number(jumlah) : 0;

              if (existingPayment.length === 0) {
                const payment_id = await generateCustomPaymentId();
                await query(`
                INSERT INTO organizer_payments (
                  payment_id, organizer_id, event_id, admin_id, bukti_transfer,
                  jumlah, status, tanggal, nomor_rekening
                ) VALUES (?, ?, ?, ?, NULL, ?, 'pending', NOW(), ?)
              `, [payment_id, organizer_id, event_id, admin_id || null, jumlahValid, nomor_rekening || null]);


                console.log(`🧾 [Kafka] Insert pembayaran baru untuk event_id: ${event_id}`);
              } else {
                await query(`
                UPDATE organizer_payments SET
                  jumlah = COALESCE(?, jumlah),
                  status = 'pending',
                  tanggal = NOW(),
                  admin_id = COALESCE(?, admin_id),
                  nomor_rekening = COALESCE(?, nomor_rekening)
                WHERE event_id = ?
              `, [jumlahValid, admin_id || null, nomor_rekening || null, event_id]);


                console.log(`🧾 [Kafka] Admin mengajukan pembayaran event_id: ${event_id} → jumlah: ${jumlahValid}`);
              }
            }

            // === STATUS: dibayar (EO upload bukti transfer) ===
            if (status === 'dibayar') {
              await query(`UPDATE organizer_payments SET bukti_transfer = ?, status = 'pending', tanggal = NOW() WHERE event_id = ?`,
                [bukti_transfer || null, event_id]);

              await query(`UPDATE event_ticket SET status = 'dibayar' WHERE event_id = ?`, [event_id]);

              console.log(`📤 [Kafka] EO upload bukti transfer dan event dibayar (event_id: ${event_id})`);
            }

            // === STATUS: diterima (admin konfirmasi pembayaran) ===
            if (status === 'diterima') {
              await query(`UPDATE event_ticket SET status = 'diterima', admin_id = ? WHERE event_id = ?`,
                [admin_id || null, event_id]);

              await query(`UPDATE organizer_payments SET status = 'success', tanggal = NOW() WHERE event_id = ?`, [event_id]);

              console.log(`✅ [Kafka] Admin (ID: ${admin_id}) konfirmasi pembayaran → event diterima (ID: ${event_id})`);
            }
            // === STATUS: ditolak ===
            if (status === 'ditolak') {
              await query(`UPDATE event_ticket SET status = 'ditolak', admin_id = ?, alasan_penolakan = ? WHERE event_id = ?`,
                [admin_id || null, data.alasan_penolakan || '-', event_id]);

              console.log(`📛 [Kafka] Event ditolak oleh Admin (ID: ${admin_id}) → event_id: ${event_id}`);
            }
            // === STATUS: dihapus ===
            if (status === 'dihapus') {
              await query('DELETE FROM orders WHERE event_id = ?', [event_id]);
              await query('DELETE FROM tickets WHERE event_id = ?', [event_id]);
              await query('DELETE FROM organizer_payments WHERE event_id = ?', [event_id]);
              await query('DELETE FROM event_ticket WHERE event_id = ?', [event_id]);

              console.log(`🗑️ [Kafka] EO (ID: ${organizer_id}) menghapus event & data terkait (event_id: ${event_id})`);
            }
          } catch (err) {
            console.error('❌ Kafka message parse error:', err.message);
          }
        }
      });
    })
    .catch(err => {
      console.error('❌ Gagal menjalankan Kafka Consumer Event:', err.message);
    });
}

module.exports = consumerEvent;

if (require.main === module) {
  consumerEvent();
}