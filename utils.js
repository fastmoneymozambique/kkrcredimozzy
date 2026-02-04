// utils.js
// Este arquivo contém funções utilitárias diversas para a aplicação,
// como funções de logging para manter um registro claro de erros e ações.

const fs = require('fs');
const path = require('path');

// Define o diretório para os logs
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

const INFO_LOG_FILE = path.join(LOG_DIR, 'info.log');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'error.log');
const ADMIN_ACTION_LOG_FILE = path.join(LOG_DIR, 'admin_actions.log');

/**
 * Formata a mensagem de log com timestamp.
 * @param {string} message - A mensagem principal do log.
 * @param {object} [details={}] - Objeto com detalhes adicionais para o log.
 * @returns {string} A mensagem de log formatada.
 */
const formatLogMessage = (message, details = {}) => {
    const timestamp = new Date().toISOString();
    return JSON.stringify({
        timestamp,
        message,
        ...details,
    }) + '\n';
};

/**
 * Escreve uma mensagem de log em um arquivo e no console (se não for ambiente de teste).
 * @param {string} filePath - O caminho do arquivo de log.
 * @param {string} message - A mensagem a ser logada.
 */
const writeLog = (filePath, message) => {
    fs.appendFile(filePath, message, (err) => {
        if (err) {
            console.error(`Falha ao escrever no arquivo de log ${filePath}:`, err);
        }
    });
    // Apenas printa no console em desenvolvimento/produção, não em teste
    if (process.env.NODE_ENV !== 'test') {
        console.log(message.trim());
    }
};

/**
 * Loga informações gerais da aplicação.
 * @param {string} message - A mensagem de informação.
 * @param {object} [details={}] - Detalhes adicionais.
 */
const logInfo = (message, details = {}) => {
    const formattedMessage = formatLogMessage(`INFO: ${message}`, details);
    writeLog(INFO_LOG_FILE, formattedMessage);
};

/**
 * Loga erros da aplicação.
 * @param {string} message - A mensagem de erro.
 * @param {object} [details={}] - Detalhes adicionais, como stack trace.
 */
const logError = (message, details = {}) => {
    const formattedMessage = formatLogMessage(`ERROR: ${message}`, details);
    writeLog(ERROR_LOG_FILE, formattedMessage);
};

/**
 * Loga ações administrativas importantes.
 * @param {string} adminId - O ID do administrador que realizou a ação.
 * @param {string} action - A descrição da ação realizada.
 * @param {object} [details={}] - Detalhes adicionais da ação.
 */
const logAdminAction = (adminId, action, details = {}) => {
    const formattedMessage = formatLogMessage(`ADMIN_ACTION by ${adminId}: ${action}`, details);
    writeLog(ADMIN_ACTION_LOG_FILE, formattedMessage);
};

/**
 * Gera um código de referência único.
 * @returns {string} Um código de referência alfanumérico de 8 caracteres.
 */
const generateReferralCode = () => {
    // Caracteres permitidos para o código de referência
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    const charactersLength = characters.length;
    for (let i = 0; i < 8; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
};


// Exporta as funções de utilidade
module.exports = {
    logInfo,
    logError,
    logAdminAction,
    generateReferralCode,
};