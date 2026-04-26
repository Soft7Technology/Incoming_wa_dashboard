"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadMediaMiddleware = exports.uploadXLSXMiddleware = void 0;
const multer_1 = __importDefault(require("multer"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const HTTP400Error_1 = __importDefault(require("@surefy/exceptions/HTTP400Error"));
// Configure storage for file uploads
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.cwd(), 'uploads', 'temp');
        // Create directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    },
});
// File filter for XLSX files
const xlsxFileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
        'application/vnd.ms-excel', // .xls
    ];
    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    }
    else {
        cb(new HTTP400Error_1.default({ message: 'Only Excel files (.xlsx, .xls) are allowed' }));
    }
};
// File filter for media files (images, videos, documents)
const mediaFileFilter = (req, file, cb) => {
    const allowedMimes = [
        // Images
        'image/jpeg',
        'image/png',
        'image/webp',
        // Videos
        'video/mp4',
        'video/3gpp',
        // Documents
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        // Audio
        'audio/mpeg',
        'audio/ogg',
        'audio/aac',
    ];
    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    }
    else {
        cb(new HTTP400Error_1.default({ message: 'Invalid file type. Allowed: images (jpg, png, webp), videos (mp4, 3gp), documents (pdf, doc, docx), audio (mp3, ogg, aac)' }));
    }
};
// Multer configurations
const uploadXLSX = (0, multer_1.default)({
    storage,
    fileFilter: xlsxFileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit for XLSX
    },
});
const uploadMedia = (0, multer_1.default)({
    storage,
    fileFilter: mediaFileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit for media files
    },
});
// Export middleware
exports.uploadXLSXMiddleware = uploadXLSX.single('file');
exports.uploadMediaMiddleware = uploadMedia.single('file');
//# sourceMappingURL=upload.middleware.js.map