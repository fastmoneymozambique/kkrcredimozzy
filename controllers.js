// controllers.js
// Este arquivo contém toda a lógica de negócio (controladores) para as rotas da API.
// Ele interage com os modelos do MongoDB para realizar operações no banco de dados.

const { User, InvestmentPlan, Investment, Deposit, Withdrawal, AdminConfig } = require('./models');
const { logInfo, logError, logAdminAction, generateReferralCode } = require('./utils');
const bcrypt = require('bcryptjs'); // Para comparar senhas em login
const fs = require('fs'); // Para ler arquivos de log
const path = require('path'); // Para resolver caminhos de arquivo

// Caminho para o arquivo de log de ações administrativas
const ADMIN_ACTION_LOG_FILE = path.join(__dirname, 'logs', 'admin_actions.log');


// --- Funções Auxiliares Internas ---

/**
 * Gera um token JWT e o envia como cookie e JSON.
 * @param {object} user - O objeto de usuário Mongoose.
 * @param {number} statusCode - O status HTTP da resposta.
 * @param {object} res - O objeto de resposta Express.
 */
const sendTokenResponse = (user, statusCode, res) => {
    const token = user.getSignedJwtToken();

    const options = {
        expires: new Date(Date.now() + process.env.JWT_COOKIE_EXPIRE * 24 * 60 * 60 * 1000), // Converte dias para milissegundos
        httpOnly: true, // O cookie não pode ser acessado via JavaScript no navegador
        secure: process.env.NODE_ENV === 'production', // Apenas HTTPS em produção
        sameSite: 'strict', // Proteção contra CSRF
    };

    res.status(statusCode).cookie('token', token, options).json({
        success: true,
        token,
        user: {
            _id: user._id,
            phoneNumber: user.phoneNumber,
            balance: user.balance,
            // Removido: bonusBalance (Conforme solicitação)
            isAdmin: user.isAdmin,
            status: user.status,
            referralCode: user.referralCode,
            invitedBy: user.invitedBy,
            visitorId: user.visitorId,
        }
    });
};

/**
 * Cria o admin inicial se nenhum admin existir.
 * Esta função é chamada uma única vez na inicialização do server.js.
 */
const createInitialAdmin = async () => {
    try {
        const adminExists = await User.findOne({ isAdmin: true });
        if (!adminExists) {
            // Verifica se um usuário com o número de telefone 848441231 já existe para evitar erro de visitorId único
            const existingUserWithPhoneNumber = await User.findOne({ phoneNumber: '848441231' });

            if (existingUserWithPhoneNumber) {
                // Se o número de telefone já existe, e o admin ainda não foi criado (adminExists === false),
                // isso significa uma inconsistência ou uma tentativa anterior falha.
                logError('Tentativa de criar admin inicial, mas um usuário com o número de telefone 848441231 já existe e não é admin. Por favor, remova ou use outro número para o admin inicial.', { existingUserId: existingUserWithPhoneNumber._id });
                return; // Impede a criação se o número já estiver em uso.
            }

            const initialAdmin = await User.create({
                phoneNumber: '848441231',
                password: '147258', // Será hashed automaticamente pelo middleware 'pre save' do schema
                isAdmin: true,
                status: 'active',
                visitorId: 'initialAdminFingerprint', // Fingerprint dummy para o admin inicial
                referralCode: generateReferralCode(),
            });
            logInfo('Admin inicial criado com sucesso: 848441231 / 147258');
        } else {
            logInfo('Admin inicial já existe. Pulando a criação.');
        }

        // Garante que existe uma configuração AdminConfig, independentemente de já haver admin
        let adminConfig = await AdminConfig.findOne();
        if (!adminConfig) {
            adminConfig = await AdminConfig.create({}); // Cria com defaults
            logInfo('AdminConfig inicial criada.');
        } else {
            logInfo('AdminConfig já existe.');
        }

    } catch (error) {
        if (error.code === 11000) { // Erro de duplicidade (visitorId ou phoneNumber)
            logError(`Erro ao criar admin inicial: Já existe um usuário com o mesmo Visitor ID ou número de telefone.`, { error: error.message });
        } else {
            logError(`Erro inesperado ao criar admin inicial: ${error.message}`, { stack: error.stack });
        }
    }
};

// --- User Controllers ---

/**
 * @desc    Registrar um novo usuário
 * @route   POST /api/register
 * @access  Public
 */
const registerUser = async (req, res) => {
    const { phoneNumber, password, visitorId, inviteCode } = req.body; // Alterado invitedBy para inviteCode (consistência com frontend)

    // 1. Validação básica de entrada
    if (!phoneNumber || !password || !visitorId) {
        return res.status(400).json({ message: 'Por favor, forneça número de telefone, senha e visitorId.' });
    }

    // 2. Validação do número de telefone (já está no schema, mas é bom pré-validar para feedback rápido)
    if (!/^\d{9}$/.test(phoneNumber)) {
        return res.status(400).json({ message: 'Número de telefone inválido. Deve ter 9 dígitos.' });
    }

    try {
        // 3. Detecção de VisitorId Duplicado e Bloqueio
        const existingUsersWithSameVisitorId = await User.find({ visitorId });

        if (existingUsersWithSameVisitorId.length > 0) {
            // Bloqueia todas as contas associadas a este visitorId, incluindo a nova tentativa
            for (const user of existingUsersWithSameVisitorId) {
                if (user.status === 'active') { // Bloqueia apenas se estiver ativa
                    user.status = 'blocked';
                    await user.save();
                    logAdminAction('SYSTEM', `Conta bloqueada automaticamente por visitorId duplicado.`, { userId: user._id, visitorId: visitorId });
                }
            }
            logError(`Tentativa de registro com visitorId duplicado: ${visitorId}. Contas associadas bloqueadas.`, { phoneNumber, visitorId });
            return res.status(403).json({ message: 'Este dispositivo já foi usado para criar uma conta. Todas as contas associadas foram bloqueadas. Entre em contato com o suporte.' });
        }

        // 4. Checar se o número de telefone já está registrado
        const userExists = await User.findOne({ phoneNumber });
        if (userExists) {
            return res.status(400).json({ message: 'Número de telefone já registrado.' });
        }

        // 5. Gerar Referral Code
        let referralCode = generateReferralCode();
        let codeExists = await User.findOne({ referralCode });
        // Garante que o código de referência é único
        while (codeExists) {
            referralCode = generateReferralCode();
            codeExists = await User.findOne({ referralCode });
        }

        // 6. Processar Indicação (inviteCode) - Apenas para rastreamento
        let invitingUser = null;
        if (inviteCode) {
            invitingUser = await User.findOne({ referralCode: inviteCode });

            if (invitingUser) {
                // Previne auto-indicação e indicação entre contas com o mesmo visitorId
                if (invitingUser.visitorId === visitorId) {
                    logError(`Tentativa de auto-indicação ou indicação entre contas do mesmo dispositivo.`, { inviterId: invitingUser._id, inviteePhoneNumber: phoneNumber, visitorId });
                    invitingUser = null; // Ignora o convidante se for o mesmo dispositivo
                }
                // Adiciona o novo usuário à lista de referidos do convidante
                // Será preenchido com o _id do novo usuário após a criação
            } else {
                logInfo(`Código de indicação inválido: ${inviteCode} para ${phoneNumber}`);
            }
        }

        // 7. Criar o novo usuário
        const newUser = await User.create({
            phoneNumber,
            password,
            visitorId,
            referralCode,
            invitedBy: invitingUser ? invitingUser.referralCode : null, // Armazena o código de indicação do convidante
        });

        if (invitingUser) {
            // Agora que newUser._id existe, podemos adicioná-lo
            invitingUser.referredUsers.push(newUser._id);
            await invitingUser.save();
            logInfo(`Usuário ${newUser.phoneNumber} registrado e referido por ${invitingUser.phoneNumber}.`, { inviterId: invitingUser._id, inviteeId: newUser._id });
        }

        logInfo(`Novo usuário registrado: ${phoneNumber}`, { userId: newUser._id, visitorId });
        sendTokenResponse(newUser, 201, res);

    } catch (error) {
        if (error.code === 11000) { // Erro de duplicidade
            return res.status(400).json({ message: 'Número de telefone ou Visitor ID já está em uso.' });
        }
        logError(`Erro no registro do usuário: ${error.message}`, { stack: error.stack, phoneNumber });
        res.status(500).json({ message: 'Erro ao registrar usuário.' });
    }
};

/**
 * @desc    Autenticar usuário e obter token
 * @route   POST /api/login
 * @access  Public
 */
const loginUser = async (req, res) => {
    const { phoneNumber, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress; // Captura o IP

    if (!phoneNumber || !password) {
        return res.status(400).json({ message: 'Por favor, forneça número de telefone e senha.' });
    }

    try {
        const user = await User.findOne({ phoneNumber }).select('+password'); // Seleciona a senha para comparação

        if (!user) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // Verifica status da conta
        if (user.status === 'blocked') {
            logError(`Tentativa de login em conta bloqueada: ${phoneNumber}`, { userId: user._id });
            return res.status(403).json({ message: 'Sua conta está bloqueada. Entre em contato com o suporte.' });
        }

        const isMatch = await user.matchPassword(password);

        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // Atualiza informações de login
        user.lastLoginIp = ipAddress;
        user.lastLoginAt = new Date();
        await user.save();

        logInfo(`Usuário logado: ${phoneNumber}`, { userId: user._id, lastLoginIp: ipAddress });
        sendTokenResponse(user, 200, res);

    } catch (error) {
        logError(`Erro no login do usuário: ${error.message}`, { stack: error.stack, phoneNumber });
        res.status(500).json({ message: 'Erro ao fazer login.' });
    }
};

/**
 * @desc    Obter perfil do usuário logado
 * @route   GET /api/profile
 * @access  Private (User)
 */
const getUserProfile = async (req, res) => {
    try {
        // Popula todos os campos necessários para o Frontend
        const user = await User.findById(req.user._id)
            .populate({ 
                path: 'activeInvestments',
                populate: {
                    path: 'planId',
                    select: 'name' 
                }
            })
            .populate('depositHistory')
            .populate('withdrawalHistory')
            .populate('referredUsers', 'phoneNumber status createdAt'); 

        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        res.status(200).json({
            success: true,
            user: {
                _id: user._id,
                phoneNumber: user.phoneNumber,
                balance: user.balance,
                // Removido: bonusBalance (Conforme solicitação)
                status: user.status,
                visitorId: user.visitorId,
                referralCode: user.referralCode,
                invitedBy: user.invitedBy,
                activeInvestments: user.activeInvestments, 
                depositHistory: user.depositHistory,
                withdrawalHistory: user.withdrawalHistory,
                referredUsers: user.referredUsers,
                createdAt: user.createdAt,
                lastLoginAt: user.lastLoginAt, 
            }
        });
    } catch (error) {
        logError(`Erro ao obter perfil do usuário: ${error.message}`, { stack: error.stack, userId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter perfil do usuário.' });
    }
};

// --- Investment Plan Controllers (Admin) ---

/**
 * @desc    Criar novo plano de investimento (Admin)
 * @route   POST /api/admin/investmentplans
 * @access  Private (Admin)
 * @param   {string} req.uploadedImageUrl - URL da imagem no Cloudinary (do uploadMiddleware).
 */
const createInvestmentPlan = async (req, res) => {
    // maxAmount é mantido no modelo, mas a lógica de preço único usa apenas minAmount como valor fixo.
    const { name, minAmount, dailyProfitRate } = req.body;
    // Pega a URL do middleware de upload (pode ser undefined se não foi feito upload)
    const uploadedImageUrl = req.uploadedImageUrl; 

    // 1. Validação de pré-requisitos
    if (!name || !minAmount || !dailyProfitRate) {
        return res.status(400).json({ message: 'Por favor, forneça nome, valor mínimo e taxa de lucro diário.' });
    }
    
    // 2. Regra de preço único: maxAmount deve ser igual a minAmount
    const maxAmount = minAmount; 

    try {
        const plan = await InvestmentPlan.create({
            name,
            minAmount,
            maxAmount, // Define maxAmount como igual a minAmount
            dailyProfitRate,
            // Prioriza a URL uploadedImageUrl
            imageUrl: uploadedImageUrl || req.body.imageUrl || 'https://res.cloudinary.com/default-image-url', 
        });

        logAdminAction(req.user._id, `Plano de investimento criado: ${name}`, { planId: plan._id, imageUrl: plan.imageUrl });
        res.status(201).json({ success: true, plan });
    } catch (error) {
        if (error.code === 11000) { // Erro de duplicidade (unique: true)
            return res.status(400).json({ message: 'Já existe um plano com este nome.' });
        }
        
        // TRATAMENTO DE ERROS DE VALIDAÇÃO DO MONGOOSE
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(val => val.message);
            logError(`Erro de validação ao criar plano: ${messages.join('; ')}`, { stack: error.stack, adminId: req.user._id });
            return res.status(400).json({ message: messages.join('; ') });
        }

        logError(`Erro inesperado ao criar plano de investimento: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao criar plano de investimento.' });
    }
};

/**
 * @desc    Obter todos os planos de investimento
 * @route   GET /api/investmentplans (público)
 * @route   GET /api/admin/investmentplans (admin)
 * @access  Public / Private (Admin)
 */
const getInvestmentPlans = async (req, res) => {
    try {
        const filter = (req.user && req.user.isAdmin) ? {} : { isActive: true };
        
        // Seleciona imageUrl
        const plans = await InvestmentPlan.find(filter).select('name minAmount maxAmount dailyProfitRate durationDays isActive imageUrl').sort({ minAmount: 1 });
        res.status(200).json({ success: true, plans });
    } catch (error) {
        logError(`Erro ao obter planos de investimento: ${error.message}`, { stack: error.stack });
        res.status(500).json({ message: 'Erro ao obter planos de investimento.' });
    }
};

/**
 * @desc    Obter um plano de investimento por ID
 * @route   GET /api/investmentplans/:id
 * @access  Public
 */
const getInvestmentPlanById = async (req, res) => {
    try {
        const plan = await InvestmentPlan.findById(req.params.id);
        if (!plan) {
            return res.status(404).json({ message: 'Plano de investimento não encontrado.' });
        }
        res.status(200).json({ success: true, plan });
    } catch (error) {
        logError(`Erro ao obter plano de investimento por ID: ${error.message}`, { stack: error.stack, planId: req.params.id });
        res.status(500).json({ message: 'Erro ao obter plano de investimento.' });
    }
};

/**
 * @desc    Atualizar um plano de investimento (Admin)
 * @route   PUT /api/admin/investmentplans/:id
 * @access  Private (Admin)
 * @param   {string} req.uploadedImageUrl - URL da imagem no Cloudinary (do uploadMiddleware).
 */
const updateInvestmentPlan = async (req, res) => {
    // Pega o URL do upload. Se não houver upload, o valor será `undefined`.
    const uploadedImageUrl = req.uploadedImageUrl; 
    
    // Pega os dados do body (mesmo que venham do formulário multipart/form-data)
    const { name, minAmount, dailyProfitRate, isActive, imageUrl } = req.body;

    try {
        let plan = await InvestmentPlan.findById(req.params.id);
        if (!plan) {
            return res.status(404).json({ message: 'Plano de investimento não encontrado.' });
        }

        // Regra de preço único: maxAmount deve ser igual a minAmount
        const maxAmount = minAmount !== undefined ? minAmount : plan.minAmount; 
        const updatedMinAmount = minAmount !== undefined ? minAmount : plan.minAmount;

        // Atualiza os campos
        plan.name = name !== undefined ? name : plan.name;
        plan.minAmount = updatedMinAmount;
        plan.maxAmount = maxAmount; // Forçado a ser igual ao minAmount
        plan.dailyProfitRate = dailyProfitRate !== undefined ? dailyProfitRate : plan.dailyProfitRate;
        plan.isActive = isActive !== undefined ? isActive : plan.isActive;
        
        // Se houver uma nova URL do upload, use-a.
        // Se não houver upload, use a URL que veio do body (que deve ser a URL antiga)
        if (uploadedImageUrl) {
            plan.imageUrl = uploadedImageUrl;
        } else if (imageUrl !== undefined) { 
             // Se o admin editou o texto do campo URL diretamente (caso não tenha feito upload)
             plan.imageUrl = imageUrl;
        }


        await plan.save();

        logAdminAction(req.user._id, `Plano de investimento atualizado: ${plan.name}`, { planId: plan._id, newImageUrl: plan.imageUrl });
        res.status(200).json({ success: true, plan });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'Já existe um plano com este nome.' });
        }
        
        // TRATAMENTO DE ERROS DE VALIDAÇÃO DO MONGOOSE
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(val => val.message);
            logError(`Erro de validação ao atualizar plano: ${messages.join('; ')}`, { stack: error.stack, adminId: req.user._id });
            return res.status(400).json({ message: messages.join('; ') });
        }

        logError(`Erro ao atualizar plano de investimento: ${error.message}`, { stack: error.stack, adminId: req.user._id, planId: req.params.id });
        res.status(500).json({ message: 'Erro ao atualizar plano de investimento.' });
    }
};

/**
 * @desc    Deletar um plano de investimento (Admin)
 * @route   DELETE /api/admin/investmentplans/:id
 * @access  Private (Admin)
 */
const deleteInvestmentPlan = async (req, res) => {
    try {
        const plan = await InvestmentPlan.findById(req.params.id);
        if (!plan) {
            return res.status(404).json({ message: 'Plano de investimento não encontrado.' });
        }

        // Adicionar lógica para verificar se há investimentos ativos com este plano.
        const activeInvestmentsUsingPlan = await Investment.countDocuments({ planId: plan._id, status: 'active' });
        if (activeInvestmentsUsingPlan > 0) {
            return res.status(400).json({ message: 'Não é possível deletar um plano com investimentos ativos. Desative-o primeiro.' });
        }

        // Usar findByIdAndDelete
        await InvestmentPlan.findByIdAndDelete(req.params.id);

        logAdminAction(req.user._id, `Plano de investimento deletado: ${plan.name}`, { planId: plan._id });
        res.status(200).json({ success: true, message: 'Plano de investimento removido.' });
    } catch (error) {
        logError(`Erro ao deletar plano de investimento: ${error.message}`, { stack: error.stack, adminId: req.user._id, planId: req.params.id });
        res.status(500).json({ message: 'Erro ao deletar plano de investimento.' });
    }
};

// --- User Investment Controllers ---

/**
 * @desc    Ativar um novo investimento para o usuário
 * @route   POST /api/investments
 * @access  Private (User)
 */
const activateInvestment = async (req, res) => {
    const { planId } = req.body; 
    const userId = req.user._id;

    if (!planId) {
        return res.status(400).json({ message: 'Por favor, forneça o ID do plano.' });
    }
    
    try {
        // Busca o usuário e o plano (sem populate)
        const user = await User.findById(userId);
        const plan = await InvestmentPlan.findById(planId);
        const adminConfig = await AdminConfig.findOne(); // Busca as configurações para comissões

        if (!user || !plan || !plan.isActive) {
            return res.status(404).json({ message: 'Usuário ou plano de investimento não encontrado/ativo.' });
        }
        
        // Se já tem investimento ativo, não permite uma nova ativação (apenas upgrade)
        if (user.activeInvestments && user.activeInvestments.length > 0) {
             return res.status(400).json({ message: 'Você já possui um investimento ativo. Use a função de Upgrade para mudar de pacote.' });
        }
        
        const amount = plan.minAmount; 
        
        if (amount <= 0) {
             return res.status(400).json({ message: 'Valor de investimento inválido (zero ou negativo).' });
        }
        
        if (user.balance < amount) {
            return res.status(400).json({ message: 'Saldo insuficiente para este investimento.' });
        }

        // 1. Deduzir o valor do saldo do usuário
        user.balance -= amount;

        // 2. Calcular data de término e criar o registro de investimento
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + plan.durationDays);

        const investment = await Investment.create({
            userId,
            planId,
            investedAmount: amount, 
            dailyProfitRate: plan.dailyProfitRate,
            endDate: endDate,
        });

        // 3. Adicionar o investimento ativo ao usuário
        user.activeInvestments.push(investment._id);
        await user.save();
        
        // 4. LÓGICA DE COMISSÃO POR ATIVAÇÃO (AGORA CRÉDITO NO SALDO PRINCIPAL)
        if (user.invitedBy && adminConfig && adminConfig.isPromotionActive && adminConfig.commissionOnPlanActivation > 0) {
            // Busca o convidante (Inviter)
            const inviter = await User.findOne({ referralCode: user.invitedBy });

            if (inviter) {
                const commissionRate = adminConfig.commissionOnPlanActivation;
                const commissionAmount = amount * commissionRate;
                
                // Credita no Saldo Principal do convidante
                inviter.balance += commissionAmount;
                await inviter.save();
                
                logInfo(`Comissão de Ativação de ${commissionAmount.toFixed(2)} MT creditada no SALDO PRINCIPAL para ${inviter.phoneNumber} (Referiu ${user.phoneNumber}).`, { 
                    inviterId: inviter._id, 
                    inviteeId: user._id, 
                    amountInvested: amount, 
                    commission: commissionAmount 
                });
            }
        }
        // FIM LÓGICA DE COMISSÃO POR ATIVAÇÃO

        logInfo(`Novo investimento ativado por ${user.phoneNumber} no plano ${plan.name} com ${amount} MT.`, { userId, investmentId: investment._id });

        res.status(201).json({ success: true, message: 'Investimento ativado com sucesso!', investment });

    } catch (error) {
        logError(`Erro ao ativar investimento para o usuário ${userId}: ${error.message}`, { stack: error.stack, userId });
        res.status(500).json({ message: 'Erro ao ativar investimento.' });
    }
};

/**
 * @desc    Troca um investimento ativo por um novo plano, cobrando a diferença.
 * @route   POST /api/investments/upgrade
 * @access  Private (User)
 */
const upgradeInvestment = async (req, res) => {
    const { newPlanId } = req.body;
    const userId = req.user._id;

    if (!newPlanId) {
        return res.status(400).json({ message: 'Por favor, forneça o ID do novo plano.' });
    }

    try {
        const user = await User.findById(userId);
        const newPlan = await InvestmentPlan.findById(newPlanId);

        if (!user || !newPlan || !newPlan.isActive) {
            return res.status(404).json({ message: 'Usuário ou novo plano de investimento não encontrado/ativo.' });
        }

        // 1. Encontrar o investimento ativo atual
        if (!user.activeInvestments || user.activeInvestments.length === 0) {
            return res.status(400).json({ message: 'Você não possui um investimento ativo para fazer upgrade.' });
        }
        
        // Pega o primeiro (e único, se a regra de 1 ativo for mantida)
        const activeInvestment = await Investment.findById(user.activeInvestments[0]).populate('planId'); 

        if (!activeInvestment) {
             // Limpa o array do usuário se o ID for inválido
             user.activeInvestments = user.activeInvestments.filter(id => id.toString() !== user.activeInvestments[0].toString());
             await user.save();
             return res.status(400).json({ message: 'Investimento ativo inválido. Por favor, tente novamente.' });
        }

        const currentPlan = activeInvestment.planId;
        const currentAmount = activeInvestment.investedAmount;
        const newAmount = newPlan.minAmount;

        // 2. Validações de Upgrade
        if (newAmount <= currentAmount) {
            return res.status(400).json({ message: `O novo plano (${newPlan.name} - ${newAmount} MT) deve ter um preço maior que o plano atual (${currentPlan.name} - ${currentAmount} MT).` });
        }

        const priceDifference = newAmount - currentAmount;

        if (user.balance < priceDifference) {
            return res.status(400).json({ message: `Saldo insuficiente para cobrir a diferença de ${priceDifference.toFixed(2)} MT.` });
        }

        // 3. Processamento do Upgrade
        
        // a) Debita a diferença de preço
        user.balance -= priceDifference;

        // b) Atualiza o investimento existente
        activeInvestment.planId = newPlan._id;
        activeInvestment.investedAmount = newAmount; // Aumenta o valor investido
        activeInvestment.dailyProfitRate = newPlan.dailyProfitRate; // Atualiza a nova taxa
        
        // REINICIA A DURAÇÃO: Novo EndDate é calculado a partir de AGORA
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + newPlan.durationDays);
        activeInvestment.endDate = newEndDate;
        
        // MANTEM o currentProfit e atualiza a data do último crédito para agora (para que o cron não credite novamente hoje)
        activeInvestment.lastProfitCreditDate = new Date(); 
        
        await activeInvestment.save();
        await user.save();

        logInfo(`Upgrade de investimento realizado para ${user.phoneNumber} do plano ${currentPlan.name} (${currentAmount} MT) para ${newPlan.name} (${newAmount} MT). Diferença paga: ${priceDifference} MT.`, { userId, investmentId: activeInvestment._id, newPlanId: newPlan._id });
        
        // 4. LÓGICA DE COMISSÃO POR ATIVAÇÃO NO UPGRADE (AGORA CRÉDITO NO SALDO PRINCIPAL)
        const adminConfig = await AdminConfig.findOne();
        if (user.invitedBy && adminConfig && adminConfig.isPromotionActive && adminConfig.commissionOnPlanActivation > 0) {
             const inviter = await User.findOne({ referralCode: user.invitedBy });

             if (inviter) {
                 const commissionRate = adminConfig.commissionOnPlanActivation;
                 const commissionAmount = priceDifference * commissionRate; // Comissão sobre a diferença paga
                 
                 // Credita no Saldo Principal do convidante
                 inviter.balance += commissionAmount;
                 await inviter.save();
                 
                 logInfo(`Comissão de Upgrade de ${commissionAmount.toFixed(2)} MT creditada no SALDO PRINCIPAL para ${inviter.phoneNumber} (Referiu ${user.phoneNumber}).`, { 
                     inviterId: inviter._id, 
                     inviteeId: user._id, 
                     amountInvested: priceDifference, 
                     commission: commissionAmount 
                 });
             }
         }
        // FIM LÓGICA DE COMISSÃO POR ATIVAÇÃO NO UPGRADE

        res.status(200).json({ 
            success: true, 
            message: `Upgrade para o plano ${newPlan.name} concluído. Diferença de ${priceDifference.toFixed(2)} MT debitada.`,
            investment: activeInvestment 
        });

    } catch (error) {
        logError(`Erro ao fazer upgrade de investimento para o usuário ${userId}: ${error.message}`, { stack: error.stack, userId });
        res.status(500).json({ message: 'Erro ao fazer upgrade de investimento.' });
    }
};


/**
 * @desc    Obter todos os investimentos ativos do usuário logado
 * @route   GET /api/investments/active
 * @access  Private (User)
 */
const getUserActiveInvestments = async (req, res) => {
    try {
        const investments = await Investment.find({ userId: req.user._id, status: 'active' })
            .populate('planId', 'name dailyProfitRate durationDays'); // Popula detalhes do plano

        res.status(200).json({ success: true, investments });
    } catch (error) {
        logError(`Erro ao obter investimentos ativos do usuário: ${error.message}`, { stack: error.stack, userId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter investimentos ativos.' });
    }
};

/**
 * @desc    Obter todo o histórico de investimentos do usuário logado
 * @route   GET /api/investments/history
 * @access  Private (User)
 */
const getUserInvestmentHistory = async (req, res) => {
    try {
        const investments = await Investment.find({ userId: req.user._id })
            .populate('planId', 'name dailyProfitRate durationDays')
            .sort({ createdAt: -1 });

        res.status(200).json({ success: true, investments });
    } catch (error) {
        logError(`Erro ao obter histórico de investimentos do usuário: ${error.message}`, { stack: error.stack, userId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter histórico de investimentos.' });
    }
};

// --- Deposit Controllers ---

/**
 * @desc    Usuário solicita um depósito
 * @route   POST /api/deposits
 * @access  Private (User)
 */
const requestDeposit = async (req, res) => {
    const { amount, confirmationMessage } = req.body;
    const userId = req.user._id;

    if (!amount || !confirmationMessage) {
        return res.status(400).json({ message: 'Por favor, forneça o valor e a mensagem de confirmação do depósito.' });
    }
    // O Frontend já está validando, mas a API deve validar o mínimo também
    const adminConfig = await AdminConfig.findOne();
    const minDeposit = adminConfig ? adminConfig.minDepositAmount : 50; 

    if (amount < minDeposit) {
        return res.status(400).json({ message: `O valor do depósito deve ser no mínimo ${minDeposit} MT.` });
    }

    try {
        const deposit = await Deposit.create({
            userId,
            amount,
            confirmationMessage,
            status: 'pending',
        });

        // Adiciona o depósito ao histórico do usuário
        const user = await User.findById(userId);
        user.depositHistory.push(deposit._id);
        await user.save();

        logInfo(`Solicitação de depósito criada por ${user.phoneNumber} no valor de ${amount} MT.`, { userId, depositId: deposit._id, confirmationMessage });
        res.status(201).json({ success: true, message: 'Solicitação de depósito enviada para aprovação.', deposit });
    } catch (error) {
        logError(`Erro ao solicitar depósito para o usuário ${userId}: ${error.message}`, { stack: error.stack, userId });
        res.status(500).json({ message: 'Erro ao solicitar depósito.' });
    }
};

/**
 * @desc    Obter histórico de depósitos do usuário logado
 * @route   GET /api/deposits/history
 * @access  Private (User)
 */
const getUserDeposits = async (req, res) => {
    try {
        // Embora o /api/profile já popule, esta rota é mais limpa para o histórico de depósito puro
        const deposits = await Deposit.find({ userId: req.user._id }).sort({ requestDate: -1 });
        res.status(200).json({ success: true, deposits });
    } catch (error) {
        logError(`Erro ao obter depósitos do usuário: ${error.message}`, { stack: error.stack, userId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter depósitos.' });
    }
};

/**
 * @desc    Obter todos os depósitos pendentes (Admin)
 * @route   GET /api/admin/deposits/pending
 * @access  Private (Admin)
 */
const getPendingDeposits = async (req, res) => {
    try {
        const pendingDeposits = await Deposit.find({ status: 'pending' })
            .populate('userId', 'phoneNumber visitorId')
            .sort({ requestDate: 1 });

        res.status(200).json({ success: true, deposits: pendingDeposits });
    } catch (error) {
        logError(`Erro ao obter depósitos pendentes: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter depósitos pendentes.' });
    }
};

/**
 * @desc    Aprovar um depósito (Admin)
 * @route   PUT /api/admin/deposits/:id/approve
 * @access  Private (Admin)
 */
const approveDeposit = async (req, res) => {
    try {
        const deposit = await Deposit.findById(req.params.id);

        if (!deposit) {
            return res.status(404).json({ message: 'Depósito não encontrado.' });
        }
        if (deposit.status !== 'pending') {
            return res.status(400).json({ message: 'Este depósito não está pendente de aprovação.' });
        }

        deposit.status = 'approved';
        deposit.approvalDate = new Date();
        deposit.adminId = req.user._id;
        await deposit.save();

        const user = await User.findById(deposit.userId);
        if (user) {
            user.balance += deposit.amount;
            await user.save();
            logInfo(`Saldo do usuário ${user.phoneNumber} creditado com ${deposit.amount} MT.`, { userId: user._id, depositId: deposit._id });
        }

        logAdminAction(req.user._id, `Depósito aprovado para o usuário ${user ? user.phoneNumber : 'N/A'}.`, { depositId: deposit._id, amount: deposit.amount });
        res.status(200).json({ success: true, message: 'Depósito aprovado com sucesso.', deposit });

    } catch (error) {
        logError(`Erro ao aprovar depósito: ${error.message}`, { stack: error.stack, adminId: req.user._id, depositId: req.params.id });
        res.status(500).json({ message: 'Erro ao aprovar depósito.' });
    }
};

/**
 * @desc    Rejeitar um depósito (Admin)
 * @route   PUT /api/admin/deposits/:id/reject
 * @access  Private (Admin)
 */
const rejectDeposit = async (req, res) => {
    try {
        const deposit = await Deposit.findById(req.params.id);

        if (!deposit) {
            return res.status(404).json({ message: 'Depósito não encontrado.' });
        }
        if (deposit.status !== 'pending') {
            return res.status(400).json({ message: 'Este depósito não está pendente de rejeição.' });
        }

        deposit.status = 'rejected';
        deposit.approvalDate = new Date(); // Pode ser a data da rejeição
        deposit.adminId = req.user._id;
        await deposit.save();

        const user = await User.findById(deposit.userId); // Apenas para logging
        logAdminAction(req.user._id, `Depósito rejeitado para o usuário ${user ? user.phoneNumber : 'N/A'}.`, { depositId: deposit._id, amount: deposit.amount });
        res.status(200).json({ success: true, message: 'Depósito rejeitado com sucesso.', deposit });

    } catch (error) {
        logError(`Erro ao rejeitar depósito: ${error.message}`, { stack: error.stack, adminId: req.user._id, depositId: req.params.id });
        res.status(500).json({ message: 'Erro ao rejeitar depósito.' });
    }
};

// --- Withdrawal Controllers ---

/**
 * Funções auxiliares para verificação de horário de saque
 */
const isWithdrawalTimeAllowed = (startTime, endTime) => {
    const now = new Date();
    // A hora do servidor deve estar no fuso correto (Africa/Maputo no seu .env)
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Converte a string HH:MM para minutos desde a meia-noite
    const parseTime = (timeStr) => {
        const [hour, minute] = timeStr.split(':').map(Number);
        if (isNaN(hour) || isNaN(minute)) return -1; // Retorna -1 se o formato for inválido
        return hour * 60 + minute;
    };

    const currentTimeInMinutes = currentHour * 60 + currentMinute;
    const startTimeInMinutes = parseTime(startTime);
    const endTimeInMinutes = parseTime(endTime);
    
    if (startTimeInMinutes === -1 || endTimeInMinutes === -1) {
        logError('Formato de hora de saque inválido na AdminConfig. Permitindo o saque.', { startTime, endTime });
        return true; // Se a config for inválida, permite por segurança
    }


    // Verifica se a hora atual está dentro do intervalo [startTime, endTime]
    return currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes <= endTimeInMinutes;
};


/**
 * @desc    Usuário solicita um saque
 * @route   POST /api/withdrawals
 * @access  Private (User)
 */
const requestWithdrawal = async (req, res) => {
    const { amount, walletAddress } = req.body; // walletAddress contém Nome, Telefone e Método de Pagamento
    const userId = req.user._id;

    if (!amount || !walletAddress) {
        return res.status(400).json({ message: 'Por favor, forneça o valor e o endereço da carteira/detalhes de pagamento para saque.' });
    }
    // O Frontend já está validando, mas a API deve validar o mínimo (1 MT)
    if (amount <= 0) {
        return res.status(400).json({ message: 'O valor do saque deve ser positivo.' });
    }

    try {
        const user = await User.findById(userId);
        const adminConfig = await AdminConfig.findOne();

        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        
        // --- VALIDAÇÃO DE HORÁRIO DE SAQUE ---
        if (adminConfig && adminConfig.withdrawalStartTime && adminConfig.withdrawalEndTime) {
            if (!isWithdrawalTimeAllowed(adminConfig.withdrawalStartTime, adminConfig.withdrawalEndTime)) {
                return res.status(400).json({ message: `A solicitação de saque só é permitida entre ${adminConfig.withdrawalStartTime} e ${adminConfig.withdrawalEndTime} (MZ Time).` });
            }
        }
        // --- FIM VALIDAÇÃO DE HORÁRIO DE SAQUE ---

        // --- VALIDAÇÃO DE LIMITE MÍNIMO E MÁXIMO DE SAQUE ---
        const minWithdrawal = adminConfig ? adminConfig.minWithdrawalAmount : 1;
        const maxWithdrawal = adminConfig ? adminConfig.maxWithdrawalAmount : Infinity;
        
        if (amount < minWithdrawal) {
            return res.status(400).json({ message: `O saque mínimo permitido é ${minWithdrawal} MT.` });
        }
        if (amount > maxWithdrawal) {
            return res.status(400).json({ message: `O saque máximo permitido é ${maxWithdrawal} MT.` });
        }
        // --- FIM VALIDAÇÃO DE LIMITE MÍNIMO E MÁXIMO DE SAQUE ---


        if (user.balance < amount) {
            return res.status(400).json({ message: 'Saldo insuficiente para este saque.' });
        }

        // Deduzir o valor do saldo imediatamente, o status será pendente
        user.balance -= amount;

        const withdrawal = await Withdrawal.create({
            userId,
            amount,
            walletAddress, // Detalhes de pagamento consolidados
            status: 'pending',
        });

        // Adiciona o saque ao histórico do usuário
        user.withdrawalHistory.push(withdrawal._id);
        await user.save();

        logInfo(`Solicitação de saque criada por ${user.phoneNumber} no valor de ${amount} MT. Detalhes: ${walletAddress}`, { userId, withdrawalId: withdrawal._id });
        res.status(201).json({ success: true, message: 'Solicitação de saque enviada para aprovação.', withdrawal });
    } catch (error) {
        logError(`Erro ao solicitar saque para o usuário ${userId}: ${error.message}`, { stack: error.stack, userId });
        res.status(500).json({ message: 'Erro ao solicitar saque.' });
    }
};

/**
 * @desc    Obter histórico de saques do usuário logado
 * @route   GET /api/withdrawals/history
 * @access  Private (User)
 */
const getUserWithdrawals = async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({ userId: req.user._id }).sort({ requestDate: -1 });
        res.status(200).json({ success: true, withdrawals });
    } catch (error) {
        logError(`Erro ao obter saques do usuário: ${error.message}`, { stack: error.stack, userId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter saques.' });
    }
};

/**
 * @desc    Obter todos os saques pendentes (Admin)
 * @route   GET /api/admin/withdrawals/pending
 * @access  Private (Admin)
 */
const getPendingWithdrawals = async (req, res) => {
    try {
        const pendingWithdrawals = await Withdrawal.find({ status: 'pending' })
            .populate('userId', 'phoneNumber visitorId')
            .sort({ requestDate: 1 });

        res.status(200).json({ success: true, withdrawals: pendingWithdrawals });
    } catch (error) {
        logError(`Erro ao obter saques pendentes: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter saques pendentes.' });
    }
};

/**
 * @desc    Aprovar um saque (Admin)
 * @route   PUT /api/admin/withdrawals/:id/approve
 * @access  Private (Admin)
 */
const approveWithdrawal = async (req, res) => {
    try {
        const withdrawal = await Withdrawal.findById(req.params.id);

        if (!withdrawal) {
            return res.status(404).json({ message: 'Saque não encontrado.' });
        }
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ message: 'Este saque não está pendente de aprovação.' });
        }

        withdrawal.status = 'approved';
        withdrawal.approvalDate = new Date();
        withdrawal.adminId = req.user._id;
        await withdrawal.save();

        const user = await User.findById(withdrawal.userId); // Apenas para logging
        logAdminAction(req.user._id, `Saque aprovado para o usuário ${user ? user.phoneNumber : 'N/A'}.`, { withdrawalId: withdrawal._id, amount: withdrawal.amount });
        res.status(200).json({ success: true, message: 'Saque aprovado com sucesso.', withdrawal });

    } catch (error) {
        logError(`Erro ao aprovar saque: ${error.message}`, { stack: error.stack, adminId: req.user._id, withdrawalId: req.params.id });
        res.status(500).json({ message: 'Erro ao aprovar saque.' });
    }
};

/**
 * @desc    Rejeitar um saque (Admin)
 * @route   PUT /api/admin/withdrawals/:id/reject
 * @access  Private (Admin)
 */
const rejectWithdrawal = async (req, res) => {
    try {
        const withdrawal = await Withdrawal.findById(req.params.id);

        if (!withdrawal) {
            return res.status(404).json({ message: 'Saque não encontrado.' });
        }
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ message: 'Este saque não está pendente de rejeição.' });
        }

        withdrawal.status = 'rejected';
        withdrawal.approvalDate = new Date(); // Pode ser a data da rejeição
        withdrawal.adminId = req.user._id;
        await withdrawal.save();

        // Se o saque for rejeitado, o valor deve ser creditado de volta ao saldo do usuário
        const user = await User.findById(withdrawal.userId);
        if (user) {
            user.balance += withdrawal.amount;
            await user.save();
            logInfo(`Valor de ${withdrawal.amount} MT creditado de volta ao usuário ${user.phoneNumber} devido a saque rejeitado.`, { userId: user._id, withdrawalId: withdrawal._id });
        }

        logAdminAction(req.user._id, `Saque rejeitado para o usuário ${user ? user.phoneNumber : 'N/A'}.`, { withdrawalId: withdrawal._id, amount: withdrawal.amount });
        res.status(200).json({ success: true, message: 'Saque rejeitado com sucesso. Valor devolvido ao saldo do usuário.', withdrawal });

    } catch (error) {
        logError(`Erro ao rejeitar saque: ${error.message}`, { stack: error.stack, adminId: req.user._id, withdrawalId: req.params.id });
        res.status(500).json({ message: 'Erro ao rejeitar saque.' });
    }
};

// --- Admin Panel Controllers ---

/**
 * @desc    Obter configurações de depósito (M-Pesa/Emola)
 * @route   GET /api/deposit-config
 * @access  Public (Usado pelo Frontend para o Checkout e Invite)
 */
const getDepositConfig = async (req, res) => {
    try {
        // Selecionando os campos relevantes (incluindo as configs de comissão)
        const config = await AdminConfig.findOne().select('minDepositAmount mpesaDepositNumber mpesaRecipientName emolaDepositNumber emolaRecipientName withdrawalStartTime withdrawalEndTime minWithdrawalAmount maxWithdrawalAmount isPromotionActive commissionOnPlanActivation commissionOnDailyProfit');
        
        if (!config) {
            // Se não houver config, cria uma com valores padrão antes de retornar
            const newConfig = await AdminConfig.create({});
            logInfo('AdminConfig não encontrada, uma nova foi criada com valores padrão.');
            return res.status(200).json({ success: true, config: newConfig });
        }

        res.status(200).json({ success: true, config });
    } catch (error) {
        logError(`Erro ao obter configurações de depósito: ${error.message}`, { stack: error.stack });
        res.status(500).json({ message: 'Erro ao obter configurações de depósito.' });
    }
};


/**
 * @desc    Obter todas as configurações de promoção (Admin)
 * @route   GET /api/admin/config
 * @access  Private (Admin)
 */
const getAdminConfig = async (req, res) => {
    try {
        // Selecionando os campos relevantes (comissão e pagamentos)
        const config = await AdminConfig.findOne().select('minDepositAmount mpesaDepositNumber mpesaRecipientName emolaDepositNumber emolaRecipientName withdrawalStartTime withdrawalEndTime minWithdrawalAmount maxWithdrawalAmount isPromotionActive commissionOnPlanActivation commissionOnDailyProfit');
        
        if (!config) {
            // Se não houver config, crie uma com valores padrão
            const newConfig = await AdminConfig.create({});
            logInfo('AdminConfig não encontrada, uma nova foi criada com valores padrão.');
            return res.status(200).json({ success: true, config: newConfig });
        }
        res.status(200).json({ success: true, config });
    } catch (error) {
        logError(`Erro ao obter configurações administrativas: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter configurações administrativas.' });
    }
};


/**
 * @desc    Atualizar configurações administrativas
 * @route   PUT /api/admin/config
 * @access  Private (Admin)
 */
const updateAdminConfig = async (req, res) => {
    // Campos de bônus e promoção
    const { isPromotionActive, commissionOnPlanActivation, commissionOnDailyProfit, minDepositAmount, mpesaDepositNumber, mpesaRecipientName, emolaDepositNumber, emolaRecipientName, withdrawalStartTime, withdrawalEndTime, minWithdrawalAmount, maxWithdrawalAmount } = req.body;

    try {
        let config = await AdminConfig.findOne(); // Busca a única instância
        if (!config) {
            config = await AdminConfig.create({});
            logInfo('AdminConfig criada durante tentativa de atualização, pois não existia.');
        }

        // Validações básicas (apenas as mais críticas)
        if (minDepositAmount !== undefined && minDepositAmount < 1) {
             return res.status(400).json({ message: 'Valor mínimo de depósito deve ser 1 ou mais.' });
        }
        
        if (minWithdrawalAmount !== undefined && minWithdrawalAmount < 1) {
             return res.status(400).json({ message: 'Valor mínimo de saque deve ser 1 ou mais.' });
        }
        if (maxWithdrawalAmount !== undefined && maxWithdrawalAmount < 1) {
             return res.status(400).json({ message: 'Valor máximo de saque deve ser 1 ou mais.' });
        }
        if (minWithdrawalAmount !== undefined && maxWithdrawalAmount !== undefined && parseFloat(minWithdrawalAmount) > parseFloat(maxWithdrawalAmount)) {
             return res.status(400).json({ message: 'Valor mínimo de saque não pode ser maior que o valor máximo de saque.' });
        }
        
        // Validação de formato de hora
        const timeRegex = /^\d{2}:\d{2}$/;
        if (withdrawalStartTime !== undefined && withdrawalStartTime.length > 0 && !timeRegex.test(withdrawalStartTime)) {
            return res.status(400).json({ message: 'Hora de início de saque inválida. Use o formato HH:MM.' });
        }
        if (withdrawalEndTime !== undefined && withdrawalEndTime.length > 0 && !timeRegex.test(withdrawalEndTime)) {
            return res.status(400).json({ message: 'Hora de fim de saque inválida. Use o formato HH:MM.' });
        }


        // Configurações de Comissão
        config.isPromotionActive = isPromotionActive !== undefined ? isPromotionActive : config.isPromotionActive;
        config.commissionOnPlanActivation = commissionOnPlanActivation !== undefined ? commissionOnPlanActivation : config.commissionOnPlanActivation;
        config.commissionOnDailyProfit = commissionOnDailyProfit !== undefined ? commissionOnDailyProfit : config.commissionOnDailyProfit;
        // Campos de bônus fixo removidos do front-end não são atualizados aqui

        // Configurações de Depósito 
        config.minDepositAmount = minDepositAmount !== undefined ? minDepositAmount : config.minDepositAmount;
        config.mpesaDepositNumber = mpesaDepositNumber !== undefined ? mpesaDepositNumber : config.mpesaDepositNumber;
        config.mpesaRecipientName = mpesaRecipientName !== undefined ? mpesaRecipientName : config.mpesaRecipientName;
        config.emolaDepositNumber = emolaDepositNumber !== undefined ? emolaDepositNumber : config.emolaDepositNumber;
        config.emolaRecipientName = emolaRecipientName !== undefined ? emolaRecipientName : config.emolaRecipientName;
        
        // Configurações de Saque 
        config.withdrawalStartTime = withdrawalStartTime !== undefined ? withdrawalStartTime : config.withdrawalStartTime;
        config.withdrawalEndTime = withdrawalEndTime !== undefined ? withdrawalEndTime : config.withdrawalEndTime;
        config.minWithdrawalAmount = minWithdrawalAmount !== undefined ? minWithdrawalAmount : config.minWithdrawalAmount;
        config.maxWithdrawalAmount = maxWithdrawalAmount !== undefined ? maxWithdrawalAmount : config.maxWithdrawalAmount;


        await config.save();

        logAdminAction(req.user._id, `Configurações administrativas atualizadas.`, { configId: config._id, updatedFields: req.body });
        res.status(200).json({ success: true, message: 'Configurações administrativas atualizadas com sucesso.', config });
    } catch (error) {
        // TRATAMENTO DE ERROS DE VALIDAÇÃO DO MONGOOSE
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(val => val.message);
            logError(`Erro de validação ao atualizar config: ${messages.join('; ')}`, { stack: error.stack, adminId: req.user._id });
            return res.status(400).json({ message: messages.join('; ') });
        }

        logError(`Erro ao atualizar configurações de promoção: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao atualizar configurações de promoção.' });
    }
};


/**
 * @desc    Obter todos os usuários (Admin)
 * @route   GET /api/admin/users
 * @access  Private (Admin)
 */
const getAllUsers = async (req, res) => {
    try {
        // Seleciona explicitamente os campos que o frontend precisa e exclui a senha
        const users = await User.find({})
                                .select('_id phoneNumber status isAdmin referralCode invitedBy createdAt')
                                .sort({ createdAt: -1 });

        res.status(200).json({ success: true, users });
    } catch (error) {
        logError(`Erro ao obter todos os usuários: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter usuários.' });
    }
};

/**
 * @desc    Obter detalhes de um único usuário (Admin)
 * @route   GET /api/admin/users/:id
 * @access  Private (Admin)
 */
const getUserDetails = async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
            .select('-password')
            .populate('activeInvestments')
            .populate('depositHistory')
            .populate('withdrawalHistory')
            .populate('referredUsers', 'phoneNumber status');

        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        res.status(200).json({ success: true, user });
    } catch (error) {
        logError(`Erro ao obter detalhes do usuário ${req.params.id}: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter detalhes do usuário.' });
    }
};

/**
 * @desc    Bloquear uma conta de usuário (Admin)
 * @route   PUT /api/admin/users/:id/block
 * @access  Private (Admin)
 */
const blockUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        if (user.isAdmin) {
            return res.status(403).json({ message: 'Não é possível bloquear outro administrador.' });
        }

        user.status = 'blocked';
        await user.save();

        logAdminAction(req.user._id, `Usuário bloqueado: ${user.phoneNumber}`, { userId: user._id });
        res.status(200).json({ success: true, message: 'Usuário bloqueado com sucesso.', user });
    } catch (error) {
        logError(`Erro ao bloquear usuário ${req.params.id}: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao bloquear usuário.' });
    }
};

/**
 * @desc    Desbloquear uma conta de usuário (Admin)
 * @route   PUT /api/admin/users/:id/unblock
 * @access  Private (Admin)
 */
const unblockUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        user.status = 'active';
        await user.save();

        logAdminAction(req.user._id, `Usuário desbloqueado: ${user.phoneNumber}`, { userId: user._id });
        res.status(200).json({ success: true, message: 'Usuário desbloqueado com sucesso.', user });
    } catch (error) {
        logError(`Erro ao desbloquear usuário ${req.params.id}: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao desbloquear usuário.' });
    }
};

/**
 * @desc    Criar um novo administrador (Admin)
 * @route   POST /api/admin/users/create-admin
 * @access  Private (Admin)
 */
const createAdmin = async (req, res) => {
    const { phoneNumber, password } = req.body;

    if (!phoneNumber || !password) {
        return res.status(400).json({ message: 'Por favor, forneça número de telefone e senha para o novo administrador.' });
    }
    if (!/^\d{9}$/.test(phoneNumber)) {
        return res.status(400).json({ message: 'Número de telefone inválido. Deve ter 9 dígitos.' });
    }

    try {
        const adminExists = await User.findOne({ phoneNumber });
        if (adminExists) {
            return res.status(400).json({ message: 'Um usuário/admin com este número de telefone já existe.' });
        }

        // Criar um visitorId dummy para o novo admin
        const visitorId = `admin_${Date.now()}`;
        const newAdmin = await User.create({
            phoneNumber,
            password,
            isAdmin: true,
            status: 'active',
            visitorId, // Um visitorId único para admins criados manualmente
            referralCode: generateReferralCode(),
        });

        logAdminAction(req.user._id, `Novo administrador criado: ${phoneNumber}`, { newAdminId: newAdmin._id });
        res.status(201).json({ success: true, message: 'Novo administrador criado com sucesso.', admin: { _id: newAdmin._id, phoneNumber: newAdmin.phoneNumber } });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'Número de telefone ou Visitor ID já está em uso.' });
        }
        logError(`Erro ao criar novo administrador: ${error.message}`, { stack: error.stack, adminId: req.user._id, phoneNumber });
        res.status(500).json({ message: 'Erro ao criar novo administrador.' });
    }
};

/**
 * @desc    Alterar a senha de um usuário (Admin)
 * @route   PUT /api/admin/users/:id/change-password
 * @access  Private (Admin)
 */
const changeUserPasswordByAdmin = async (req, res) => {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ message: 'A nova senha deve ter pelo menos 6 caracteres.' });
    }

    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        // A senha será hashed automaticamente pelo middleware 'pre save'
        user.password = newPassword;
        await user.save(); // Salvar para que o hook de hash seja acionado

        logAdminAction(req.user._id, `Senha do usuário ${user.phoneNumber} alterada.`, { userId: user._id });
        res.status(200).json({ success: true, message: 'Senha do usuário alterada com sucesso.' });
    } catch (error) {
        logError(`Erro ao alterar senha do usuário ${req.params.id} pelo admin: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao alterar senha do usuário.' });
    }
};

/**
 * @desc    Obter contas bloqueadas (Admin)
 * @route   GET /api/admin/users/blocked
 * @access  Private (Admin)
 */
const getBlockedUsers = async (req, res) => {
    try {
        // Seleciona explicitamente os campos que o frontend precisa e exclui a senha
        const blockedUsers = await User.find({ status: 'blocked' })
                                        .select('_id phoneNumber status referralCode invitedBy createdAt') // Campos essenciais
                                        .sort({ createdAt: -1 });

        res.status(200).json({ success: true, users: blockedUsers });
    } catch (error) {
        logError(`Erro ao obter contas bloqueadas: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter contas bloqueadas.' });
    }
};

/**
 * @desc    Obter Logs de Ações Administrativas (Admin)
 * @route   GET /api/admin/logs/admin-actions
 * @access  Private (Admin)
 */
const getAdminLogs = async (req, res) => {
    try {
        // 1. Verifica se o arquivo de log existe
        if (!fs.existsSync(ADMIN_ACTION_LOG_FILE)) {
            return res.status(200).json({ success: true, logs: [], message: 'Arquivo de log não encontrado.' });
        }

        // 2. Lê o conteúdo do arquivo
        const data = fs.readFileSync(ADMIN_ACTION_LOG_FILE, 'utf8');
        
        // 3. Divide por linha, filtra linhas vazias e inverte (mais recente primeiro)
        const logs = data.split('\n').filter(line => line.trim() !== '').reverse(); 
        
        // NOTA: O frontend fará o JSON.parse de cada linha.
        res.status(200).json({ success: true, logs });

    } catch (error) {
        logError(`Erro ao ler logs de admin: ${error.message}`, { stack: error.stack, adminId: req.user._id });
        res.status(500).json({ message: 'Erro ao obter logs de atividade administrativa.' });
    }
};


// --- Funções de CRON / Tarefas Agendadas (Final - Saldo Único, Sem Bônus Fixo) ---

/**
 * @desc    Processa lucros diários para investimentos ativos e comissões.
 * @route   POST /api/internal/process-daily-profits (Protegida por API Key ou IP whitelist em produção)
 * @access  Private (Internal/Scheduled Task)
 */
const processDailyProfitsAndCommissions = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Considerar o início do dia para cálculo

        // Busca investimentos que ainda não foram creditados HOJE (lt: today)
        const investments = await Investment.find({
            status: 'active',
            $or: [
                { lastProfitCreditDate: { $lt: today } }, // Crédito foi antes de hoje
                { lastProfitCreditDate: { $exists: false } } // Nunca foi creditado
            ]
        }).populate('userId'); // Popula o usuário para atualizar o saldo e verificar convidante

        // Busca as configurações de admin (necessário para comissões)
        const adminConfig = await AdminConfig.findOne(); 
        const isPromotionActive = adminConfig ? adminConfig.isPromotionActive : false;
        const commissionRate = adminConfig ? adminConfig.commissionOnDailyProfit : 0;
        
        // Bônus fixo e referidos necessários não são mais usados.

        logInfo(`Iniciando processamento diário de lucros para ${investments.length} investimentos. Promoção Ativa: ${isPromotionActive}`);

        for (const investment of investments) {
            const user = investment.userId; // O usuário já populado (o referido)

            if (!user || user.status === 'blocked') {
                logInfo(`Ignorando investimento ${investment._id} porque o usuário está bloqueado ou não existe.`, { investmentId: investment._id, userId: user ? user._id : 'N/A' });
                // Encerra investimento se a duração for atingida
                if (investment.endDate <= today) {
                    investment.status = 'completed';
                    // Não remove da lista do usuário aqui, mas sim no próximo passo se o usuário existir
                    await investment.save();
                }
                continue;
            }

            // 1. Verificar e encerrar investimento se a duração for atingida
            if (investment.endDate <= today) {
                investment.status = 'completed';
                await investment.save();

                // Remover o investimento da lista de ativos do usuário
                user.activeInvestments = user.activeInvestments.filter(id => id.toString() !== investment._id.toString());
                await user.save();

                logInfo(`Investimento ${investment._id} do usuário ${user.phoneNumber} completado e encerrado.`, { userId: user._id, investmentId: investment._id });
                continue; // Não credita lucro se foi encerrado
            }


            // 2. Calcular e creditar lucro diário (para o referido)
            const dailyProfit = investment.investedAmount * investment.dailyProfitRate;
            investment.currentProfit += dailyProfit;
            user.balance += dailyProfit; // Credita no saldo principal do referido

            // 3. LÓGICA DE COMISSÃO SOBRE LUCRO DIÁRIO (CRÉDITO NO SALDO PRINCIPAL)
            if (isPromotionActive && commissionRate > 0 && user.invitedBy) {
                // Busca o convidante (Inviter)
                const inviter = await User.findOne({ referralCode: user.invitedBy });

                if (inviter && inviter.status === 'active') { // Apenas credita se o convidante estiver ativo
                    const commissionAmount = dailyProfit * commissionRate;
                    
                    // Credita no Saldo Principal do convidante
                    inviter.balance += commissionAmount;
                    await inviter.save();
                    
                    logInfo(`Comissão Diária de ${commissionAmount.toFixed(2)} MT creditada no SALDO PRINCIPAL para ${inviter.phoneNumber} (Referiu ${user.phoneNumber}).`, { 
                        inviterId: inviter._id, 
                        inviteeId: user._id, 
                        dailyProfit: dailyProfit, 
                        commission: commissionAmount 
                    });
                }
            }
            // FIM LÓGICA DE COMISSÃO

            investment.lastProfitCreditDate = today; // Atualiza a data do último crédito de lucro
            await investment.save();
            await user.save(); // Salva as atualizações no usuário (saldo principal)

            logInfo(`Lucro diário de ${dailyProfit} MT creditado para o investimento ${investment._id} do usuário ${user.phoneNumber}. Novo saldo: ${user.balance}.`, { userId: user._id, investmentId: investment._id });
        }

        logInfo('Processamento diário de lucros e comissões concluído.');
        if (res) { // Só envia resposta se for uma requisição HTTP
            res.status(200).json({ success: true, message: 'Processamento diário de lucros e comissões concluído.' });
        }
    } catch (error) {
        logError(`Erro durante o processamento diário de lucros e comissões: ${error.message}`, { stack: error.stack });
        if (res) {
            res.status(500).json({ message: 'Erro durante o processamento diário de lucros e comissões.' });
        }
    }
};


// Exportar todos os controladores
module.exports = {
    registerUser,
    loginUser,
    getUserProfile,
    createInvestmentPlan,
    getInvestmentPlans,
    getInvestmentPlanById,
    updateInvestmentPlan,
    deleteInvestmentPlan,
    activateInvestment,
    upgradeInvestment, 
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
    createInitialAdmin, 
    getDepositConfig, 
    getAdminLogs, 
};