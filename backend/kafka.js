// backend/kafka.js
const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'tiketkita-app',
  brokers: ['192.168.2.231:9092'] ,
  brokers: ['192.168.2.75:9093'] 
 // brokers: ['localhost:9092']
});

module.exports = kafka;