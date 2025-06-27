const kafka = require('../kafka');

const consumer = kafka.consumer({ groupId: 'order-log-group' });

async function consumerOrder() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'order-lifecycle', fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const data = JSON.parse(message.value.toString());
        const {
          action,
          order_id,
          user_id,
          event_id,
          ticket_id,
          jumlah,
          harga,
          status,
          timestamp,
        } = data;

        if (!order_id || !user_id || !action) {
          console.warn('⚠️ Field order_id, user_id, dan action wajib.');
          return;
        }

        if (action === 'buat') {
        message = `[Kafka] Order baru dibuat oleh User ${data.user_id} untuk Event ${data.event_id}, Jumlah: ${data.jumlah}`;
        } else if (action === 'konfirmasi') {
        message = `[Kafka] Order #${data.order_id} telah dikonfirmasi dan dibayar.`;
        } else if (action === 'batalkan') {
        message = `[Kafka] Order #${data.order_id} dibatalkan.`;
        } else {
        throw new Error(`⚠️ Aksi '${action}' tidak valid. Gunakan salah satu dari: ${allowedActions.join(', ')}`);
        }
      } catch (err) {
        console.error('❌ Kafka order error:', err.message);
      }
    },
  });
}

module.exports = consumerOrder;

if (require.main === module) {
  consumerOrder().catch((err) => {
    console.error('❌ Gagal menjalankan Kafka Consumer Order:', err.message);
  });
}