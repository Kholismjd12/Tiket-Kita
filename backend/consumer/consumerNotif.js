const kafka = require('../kafka');

const consumer = kafka.consumer({ groupId: 'notif-log-group' });

async function consumerNotif() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'notification', fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const data = JSON.parse(message.value.toString());
        const { name, email, role, action, title } = data;

        if (!email || !action) {
          console.warn('⚠️ Field email dan action wajib.');
          return;
        }

        // Deteksi tipe notifikasi berdasarkan isi
        if (['approve', 'reject'].includes(action) && role === 'admin') {
          const label = action === 'approve' ? '✅ DISSETUJUI' : '❌ DITOLAK';
          console.log(`📥 [Kafka] AKUN ADMIN ${label} - ${name} (${email})`);
        } else if (title) {
          // Untuk notifikasi event (berdasarkan field title)
          console.log(`📥 [Kafka] ${action.toUpperCase()} notifikasi oleh ${email} - Judul: ${title}`);
        } else {
          console.warn(`⚠️ [Kafka] Format notifikasi tidak dikenali:`, data);
        }

      } catch (err) {
        console.error('❌ Kafka notif error:', err.message);
      }
    }
  });
}

module.exports = consumerNotif;

if (require.main === module) {
  consumerNotif().catch(err => {
    console.error('❌ Gagal menjalankan Kafka Consumer Notif:', err.message);
  });
}