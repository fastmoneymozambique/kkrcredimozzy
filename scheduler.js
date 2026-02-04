// scheduler.js
// Este arquivo configura e gerencia tarefas agendadas (CRON jobs) para a aplicação.
// A principal tarefa é o processamento diário de lucros e comissões.

const cron = require('node-cron');
const { processDailyProfitsAndCommissions } = require('./controllers');
const { logInfo, logError } = require('./utils');
const { connectDB } = require('./config'); // Para garantir a conexão antes de agendar

/**
 * Inicia as tarefas agendadas da aplicação.
 * Deve ser chamado APÓS a conexão bem-sucedida ao banco de dados no server.js.
 */
const startScheduler = () => {
    // Agenda a tarefa para rodar todos os dias à meia-noite (00:00).
    // O formato do CRON pode ser configurado via variável de ambiente CRON_SCHEDULE.
    // Exemplo de formato: '0 0 * * *' para todos os dias à 00:00.
    // Para testes, pode-se usar '*/1 * * * *' para cada minuto.
    cron.schedule(process.env.CRON_SCHEDULE || '0 0 * * *', async () => {
        logInfo('Iniciando tarefa agendada: processamento diário de lucros e comissões.');
        try {
            // Tenta reconectar ou garante que a conexão DB está ativa antes de executar a tarefa.
            // Isso é crucial se o DB cair e retornar enquanto a aplicação estiver rodando.
            await connectDB();
            // Chama a função do controller, passando null para req e res, pois é um job interno.
            // A função do controller deve ser robusta o suficiente para lidar com isso.
            await processDailyProfitsAndCommissions(null, null);
            logInfo('Tarefa agendada concluída: processamento diário de lucros e comissões.');
        } catch (error) {
            logError(`Erro na tarefa agendada de processamento diário: ${error.message}`, { stack: error.stack });
        }
    }, {
        scheduled: true,
        // Define o fuso horário para o agendamento. É importante para garantir que o job rode
        // na hora correta, independentemente do fuso horário do servidor.
        timezone: process.env.TZ || 'Africa/Maputo'
    });

    logInfo(`Scheduler iniciado. Próxima execução de lucros agendada para: ${process.env.CRON_SCHEDULE || 'diariamente à 00:00'} (Fuso Horário: ${process.env.TZ || 'Africa/Maputo'}).`);
};

module.exports = { startScheduler };