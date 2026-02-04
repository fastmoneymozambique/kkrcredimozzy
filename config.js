// config.js
// Este arquivo é responsável por gerenciar a conexão com o banco de dados MongoDB
// e definir outras configurações globais da aplicação.

const mongoose = require('mongoose');
const { logInfo, logError } = require('./utils'); // Importa as funções de logging

/**
 * Conecta a aplicação ao banco de dados MongoDB.
 * A URI de conexão é obtida das variáveis de ambiente (process.env.MONGO_URI).
 */
const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI);
        logInfo(`MongoDB Conectado: ${conn.connection.host}`);
    } catch (error) {
        logError(`Erro ao conectar ao MongoDB: ${error.message}`, { stack: error.stack });
        process.exit(1); // Encerra o processo da aplicação em caso de falha na conexão com o DB
    }
};

// Exporta a função de conexão para ser usada em server.js
module.exports = {
    connectDB,
    // Outras configurações globais podem ser adicionadas aqui futuramente.
    // Ex: JWT_SECRET, EMAIL_SERVICE_API_KEY, etc.
};