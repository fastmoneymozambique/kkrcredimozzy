// middleware.js
// Este arquivo contém os middlewares para autenticação (JWT) e autorização
// (verificação de admin) que serão usados nas rotas protegidas.

const jwt = require('jsonwebtoken');
const { User } = require('./models'); // Importa o modelo de usuário
const { logError } = require('./utils'); // Para logging de erros

/**
 * Middleware para proteger rotas. Verifica a existência e validade de um JWT.
 * Adiciona o usuário decodificado à requisição (req.user).
 */
const protect = async (req, res, next) => {
    let token;

    // Verifica se o token está no cabeçalho Authorization
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            // Extrai o token do cabeçalho "Bearer <token>"
            token = req.headers.authorization.split(' ')[1];

            // Verifica o token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Busca o usuário pelo ID do token, excluindo a senha
            req.user = await User.findById(decoded.id).select('-password');

            if (!req.user) {
                logError('Tentativa de acesso com token válido, mas usuário não encontrado.', { token, decodedId: decoded.id });
                return res.status(401).json({ message: 'Não autorizado, usuário não encontrado.' });
            }

            // Verifica se a conta está bloqueada
            if (req.user.status === 'blocked') {
                logError(`Tentativa de acesso de usuário bloqueado: ${req.user.phoneNumber}`, { userId: req.user._id });
                return res.status(403).json({ message: 'Sua conta está bloqueada. Entre em contato com o suporte.' });
            }

            next(); // Prossegue para a próxima função da rota
        } catch (error) {
            logError(`Erro na autenticação de token: ${error.message}`, { token, errorStack: error.stack });
            if (error.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Não autorizado, token expirado.' });
            }
            return res.status(401).json({ message: 'Não autorizado, token falhou ou é inválido.' });
        }
    }

    if (!token) {
        logError('Tentativa de acesso a rota protegida sem token.');
        return res.status(401).json({ message: 'Não autorizado, nenhum token.' });
    }
};

/**
 * Middleware para verificar se o usuário autenticado é um administrador.
 * Deve ser usado APÓS o middleware 'protect'.
 */
const authorizeAdmin = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        logError(`Tentativa de acesso admin não autorizado: ${req.user ? req.user.phoneNumber : 'N/A'}`, { userId: req.user ? req.user._id : 'N/A' });
        return res.status(403).json({ message: 'Não autorizado como administrador.' });
    }
    next(); // Prossegue se o usuário for um administrador
};

module.exports = {
    protect,
    authorizeAdmin,
};