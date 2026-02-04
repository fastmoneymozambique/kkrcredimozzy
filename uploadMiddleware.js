// uploadMiddleware.js
// Configuração do Multer (para upload local) e do Cloudinary (para armazenamento em nuvem).

const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { logInfo, logError } = require('./utils');

// 1. Configuração do Cloudinary
if (process.env.NODE_ENV !== 'production' || process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true,
    });
    logInfo('Cloudinary configurado com sucesso.');
} else {
    logError('Cloudinary não configurado. Verifique as variáveis de ambiente.');
}

// 2. Configuração do Multer
// Uso de armazenamento em memória para que o Cloudinary possa acessar o buffer diretamente
const storage = multer.memoryStorage();

// Middleware Multer
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // Limite de 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos de imagem são permitidos.'), false);
        }
    },
});

/**
 * Middleware para fazer o upload do buffer da imagem para o Cloudinary.
 * Deve ser usado APÓS o Multer.single('image').
 * @param {object} req - Objeto de requisição Express (contendo req.file do Multer).
 * @param {object} res - Objeto de resposta Express.
 * @param {function} next - Função next.
 */
const uploadToCloudinary = async (req, res, next) => {
    if (!req.file) {
        // Se não houver arquivo, não há upload a fazer, apenas prossegue.
        // O controller cuidará da lógica de usar a URL padrão ou a URL enviada via body.
        return next(); 
    }

    // Cria um Data URI para o buffer
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    let dataURI = 'data:' + req.file.mimetype + ';base64,' + b64;
    
    try {
        // Faz o upload para o Cloudinary
        const result = await cloudinary.uploader.upload(dataURI, {
            folder: 'kkr_investment_plans', // Pasta no Cloudinary
            resource_type: 'image',
        });

        // Adiciona a URL segura (https) à requisição
        req.uploadedImageUrl = result.secure_url;
        logInfo(`Upload para Cloudinary bem-sucedido: ${result.secure_url}`);

        next();
    } catch (error) {
        logError(`Erro ao fazer upload para o Cloudinary: ${error.message}`, { adminId: req.user ? req.user._id : 'N/A' });
        // Se o upload falhar, retorna um erro 500
        return res.status(500).json({ success: false, message: 'Falha no upload da imagem para o servidor de arquivos.' });
    }
};

module.exports = {
    upload,
    uploadToCloudinary,
};