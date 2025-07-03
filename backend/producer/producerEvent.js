let producerInstance;

function setProducer(producer) {
  producerInstance = producer;
}

async function sendEventLifecycle({
  event_id,
  organizer_id,
  nama_event,
  status,
  instansi = '',
  tanggal = '',
  lokasi = '',
  alasan_penolakan = '',
  deskripsi = '',
  gambar_event = '',
  harga,
  jumlah_tersedia,
  admin_id,
  jumlah,
  bukti_transfer = '',
  nomor_rekening = '',
  payment_id = ''
}) {
  if (!producerInstance) throw new Error('Kafka producer belum diinisialisasi');

  const allowedStatuses = ['pending', 'menunggu_dibayar', 'dibayar', 'diterima', 'ditolak','dihapus'];
  if (!allowedStatuses.includes(status)) throw new Error(`Status '${status}' tidak valid.`);

  const hargaFinal = isNaN(Number(harga)) ? 0 : Number(harga);
  const jumlahFinal = isNaN(Number(jumlah_tersedia)) ? 0 : Number(jumlah_tersedia);
  const jumlahBayar = isNaN(Number(jumlah)) ? 0 : Number(jumlah);

  const payload = {
    event_id,
    organizer_id,
    nama_event,
    status,
    instansi,
    tanggal,
    lokasi,
    alasan_penolakan,
    deskripsi,
    gambar_event,
    harga: hargaFinal,
    jumlah_tersedia: jumlahFinal,
    admin_id,
    jumlah: jumlahBayar,
    bukti_transfer,       
    nomor_rekening,
    payment_id,       
    timestamp: new Date().toISOString()
  };

  try {
    await producerInstance.send({
      topic: 'event-lifecycle',
      messages: [
        {
          key: String(status),
          value: JSON.stringify(payload)
        }
      ]
    });
  } catch (err) {
    console.error('❌ Gagal kirim event ke Kafka:', err.message);
  }
}

module.exports = {
  setProducer,
  sendEventLifecycle
};