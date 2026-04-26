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
exports.optionalJWTAuthMiddleware = exports.requireRole = exports.jwtAuthMiddleware = void 0;
const HTTP401Error_1 = __importDefault(require("../exceptions/HTTP401Error"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
/**
 * JWT Authentication middleware
 * Requires Authorization: Bearer <token> header
 */
const jwtAuthMiddleware = (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const authHeader = req.headers['authorization'];
        // console.log("JWT Auth Middleware - Authorization header:", authHeader); // Debug log
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new HTTP401Error_1.default({ message: 'No token provided. Authorization header required' });
        }
        const token = authHeader.substring(7); // Remove 'Bearer ' prefix
        if (!token) {
            throw new HTTP401Error_1.default({ message: 'Invalid token format' });
        }
        // Verify token
        const JWT_SECRET = process.env.JWT_SECRET || '1428736492837465';
        let decoded;
        try {
            decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        }
        catch (error) {
            throw new HTTP401Error_1.default({ message: 'Invalid or expired token' });
        }
        // Attach user info to request
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        req.companyId = decoded.companyId;
        req.email = decoded.email;
        req.phone = decoded.phone;
        console.log("Decoded JWT payload:", decoded); // Debug log
        next();
    }
    catch (error) {
        next(error);
    }
});
exports.jwtAuthMiddleware = jwtAuthMiddleware;
/**
 * Role-based authorization middleware
 * Usage: requireRole('admin', 'superadmin')
 */
const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        try {
            if (!req.userRole) {
                throw new HTTP401Error_1.default({ message: 'No user role found in request' });
            }
            if (!allowedRoles.includes(req.userRole)) {
                throw new HTTP401Error_1.default({
                    message: `Access denied. Required role: ${allowedRoles.join(' or ')}`,
                });
            }
            next();
        }
        catch (error) {
            next(error);
        }
    };
};
exports.requireRole = requireRole;
/**
 * Optional JWT authentication middleware
 * Validates if token is provided but doesn't fail if missing
 */
const optionalJWTAuthMiddleware = (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            if (token) {
                const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
                try {
                    const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
                    req.userId = decoded.userId;
                    req.userRole = decoded.role;
                    req.companyId = decoded.companyId;
                    req.email = decoded.email;
                    req.phone = decoded.phone;
                }
                catch (error) {
                    // Token is invalid, but we don't fail - just continue without auth
                }
            }
        }
        next();
    }
    catch (error) {
        next(error);
    }
});
exports.optionalJWTAuthMiddleware = optionalJWTAuthMiddleware;
//# sourceMappingURL=jwtAuth.middleware.js.map