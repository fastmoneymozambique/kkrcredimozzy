// server.js
// Este arquivo é o ponto de entrada principal do backend da KKR Credit.
// Ele inicializa o servidor Express, conecta ao banco de dados MongoDB,
// configura middlewares essenciais, define as rotas da API e inicia o scheduler.

require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env
const express = require('express');
const mongoose = require('mongoose'); // Mongoose é necessário para o erro de conexão do DB
const cors = require('cors'); // Para permitir requisições de diferentes origens
const { connectDB } = require('./config'); // Importa a função de conexão DB
const { appRoutes } = require('./routes'); // Importa as rotas da aplicação
const { logError, logInfo } = require('./utils'); // Para logging
const { startScheduler } = require('./scheduler'); // Importa o scheduler
const { createInitialAdmin } = require('./controllers'); // Importa a função para criar o admin inicial

const app = express();
const PORT = process.env.PORT || 5000;

// --- Configuração de Middlewares ---
// Configuração CORS: Permite que o frontend em um domínio diferente acesse o backend.
// A origem permitida pode ser configurada via variáveis de ambiente.
const corsOptions = {
    origin: process.env.CORS_ORIGIN === '*' ? '*' : process.env.CORS_ORIGIN,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// Middleware para parsing de JSON no corpo das requisições
app.use(express.json());

// --- Conexão ao Banco de Dados e Inicialização de Admin/Scheduler ---
const initializeApp = async () => {
    try {
        await connectDB(); // Tenta conectar ao DB
        await createInitialAdmin(); // Cria o admin inicial se não existir
        startScheduler(); // Inicia as tarefas agendadas
    } catch (error) {
        logError(`Falha na inicialização da aplicação: ${error.message}`, { stack: error.stack });
        // O erro já é tratado em connectDB, mas é bom ter um log aqui também.
        process.exit(1);
    }
};

initializeApp(); // Chama a função de inicialização


// --- Rotas da Aplicação ---
// Todas as rotas da API são definidas no arquivo routes.js e importadas aqui.
appRoutes(app); // Passa a instância do app para as rotas serem registradas

// --- Rota de Teste Simples ---
app.get('/', (req, res) => {
    res.status(200).json({ message: 'Bem-vindo ao Backend da KKR Credit!' });
});

// --- Tratamento de Erros Global (Middleware de Erro) ---
// Este middleware captura erros que não foram tratados pelas rotas/controladores.
app.use((err, req, res, next) => {
    logError(`Erro interno do servidor: ${err.message}`, { stack: err.stack, method: req.method, path: req.path });
    res.status(500).json({ message: 'Ocorreu um erro interno no servidor.', error: err.message });
});

// --- Inicialização do Servidor ---
app.listen(PORT, () => {
    logInfo(`Servidor rodando na porta ${PORT}`);
    logInfo(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
    logInfo(`CORS_ORIGIN: ${process.env.CORS_ORIGIN}`);
});

// --- Tratamento de Exceções Não Capturadas ---
process.on('unhandledRejection', (reason, promise) => {
    logError(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    // Opcional: Encerrar o processo para evitar estado inconsistente.
    // process.exit(1);
});

process.on('uncaughtException', (error) => {
    logError(`Uncaught Exception: ${error.message}`, { stack: error.stack });
    // Encerrar o processo para evitar estado inconsistente.
    process.exit(1);
});