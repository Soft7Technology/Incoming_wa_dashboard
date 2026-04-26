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
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const hpp_1 = __importDefault(require("hpp"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const errorHandler_1 = require("./middleware/errorHandler");
const health_route_1 = __importDefault(require("./routes/health.route"));
const createBaseApp = (routes = []) => {
    const app = (0, express_1.default)();
    const PORT = process.env.PORT || 5000;
    // Middleware
    app.use((0, helmet_1.default)({
        contentSecurityPolicy: false, // Allow Swagger UI to load
    }));
    app.use((0, cors_1.default)());
    app.use((0, hpp_1.default)());
    app.use((0, compression_1.default)());
    app.use(express_1.default.json({ limit: '10mb' }));
    app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
    app.use((0, morgan_1.default)('dev'));
    app.use(express_1.default.json());
    // Swagger Documentation
    try {
        const swaggerPath = path.join(__dirname, '../../../swagger.json');
        if (fs.existsSync(swaggerPath)) {
            const swaggerDocument = JSON.parse(fs.readFileSync(swaggerPath, 'utf8'));
            app.use('/api-docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swaggerDocument, {
                customCss: '.swagger-ui .topbar { display: none }',
                customSiteTitle: 'Console API Documentation',
            }));
            console.log('📚 Swagger UI available at /api-docs');
        }
    }
    catch (error) {
        console.warn('⚠️  Swagger documentation not available');
    }
    // Health check route
    app.use('/health', health_route_1.default);
    // Register custom routes
    routes.forEach(({ basePath, route }) => {
        app.use(basePath, route);
    });
    // 404 handler - must be after all routes
    app.use((req, res) => {
        res.status(404).json({
            success: false,
            error: {
                message: 'Route not found',
                path: req.path,
                method: req.method,
                code: 404,
            },
        });
    });
    // Error handler (must be last)
    app.use(errorHandler_1.errorHandler);
    // Start server only if not in worker mode
    if (process.env.WORKER_MODE !== 'true') {
        app.listen(PORT, () => {
            console.log(`🚀 Server is running on port ${PORT}`);
            console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🔗 Health check: http://localhost:${PORT}/health`);
            console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
        });
    }
    return app;
};
exports.default = createBaseApp;
//# sourceMappingURL=server.js.map