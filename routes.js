// routes.js
// Este arquivo define todas as rotas da API e as associa aos controladores correspondentes,
// aplicando middlewares de autenticação e autorização quando necessário.

const express = require('express');
const {
    registerUser,
    loginUser,
    getUserProfile,
    createInvestmentPlan,
    getInvestmentPlans,
    getInvestmentPlanById,
    updateInvestmentPlan,
    deleteInvestmentPlan,
    activateInvestment,
    upgradeInvestment, // NOVO: Importa o novo controlador
    getUserActiveInvestments,
    getUserInvestmentHistory,
    requestDeposit,
    getUserDeposits,
    getPendingDeposits,
    approveDeposit,
    rejectDeposit,
    requestWithdrawal,
    getUserWithdrawals,
    getPendingWithdrawals,
    approveWithdrawal,
    rejectWithdrawal,
    getAdminConfig,
    updateAdminConfig,
    getAllUsers,
    getUserDetails,
    blockUser,
    unblockUser,
    createAdmin,
    changeUserPasswordByAdmin,
    getBlockedUsers,
    processDailyProfitsAndCommissions,
    getDepositConfig,
    getAdminLogs,
} = require('./controllers'); // Importa todos os controladores
const { protect, authorizeAdmin } = require('./middleware'); // Importa os middlewares de segurança
const { upload, uploadToCloudinary } = require('./uploadMiddleware'); // Importa middlewares de upload

const router = express.Router(); // Cria uma instância de router do Express

/**
 * @function appRoutes
 * @description Configura todas as rotas da aplicação no objeto Express 'app'.
 * @param {object} app - A instância do aplicativo Express.
 */
const appRoutes = (app) => {
    // --- Rotas de Autenticação e Usuário (Públicas e Privadas) ---
    router.post('/register', registerUser);
    router.post('/login', loginUser);
    router.get('/profile', protect, getUserProfile); // Perfil do usuário logado

    // --- Rotas de Configuração Pública (Novo para o Checkout) ---
    router.get('/deposit-config', getDepositConfig); // Configs de depósito M-Pesa/Emola

    // --- Rotas de Planos de Investimento (Públicas para leitura, Admin para CRUD) ---
    router.get('/investmentplans', getInvestmentPlans); // Todos podem ver os planos (Ativos)
    router.get('/investmentplans/:id', getInvestmentPlanById); // Todos podem ver um plano específico

    // --- Rotas de Investimento do Usuário ---
    router.post('/investments', protect, activateInvestment); // Ativar um novo investimento
    router.post('/investments/upgrade', protect, upgradeInvestment); // NOVO: Fazer upgrade de investimento
    router.get('/investments/active', protect, getUserActiveInvestments); // Ver investimentos ativos
    router.get('/investments/history', protect, getUserInvestmentHistory); // Ver histórico de investimentos

    // --- Rotas de Depósito do Usuário ---
    router.post('/deposits', protect, requestDeposit); // Solicitar um depósito
    router.get('/deposits/history', protect, getUserDeposits); // Ver histórico de depósitos do usuário

    // --- Rotas de Saque do Usuário ---
    router.post('/withdrawals', protect, requestWithdrawal); // Solicitar um saque
    router.get('/withdrawals/history', protect, getUserWithdrawals); // Ver histórico de saques do usuário

    // --- Rotas do Painel Administrativo (Exigem autenticação e autorização de Admin) ---

    // Gerenciamento de Planos de Investimento
    router.get('/admin/investmentplans', protect, authorizeAdmin, getInvestmentPlans); 
    
    // Rota de Criação com Upload de Imagem
    router.post('/admin/investmentplans', 
        protect, 
        authorizeAdmin, 
        upload.single('image'), // 1. Multer processa o campo 'image'
        uploadToCloudinary, // 2. Envia para o Cloudinary e coloca a URL em req.uploadedImageUrl
        createInvestmentPlan); // 3. Controller salva o plano com a nova URL
    
    // Rota de Atualização com Upload de Imagem
    router.put('/admin/investmentplans/:id', 
        protect, 
        authorizeAdmin, 
        upload.single('image'), // 1. Multer processa o campo 'image'
        uploadToCloudinary, // 2. Envia para o Cloudinary
        updateInvestmentPlan); // 3. Controller atualiza o plano com a nova URL
        
    router.delete('/admin/investmentplans/:id', protect, authorizeAdmin, deleteInvestmentPlan);

    // Gerenciamento de Depósitos
    router.get('/admin/deposits/pending', protect, authorizeAdmin, getPendingDeposits);
    router.put('/admin/deposits/:id/approve', protect, authorizeAdmin, approveDeposit);
    router.put('/admin/deposits/:id/reject', protect, authorizeAdmin, rejectDeposit);

    // Gerenciamento de Saques
    router.get('/admin/withdrawals/pending', protect, authorizeAdmin, getPendingWithdrawals);
    router.put('/admin/withdrawals/:id/approve', protect, authorizeAdmin, approveWithdrawal);
    router.put('/admin/withdrawals/:id/reject', protect, authorizeAdmin, rejectWithdrawal);

    // Gerenciamento de Usuários
    router.get('/admin/users', protect, authorizeAdmin, getAllUsers); // LISTAR TODOS

    // CRÍTICO: Rota fixa '/blocked' DEVE vir antes de rotas dinâmicas como '/:id'
    router.get('/admin/users/blocked', protect, authorizeAdmin, getBlockedUsers); // LISTAR BLOQUEADOS
    
    router.get('/admin/users/:id', protect, authorizeAdmin, getUserDetails); // DETALHES DE UM ÚNICO USUÁRIO
    
    router.put('/admin/users/:id/block', protect, authorizeAdmin, blockUser);
    router.put('/admin/users/:id/unblock', protect, authorizeAdmin, unblockUser);
    router.post('/admin/users/create-admin', protect, authorizeAdmin, createAdmin); // Criar novos admins
    router.put('/admin/users/:id/change-password', protect, authorizeAdmin, changeUserPasswordByAdmin);
    
    // Logs de Admin
    router.get('/admin/logs/admin-actions', protect, authorizeAdmin, getAdminLogs); 

    // Gerenciamento de Configurações Administrativas / Promoções
    router.get('/admin/config', protect, authorizeAdmin, getAdminConfig);
    router.put('/admin/config', protect, authorizeAdmin, updateAdminConfig);

    // --- Rota Interna para Tarefas Agendadas (CRON) ---
    router.post('/internal/process-daily-profits', protect, authorizeAdmin, processDailyProfitsAndCommissions);


    // Conecta todas as rotas definidas com o prefixo /api
    app.use('/api', router);
};

module.exports = { appRoutes };