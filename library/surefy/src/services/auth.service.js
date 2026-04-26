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
exports.validateCompanyKey = exports.generateCompanyKey = void 0;
const database_1 = __importDefault(require("../database"));
const crypto = __importStar(require("crypto"));
/**
 * Generate secure company key from company ID
 * This creates a non-reversible but deterministic key
 */
const generateCompanyKey = (companyId, salt) => {
    return crypto
        .createHmac('sha256', salt || process.env.API_KEY_SALT || 'default-salt')
        .update(companyId)
        .digest('hex')
        .substring(0, 32); // 32 character key
};
exports.generateCompanyKey = generateCompanyKey;
/**
 * Validate company key and extract company ID
 */
const validateCompanyKey = (apiKey, companyKey) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // Find company by API key directly using db
        const company = yield (0, database_1.default)('companies')
            .where({ api_key: apiKey, status: 'active' })
            .whereNull('deleted_at')
            .first();
        if (!company) {
            return null;
        }
        // Generate expected company key
        const expectedKey = (0, exports.generateCompanyKey)(company.id, process.env.API_KEY_SALT || '');
        // Compare keys (constant-time comparison to prevent timing attacks)
        if (!crypto.timingSafeEqual(Buffer.from(companyKey), Buffer.from(expectedKey))) {
            return null;
        }
        return company.id;
    }
    catch (error) {
        console.error('Error validating company key:', error);
        return null;
    }
});
exports.validateCompanyKey = validateCompanyKey;
//# sourceMappingURL=auth.service.js.map