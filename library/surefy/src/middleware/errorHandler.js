"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = void 0;
const CustomError_1 = require("../exceptions/CustomError");
const HttpStatusCode_1 = require("../utils/HttpStatusCode");
const Response_1 = require("../utils/Response");
const errorHandler = (err, req, res, next) => {
    if (err instanceof CustomError_1.CustomError) {
        return (0, Response_1.sendResponse)(res, err.statusCode, false, err.message, undefined, err.details);
    }
    // Log unexpected errors
    console.error('Unexpected error:', err);
    return (0, Response_1.sendResponse)(res, HttpStatusCode_1.HttpStatusCode.INTERNAL_SERVER_ERROR, false, 'An unexpected error occurred', undefined, process.env.NODE_ENV === 'development' ? err.message : undefined);
};
exports.errorHandler = errorHandler;
//# sourceMappingURL=errorHandler.js.map