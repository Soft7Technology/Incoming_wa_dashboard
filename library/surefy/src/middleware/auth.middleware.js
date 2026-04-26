"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalAuthMiddleware = exports.authMiddleware = exports.generateCompanyKey = void 0;
const HTTP401Error_1 = __importDefault(require("../exceptions/HTTP401Error"));
const auth_service_1 = require("../services/auth.service");
Object.defineProperty(exports, "generateCompanyKey", { enumerable: true, get: function () { return auth_service_1.generateCompanyKey; } });
/**
 * Authentication middleware
 * Requires both x-api-key and x-company-key headers
 */
const authMiddleware = (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const apiKey = req.headers['x-api-key'];
        const companyKey = req.headers['x-company-key'];
        if (!apiKey || !companyKey) {
            throw new HTTP401Error_1.default({ message: 'API key and Company key are required' });
        }
        // Validate and get company ID
        const companyId = yield (0, auth_service_1.validateCompanyKey)(apiKey, companyKey);
        if (!companyId) {
            throw new HTTP401Error_1.default({ message: 'Invalid API key or Company key' });
        }
        // Attach to request
        req.apiKey = apiKey;
        req.companyId = companyId;
        next();
    }
    catch (error) {
        next(error);
    }
});
exports.authMiddleware = authMiddleware;
/**
 * Optional authentication middleware
 * Validates if credentials are provided but doesn't fail if missing
 */
const optionalAuthMiddleware = (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const apiKey = req.headers['x-api-key'];
        const companyKey = req.headers['x-company-key'];
        if (apiKey && companyKey) {
            const companyId = yield (0, auth_service_1.validateCompanyKey)(apiKey, companyKey);
            if (companyId) {
                req.apiKey = apiKey;
                req.companyId = companyId;
            }
        }
        next();
    }
    catch (error) {
        next(error);
    }
});
exports.optionalAuthMiddleware = optionalAuthMiddleware;
//# sourceMappingURL=auth.middleware.js.map